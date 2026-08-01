#!/usr/bin/env python3
"""Generate Benaiah Desktop icons from the production Benaiah mark."""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont


DESKTOP_ROOT = Path(__file__).resolve().parents[1]
ASSETS = DESKTOP_ROOT / "assets"
PUBLIC = DESKTOP_ROOT / "public"
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
APP_ICON_SCALE = 0.80


def mark(size: int) -> Image.Image:
    scale = size / 1024
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=round(224 * scale),
        fill="#000000",
    )

    font = ImageFont.truetype(FONT, round(604 * scale))
    mask_size = size * 2
    glyph_mask = Image.new("L", (mask_size, mask_size), 0)
    glyph_draw = ImageDraw.Draw(glyph_mask)
    glyph_draw.text(
        (mask_size // 2, mask_size // 2),
        "B",
        font=font,
        fill=255,
        anchor="mm",
    )
    glyph_bounds = glyph_mask.getbbox()
    if glyph_bounds:
        glyph = glyph_mask.crop(glyph_bounds)
        image.paste(
            (255, 255, 255, 255),
            ((size - glyph.width) // 2, (size - glyph.height) // 2),
            glyph,
        )

    return image


def app_icon(size: int) -> Image.Image:
    """Inset the mark so OS launchers give it the same optical weight as peers."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mark_size = max(1, round(size * APP_ICON_SCALE))
    inset = (size - mark_size) // 2
    image.alpha_composite(mark(mark_size), (inset, inset))
    return image


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    master = app_icon(1024)
    master.save(ASSETS / "icon.png", optimize=True)
    mark(1024).save(PUBLIC / "apple-touch-icon.png", optimize=True)
    mark(1024).save(PUBLIC / "benaiah-mark.png", optimize=True)
    app_icon(256).save(
        ASSETS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for points in (16, 32, 128, 256, 512):
            app_icon(points).save(iconset / f"icon_{points}x{points}.png", optimize=True)
            app_icon(points * 2).save(iconset / f"icon_{points}x{points}@2x.png", optimize=True)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "icon.icns")],
            check=True,
        )


if __name__ == "__main__":
    main()
