"""Build in-memory 2x3 montages for batched vision checks."""
from __future__ import annotations

import io
import math
from dataclasses import dataclass


MONTAGE_SIZE = (2000, 2000)
MAX_SLOTS = 6
MONTAGE_COLUMNS = math.ceil(math.sqrt(MAX_SLOTS))
MONTAGE_ROWS = math.ceil(MAX_SLOTS / MONTAGE_COLUMNS)
SLOT_LABEL_HEIGHT = 48
SLOT_LABEL_FONT_SIZE = 28


class MontageUnavailable(RuntimeError):
    """A source image could not be decoded or Pillow is unavailable."""


@dataclass(frozen=True)
class MontageSlot:
    slot: int
    field: str
    width: int
    height: int


@dataclass(frozen=True)
class MontageTask:
    image: bytes
    slots: tuple[MontageSlot, ...]


def _slot_bounds(slot: int) -> tuple[int, int, int, int]:
    """Return this slot's bounds from the canvas and capacity, not fixed pixels."""
    index = slot - 1
    row, column = divmod(index, MONTAGE_COLUMNS)
    left = round(column * MONTAGE_SIZE[0] / MONTAGE_COLUMNS)
    right = round((column + 1) * MONTAGE_SIZE[0] / MONTAGE_COLUMNS)
    top = round(row * MONTAGE_SIZE[1] / MONTAGE_ROWS)
    bottom = round((row + 1) * MONTAGE_SIZE[1] / MONTAGE_ROWS)
    return left, top, right, bottom


def _fit_image(data: bytes, bounds: tuple[int, int, int, int]):
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise MontageUnavailable("Pillow 未安装，无法生成视觉检测拼图") from exc
    try:
        with Image.open(io.BytesIO(data)) as source:
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGBA")
            width, height = image.size
            left, top, right, bottom = bounds
            scale = min((right - left) / width, (bottom - top) / height)
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
            image = image.resize(size, Image.Resampling.LANCZOS)
            return image, width, height
    except Exception as exc:  # noqa: BLE001 - fail closed for inspection
        raise MontageUnavailable(f"图片无法解码，无法生成视觉检测拼图: {type(exc).__name__}: {exc}") from exc


def build_montages(images: list[tuple[bytes, str]]) -> list[MontageTask]:
    """Pack source images into white 2000x2000 JPEGs without cropping."""
    if not images:
        return []
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise MontageUnavailable("Pillow 未安装，无法生成视觉检测拼图") from exc

    tasks: list[MontageTask] = []
    for start in range(0, len(images), MAX_SLOTS):
        canvas = Image.new("RGB", MONTAGE_SIZE, "white")
        slots: list[MontageSlot] = []
        for offset, (data, field) in enumerate(images[start:start + MAX_SLOTS]):
            slot = offset + 1
            left, top, right, bottom = _slot_bounds(slot)
            image_bounds = (left, top + SLOT_LABEL_HEIGHT, right, bottom)
            fitted, width, height = _fit_image(data, image_bounds)
            x = left + (right - left - fitted.width) // 2
            y = top + SLOT_LABEL_HEIGHT + (bottom - top - SLOT_LABEL_HEIGHT - fitted.height) // 2
            canvas.paste(fitted, (x, y), fitted)
            # Give the vision model an unambiguous visual key for its JSON slot.
            # Reserve a label band instead of painting over source pixels.
            draw = ImageDraw.Draw(canvas)
            font = ImageFont.load_default(size=SLOT_LABEL_FONT_SIZE)
            draw.rectangle((left, top, right - 1, top + SLOT_LABEL_HEIGHT - 1),
                           fill="white", outline="black", width=2)
            draw.text((left + 18, top + 8), f"SLOT {slot}", fill="black", font=font)
            slots.append(MontageSlot(slot, field, width, height))
        output = io.BytesIO()
        canvas.save(output, format="JPEG", quality=90, optimize=True)
        tasks.append(MontageTask(output.getvalue(), tuple(slots)))
    return tasks
