from __future__ import annotations

import json
import os
import random
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

import google.generativeai as genai


class GeminiError(Exception):
    pass


@dataclass(frozen=True)
class GeminiThumbnailAuditResult:
    score: float
    audit: List[str]
    prompt_for_fix: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "score": self.score,
            "audit": self.audit,
            "prompt_for_fix": self.prompt_for_fix,
        }


@dataclass(frozen=True)
class GeminiGodTierFluxPromptResult:
    performance_score: float
    critique: str
    flux_prompt: str
    text_overlay_suggestion: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "performance_score": self.performance_score,
            "critique": self.critique,
            "flux_prompt": self.flux_prompt,
            "text_overlay_suggestion": self.text_overlay_suggestion,
        }


_SYSTEM_INSTRUCTION = (
    "You are a world-class YouTube Thumbnail Strategist. Analyze the uploaded image based on:\n\n"
    "Visual Hierarchy (where does the eye go first?)\n\n"
    "Readability (is text legible on mobile?)\n\n"
    "Psychological Triggers (Curiosity, Tension, or Result).\n\n"
    "Combine this with the provided stats (Views/Likes). Output a JSON object with:\n\n"
    "score: (0-100)\n"
    "Scoring guidance: 50 = average thumbnail, 70+ = strong, 85+ = excellent. "
    "Avoid giving very low scores (<40) unless there are clear, major issues (illegible, cluttered, no focal point, muddy colors).\n\n"
    "audit: (Exactly 3 brief, brutal points. IMPORTANT: even if the thumbnail is succeeding (80+), you MUST include at least 1 specific improvement action to reach 95-100.\n"
    "Use this structure when score is high: 2 strengths + 1 upgrade/test. Each item should be concrete (what works / what to change), not vague praise.)\n\n"
    "prompt_for_fix: (A detailed image generation prompt to improve this thumbnail)."
)


_GOD_TIER_SYSTEM_INSTRUCTION = (
    "You are the World's Lead YouTube Growth Strategist & Visual Engineer.\n"
    "Your goal is to analyze a video's performance and generate a 'God-Tier' prompt for Flux.1 [Dev] to create a high-CTR background.\n\n"
    "INPUTS:\n"
    "- Current Thumbnail Image\n"
    "- Video Title: {title}\n"
    "- Current Stats: {stats}\n\n"
    "ANALYSIS RULES:\n"
    "1. Identify the 'Core Emotional Trigger' (Curiosity, Fear, Greed, or Joy).\n"
    "2. Evaluate the 'Subject-Background Contrast'.\n"
    "3. Check for 'Negative Space' (Where will the user's face or text go?).\n\n"
    "OUTPUT FORMAT (Strict JSON):\n"
    "{\n"
    "  \"performance_score\": 0-100,\n"
    "  \"critique\": \"Brutally honest feedback on why the current one fails.\",\n"
    "  \"flux_prompt\": \"A highly detailed image prompt. Use keywords like: '8k resolution', 'hyper-realistic', 'high-contrast', 'depth of field', 'saturated cinematic lighting'. Explicitly describe the background, lighting, and textures. Do NOT include faces if the user will add their own later.\",\n"
    "  \"text_overlay_suggestion\": \"The exact 2-3 words that should be on the thumbnail.\"\n"
    "}"
)


_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_json_object(text: str) -> Dict[str, Any]:
    text = text.strip()

    # Best case: model returns raw JSON.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Common case: JSON inside a fenced code block.
    match = _JSON_BLOCK_RE.search(text)
    if match:
        candidate = match.group(1)
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    # Last resort: attempt to locate the first {...} block.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = text[start : end + 1]
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    raise GeminiError("Gemini returned non-JSON output.")


def _coerce_score(value: Any) -> float:
    if isinstance(value, (int, float)):
        score = float(value)
    elif isinstance(value, str) and value.strip() != "":
        try:
            score = float(value)
        except ValueError as exc:
            raise GeminiError("Invalid score type returned by Gemini.") from exc
    else:
        raise GeminiError("Missing score in Gemini response.")

    # Clamp to 0..100 to keep downstream stable.
    if score < 0:
        score = 0.0
    if score > 100:
        score = 100.0
    return score


def _coerce_audit(value: Any) -> List[str]:
    if isinstance(value, list):
        items = [str(v).strip() for v in value if str(v).strip()]
    elif isinstance(value, str):
        # Some models return a single string; split into up to 3 lines.
        lines = [ln.strip(" -\t") for ln in value.splitlines() if ln.strip()]
        items = lines
    else:
        items = []

    # Ensure exactly 3 brief points if possible, but don’t invent content.
    return items[:3]


