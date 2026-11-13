import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gateway


class FakeResponse:
    def __init__(self, payload: bytes, content_type: str = "application/octet-stream"):
        self.payload = payload
        self.headers = {"Content-Type": content_type}

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size: int):
        for offset in range(0, len(self.payload), chunk_size):
            yield self.payload[offset:offset + chunk_size]


class VisualFallbackTests(unittest.TestCase):
    def test_generated_visual_fallback_is_created_for_the_scene(self):
        with tempfile.TemporaryDirectory() as directory:
            path, metadata = gateway.create_fallback_visual_asset(
                "Rocky Balboa ve köpeği Butkus", Path(directory), 1
            )
            self.assertTrue(path.is_file())
            with Image.open(path) as image:
                self.assertEqual(image.size, (1000, 1200))
                self.assertEqual(image.format, "JPEG")
            self.assertEqual(metadata["source"], "Generated scene visual fallback")
            self.assertIn("Rocky", metadata["title"])

    def test_download_normalizes_valid_image_with_generic_mime_type(self):
        buffer = io.BytesIO()
        Image.new("RGB", (800, 600), "#365A88").save(buffer, format="PNG")
        response = FakeResponse(buffer.getvalue(), "application/octet-stream")
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(gateway.requests, "get", return_value=response):
                result = gateway.download_image_asset(
                    {"url": "https://example.test/image", "source": "test"},
                    Path(directory),
                    1,
                )
            self.assertIsNotNone(result)
            with Image.open(result) as image:
                self.assertEqual(image.format, "JPEG")
                self.assertEqual(image.size, (800, 600))


if __name__ == "__main__":
    unittest.main()
