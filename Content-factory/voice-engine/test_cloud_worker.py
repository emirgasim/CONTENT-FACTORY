"""Regression checks for the cloud worker's startup dependencies."""
import ast
import unittest
from pathlib import Path


WORKER = Path(__file__).with_name("cloud_worker.py")


class CloudWorkerRegressionTests(unittest.TestCase):
    def test_worker_imports_re_used_by_scene_research(self):
        tree = ast.parse(WORKER.read_text(encoding="utf-8"))
        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertIn("re", imported, "cloud_worker.py calls re.sub but must import re")

    def test_worker_contains_research_and_render_phases(self):
        source = WORKER.read_text(encoding="utf-8")
        self.assertIn("def prepare_review(", source)
        self.assertIn("def render(", source)
        self.assertIn('if phase=="research":', source)
        self.assertIn('if phase!="render":', source)


if __name__ == "__main__":
    unittest.main()
