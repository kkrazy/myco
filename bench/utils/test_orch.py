#!/usr/bin/env python3
"""Regression tests for bench/utils/orch.py retry classification.

Guards the bug the user hit on the HLE run (2026-10-31, hle-20261031143030):
the n2 engine reports a DETERMINISTIC failure ("n2 stalled: no worker output
in 180000ms") behind an "HTTP 502:" prefix overnight, and the old _retryable()
matched the bare "502" substring and treated it as transient — so run.py
retried the stall up to N times, re-burning the full stall window each attempt
AND re-writing the same work/<stamp>/n2/<seq> worker dir from scratch
(transcript.txt / events-worker-*.jsonl / final_answer.txt). That's the
"keeps generating files in one path" symptom.

Run standalone (no pytest needed):  python3 -I test_orch.py

Behavior contract:
  - _retryable() is True  for transient upstream errors (502/503/reset/…).
  - _retryable() is False for deterministic engine failures (stall / timeout /
    team-fail / sdk-init), even when they carry an "HTTP 502:" prefix.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("orch", os.path.join(HERE, "orch.py"))
orch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(orch)

_CASES = [
    # (error, expected _retryable)
    # ── deterministic engine failures: MUST NOT be retried ──
    ("HTTP 502: n2 stalled: no worker output in 180000ms", False),
    ("HTTP 502: n2 stalled: no worker output in 300000ms", False),
    ("HTTP 502: n2 team failed", False),
    ("HTTP 502: model timeout after 120000ms", False),
    ("HTTP 502: model stalled: no assistant output in 120000ms", False),
    ("HTTP 502: sdk init failed: boom", False),
    ("HTTP 502: n2 timeout after 600000ms (worker output: yes)", False),
    # ── transient upstream errors: MUST be retried ──
    ("HTTP 502: connection reset", True),
    ("HTTP 503: service unavailable", True),
    ("HTTP 502: bad gateway", True),
    ("timed out reading response headers", True),
    # ── no error / unknown: not retried ──
    ("", False),
    (None, False),
]


def main():
    failures = 0
    for err, want in _CASES:
        got = orch._retryable(err)
        det = orch._deterministic(err)
        status = "ok " if got == want else "FAIL"
        if got != want:
            failures += 1
        print(f"  [{status}] retryable={got!s:5} deterministic={det!s:5}  {str(err or '')[:70]}")
    print()
    if failures:
        print(f"FAILED: {failures}/{len(_CASES)} cases wrong")
        return 1
    print(f"PASS: all {len(_CASES)} cases correct")
    return 0


if __name__ == "__main__":
    sys.exit(main())
