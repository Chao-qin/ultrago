import io
import unittest

from PIL import Image

from vision_montage import (MONTAGE_COLUMNS, MONTAGE_ROWS, SLOT_LABEL_HEIGHT,
                             _slot_bounds, build_montages)


def jpeg(size, color):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "JPEG")
    return out.getvalue()


class MontageTests(unittest.TestCase):
    def test_slot_label_has_readable_ink_height(self):
        task = build_montages([(jpeg((200, 200), 'white'), '/images/main/0')])[0]
        with Image.open(io.BytesIO(task.image)) as image:
            label = image.crop((18, 8, 180, SLOT_LABEL_HEIGHT - 4)).convert('L')
            ink = label.point(lambda value: 255 if value < 100 else 0)
            bounds = ink.getbbox()
            self.assertIsNotNone(bounds)
            self.assertGreaterEqual(bounds[3] - bounds[1], 18)

    def test_packs_six_images_into_fixed_canvas_and_preserves_slots(self):
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255),
                  (255, 255, 0), (255, 0, 255), (0, 255, 255)]
        images = [(jpeg((1600, 400), color), f"/images/main/{i}")
                  for i, color in enumerate(colors)]
        task = build_montages(images)[0]
        self.assertEqual(len(task.slots), 6)
        self.assertEqual([slot.slot for slot in task.slots], [1, 2, 3, 4, 5, 6])
        with Image.open(io.BytesIO(task.image)) as image:
            self.assertEqual(image.size, (2000, 2000))
            self.assertEqual(image.mode, "RGB")
            # Each coloured source must be visible in its dynamically-derived cell.
            for slot, color in enumerate(colors, start=1):
                left, top, right, bottom = _slot_bounds(slot)
                pixel = image.getpixel(((left + right) // 2, (top + bottom) // 2))
                if not isinstance(pixel, tuple):
                    self.fail(f"expected RGB tuple, got {pixel!r}")
                self.assertTrue(all(abs(actual - expected) <= 2
                                    for actual, expected in zip(pixel, color)))
                label_pixel = image.getpixel((left + 4, top + 4))
                if not isinstance(label_pixel, tuple):
                    self.fail(f"expected RGB tuple, got {label_pixel!r}")
                self.assertTrue(all(channel >= 252 for channel in label_pixel))

    def test_slot_bounds_cover_canvas_with_three_columns_and_two_rows(self):
        self.assertEqual((MONTAGE_COLUMNS, MONTAGE_ROWS), (3, 2))
        self.assertEqual(_slot_bounds(1), (0, 0, 667, 1000))
        self.assertEqual(_slot_bounds(3), (1333, 0, 2000, 1000))
        self.assertEqual(_slot_bounds(4), (0, 1000, 667, 2000))
        self.assertEqual(_slot_bounds(6), (1333, 1000, 2000, 2000))

    def test_last_batch_has_remaining_slots_and_padding_is_white(self):
        task = build_montages([
            (jpeg((400, 1600), (0, 0, 255)), "/images/detail/0"),
            (jpeg((800, 800), (0, 255, 0)), "/images/detail/1"),
            (jpeg((800, 800), (255, 0, 0)), "/images/detail/2"),
            (jpeg((800, 800), (255, 255, 0)), "/images/detail/3"),
            (jpeg((800, 800), (0, 255, 255)), "/images/detail/4"),
            (jpeg((800, 800), (255, 0, 255)), "/images/detail/5"),
            (jpeg((800, 800), (10, 10, 10)), "/images/detail/6"),
        ])[1]
        self.assertEqual(len(task.slots), 1)
        with Image.open(io.BytesIO(task.image)) as image:
            self.assertEqual(image.getpixel((1500, 1000)), (255, 255, 255))


if __name__ == "__main__":
    unittest.main()
