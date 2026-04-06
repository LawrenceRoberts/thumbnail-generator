"""youtube_service.py

Thin data-access layer for the YouTube Data API v3.

Provides a small service for fetching a video's snippet + statistics.

Env vars:
- YOUTUBE_API_KEY: YouTube Data API v3 key

Example:
    from youtube_service import YouTubeDataService

    svc = YouTubeDataService()
    data = svc.get_video_overview("dQw4w9WgXcQ")
    print(data)
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Optional

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class YouTubeApiError(RuntimeError):
    """Base error for YouTube API failures."""


class InvalidVideoIdError(YouTubeApiError):
    """Raised when the supplied video id is invalid or not found."""


class QuotaExceededError(YouTubeApiError):
    """Raised when the YouTube API quota/rate limit is exceeded."""


@dataclass(frozen=True)
class YouTubeVideoOverview:
    video_id: str
    title: str
    views: int
    likes: Optional[int]
    comment_count: Optional[int]
    thumbnail_url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "video_id": self.video_id,
            "title": self.title,
            "views": self.views,
            "likes": self.likes,
            "comment_count": self.comment_count,
            "thumbnail_url": self.thumbnail_url,
        }


def _normalize_video_id(video_id: str) -> str:
    return (video_id or "").strip()


def _validate_video_id(video_id: str) -> None:
    if not _VIDEO_ID_RE.match(video_id):
        raise InvalidVideoIdError(
            "Invalid YouTube video_id format. Expected 11 characters (letters, numbers, '_' or '-')."
        )


def _parse_http_error_reason(err: HttpError) -> tuple[Optional[str], Optional[str]]:
    """Return (reason, message) if response body is JSON; otherwise (None, None)."""
    try:
        raw = err.content.decode("utf-8") if isinstance(err.content, (bytes, bytearray)) else str(err.content)
        data = json.loads(raw)
    except Exception:
        return None, None

    error_obj = (data or {}).get("error") or {}
    message = error_obj.get("message")
    errors = error_obj.get("errors") or []
    reason = None
    if errors and isinstance(errors, list) and isinstance(errors[0], dict):
        reason = errors[0].get("reason")

    return reason, message


def _pick_best_thumbnail_url(thumbnails: dict[str, Any]) -> str:
    """Pick the most appropriate thumbnail URL from snippet.thumbnails."""
    if not thumbnails or not isinstance(thumbnails, dict):
        return ""

    # Prefer the standard YouTube order from smallest->largest, pick the largest available.
    preferred = ["maxres", "standard", "high", "medium", "default"]
    for key in preferred:
        entry = thumbnails.get(key)
        if isinstance(entry, dict) and entry.get("url"):
            return str(entry["url"])

    # Fallback: pick any with the greatest width.
    best_url = ""
    best_w = -1
    for entry in thumbnails.values():
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        w = entry.get("width")
        if url and isinstance(w, int) and w > best_w:
            best_w = w
            best_url = str(url)
    if best_url:
        return best_url

    # Final fallback: first url found.
    for entry in thumbnails.values():
        if isinstance(entry, dict) and entry.get("url"):
            return str(entry["url"])

    return ""


class YouTubeDataService:
    """Service wrapper around the YouTube Data API v3 (videos.list)."""

    def __init__(self, api_key: Optional[str] = None):
        api_key = api_key or os.getenv("YOUTUBE_API_KEY")
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY environment variable not set")

        # cache_discovery=False avoids writing discovery docs to disk (important on serverless/readonly FS).
        self._client = build("youtube", "v3", developerKey=api_key, cache_discovery=False)

    def get_video_overview(self, video_id: str) -> dict[str, Any]:
        """Fetch a video's snippet + statistics and return a clean JSON-friendly dict.

        Returns:
            {
              "video_id": "...",
              "views": 123,
              "likes": 45,
              "comment_count": 6,
              "thumbnail_url": "https://..."
            }

        Raises:
            InvalidVideoIdError: invalid format or not found
            QuotaExceededError: quota/rate limit reached
            YouTubeApiError: other API errors
        """
        vid = _normalize_video_id(video_id)
        _validate_video_id(vid)

        try:
            resp = (
                self._client.videos()
                .list(part="snippet,statistics", id=vid, maxResults=1)
                .execute()
            )
        except HttpError as e:
            reason, message = _parse_http_error_reason(e)

            # Quota / rate limiting
            if reason in {"quotaExceeded", "dailyLimitExceeded", "userRateLimitExceeded", "rateLimitExceeded"}:
                raise QuotaExceededError(message or "YouTube API quota/rate limit exceeded") from e

            # Invalid ID / not found
            if e.resp is not None and getattr(e.resp, "status", None) in {400, 404}:
                raise InvalidVideoIdError(message or "Invalid video id or video not found") from e

            raise YouTubeApiError(message or f"YouTube API error ({getattr(e.resp, 'status', 'unknown')})") from e
        except Exception as e:
            raise YouTubeApiError(f"Unexpected error calling YouTube API: {e}") from e

        items = resp.get("items") if isinstance(resp, dict) else None
        if not items:
            raise InvalidVideoIdError("Video not found (no items returned)")

        item = items[0] if isinstance(items, list) else None
        if not isinstance(item, dict):
            raise YouTubeApiError("Unexpected YouTube API response format")

        stats = item.get("statistics") or {}
        snippet = item.get("snippet") or {}

        def _to_int(v: Any) -> Optional[int]:
            if v is None:
                return None
            try:
                return int(v)
            except Exception:
                return None

        overview = YouTubeVideoOverview(
            video_id=vid,
            title=str(snippet.get("title") or "").strip(),
            views=_to_int(stats.get("viewCount")) or 0,
            likes=_to_int(stats.get("likeCount")),
            comment_count=_to_int(stats.get("commentCount")),
            thumbnail_url=_pick_best_thumbnail_url(snippet.get("thumbnails") or {}) or "",
        )

        if not overview.thumbnail_url:
            # Not fatal for the main metrics, but usually indicates a malformed snippet.
            raise YouTubeApiError("Unable to determine thumbnail URL from API response")

        return overview.to_dict()
