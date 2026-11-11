"""ChannelSpec.timeout is env-configurable (HARNESS2_CHANNEL_TIMEOUT).

Run-2's 4 agg composition sessions all died at the hardcoded 3600 s wall
mid-read, zero edits — the fix (from run-1's agg re-run) is a 7200 s wall
set by run policy through the env, not by editing code defaults.

Run: python -m unittest tests.test_channel_timeout
"""

from __future__ import annotations

import os
import unittest

from harness2.core.spec import ChannelSpec, resolve_channel_model


class ChannelTimeoutTest(unittest.TestCase):
    def test_default_timeout_is_3600(self):
        self.assertEqual(ChannelSpec("claude_local", "m").timeout, 3600)

    def test_env_sets_the_timeout(self):
        os.environ["HARNESS2_CHANNEL_TIMEOUT"] = "7200"
        try:
            self.assertEqual(ChannelSpec("claude_local", "m").timeout, 7200)
            # resolve_channel_model with no explicit timeout defers to the env default
            spec = resolve_channel_model("claude_local", "glm53/GLM-5.3")
            self.assertEqual(spec.timeout, 7200)
        finally:
            del os.environ["HARNESS2_CHANNEL_TIMEOUT"]
        self.assertEqual(ChannelSpec("claude_local", "m").timeout, 3600)

    def test_an_explicit_timeout_still_wins(self):
        os.environ["HARNESS2_CHANNEL_TIMEOUT"] = "7200"
        try:
            self.assertEqual(
                resolve_channel_model("claude_local", "glm53/GLM-5.3", timeout=1800).timeout,
                1800,
            )
        finally:
            del os.environ["HARNESS2_CHANNEL_TIMEOUT"]

    def test_a_bad_env_value_names_the_variable(self):
        os.environ["HARNESS2_CHANNEL_TIMEOUT"] = "two-hours"
        try:
            with self.assertRaises(Exception) as cm:
                ChannelSpec("claude_local", "m")
            self.assertIn("HARNESS2_CHANNEL_TIMEOUT", str(cm.exception))
        finally:
            del os.environ["HARNESS2_CHANNEL_TIMEOUT"]


if __name__ == "__main__":
    unittest.main()
