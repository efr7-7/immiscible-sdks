"""House style: no em or en dashes in anything this package says."""

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DASHES = ("\u2013", "\u2014")


class Style(unittest.TestCase):
    def test_no_em_or_en_dashes(self):
        offenders = []
        for p in ROOT.rglob("*"):
            if p.is_file() and p.suffix in {".py", ".md", ".toml", ".json"} and "__pycache__" not in p.parts:
                for i, line in enumerate(p.read_text("utf-8").splitlines(), 1):
                    if any(d in line for d in DASHES):
                        offenders.append(f"{p}:{i}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
