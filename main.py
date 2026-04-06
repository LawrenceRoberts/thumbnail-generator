"""
FastAPI Backend for YouTube Thumbnail Generator
Exposes REST API endpoints for the thumbnail generation service
"""

import os
from dotenv import load_dotenv

# Load local environment variables from .env as early as possible (before importing other modules).
load_dotenv()

from fastapi import FastAPI, HTTPException, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Any, Dict
import asyncio
import threading
import base64
import logging
from urllib.parse import quote
from io import BytesIO
from PIL import Image
import uuid
import math

from supabase import Client, create_client
import httpx
import fal_client

from thumbnail_service import ThumbnailGenerator
from youtube_service import (
    YouTubeDataService,
    InvalidVideoIdError,
    QuotaExceededError,
    YouTubeApiError,
)

from gemini_service import gemini_audit_thumbnail, gemini_generate_god_tier_flux_background_prompt

_GENERATOR: Optional[ThumbnailGenerator] = None
_GENERATOR_LOCK = threading.Lock()

_FAL_ASYNC_CLIENT: Optional[fal_client.AsyncClient] = None
_FAL_ASYNC_CLIENT_LOCK = threading.Lock()


def _get_fal_async_client() -> fal_client.AsyncClient:
    """Return a configured Fal AsyncClient.

    Important:
    - Always read the key from the environment using os.getenv('FAL_KEY').
    - Do not hardcode keys in source.
    """

    global _FAL_ASYNC_CLIENT
    fal_key = os.getenv("FAL_KEY")
    if not fal_key:
        raise HTTPException(status_code=500, detail="Missing FAL_KEY for fal-client authentication.")

    if _FAL_ASYNC_CLIENT is not None:
        return _FAL_ASYNC_CLIENT

    with _FAL_ASYNC_CLIENT_LOCK:
        if _FAL_ASYNC_CLIENT is None:
            _FAL_ASYNC_CLIENT = fal_client.AsyncClient(key=fal_key)

    return _FAL_ASYNC_CLIENT


def _get_generator() -> ThumbnailGenerator:
    global _GENERATOR
    if _GENERATOR is not None:
        return _GENERATOR

    with _GENERATOR_LOCK:
        if _GENERATOR is None:
            _GENERATOR = ThumbnailGenerator()

    return _GENERATOR

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


_SUPABASE_ADMIN_CLIENT: Optional[Client] = None
_SUPABASE_ADMIN_CLIENT_LOCK = threading.Lock()


def _clamp_0_100(value: float) -> float:
    try:
        v = float(value)
    except Exception:
        return 0.0
    return max(0.0, min(100.0, v))


def _compute_engagement_score(*, views: int, likes: Optional[int], comments: Optional[int]) -> Dict[str, Any]:
    """Compute a best-effort 0–100 score from public engagement signals.

    Notes:
    - We do NOT have impressions or CTR from YouTube.
    - Likes/views and comments/views are noisy, so we shrink the score towards 50 for low-view videos.
    """

    v = int(views or 0)
    l = int(likes) if likes is not None else None
    c = int(comments) if comments is not None else None

    like_rate = (l / v) if (v > 0 and l is not None) else 0.0
    comment_rate = (c / v) if (v > 0 and c is not None) else 0.0

    # Reference engagement rates (roughly "typical" across many niches).
    # We use a log scale so doubling rates doesn't instantly max the score.
    like_ref = 0.02
    comment_ref = 0.001
    eps = 1e-6

    # Base score of 50 when rates are at the reference points.
    raw = 50.0
    raw += 22.0 * math.log10(max(like_rate, eps) / like_ref)
    raw += 18.0 * math.log10(max(comment_rate, eps) / comment_ref)
    raw = _clamp_0_100(raw)

    # Reliability factor: shrink towards 50 when views are low.
    # 1k views => ~0.5, 1M views => ~1.0.
    if v <= 0:
        reliability = 0.35
    else:
        reliability = max(0.35, min(1.0, math.log10(max(v, 10)) / 6.0))

    score = 50.0 + (raw - 50.0) * reliability
    score = _clamp_0_100(score)

    return {
        "score": float(score),
        "raw": float(raw),
        "reliability": float(reliability),
        "like_rate": float(like_rate),
        "comment_rate": float(comment_rate),
    }


def _blend_scores(*, heuristic: float, gemini: float) -> float:
    """Blend heuristic + Gemini scores to avoid unfair under-rating.

    Gemini can be subjective; heuristic can be noisy. We combine them, but if one
    is much lower than the other we avoid dragging the result down too harshly.
    """

    h = _clamp_0_100(heuristic)
    g = _clamp_0_100(gemini)

    diff = g - h
    if abs(diff) <= 15:
        blended = 0.5 * h + 0.5 * g
    elif diff < -15:
        # Gemini much lower: trust engagement more, apply a small discount.
        blended = max(0.0, h - 5.0)
    else:
        # Gemini much higher: lift the score, but don't fully jump to g.
        blended = 0.75 * g + 0.25 * h

    return _clamp_0_100(blended)


