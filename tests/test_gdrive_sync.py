"""Unit tests for Google Drive campaign archive sync & search."""

from pathlib import Path
import sys
import tempfile
import unittest

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import gdrive_sync


SAMPLE_SUMMARIES_MD = """# **D&D Campaign Summaries: The B.U.G.S.**

## **Session 12: Bargains at Stonehill**

Date: May 26, 2025

Summary: **Gundren Rockseeker** thanked the party for clearing Cragmaw Hideout and introduced **Sildar Hallwinter**.

## **Session 68: Secrets Under Phandalin**

Date: Nov 5, 2026

Summary: **Gwen** connected the ZORD graffiti to **Zorzula's Rest** and revealed a duergar axe under the well.
"""


class GdriveSyncTests(unittest.TestCase):
    """Tests URL parsing, summary parsing, full-text search, and bundle portability."""

    def test_extract_drive_id(self):
        self.assertEqual(
            gdrive_sync.extract_drive_id(
                "https://drive.google.com/drive/folders/1tEt4H3yfD94K3ReX5UU-U1Pft0Enm4sU?usp=sharing"
            ),
            "1tEt4H3yfD94K3ReX5UU-U1Pft0Enm4sU",
        )
        self.assertEqual(
            gdrive_sync.extract_drive_id(
                "https://docs.google.com/document/d/1CScT1IcjnRzKs6oalSqXScjHIy0_BCZYR83TBjtl87k/edit"
            ),
            "1CScT1IcjnRzKs6oalSqXScjHIy0_BCZYR83TBjtl87k",
        )
        self.assertEqual(
            gdrive_sync.extract_drive_id("1eUp4_B6KOLWvwiivCXhly7jBYO9xKb6CbbqcBvxIs7Y"),
            "1eUp4_B6KOLWvwiivCXhly7jBYO9xKb6CbbqcBvxIs7Y",
        )

    def test_parse_summaries_search_and_bundle_roundtrip(self):
        parsed = gdrive_sync.parse_master_summaries_md(SAMPLE_SUMMARIES_MD)
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["sessionNumber"], 68)
        self.assertIn("Zorzula's Rest", parsed[0]["summary"])

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            orig_paths = (
                gdrive_sync.CACHE_DIR,
                gdrive_sync.TRANSCRIPTS_DIR,
                gdrive_sync.INDEX_FILE,
                gdrive_sync.SUMMARIES_MD_FILE,
                gdrive_sync.BACKSTORIES_TXT_FILE,
                gdrive_sync.CONFIG_FILE,
                gdrive_sync.TOKEN_FILE,
                gdrive_sync.OAUTH_CLIENT_FILE,
            )
            try:
                gdrive_sync.CACHE_DIR = tmp_path / "cache"
                gdrive_sync.TRANSCRIPTS_DIR = gdrive_sync.CACHE_DIR / "transcripts"
                gdrive_sync.INDEX_FILE = gdrive_sync.CACHE_DIR / "index.json"
                gdrive_sync.SUMMARIES_MD_FILE = gdrive_sync.CACHE_DIR / "summaries.md"
                gdrive_sync.BACKSTORIES_TXT_FILE = gdrive_sync.CACHE_DIR / "backstories.txt"
                gdrive_sync.CONFIG_FILE = tmp_path / "config.json"
                gdrive_sync.TOKEN_FILE = tmp_path / "token.json"
                gdrive_sync.OAUTH_CLIENT_FILE = tmp_path / "oauth.json"

                bundle_in = {
                    "version": 1,
                    "kind": "dnd-copilot-drive-archive",
                    "folderId": "folder1234567890",
                    "summariesMd": SAMPLE_SUMMARIES_MD,
                    "backstoriesTxt": "Gonloar swore an oath to Moradin after the mine collapse killed his kin.",
                    "transcripts": [
                        {
                            "id": "file69",
                            "name": "BUGS 69 11-12-2026.txt",
                            "text": "[Speaker 1]\nScrap warned us the glowing green boss at Zorzula's Rest fears only fire.\n",
                        }
                    ],
                }
                status = gdrive_sync.import_archive_bundle(bundle_in)
                self.assertEqual(status["cachedTranscriptCount"], 1)
                self.assertEqual(status["cachedSummaryCount"], 2)
                self.assertTrue(status["hasBackstories"])
                self.assertTrue(status["autoSyncEnabled"])
                self.assertEqual(status["autoSyncIntervalMinutes"], 10)

                mysteries = gdrive_sync.extract_campaign_mysteries()
                self.assertTrue(len(mysteries["openMysteries"]) >= 1)
                self.assertTrue(any("Zorzula" in m["excerpt"] for m in mysteries["openMysteries"]))

                listed = gdrive_sync.list_cached_transcripts()
                self.assertEqual(len(listed), 1)
                latest_tr = gdrive_sync.get_cached_transcript("latest")
                self.assertEqual(latest_tr["name"], "BUGS 69 11-12-2026.txt")
                self.assertIn("Scrap warned us", latest_tr["text"])

                res = gdrive_sync.search_campaign_archive("Who is the glowing green boss at Zorzula's Rest?")
                self.assertTrue(len(res["recentSummaries"]) >= 1)
                self.assertTrue(len(res["matchedSummaries"]) >= 1)
                self.assertTrue(len(res["matchedSnippets"]) >= 1)
                self.assertIn("Zorzula's Rest", res["contextText"])
                self.assertIn("BUGS 69", res["contextText"])

                exported = gdrive_sync.export_archive_bundle()
                self.assertEqual(len(exported["transcripts"]), 1)
                self.assertIn("Moradin", exported["backstoriesTxt"])
            finally:
                (
                    gdrive_sync.CACHE_DIR,
                    gdrive_sync.TRANSCRIPTS_DIR,
                    gdrive_sync.INDEX_FILE,
                    gdrive_sync.SUMMARIES_MD_FILE,
                    gdrive_sync.BACKSTORIES_TXT_FILE,
                    gdrive_sync.CONFIG_FILE,
                    gdrive_sync.TOKEN_FILE,
                    gdrive_sync.OAUTH_CLIENT_FILE,
                ) = orig_paths


if __name__ == "__main__":
    unittest.main()
