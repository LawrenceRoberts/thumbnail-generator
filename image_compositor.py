"""
Image Composition Utilities
Handles background removal, photo compositing, and text overlay
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageOps
from rembg import remove, new_session
import io
from typing import Optional, Tuple
import logging
import os
import time

logger = logging.getLogger(__name__)


_REMBG_SESSION = None
_REMBG_MODEL = None


def _get_rembg_session():
    global _REMBG_SESSION, _REMBG_MODEL

    # Match original/default rembg behavior unless explicitly overridden.
    # (u2net is the rembg default model; users can set REMBG_MODEL if desired.)
    model = os.getenv("REMBG_MODEL", "u2net")
    providers_env = os.getenv("REMBG_PROVIDERS", "CPUExecutionProvider")
    providers = [p.strip() for p in providers_env.split(',') if p.strip()]
    if not providers:
        providers = ["CPUExecutionProvider"]

    if _REMBG_SESSION is None or _REMBG_MODEL != model:
        logger.info(f"Initializing rembg session with model: {model}")
        try:
            # Force CPU by default to avoid CUDA DLL issues on Windows.
            _REMBG_SESSION = new_session(model, providers=providers)
        except Exception as e:
            # Common failure: onnxruntime tries CUDA provider but CUDA/cuBLAS DLLs are not installed.
            logger.warning(f"rembg session init failed for providers={providers}: {e}; falling back to CPUExecutionProvider")
            _REMBG_SESSION = new_session(model, providers=["CPUExecutionProvider"])
        _REMBG_MODEL = model

    return _REMBG_SESSION


def remove_background(image: Image.Image, *, quality: str = "auto") -> Image.Image:
    """
    Remove background from an image using AI.
    Optimizes image quality before processing.
    
    Args:
        image: PIL Image with background
        
    Returns:
        PIL Image with transparent background (optimized)
    """
    # Keep signature for API compatibility.
    start_t = time.perf_counter()
    logger.info("Optimizing and removing background from image...")

    q = (quality or "auto").strip().lower()
    if q not in {"auto", "fast", "quality"}:
        q = "auto"

    # Respect EXIF orientation from phone photos
    image = ImageOps.exif_transpose(image)
    
    width, height = image.size

    # Performance: phone photos can be huge (e.g. 12MP+). Running rembg on full-res
    # can take minutes on a 1-CPU VM. Downscale in auto/fast to a reasonable size.
    if q in {"auto", "fast"}:
        max_side = max(width, height)
        if max_side > 1800:
            scale = 1800 / max_side
            new_width = max(1, int(width * scale))
            new_height = max(1, int(height * scale))
            logger.info(f"Downscaling image from {width}x{height} to {new_width}x{new_height} for faster cutout")
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            width, height = image.size

    # Quality: optionally upscale small images (but keep auto/fast conservative).
    min_dimension = 1500 if q == "quality" else 900
    if width < min_dimension or height < min_dimension:
        scale_factor = min_dimension / min(width, height)
        new_width = max(1, int(width * scale_factor))
        new_height = max(1, int(height * scale_factor))
        logger.info(f"Upscaling image from {width}x{height} to {new_width}x{new_height}")
        image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
    
    # Ensure a consistent mode for preprocessing
    if image.mode not in ('RGB', 'RGBA'):
        image = image.convert('RGB')

    # Light preprocessing: skip heavier enhancement in fast mode.
    if q != "fast":
        enhancer = ImageEnhance.Sharpness(image)
        image = enhancer.enhance(1.25 if q == "auto" else 1.3)

        enhancer = ImageEnhance.Contrast(image)
        image = enhancer.enhance(1.08 if q == "auto" else 1.1)
    
    # Convert to bytes for rembg
    img_byte_arr = io.BytesIO()
    image.save(img_byte_arr, format='PNG')
    img_bytes = img_byte_arr.getvalue()
    
    # Remove background, but still use a CPU-only session
    # to avoid CUDA DLL issues on Windows.
    # post_process_mask helps clean small artifacts around edges.
    session = _get_rembg_session()
    post_process_mask = (q == "quality")
    output_bytes = remove(img_bytes, session=session, post_process_mask=post_process_mask)

    # Convert back to PIL Image
    output_image = Image.open(io.BytesIO(output_bytes)).convert('RGBA')

    # Light alpha smoothing reduces tiny edge specks.
    alpha = output_image.getchannel('A')
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.4 if q == "fast" else 0.6))
    output_image.putalpha(alpha)
    
    elapsed_ms = int((time.perf_counter() - start_t) * 1000)
    logger.info(f"Background removed in {elapsed_ms}ms. Output mode: {output_image.mode}, size: {output_image.size}")
    return output_image


def warmup_background_removal() -> None:
    """Load the rembg model into memory so the first request is faster."""
    _get_rembg_session()


def composite_person_on_background(
    person_image: Image.Image,
    background_image: Image.Image,
    position: str = "center",
    scale: float = 0.75
) -> Image.Image:
    """
    Composite a cutout person onto a background image.
    
    Args:
        person_image: Person with transparent background
        background_image: AI-generated background
        position: Where to place person (center, left, right)
        scale: How large the person should be (0.0-1.0)
        
    Returns:
        Composited image
    """
    logger.info(f"Compositing person onto background. Position: {position}, Scale: {scale}")
    
    # Ensure background is RGB
    if background_image.mode != 'RGB':
        background_image = background_image.convert('RGB')
    
    # Ensure person has alpha channel
    if person_image.mode != 'RGBA':
        person_image = person_image.convert('RGBA')
    
    # Calculate scaled size for person
    bg_width, bg_height = background_image.size
    person_height = int(bg_height * scale)
    aspect_ratio = person_image.width / person_image.height
    person_width = int(person_height * aspect_ratio)
    
    # Resize person with high-quality resampling
    person_resized = person_image.resize((person_width, person_height), Image.Resampling.LANCZOS)
    
    # Apply slight sharpening after resize to maintain quality
    enhancer = ImageEnhance.Sharpness(person_resized)
    person_resized = enhancer.enhance(1.2)
    
    # Calculate position
    if position == "center":
        x = (bg_width - person_width) // 2
    elif position == "left":
        x = bg_width // 4 - person_width // 2
    elif position == "right":
        x = 3 * bg_width // 4 - person_width // 2
    else:
        x = (bg_width - person_width) // 2
    
    # Align person to bottom edge (no padding)
    y = bg_height - person_height
    
    # Create final composite
    result = background_image.copy()
    result.paste(person_resized, (x, y), person_resized)
    
    logger.info(f"Person composited at position ({x}, {y})")
    return result


def composite_people_on_background(
    people_images: list[Image.Image],
    background_image: Image.Image,
    scale: float = 0.75,
) -> Image.Image:
    """Composite multiple RGBA cutouts onto a single background.

    Places people side-by-side, bottom-aligned, and auto-scales to fit.
    """
    if not people_images:
        return background_image

    if len(people_images) == 1:
        return composite_person_on_background(people_images[0], background_image, position="center", scale=scale)

    logger.info(f"Compositing {len(people_images)} people onto background")

    # Ensure background is RGB
    if background_image.mode != 'RGB':
        background_image = background_image.convert('RGB')

    bg_width, bg_height = background_image.size

    # Heuristic: more people -> slightly smaller so they fit.
    n = len(people_images)
    if n == 2:
        height_frac = 0.65
    elif n == 3:
        height_frac = 0.55
    else:
        height_frac = 0.50

    target_height = int(bg_height * min(scale, height_frac))

    resized: list[Image.Image] = []
    for p in people_images:
        if p.mode != 'RGBA':
            p = p.convert('RGBA')

        pw, ph = p.size
        if ph <= 0:
            continue

        s = target_height / ph
        new_w = max(1, int(pw * s))
        new_h = max(1, int(ph * s))
        pr = p.resize((new_w, new_h), Image.Resampling.LANCZOS)
        enhancer = ImageEnhance.Sharpness(pr)
        pr = enhancer.enhance(1.1)
        resized.append(pr)

    if not resized:
        return background_image

    gap = max(20, int(bg_width * 0.02))
    total_w = sum(p.size[0] for p in resized) + gap * (len(resized) - 1)

    # If they still don't fit, uniformly shrink to fit within 92% of width.
    max_w = int(bg_width * 0.92)
    if total_w > max_w:
        shrink = (max_w - gap * (len(resized) - 1)) / max(1, sum(p.size[0] for p in resized))
        resized2: list[Image.Image] = []
        for p in resized:
            new_w = max(1, int(p.size[0] * shrink))
            new_h = max(1, int(p.size[1] * shrink))
            resized2.append(p.resize((new_w, new_h), Image.Resampling.LANCZOS))
        resized = resized2
        total_w = sum(p.size[0] for p in resized) + gap * (len(resized) - 1)

    x = (bg_width - total_w) // 2
    y_baseline = bg_height

    result = background_image.copy().convert('RGBA')
    for p in resized:
        pw, ph = p.size
        y = y_baseline - ph
        result.alpha_composite(p, (x, y))
        x += pw + gap

    return result.convert('RGB')


def add_text_overlay(
    image: Image.Image,
    text: str,
    position: Tuple[int, int] = None,
    font_size: int = 120,
    color: str = "white",
    stroke_color: str = "black",
    stroke_width: int = 10
) -> Image.Image:
    """
    Add high-quality text overlay to thumbnail with shadow effect.
    Auto-adjusts size to fit within boundaries and avoid person.
    
    Args:
        image: Base image
        text: Text to overlay
        position: (x, y) position. If None, auto-positions at top
        font_size: Initial size of text (will auto-adjust if needed)
        color: Text color
        stroke_color: Outline color
        stroke_width: Outline thickness
        
    Returns:
        Image with text overlay
    """
    logger.info(f"Adding text overlay: '{text}'")
    
    # Create a high-resolution copy for better text quality
    result = image.copy()
    
    # Use RGBA for better text rendering
    if result.mode != 'RGBA':
        result = result.convert('RGBA')
    
    # Create transparent overlay for text
    txt_layer = Image.new('RGBA', result.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(txt_layer)
    
    # Try to load a bold, high-quality font
    font = None
    font_paths = [
        "C:\\Windows\\Fonts\\impact.ttf",      # Impact - YouTube style
        "C:\\Windows\\Fonts\\arialbd.ttf",     # Arial Bold
        "C:\\Windows\\Fonts\\calibrib.ttf",    # Calibri Bold
        "arial.ttf"
    ]
    
    loaded_font_path = None
    for font_path in font_paths:
        try:
            font = ImageFont.truetype(font_path, font_size)
            loaded_font_path = font_path
            logger.info(f"Using font: {font_path}")
            break
        except:
            continue
    
    if font is None:
        logger.warning("No TrueType font found, using default")
        font = ImageFont.load_default()
    
    # Split text into uppercase for better YouTube style
    text = text.upper()
    
    # Calculate available space (top 25% of image, person takes bottom 75%)
    available_width = int(image.width * 0.95)  # 95% width for margins
    available_height = int(image.height * 0.20)  # Top 20% for text
    
    # Auto-adjust font size to fit within available space
    max_attempts = 20
    current_font_size = font_size
    
    for attempt in range(max_attempts):
        if loaded_font_path:
            font = ImageFont.truetype(loaded_font_path, current_font_size)
        
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        
        # Check if text fits within available space
        if text_width <= available_width and text_height <= available_height:
            break
        
        # Reduce font size by 5% and try again
        current_font_size = int(current_font_size * 0.95)
        
        if current_font_size < 30:  # Minimum readable size
            # Text is too long, try word wrapping
            logger.warning("Text too long for single line, attempting word wrap")
            break
    
    # Word wrap if still too long
    words = text.split()
    if text_width > available_width and len(words) > 1:
        # Try splitting into 2 lines
        mid = len(words) // 2
        line1 = ' '.join(words[:mid])
        line2 = ' '.join(words[mid:])
        
        # Check if 2 lines fit
        bbox1 = draw.textbbox((0, 0), line1, font=font)
        bbox2 = draw.textbbox((0, 0), line2, font=font)
        line1_width = bbox1[2] - bbox1[0]
        line2_width = bbox2[2] - bbox2[0]
        total_height = (bbox1[3] - bbox1[1]) + (bbox2[3] - bbox2[1]) + 10  # 10px gap
        
        max_line_width = max(line1_width, line2_width)
        
        if max_line_width <= available_width and total_height <= available_height:
            # Use 2 lines
            logger.info(f"Using 2 lines for text. Font size: {current_font_size}")
            
            # Calculate centered positions for both lines
            y_start = int(image.height * 0.05)
            x1 = (image.width - line1_width) // 2
            x2 = (image.width - line2_width) // 2
            y1 = y_start
            y2 = y_start + (bbox1[3] - bbox1[1]) + 10
            
            # Draw shadows for both lines
            shadow_offset = stroke_width // 2
            draw.text(
                (x1 + shadow_offset, y1 + shadow_offset),
                line1,
                font=font,
                fill=(0, 0, 0, 180),
                stroke_fill=(0, 0, 0, 180),
                stroke_width=stroke_width // 2
            )
            draw.text(
                (x2 + shadow_offset, y2 + shadow_offset),
                line2,
                font=font,
                fill=(0, 0, 0, 180),
                stroke_fill=(0, 0, 0, 180),
                stroke_width=stroke_width // 2
            )
            
            # Draw main text for both lines
            draw.text((x1, y1), line1, font=font, fill=color, stroke_fill=stroke_color, stroke_width=stroke_width)
            draw.text((x2, y2), line2, font=font, fill=color, stroke_fill=stroke_color, stroke_width=stroke_width)
            
            # Composite and return
            result = Image.alpha_composite(result, txt_layer)
            result = result.convert('RGB')
            logger.info(f"Text added as 2 lines")
            return result
    
    logger.info(f"Using single line. Final font size: {current_font_size}")
    
    # Calculate final text size and position for single line
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    
    if position is None:
        # Auto-position at top to avoid person at bottom
        x = (image.width - text_width) // 2
        y = int(image.height * 0.05)  # Higher up at 5% from top to avoid person
        position = (x, y)
    
    # Draw shadow first (offset slightly)
    shadow_offset = stroke_width // 2
    draw.text(
        (position[0] + shadow_offset, position[1] + shadow_offset),
        text,
        font=font,
        fill=(0, 0, 0, 180),  # Semi-transparent black shadow
        stroke_fill=(0, 0, 0, 180),
        stroke_width=stroke_width // 2
    )
    
    # Draw main text with thick outline
    draw.text(
        position,
        text,
        font=font,
        fill=color,
        stroke_fill=stroke_color,
        stroke_width=stroke_width
    )
    
    # Composite text layer onto image
    result = Image.alpha_composite(result, txt_layer)
    
    # Convert back to RGB
    result = result.convert('RGB')
    
    logger.info(f"Text added at position {position}")
    return result


def enhance_thumbnail(image: Image.Image) -> Image.Image:
    """
    Apply YouTube thumbnail enhancements (saturation, sharpness, contrast).
    
    Args:
        image: Base image
        
    Returns:
        Enhanced image
    """
    logger.info("Applying professional thumbnail enhancements...")
    
    # Increase saturation for vibrant colors
    enhancer = ImageEnhance.Color(image)
    image = enhancer.enhance(1.4)
    
    # Increase sharpness for crisp details
    enhancer = ImageEnhance.Sharpness(image)
    image = enhancer.enhance(1.6)
    
    # Increase contrast for pop
    enhancer = ImageEnhance.Contrast(image)
    image = enhancer.enhance(1.25)
    
    # Slight brightness boost
    enhancer = ImageEnhance.Brightness(image)
    image = enhancer.enhance(1.05)
    
    logger.info("High-quality enhancements applied")
    return image