def _build_heuristic_flux_prompt(*, overview: Dict[str, Any], suggestions: List[str]) -> str:
    """Build a reasonable Flux background prompt without Gemini.

    This is used when Gemini is unavailable (quota/rate limit/key issues) so the
    frontend flow can still proceed.
    """

    title = str(overview.get("title") or "").strip()

    # Keep this explicitly a BACKGROUND prompt: no people/faces/text.
    base = (
        "YouTube thumbnail BACKGROUND ONLY (no text, no logos, no watermarks, no people, no faces). "
        "16:9 composition, 1280x720. High-CTR, hyper-realistic, cinematic lighting, high contrast, "
        "saturated but clean color palette, depth of field, sharp details, modern look. "
        "Leave strong negative space on the LEFT ~35% for a subject cutout and bold title text. "
        "Keep the RIGHT side visually interesting but not cluttered. "
    )

    # Lightly incorporate heuristic suggestions so we align with the audit.
    suggestion_text = " ".join([s.strip() for s in (suggestions or []) if isinstance(s, str) and s.strip()])
    if suggestion_text:
        suggestion_text = (
            "Improve based on these notes: "
            + suggestion_text
            + ". "
            "Translate them into background composition, lighting, and contrast choices. "
        )

    # Add a minimal theme hook from the title, but avoid generating literal words.
    title_hook = ""
    if title:
        title_hook = (
            f"Theme inspiration (do NOT render any text): {title}. "
            "Pick an on-theme environment/texture/motif that reinforces the promise. "
        )

    return (base + title_hook + suggestion_text + "8k, ultra-detailed.").strip()


def _build_supabase_public_object_url(*, bucket: str, object_path: str) -> str:
    """Build a public object URL for Supabase Storage.

    Notes:
    - This assumes the bucket/object is publicly readable.
    - We URL-encode `object_path` (but keep `/`) to avoid broken URLs when filenames contain spaces.
    """

    base_url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    encoded_path = quote(object_path.lstrip("/"), safe="/")
    return f"{base_url}/storage/v1/object/public/{bucket}/{encoded_path}"


def _coerce_public_url(value: Any) -> Optional[str]:
    """Try to coerce various Supabase SDK return shapes to a string URL."""

    if isinstance(value, str) and value:
        return value

    if isinstance(value, dict):
        # supabase-js style
        if isinstance(value.get("publicUrl"), str) and value.get("publicUrl"):
            return str(value["publicUrl"])
        if isinstance(value.get("public_url"), str) and value.get("public_url"):
            return str(value["public_url"])
        data = value.get("data")
        if isinstance(data, dict):
            if isinstance(data.get("publicUrl"), str) and data.get("publicUrl"):
                return str(data["publicUrl"])
            if isinstance(data.get("public_url"), str) and data.get("public_url"):
                return str(data["public_url"])

    # Some SDKs return objects with attrs.
    for attr in ("publicUrl", "public_url"):
        try:
            v = getattr(value, attr)
            if isinstance(v, str) and v:
                return v
        except Exception:
            pass

    return None


def _supabase_storage_enabled() -> bool:
    return bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_ROLE_KEY"))


def _get_supabase_admin_client() -> Client:
    """Create or return a cached Supabase admin client.

    Uses:
    - os.getenv('SUPABASE_URL')
    - os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    """

    global _SUPABASE_ADMIN_CLIENT

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    if _SUPABASE_ADMIN_CLIENT is not None:
        return _SUPABASE_ADMIN_CLIENT

    with _SUPABASE_ADMIN_CLIENT_LOCK:
        if _SUPABASE_ADMIN_CLIENT is None:
            _SUPABASE_ADMIN_CLIENT = create_client(url, key)

    return _SUPABASE_ADMIN_CLIENT


def ensure_thumbnails_bucket_exists(*, public: bool = True) -> None:
    """Ensure the Supabase Storage bucket 'thumbnails' exists; create it if missing.

    Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
    """

    if not _supabase_storage_enabled():
        raise RuntimeError("Supabase Storage not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY).")

    supabase = _get_supabase_admin_client()

    try:
        supabase.storage.get_bucket("thumbnails")
        return
    except Exception:
        # Bucket may not exist; attempt creation.
        pass

    try:
        supabase.storage.create_bucket("thumbnails", options={"public": bool(public)})
        logger.info("Created Supabase Storage bucket: thumbnails (public=%s)", public)
    except Exception as e:
        # If this races with another instance, creation may fail with "already exists".
        msg = str(e).lower()
        if "already" in msg and "exist" in msg:
            return
        if "409" in msg or "conflict" in msg:
            return
        raise