def _coerce_prompt(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise GeminiError("Missing prompt_for_fix in Gemini response.")


def _coerce_required_str(value: Any, field: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise GeminiError(f"Missing {field} in Gemini response.")


def _resolve_model_name(model_name: Optional[str]) -> str:
    resolved = (model_name or os.getenv("GEMINI_MODEL_NAME") or "").strip()
    # Default to a current "latest" model name when unset.
    return resolved or "models/gemini-flash-latest"


def _resolve_model_candidates(model_name: Optional[str]) -> List[str]:
    primary = _resolve_model_name(model_name)
    # Ordered fallbacks for new keys/projects where older models may be unavailable.
    fallbacks = [
        "models/gemini-flash-latest",
        "models/gemini-pro-latest",
        "models/gemini-2.5-flash",
        "models/gemini-2.5-pro",
        "models/gemini-2.0-flash",
        "models/gemini-2.0-flash-lite",
    ]
    seen = set()
    out: List[str] = []
    for name in [primary, *fallbacks]:
        name = (name or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _is_retryable_quota_error(exc: Exception) -> bool:
    message = f"{exc}".lower()
    return (
        "429" in message
        or "resource_exhausted" in message
        or "quota" in message
        or "rate limit" in message
        or "rate-limit" in message
        or "too many requests" in message
    )


def _is_model_unavailable_error(exc: Exception) -> bool:
    message = f"{exc}".lower()
    return (
        "404" in message
        or "not found" in message
        or "no longer available" in message
        or "model" in message
        and "available" in message
    )


def gemini_audit_thumbnail(
    *,
    thumbnail_image_bytes: bytes,
    youtube_metadata: Mapping[str, Any],
    mime_type: str = "image/jpeg",
    api_key: Optional[str] = None,
    model_name: Optional[str] = None,
    timeout_s: int = 25,
) -> GeminiThumbnailAuditResult:
    """Analyze a YouTube thumbnail using Gemini.

    Args:
        thumbnail_image_bytes: Raw image bytes of the thumbnail.
        youtube_metadata: Dict-like metadata (e.g. title, views, likes, channel).
        mime_type: e.g. image/jpeg, image/png.
        api_key: If not provided, reads GEMINI_API_KEY then GOOGLE_API_KEY.
        model_name: Gemini model id. If not provided, reads GEMINI_MODEL_NAME then defaults.
        timeout_s: Request timeout (best-effort; SDK may not hard-enforce in all transports).

    Returns:
        GeminiThumbnailAuditResult with score (0-100), audit (3 points), prompt_for_fix.
    """

    resolved_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not resolved_key:
        raise GeminiError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) env var.")

    genai.configure(api_key=resolved_key)

    model_candidates = _resolve_model_candidates(model_name)

    # Encourage strict JSON output.
    generation_config: Dict[str, Any] = {
        "temperature": 0.2,
        "max_output_tokens": 800,
    }
    # Supported by many recent SDK versions; safe to omit if not recognized.
    generation_config["response_mime_type"] = "application/json"

    response = None
    resolved_model = model_candidates[0] if model_candidates else _resolve_model_name(model_name)

    prompt = (
        "You will be given a YouTube thumbnail image and YouTube metadata. "
        "Return ONLY valid JSON (no markdown, no extra text).\n\n"
        "YouTube metadata (JSON):\n"
        f"{json.dumps(dict(youtube_metadata), ensure_ascii=False)}"
    )

    # The SDK supports inline_data parts for images.
    image_part = {
        "mime_type": mime_type,
        "data": thumbnail_image_bytes,
    }

    last_error: Optional[Exception] = None
    for candidate in model_candidates:
        resolved_model = candidate
        model = genai.GenerativeModel(
            model_name=candidate,
            system_instruction=_SYSTEM_INSTRUCTION,
            generation_config=generation_config,
        )

        for attempt in range(1, 4):
            try:
                response = model.generate_content(
                    contents=[
                        {"role": "user", "parts": [prompt, {"inline_data": image_part}]},
                    ],
                    request_options={"timeout": timeout_s},
                )
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc

                # If the model is deprecated/unavailable for this key, try the next candidate.
                if _is_model_unavailable_error(exc):
                    break

                if _is_retryable_quota_error(exc) and attempt < 3:
                    # Backoff with jitter to tolerate transient quota/rate limiting.
                    time.sleep((0.8 * (2 ** (attempt - 1))) + random.random() * 0.25)
                    continue

                message = str(exc)
                if _is_retryable_quota_error(exc):
                    message = (
                        f"Gemini quota/rate limit exceeded (HTTP 429). "
                        f"Check your Google AI Studio project quota/billing for this API key, "
                        f"or set GEMINI_MODEL_NAME to an available model (currently using '{resolved_model}'). "
                        f"Raw error: {exc}"
                    )
                raise GeminiError(f"Gemini request failed: {message}") from exc

        if response is not None:
            break

    if response is None:
        message = str(last_error) if last_error else "Unknown error"
        if last_error and _is_model_unavailable_error(last_error):
            message = (
                f"Gemini model unavailable for this API key/project. "
                f"Tried: {', '.join(model_candidates[:4])}{'…' if len(model_candidates) > 4 else ''}. "
                f"Set GEMINI_MODEL_NAME to a model returned by ListModels. Raw error: {last_error}"
            )
        raise GeminiError(f"Gemini request failed: {message}") from last_error

    text = getattr(response, "text", None)
    if not text:
        raise GeminiError("Gemini returned an empty response.")

    data = _extract_json_object(text)

    score = _coerce_score(data.get("score"))
    audit = _coerce_audit(data.get("audit"))
    prompt_for_fix = _coerce_prompt(data.get("prompt_for_fix"))

    return GeminiThumbnailAuditResult(score=score, audit=audit, prompt_for_fix=prompt_for_fix)


def gemini_generate_god_tier_flux_background_prompt(
    *,
    thumbnail_image_bytes: bytes,
    title: str,
    stats: Mapping[str, Any],
    mime_type: str = "image/jpeg",
    api_key: Optional[str] = None,
    model_name: Optional[str] = None,
    timeout_s: int = 30,
) -> GeminiGodTierFluxPromptResult:
    """Generate a strict-JSON Flux background prompt using Gemini.

    Inputs:
      - Current thumbnail image (bytes)
      - Video title
      - Current stats (views/likes/etc)

    Output keys (strict): performance_score, critique, flux_prompt, text_overlay_suggestion
    """

    resolved_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not resolved_key:
        raise GeminiError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) env var.")

    genai.configure(api_key=resolved_key)

    model_candidates = _resolve_model_candidates(model_name)

    generation_config: Dict[str, Any] = {
        "temperature": 0.2,
        "max_output_tokens": 900,
    }
    generation_config["response_mime_type"] = "application/json"

    response = None
    resolved_model = model_candidates[0] if model_candidates else _resolve_model_name(model_name)

    prompt = (
        "Return ONLY valid JSON matching the required schema (no markdown, no extra text).\n\n"
        f"Video Title: {title.strip()}\n\n"
        "Current Stats (JSON):\n"
        f"{json.dumps(dict(stats), ensure_ascii=False)}"
    )

    image_part = {"mime_type": mime_type, "data": thumbnail_image_bytes}

    last_error: Optional[Exception] = None
    for candidate in model_candidates:
        resolved_model = candidate
        model = genai.GenerativeModel(
            model_name=candidate,
            system_instruction=_GOD_TIER_SYSTEM_INSTRUCTION,
            generation_config=generation_config,
        )

        for attempt in range(1, 4):
            try:
                response = model.generate_content(
                    contents=[{"role": "user", "parts": [prompt, {"inline_data": image_part}]}],
                    request_options={"timeout": timeout_s},
                )
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc

                if _is_model_unavailable_error(exc):
                    break

                if _is_retryable_quota_error(exc) and attempt < 3:
                    time.sleep((0.8 * (2 ** (attempt - 1))) + random.random() * 0.25)
                    continue

                message = str(exc)
                if _is_retryable_quota_error(exc):
                    message = (
                        f"Gemini quota/rate limit exceeded (HTTP 429). "
                        f"Check your Google AI Studio project quota/billing for this API key, "
                        f"or set GEMINI_MODEL_NAME to an available model (currently using '{resolved_model}'). "
                        f"Raw error: {exc}"
                    )
                raise GeminiError(f"Gemini request failed: {message}") from exc

        if response is not None:
            break

    if response is None:
        message = str(last_error) if last_error else "Unknown error"
        if last_error and _is_model_unavailable_error(last_error):
            message = (
                f"Gemini model unavailable for this API key/project. "
                f"Tried: {', '.join(model_candidates[:4])}{'…' if len(model_candidates) > 4 else ''}. "
                f"Set GEMINI_MODEL_NAME to a model returned by ListModels. Raw error: {last_error}"
            )
        raise GeminiError(f"Gemini request failed: {message}") from last_error

    text = getattr(response, "text", None)
    if not text:
        raise GeminiError("Gemini returned an empty response.")

    data = _extract_json_object(text)

    performance_score = _coerce_score(data.get("performance_score"))
    critique = _coerce_required_str(data.get("critique"), "critique")
    flux_prompt = _coerce_required_str(data.get("flux_prompt"), "flux_prompt")
    text_overlay_suggestion = _coerce_required_str(
        data.get("text_overlay_suggestion"),
        "text_overlay_suggestion",
    )

    return GeminiGodTierFluxPromptResult(
        performance_score=performance_score,
        critique=critique,
        flux_prompt=flux_prompt,
        text_overlay_suggestion=text_overlay_suggestion,
    )
