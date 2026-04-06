"""
YouTube Thumbnail Generator Service
Combines user prompts with professional CTR optimization rules
and generates high-impact 1280x720 thumbnails using Stability AI.
"""

import os
from dotenv import load_dotenv
import httpx
from typing import Optional, Dict, Any
from fastapi import HTTPException
from stability_sdk import client
import stability_sdk.interfaces.gooseai.generation.generation_pb2 as generation
from datetime import datetime
import logging
from PIL import Image
from io import BytesIO
import time

# Load environment variables from .env file
load_dotenv()

logger = logging.getLogger(__name__)

# Stability AI configuration
STABILITY_HOST = os.getenv('STABILITY_HOST', 'grpc.stability.ai:443')
STABILITY_KEY = os.getenv('STABILITY_API_KEY')

# ZAR currency conversion API (example: exchangerate-api.com)
CURRENCY_API_URL = "https://api.exchangerate-api.com/v4/latest/USD"


class ThumbnailGenerator:
    """Professional YouTube Thumbnail Generator with CTR optimization"""
    
    # System-level design rules embedded in prompts
    SYSTEM_LOGIC = """
Professional Thumbnail Style Guidelines:
- Maintain the requested aspect ratio and resolution
- Apply Rule of Thirds composition: subject positioned left or right third
- High contrast rim lighting around main subject
- Use complementary color schemes (orange vs blue, purple vs yellow)
- Apply Gaussian blur to background (subject stays sharp)
- High color saturation for maximum visual impact
- If person present: EXAGGERATED facial expression (shocked/excited/intense like MrBeast style)
- Clean composition, readable on mobile screens
- Dramatic, eye-catching, professional studio quality
- No clutter, clear focal point
"""

    # Negative prompt to exclude unwanted elements
    NEGATIVE_PROMPT = """
multiple heads, two heads, extra heads, blurry face, blurred face, blurry faces, 
low resolution, low quality, pixelated, grainy, messy text, illegible text, 
distorted text, bad typography, small details, tiny objects, cluttered, 
dark colors, muddy colors, desaturated, washed out colors, dim lighting, 
4:3 aspect ratio, square format, vertical format, portrait orientation, 
deformed, disfigured, bad anatomy, extra limbs, amateur, unprofessional
"""

    def __init__(self):
        if not STABILITY_KEY:
            raise ValueError("STABILITY_API_KEY environment variable not set")
        
        self.stability_api = client.StabilityInference(
            key=STABILITY_KEY,
            verbose=True,
            engine="stable-diffusion-xl-1024-v1-0"  # Use SDXL for best quality
        )
        self.zar_exchange_rate: Optional[float] = None
        self._zar_last_updated: Optional[float] = None
    
    async def get_zar_exchange_rate(self) -> float:
        """
        Fetch current USD to ZAR exchange rate.
        Used for cost tracking in ZAR currency.
        """
        try:
            # Cache exchange rate to avoid adding latency to every generation.
            ttl_seconds = int(os.getenv("ZAR_RATE_TTL_SECONDS", "3600"))
            now = time.time()
            if self.zar_exchange_rate is not None and self._zar_last_updated and (now - self._zar_last_updated) < ttl_seconds:
                return self.zar_exchange_rate

            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(CURRENCY_API_URL)
                response.raise_for_status()
                data = response.json()
                
                if 'rates' in data and 'ZAR' in data['rates']:
                    self.zar_exchange_rate = data['rates']['ZAR']
                    self._zar_last_updated = time.time()
                    logger.info(f"Updated ZAR exchange rate: {self.zar_exchange_rate}")
                    return self.zar_exchange_rate
                else:
                    raise ValueError("ZAR rate not found in API response")
                    
        except httpx.HTTPError as e:
            logger.error(f"HTTP error fetching ZAR rate: {e}")
            # Fallback to approximate rate if API fails
            self.zar_exchange_rate = 18.5  # Approximate fallback
            self._zar_last_updated = time.time()
            return self.zar_exchange_rate
        except Exception as e:
            logger.error(f"Unexpected error fetching ZAR rate: {e}")
            self.zar_exchange_rate = 18.5  # Approximate fallback
            self._zar_last_updated = time.time()
            return self.zar_exchange_rate
    
    def calculate_cost_in_zar(self, usd_cost: float) -> Dict[str, float]:
        """
        Convert USD cost to ZAR for tracking.
        
        Args:
            usd_cost: Cost in USD
            
        Returns:
            Dictionary with USD and ZAR costs
        """
        if not self.zar_exchange_rate:
            logger.warning("ZAR exchange rate not set, using fallback")
            self.zar_exchange_rate = 18.5
        
        zar_cost = usd_cost * self.zar_exchange_rate
        
        return {
            "usd": round(usd_cost, 4),
            "zar": round(zar_cost, 2),
            "exchange_rate": self.zar_exchange_rate,
            "timestamp": datetime.utcnow().isoformat()
        }
    
    def build_enhanced_prompt(self, simple_prompt: str, *, width: int, height: int) -> str:
        """
        Combine user's simple prompt with professional thumbnail design rules.
        
        Args:
            simple_prompt: User's basic description (e.g., "shocked gamer reacting")
            
        Returns:
            Enhanced prompt optimized for thumbnail generation
        """
        # Aspect guidance matters a lot. The SDXL engine will happily generate portrait
        # if we ask for it, but we must not contradict it in the prompt.
        aspect_hint = "requested aspect ratio"
        if width > 0 and height > 0:
            r = width / height
            if abs(r - (16 / 9)) < 0.03:
                aspect_hint = "16:9 landscape (YouTube thumbnail)"
            elif abs(r - (9 / 16)) < 0.03:
                aspect_hint = "9:16 portrait (vertical, YouTube Shorts style)"

        enhanced = (
            f"{simple_prompt}, professional thumbnail style, {aspect_hint}, "
            "professional studio lighting, high contrast rim lighting, vibrant complementary colors, "
            "rule of thirds composition, sharp focus on subject, blurred background, dramatic and eye-catching, "
            "mobile-friendly, clean composition"
        )
        return enhanced.strip()
    
    async def generate_thumbnail(
        self,
        simple_prompt: str,
        width: int = 1280,
        height: int = 720,
        cfg_scale: float = 8.0,
        steps: int = 40,
        samples: int = 1,
        track_cost: bool = True,
        init_image: Optional[Image.Image] = None
    ) -> Dict[str, Any]:
        """
        Generate a YouTube thumbnail from a simple user prompt.
        Optionally uses a reference image for image-to-image generation.
        
        Args:
            simple_prompt: User's basic description
            width: Image width (default 1280)
            height: Image height (default 720)
            cfg_scale: Guidance scale for prompt adherence
            steps: Number of diffusion steps (higher = better quality)
            samples: Number of images to generate
            track_cost: Whether to track costs in ZAR
            init_image: Optional PIL Image for image-to-image generation
            
        Returns:
            Dictionary containing image data, metadata, and cost tracking
            
        Raises:
            HTTPException: If generation fails
        """
        try:
            t0 = time.perf_counter()
            # Update ZAR exchange rate if cost tracking enabled
            if track_cost:
                await self.get_zar_exchange_rate()
            
            # Build the enhanced prompt
            enhanced_prompt = self.build_enhanced_prompt(simple_prompt, width=width, height=height)
            
            logger.info(f"Generating thumbnail with prompt: {simple_prompt}")
            logger.debug(f"Enhanced prompt: {enhanced_prompt}")
            
            # Generate image using Stability AI
            # Note: stability-sdk includes negative prompt guidance in the main prompt.
            # Avoid listing aspect ratios/orientations that contradict the requested output.
            avoid_bits = [
                "multiple heads",
                "blurry faces",
                "low quality",
                "messy text",
                "small details",
                "dark muddy colors",
                "4:3 aspect ratio",
                "square format",
            ]
            if width > height:
                avoid_bits += ["vertical format", "portrait orientation", "9:16 aspect ratio"]
            elif height > width:
                avoid_bits += ["horizontal format", "landscape orientation", "16:9 aspect ratio"]

            full_prompt = f"{enhanced_prompt}. Avoid: {', '.join(avoid_bits)}"
            
            # SDXL engine is optimized for ~1024px sizes; generating larger directly can be slower.
            # Generate at an SDXL-friendly size and upscale to the requested output size.
            gen_width, gen_height = width, height
            if width == 1280 and height == 720:
                gen_width, gen_height = 1024, 576
            elif width == 720 and height == 1280:
                gen_width, gen_height = 576, 1024

            # Prepare generation parameters
            gen_params = {
                "prompt": full_prompt,
                "width": gen_width,
                "height": gen_height,
                "cfg_scale": cfg_scale,
                "steps": steps,
                "samples": samples,
                "sampler": generation.SAMPLER_K_DPMPP_2M
            }
            
            # Add init_image for image-to-image generation if provided
            if init_image:
                logger.info("Using reference image for image-to-image generation")
                gen_params["init_image"] = init_image  # Pass PIL Image directly
                gen_params["start_schedule"] = 0.6  # How much to modify the init image (0-1)
            
            answers = self.stability_api.generate(**gen_params)
            
            # Process results
            results = []
            for resp in answers:
                for artifact in resp.artifacts:
                    if artifact.finish_reason == generation.FILTER:
                        logger.warning("Content filter triggered - prompt may be inappropriate")
                        raise HTTPException(
                            status_code=400,
                            detail="Content filtered. Please modify your prompt."
                        )
                    
                    if artifact.type == generation.ARTIFACT_IMAGE:
                        img_bytes = artifact.binary

                        # Upscale to requested output size if we generated smaller.
                        if (gen_width, gen_height) != (width, height):
                            try:
                                img = Image.open(BytesIO(img_bytes))
                                if img.mode not in ("RGB", "RGBA"):
                                    img = img.convert("RGB")
                                img = img.resize((width, height), Image.Resampling.LANCZOS)
                                buf = BytesIO()
                                img.save(buf, format="PNG")
                                img_bytes = buf.getvalue()
                            except Exception as e:
                                logger.warning(f"Upscale failed, returning original size: {e}")

                        results.append({
                            "image_data": img_bytes,
                            "seed": artifact.seed,
                            "finish_reason": artifact.finish_reason
                        })
            
            if not results:
                raise HTTPException(
                    status_code=500,
                    detail="No images generated. Please try again."
                )
            
            # Estimate cost (Stability AI SDXL pricing: ~$0.04 per image at 40 steps)
            estimated_usd_cost = 0.04 * samples
            cost_tracking = None
            
            if track_cost:
                try:
                    cost_tracking = self.calculate_cost_in_zar(estimated_usd_cost)
                except Exception as e:
                    logger.error(f"Cost tracking error: {e}")
                    # Don't fail the request if cost tracking fails
                    cost_tracking = {
                        "error": str(e),
                        "note": "Cost tracking failed but image generated successfully"
                    }
            
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            logger.info(
                f"Stability generation complete in {elapsed_ms}ms (generated {gen_width}x{gen_height}, returned {width}x{height}, steps={steps}, samples={samples})"
            )

            return {
                "success": True,
                "images": results,
                "metadata": {
                    "original_prompt": simple_prompt,
                    "enhanced_prompt": enhanced_prompt,
                    "width": width,
                    "height": height,
                    "cfg_scale": cfg_scale,
                    "steps": steps,
                    "samples": samples,
                    "generated_at": datetime.utcnow().isoformat()
                },
                "cost_tracking": cost_tracking
            }
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Thumbnail generation failed: {e}", exc_info=True)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to generate thumbnail: {str(e)}"
            )


# Example usage function
async def generate_youtube_thumbnail(simple_prompt: str) -> Dict[str, Any]:
    """
    Convenience function to generate a thumbnail with default settings.
    
    Args:
        simple_prompt: Simple user description
        
    Returns:
        Generated thumbnail data with cost tracking
    """
    generator = ThumbnailGenerator()
    return await generator.generate_thumbnail(
        simple_prompt=simple_prompt,
        track_cost=True
    )