def upload_background_removed_image_to_supabase(
    *,
    image: Image.Image,
    filename: Optional[str] = None,
    bucket: str = "thumbnails",
    folder: str = "background-removed",
    content_type: str = "image/png",
) -> str:
    """Upload a background-removed (cutout) image to Supabase Storage and return a public URL.

    Notes:
    - Assumes the Storage bucket is public (or you have a public URL policy).
    - Uses the service role key; only call on the server.
    """

    if image.mode not in ("RGBA", "RGB"):
        image = image.convert("RGBA")

    buf = BytesIO()
    # PNG preserves alpha transparency (typical for background-removed cutouts).
    image.save(buf, format="PNG")
    data = buf.getvalue()

    path_name = filename or f"{uuid.uuid4().hex}.png"
    object_path = f"{folder}/{path_name}" if folder else path_name

    supabase = _get_supabase_admin_client()

    # Upload bytes. supabase-py accepts raw bytes for the file payload.
    upload_result = supabase.storage.from_(bucket).upload(
        object_path,
        data,
        file_options={
            "content-type": content_type,
            "upsert": "true",
        },
    )

    # Some clients return structured errors instead of throwing.
    if isinstance(upload_result, dict) and upload_result.get("error"):
        raise RuntimeError(str(upload_result.get("error")))

    # Prefer SDK helper if available; fall back to public URL convention.
    try:
        public_url = supabase.storage.from_(bucket).get_public_url(object_path)
        coerced = _coerce_public_url(public_url)
        if coerced:
            return coerced
    except Exception:
        pass

    return _build_supabase_public_object_url(bucket=bucket, object_path=object_path)


def upload_bytes_to_supabase(
    *,
    data: bytes,
    object_path: str,
    bucket: str = "thumbnails",
    content_type: str = "image/jpeg",
) -> str:
    """Upload raw bytes to Supabase Storage and return a public URL."""

    supabase = _get_supabase_admin_client()
    upload_result = supabase.storage.from_(bucket).upload(
        object_path,
        data,
        file_options={
            "content-type": content_type,
            "upsert": "true",
        },
    )

    if isinstance(upload_result, dict) and upload_result.get("error"):
        raise RuntimeError(str(upload_result.get("error")))

    try:
        public_url = supabase.storage.from_(bucket).get_public_url(object_path)
        coerced = _coerce_public_url(public_url)
        if coerced:
            return coerced
    except Exception:
        pass

    return _build_supabase_public_object_url(bucket=bucket, object_path=object_path)


async def _download_image_bytes(url: str, timeout_s: int = 45) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type") or "image/jpeg"
        return resp.content, content_type


async def _generate_flux_dev_with_retries(
    *,
    prompt: str,
    width: int = 1280,
    height: int = 720,
    retries: int = 3,
) -> str:
    """Generate an image URL using fal-ai/flux/dev with retry/backoff."""

    last_error: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            result = await _get_fal_async_client().run(
                "fal-ai/flux/dev",
                arguments={
                    "prompt": prompt,
                    "image_size": {"width": width, "height": height},
                    "num_images": 1,
                    "output_format": "jpeg",
                },
            )

            if not isinstance(result, dict):
                raise RuntimeError("fal result was not an object")
            images = result.get("images")
            if not isinstance(images, list) or not images:
                raise RuntimeError("fal result missing images")
            first = images[0]
            if not isinstance(first, dict) or not first.get("url"):
                raise RuntimeError("fal result missing image url")
            return str(first["url"])
        except Exception as exc:
            last_error = exc
            if attempt < retries:
                await asyncio.sleep(0.8 * (2 ** (attempt - 1)))

    raise RuntimeError(f"Flux generation failed after {retries} attempts: {last_error}")


async def _generate_flux_dev_landscape_with_params(
    *,
    prompt: str,
    guidance_scale: float = 3.5,
    num_inference_steps: int = 28,
    retries: int = 3,
) -> str:
    """Generate an image URL using Flux.1 [dev] with required tuning params."""

    last_error: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            result = await _get_fal_async_client().run(
                "fal-ai/flux/dev",
                arguments={
                    "prompt": prompt,
                    "image_size": "landscape_16_9",
                    "guidance_scale": guidance_scale,
                    "num_inference_steps": num_inference_steps,
                    "num_images": 1,
                    "output_format": "jpeg",
                },
            )

            if not isinstance(result, dict):
                raise RuntimeError("fal result was not an object")
            images = result.get("images")
            if not isinstance(images, list) or not images:
                raise RuntimeError("fal result missing images")
            first = images[0]
            if not isinstance(first, dict) or not first.get("url"):
                raise RuntimeError("fal result missing image url")
            return str(first["url"])
        except Exception as exc:
            last_error = exc
            if attempt < retries:
                await asyncio.sleep(0.8 * (2 ** (attempt - 1)))

    raise RuntimeError(f"Flux generation failed after {retries} attempts: {last_error}")


