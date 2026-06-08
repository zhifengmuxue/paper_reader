from __future__ import annotations

import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"
ICON_PNG = BUILD / "brand-icon-1024.png"
ICON_ICNS = BUILD / "icon.icns"

SIZES = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}


def hex_color(value: str) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4)) + (255,)


def rounded_rect(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], radius: float, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    padding = size * 0.08
    box = (padding, padding, size - padding, size - padding)
    radius = size * 0.23

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    rounded_rect(
        shadow_draw,
        (box[0], box[1] + size * 0.03, box[2], box[3] + size * 0.03),
        radius,
        (62, 31, 8, 78),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=size * 0.045))
    image.alpha_composite(shadow)

    panel = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    panel_draw = ImageDraw.Draw(panel)
    rounded_rect(panel_draw, box, radius, hex_color("#F7E8CF"))
    panel = panel.filter(ImageFilter.GaussianBlur(radius=size * 0.001))
    image.alpha_composite(panel)

    glaze = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glaze_draw = ImageDraw.Draw(glaze)
    glaze_draw.rounded_rectangle(
        box,
        radius=radius,
        fill=(0, 0, 0, 0),
        outline=(255, 250, 244, 180),
        width=max(1, int(size * 0.012)),
    )
    image.alpha_composite(glaze)

    ribbon_box = (
        box[0] + size * 0.11,
        box[1] + size * 0.12,
        box[0] + size * 0.28,
        box[3] - size * 0.14,
    )
    rounded_rect(draw, ribbon_box, radius=size * 0.05, fill=hex_color("#8F4E2B"))

    page_box = (
        box[0] + size * 0.2,
        box[1] + size * 0.16,
        box[2] - size * 0.15,
        box[3] - size * 0.18,
    )
    rounded_rect(draw, page_box, radius=size * 0.06, fill=hex_color("#FFFDF9"))

    fold = [
        (page_box[2] - size * 0.14, page_box[1]),
        (page_box[2], page_box[1] + size * 0.14),
        (page_box[2], page_box[1]),
    ]
    draw.polygon(fold, fill=hex_color("#E8D3B4"))
    draw.line(
        [fold[0], fold[1], (page_box[2] - size * 0.14, page_box[1] + size * 0.14)],
        fill=(205, 182, 148, 255),
        width=max(1, int(size * 0.008)),
    )

    text_left = page_box[0] + size * 0.06
    text_right = page_box[2] - size * 0.1
    y = page_box[1] + size * 0.12
    line_gap = size * 0.075
    colors = [(174, 146, 113, 255), (177, 147, 111, 255), (190, 159, 124, 255)]
    lengths = [0.82, 0.76, 0.7, 0.78, 0.64]
    for index, factor in enumerate(lengths):
      draw.rounded_rectangle(
          (
              text_left,
              y + index * line_gap,
              text_left + (text_right - text_left) * factor,
              y + index * line_gap + size * 0.024,
          ),
          radius=size * 0.012,
          fill=colors[index % len(colors)],
      )

    lens_center = (box[2] - size * 0.2, box[3] - size * 0.22)
    lens_r = size * 0.14
    lens_bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    lens_draw = ImageDraw.Draw(lens_bg)
    lens_draw.ellipse(
        (
            lens_center[0] - lens_r,
            lens_center[1] - lens_r,
            lens_center[0] + lens_r,
            lens_center[1] + lens_r,
        ),
        fill=(190, 225, 236, 120),
        outline=(58, 74, 83, 255),
        width=max(1, int(size * 0.018)),
    )
    image.alpha_composite(lens_bg)

    highlight = [
        (lens_center[0] - lens_r * 0.35, lens_center[1] - lens_r * 0.45),
        (lens_center[0] + lens_r * 0.1, lens_center[1] - lens_r * 0.18),
    ]
    draw.line(highlight, fill=(255, 255, 255, 180), width=max(1, int(size * 0.016)))

    handle_start = (lens_center[0] + lens_r * 0.58, lens_center[1] + lens_r * 0.58)
    handle_end = (handle_start[0] + size * 0.11, handle_start[1] + size * 0.11)
    draw.line(
        [handle_start, handle_end],
        fill=(70, 43, 24, 255),
        width=max(2, int(size * 0.04)),
        joint="curve",
    )

    return image


def run() -> None:
    BUILD.mkdir(exist_ok=True)
    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir(parents=True, exist_ok=True)

    base = make_icon(1024)
    base.save(ICON_PNG)

    for name, size in SIZES.items():
        resized = base.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(ICONSET / name)

    base.save(ICON_ICNS, format="ICNS")


if __name__ == "__main__":
    run()