async def get_performance_tuning(*, video_id: str) -> Dict[str, Any]:
    """Gemini critique+Flux prompt from YouTube metadata+thumbnail, then generate Flux background.

    Returns:
        {"critique": str, "imageUrl": str}
    """

    if not os.getenv("FAL_KEY"):
        raise HTTPException(status_code=500, detail="Missing FAL_KEY for fal-client authentication.")

    svc = YouTubeDataService()
    overview = svc.get_video_overview(video_id)

    thumbnail_url = str(overview.get("thumbnail_url") or "")
    title = str(overview.get("title") or "").strip() or "(untitled video)"

    current_stats: Dict[str, Any] = {
        "views": overview.get("views"),
        "likes": overview.get("likes"),
        "comment_count": overview.get("comment_count"),
    }

    if not thumbnail_url:
        raise HTTPException(status_code=400, detail="No thumbnail URL available for this video.")

    thumb_bytes, content_type = await _download_image_bytes(thumbnail_url, timeout_s=60)
    mime_type = (content_type or "image/jpeg").split(";")[0].strip() or "image/jpeg"

    # Gemini call is blocking; run in a thread to avoid blocking the event loop.
    gemini_result = await asyncio.to_thread(
        gemini_generate_god_tier_flux_background_prompt,
        thumbnail_image_bytes=thumb_bytes,
        title=title,
        stats={
            "current_stats": current_stats,
            "youtube_metadata": overview,
        },
        mime_type=mime_type,
    )

    flux_prompt = (gemini_result.flux_prompt or "").strip()
    if not flux_prompt:
        raise HTTPException(status_code=502, detail="Gemini did not return a flux_prompt.")

    # Immediately generate via Flux.1 [Dev] with the required parameters.
    image_url = await _generate_flux_dev_landscape_with_params(
        prompt=flux_prompt,
        guidance_scale=3.5,
        num_inference_steps=28,
        retries=3,
    )

    return {
        "critique": gemini_result.critique,
        "imageUrl": image_url,
    }

# Initialize FastAPI app
app = FastAPI(
    title="YouTube Thumbnail Generator API",
    description="AI-powered thumbnail generation with CTR optimization",
    version="1.0.0"
)


@app.on_event("startup")
async def _startup_warmup():
    # Don't block server startup on model downloads/initialization.
    # Fly's proxy expects the app to start listening promptly.
    try:
        # Supabase Storage sanity check (non-fatal).
        if not _supabase_storage_enabled():
            logger.warning(
                "Supabase Storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable uploads."
            )
        else:
            # Ensure required bucket exists (non-blocking, non-fatal).
            def _ensure_bucket_safe() -> None:
                try:
                    ensure_thumbnails_bucket_exists(public=True)
                except Exception as e:
                    logger.warning(f"Supabase bucket check failed (non-fatal): {e}")

            asyncio.create_task(asyncio.to_thread(_ensure_bucket_safe))

        def _warmup():
            from image_compositor import warmup_background_removal

            warmup_background_removal()

        # Warm the AI client too (without blocking startup).
        def _warmup_generator():
            try:
                _get_generator()
                logger.info("thumbnail generator warmup complete")
            except Exception as e:
                logger.warning(f"thumbnail generator warmup failed: {e}")

        asyncio.create_task(asyncio.to_thread(_warmup))
        asyncio.create_task(asyncio.to_thread(_warmup_generator))
        logger.info("rembg warmup scheduled")
    except Exception as e:
        logger.warning(f"rembg warmup scheduling failed: {e}")

# Configure CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response Models
class GenerateRequest(BaseModel):
    simple_prompt: str = Field(..., description="Simple description of the thumbnail")
    width: int = Field(default=1280, ge=512, le=2048)
    height: int = Field(default=720, ge=512, le=2048)
    cfg_scale: float = Field(default=8.0, ge=1.0, le=20.0)
    steps: int = Field(default=40, ge=10, le=150)
    samples: int = Field(default=1, ge=1, le=4)
    track_cost: bool = Field(default=True)


class ImageResult(BaseModel):
    image_data: str
    seed: int
    finish_reason: int


class CostTracking(BaseModel):
    usd: float
    zar: float
    exchange_rate: float
    timestamp: str


class GenerateResponse(BaseModel):
    success: bool
    images: List[ImageResult]
    metadata: dict
    cost_tracking: Optional[CostTracking]
    editable_data: Optional[dict] = None


class AnalyzeRequest(BaseModel):
    video_id: str = Field(..., description="YouTube video id (11 chars)")


class AnalyzeResponse(BaseModel):
    videoId: str
    thumbnailUrl: Optional[str] = None
    performanceScore: float
    # Optional transparency/debug fields (safe for clients to ignore).
    heuristicScore: Optional[float] = None
    geminiScore: Optional[float] = None
    scoreSource: Optional[str] = None
    scoreBreakdown: Optional[Dict[str, Any]] = None
    improvementSuggestions: List[str]
    title: Optional[str] = None
    views: Optional[int] = None
    likes: Optional[int] = None
    commentCount: Optional[int] = None
    flux_prompt: Optional[str] = None
    gemini_error: Optional[str] = None


class GenerateOptimizedBackgroundRequest(BaseModel):
    prompt: Optional[str] = Field(default=None, description="Prompt for Flux.1 [dev] generated by Gemini")
    flux_prompt: Optional[str] = Field(
        default=None,
        description="Alias for prompt (Flux prompt) sent by some clients.",
    )
    style_reference_url: str = Field(..., description="Reference image URL (for context/traceability)")


class GenerateOptimizedBackgroundResponse(BaseModel):
    imageUrl: str
    falImageUrl: str
    styleReferenceUrl: str


class PerformanceTuningRequest(BaseModel):
    video_id: str = Field(..., description="YouTube video id (11 chars)")


class PerformanceTuningResponse(BaseModel):
    critique: str
    imageUrl: str


# Health check endpoint
@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "YouTube Thumbnail Generator",
        "version": "1.0.0"
    }


@app.get("/health")
async def health_check():
    """Detailed health check"""
    return {
        "status": "healthy",
        "service": "thumbnail-generator",
        "timestamp": "2025-12-18T00:00:00Z"
    }


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_video(request: AnalyzeRequest):
    """Analyze a YouTube video's current thumbnail performance signals.

    This endpoint is designed to be called by the Next.js proxy route.
    It fetches YouTube statistics and returns a simple score + suggestions.
    """
    try:
        svc = YouTubeDataService()
        overview = svc.get_video_overview(request.video_id)

        title = str(overview.get("title") or "").strip() or None
        views = int(overview.get("views") or 0)
        likes = overview.get("likes")
        comments = overview.get("comment_count")
        thumbnail_url = str(overview.get("thumbnail_url") or "")

        engagement = _compute_engagement_score(
            views=views,
            likes=int(likes) if likes is not None else None,
            comments=int(comments) if comments is not None else None,
        )
        heuristic_score = float(engagement["score"])
        score = float(heuristic_score)
        score_source: str = "heuristic"
        gemini_score: Optional[float] = None

        like_rate = float(engagement.get("like_rate") or 0.0)
        comment_rate = float(engagement.get("comment_rate") or 0.0)

        suggestions: List[str] = []
        if views < 1000:
            suggestions.append("If impressions are low, test stronger topics/titles to drive more views.")

        if like_rate < 0.015:
            suggestions.append("Boost clarity: larger subject, fewer elements, stronger contrast for mobile.")
            suggestions.append("Add an expressive face or clear focal object if relevant to the niche.")
        elif like_rate < 0.03:
            suggestions.append("Consider A/B testing 2 thumbnail variants with different backgrounds/colors.")

        if not thumbnail_url:
            suggestions.append("No thumbnail URL detected; verify the video has a public thumbnail.")

        if not suggestions:
            suggestions.append("Performance looks healthy. Try small iterative tests (color, composition, text).")

        flux_prompt: Optional[str] = None
        gemini_error: Optional[str] = None

        # Prefer Gemini-generated optimization logic when available.
        if thumbnail_url:
            try:
                thumb_bytes, content_type = await _download_image_bytes(thumbnail_url, timeout_s=60)
                mime_type = (content_type or "image/jpeg").split(";")[0].strip() or "image/jpeg"

                gemini_result = await asyncio.to_thread(
                    gemini_audit_thumbnail,
                    thumbnail_image_bytes=thumb_bytes,
                    youtube_metadata=overview,
                    mime_type=mime_type,
                )

                # Override heuristics with Gemini audit.
                gemini_score = float(gemini_result.score)
                suggestions = list(gemini_result.audit or [])[:3]
                flux_prompt = (gemini_result.prompt_for_fix or "").strip() or None
                score = _blend_scores(heuristic=heuristic_score, gemini=gemini_score)
                score_source = "blended"
            except Exception as e:
                gemini_error = str(e)
                # Keep response payload reasonable.
                if len(gemini_error) > 600:
                    gemini_error = gemini_error[:600] + "…"
                logger.warning(f"Gemini audit failed; falling back to heuristic analyze: {e}")

        # If Gemini couldn't provide a prompt (quota/key/rate limit), still return a usable prompt
        # so the frontend can proceed with Flux background generation.
        if thumbnail_url and not flux_prompt:
            flux_prompt = _build_heuristic_flux_prompt(overview=overview, suggestions=suggestions)

        return {
            "videoId": request.video_id,
            "thumbnailUrl": thumbnail_url or None,
            "performanceScore": round(float(score), 1),
            "heuristicScore": round(float(heuristic_score), 1),
            "geminiScore": round(float(gemini_score), 1) if gemini_score is not None else None,
            "scoreSource": score_source,
            "scoreBreakdown": {
                "engagement": {
                    "likeRate": round(float(engagement.get("like_rate") or 0.0), 6),
                    "commentRate": round(float(engagement.get("comment_rate") or 0.0), 6),
                    "raw": round(float(engagement.get("raw") or 0.0), 1),
                    "reliability": round(float(engagement.get("reliability") or 0.0), 3),
                }
            },
            "improvementSuggestions": suggestions,
            "title": title,
            "views": views,
            "likes": int(likes) if likes is not None else None,
            "commentCount": int(comments) if comments is not None else None,
            "flux_prompt": flux_prompt,
            "gemini_error": gemini_error,
        }

    except InvalidVideoIdError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except QuotaExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except YouTubeApiError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.error(f"Analyze failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analyze failed: {str(e)}")


@app.post("/generate-optimized-background", response_model=GenerateOptimizedBackgroundResponse)
async def generate_optimized_background(request: GenerateOptimizedBackgroundRequest):
    """Generate a 1280x720 optimized background via Flux.1 [dev], upload to Supabase, return public URL.

    Requirements:
    - env FAL_KEY (fal-client auth)
    - env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Storage upload)
    """

    if not _supabase_storage_enabled():
        raise HTTPException(
            status_code=500,
            detail="Supabase Storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        )
    if not os.getenv("FAL_KEY"):
        raise HTTPException(status_code=500, detail="Missing FAL_KEY for fal-client authentication.")

    try:
        # Flux dev is text-to-image; we accept style_reference_url for traceability and
        # include it in the prompt so the request is self-contained.
        prompt = ((request.prompt or request.flux_prompt) or "").strip()

        # Debug/logging (safe: this is user-provided prompt text)
        print(f'Received prompt: {prompt}')

        if not prompt:
            raise HTTPException(
                status_code=400,
                detail="Backend received the request but the prompt field was empty",
            )

        prompt_with_context = f"{prompt}\n\nStyle reference URL (for context): {request.style_reference_url}".strip()

        fal_image_url = await _generate_flux_dev_with_retries(
            prompt=prompt_with_context,
            width=1280,
            height=720,
            retries=3,
        )

        img_bytes, content_type = await _download_image_bytes(fal_image_url, timeout_s=60)

        ext = "jpg"
        if "png" in (content_type or "").lower():
            ext = "png"

        object_path = f"optimized-backgrounds/{uuid.uuid4().hex}.{ext}"
        public_url = upload_bytes_to_supabase(
            data=img_bytes,
            object_path=object_path,
            bucket="thumbnails",
            content_type=content_type or "image/jpeg",
        )

        return {
            "imageUrl": public_url,
            "falImageUrl": fal_image_url,
            "styleReferenceUrl": request.style_reference_url,
        }
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        logger.error(f"Failed downloading Flux image: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to download generated image: {str(e)}")
    except Exception as e:
        logger.error(f"generate-optimized-background failed: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to generate optimized background: {str(e)}")


@app.post("/performance-tuning", response_model=PerformanceTuningResponse)
async def performance_tuning(request: PerformanceTuningRequest):
    """Gemini critique+Flux prompt from YouTube metadata+thumbnail, then generate Flux background."""

    try:
        return await get_performance_tuning(video_id=request.video_id)
    except InvalidVideoIdError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except QuotaExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except YouTubeApiError as e:
        raise HTTPException(status_code=502, detail=str(e))


# Main generation endpoint
@app.post("/api/generate", response_model=GenerateResponse)
async def generate_thumbnail(
    simple_prompt: str = Form(...),
    width: int = Form(default=1280),
    height: int = Form(default=720),
    cfg_scale: float = Form(default=8.0),
    steps: int = Form(default=40),
    samples: int = Form(default=1),
    track_cost: bool = Form(default=True),
    reference_image: Optional[UploadFile] = File(None),
    people_images: List[UploadFile] = File(default=[]),
    background_image: Optional[UploadFile] = File(None),
    overlay_text: Optional[str] = Form(None),
    cutout_quality: str = Form(default="auto"),
):
    """
    Generate a YouTube thumbnail with photo composition.
    
    Workflow:
    1. Use uploaded background OR generate AI background from prompt
    2. If reference image provided: remove background and composite onto background
    3. Add text overlay if provided
    4. Apply enhancements (saturation, contrast, sharpness)
    
    Args:
        simple_prompt: Description of the background/scene (or additional instructions if background uploaded)
        reference_image: Optional photo to composite (person/object)
        background_image: Optional background image (skips AI generation if provided)
        overlay_text: Optional text to overlay on thumbnail
        width, height: Output dimensions
        cfg_scale: Guidance scale
        steps: Number of diffusion steps
        samples: Number of images to generate
        track_cost: Whether to track costs
        
    Returns:
        Generated thumbnail with metadata and cost tracking
    """
    try:
        from image_compositor import (
            remove_background,
            composite_person_on_background,
            composite_people_on_background,
            add_text_overlay,
            enhance_thumbnail,
        )

        logger.info(f"Generating thumbnail for prompt: {simple_prompt}")
        
        # Process uploaded background if provided
        uploaded_bg = None
        if background_image:
            try:
                logger.info(f"Using uploaded background: {background_image.filename}")
                bg_data = await background_image.read()
                uploaded_bg = Image.open(BytesIO(bg_data))
                
                # Ensure RGB and resize to exact dimensions
                if uploaded_bg.mode != 'RGB':
                    uploaded_bg = uploaded_bg.convert('RGB')
                uploaded_bg = uploaded_bg.resize((width, height), Image.Resampling.LANCZOS)
                logger.info(f"Background image resized to {width}x{height}")
                
                # Apply quality enhancements to uploaded background
                from PIL import ImageEnhance
                
                # Increase saturation
                enhancer = ImageEnhance.Color(uploaded_bg)
                uploaded_bg = enhancer.enhance(1.3)
                
                # Increase sharpness
                enhancer = ImageEnhance.Sharpness(uploaded_bg)
                uploaded_bg = enhancer.enhance(1.4)
                
                # Increase contrast
                enhancer = ImageEnhance.Contrast(uploaded_bg)
                uploaded_bg = enhancer.enhance(1.2)
                
                # Slight brightness boost
                enhancer = ImageEnhance.Brightness(uploaded_bg)
                uploaded_bg = enhancer.enhance(1.05)
                
                logger.info("Background image optimized with quality enhancements")
                
            except Exception as e:
                logger.error(f"Error processing background image: {e}", exc_info=True)
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to process background image: {str(e)}"
                )
        
        # Process people images for composition (not image-to-image)
        # Supports both legacy single reference_image and new people_images[]
        person_cutouts: List[Image.Image] = []
        people_files: List[UploadFile] = []
        if people_images:
            people_files.extend(people_images)
        if reference_image:
            people_files.append(reference_image)

        has_people = len(people_files) > 0

        # Initialize generator
        generator = _get_generator()

        # Start background generation early (in parallel with CPU-heavy cutouts)
        bg_task = None

        # Use uploaded background or generate with AI
        if uploaded_bg:
            logger.info("Using uploaded background image")
            
            # Save uploaded background to bytes
            img_byte_arr = BytesIO()
            uploaded_bg.save(img_byte_arr, format='PNG')
            img_bytes = img_byte_arr.getvalue()
            
            # Create a mock result structure with uploaded background
            result = {
                "success": True,
                "images": [{
                    "image_data": img_bytes,
                    "seed": 0,
                    "finish_reason": 0
                }],
                "metadata": {
                    "original_prompt": simple_prompt,
                    "enhanced_prompt": "User uploaded background",
                    "width": width,
                    "height": height,
                    "cfg_scale": cfg_scale,
                    "steps": steps,
                    "samples": 1,
                    "generated_at": "2025-12-20T00:00:00Z"
                },
                "cost_tracking": {
                    "usd": 0.0,
                    "zar": 0.0,
                    "exchange_rate": 0.0,
                    "timestamp": "2025-12-20T00:00:00Z"
                }
            }
            
        else:
            logger.info("Generating AI background")
            # Modify prompt to exclude people if we're compositing
            background_prompt = simple_prompt
            if has_people:
                background_prompt = f"{simple_prompt}, no people, empty scene, background only"

            # Kick off the Stability request early; cutouts can run while we wait.
            bg_task = asyncio.create_task(
                generator.generate_thumbnail(
                    simple_prompt=background_prompt,
                    width=width,
                    height=height,
                    cfg_scale=cfg_scale,
                    steps=steps,
                    samples=samples,
                    track_cost=track_cost,
                    init_image=None,  # Don't use image-to-image
                )
            )

        # Now do CPU-heavy cutouts (can overlap with bg_task network wait)
        uploaded_cutout_urls: List[str] = []
        if has_people:
            for idx, f in enumerate(people_files):
                try:
                    logger.info(f"Processing person image {idx + 1}/{len(people_files)}: {f.filename}")
                    image_data = await f.read()

                    person_img = Image.open(BytesIO(image_data))
                    logger.info(f"Loaded person image: mode={person_img.mode}, size={person_img.size}")

                    cutout = await asyncio.to_thread(remove_background, person_img, quality=cutout_quality)
                    person_cutouts.append(cutout)
                    logger.info("Background removed from person image")

                    # Upload background-removed cutout to Supabase Storage (optional)
                    if _supabase_storage_enabled():
                        safe_name = (f.filename or f"person-{idx + 1}").rsplit(".", 1)[0]
                        upload_name = f"{safe_name}-{uuid.uuid4().hex}.png"
                        try:
                            url = await asyncio.to_thread(
                                upload_background_removed_image_to_supabase,
                                image=cutout,
                                filename=upload_name,
                            )
                            uploaded_cutout_urls.append(url)
                        except Exception as e:
                            logger.warning(f"Supabase cutout upload failed: {e}")
                except Exception as e:
                    logger.error(f"Error processing person image: {e}", exc_info=True)
                    raise HTTPException(
                        status_code=400,
                        detail=f"Failed to process person image: {str(e)}"
                    )

        # If we started an AI generation task, wait for it now.
        if bg_task is not None:
            result = await bg_task
        
        # Post-process each generated image
        editable_data = {}
        
        for image_data in result["images"]:
            # Decode the generated background
            bg_image = Image.open(BytesIO(image_data["image_data"]))
            
            # Store clean background for editing
            bg_byte_arr = BytesIO()
            bg_image.save(bg_byte_arr, format='PNG')
            editable_data["background_image"] = base64.b64encode(bg_byte_arr.getvalue()).decode('utf-8')
            
            # Composite person if provided
            if person_cutouts:
                if len(person_cutouts) == 1:
                    logger.info("Compositing 1 person onto background")
                    bg_image = composite_person_on_background(person_cutouts[0], bg_image)
                else:
                    logger.info(f"Compositing {len(person_cutouts)} people onto background")
                    bg_image = composite_people_on_background(person_cutouts, bg_image)

                # Store person cutouts for potential future editing
                cutouts_b64: List[str] = []
                for cutout in person_cutouts:
                    person_byte_arr = BytesIO()
                    cutout.save(person_byte_arr, format='PNG')
                    cutouts_b64.append(base64.b64encode(person_byte_arr.getvalue()).decode('utf-8'))
                # Backward compatible: keep first as person_cutout
                editable_data["person_cutout"] = cutouts_b64[0]
                editable_data["person_cutouts"] = cutouts_b64

                # Include public URLs if cutouts were uploaded.
                if uploaded_cutout_urls:
                    editable_data["person_cutout_url"] = uploaded_cutout_urls[0]
                    editable_data["person_cutout_urls"] = uploaded_cutout_urls
            
            # Store composite before text for editing
            composite_before_text = bg_image.copy()
            composite_byte_arr = BytesIO()
            composite_before_text.save(composite_byte_arr, format='PNG')
            editable_data["composite_before_text"] = base64.b64encode(composite_byte_arr.getvalue()).decode('utf-8')
            
            # Add text overlay if provided
            if overlay_text and overlay_text.strip():
                logger.info(f"Adding text overlay: {overlay_text}")
                bg_image = add_text_overlay(bg_image, overlay_text.strip())
                editable_data["text_content"] = overlay_text.strip()
            
            # Apply enhancements
            bg_image = enhance_thumbnail(bg_image)
            
            # Convert back to bytes
            img_byte_arr = BytesIO()
            bg_image.save(img_byte_arr, format='PNG')
            image_data["image_data"] = img_byte_arr.getvalue()
        
        # Convert binary image data to base64 for JSON response
        for image in result["images"]:
            image["image_data"] = base64.b64encode(image["image_data"]).decode('utf-8')
        
        # Add editable data to response
        result["editable_data"] = editable_data
        
        logger.info(f"Successfully generated {len(result['images'])} thumbnail(s)")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate thumbnail: {str(e)}"
        )


@app.get("/api/pricing")
async def get_pricing():
    """Get current pricing information in USD and ZAR"""
    try:
        generator = ThumbnailGenerator()
        await generator.get_zar_exchange_rate()
        
        pricing_tiers = [
            {"steps": 40, "usd": 0.04},
            {"steps": 50, "usd": 0.05},
            {"steps": 60, "usd": 0.06},
        ]
        
        # Add ZAR conversions
        for tier in pricing_tiers:
            cost_info = generator.calculate_cost_in_zar(tier["usd"])
            tier["zar"] = cost_info["zar"]
            tier["exchange_rate"] = cost_info["exchange_rate"]
        
        return {
            "pricing": pricing_tiers,
            "resolution": "1280x720 (16:9)",
            "currency": "USD/ZAR",
            "timestamp": pricing_tiers[0]["exchange_rate"] if pricing_tiers else None
        }
        
    except Exception as e:
        logger.error(f"Failed to fetch pricing: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch pricing: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    import os
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=os.environ.get("UVICORN_RELOAD", "0") == "1",
        log_level="info"
    )
