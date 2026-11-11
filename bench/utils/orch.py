# utils/orch.py — shared orchestration helpers for the benchmark harnesses
# (bench/hle/run.py and bench/tb4/run.py): HTTP client with retry/backoff,
# live progress status, incremental (resumable) results.jsonl saving, and a few
# pure text/id-parse helpers.
#
# Extracted verbatim (behavior-neutral) from bench/hle/run.py. Each bench has
# its own run.py process, so the module-level `_results_path` never collides.
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request


# ── HTTP helpers ─────────────────────────────────────────────────────────────
def http_post(url, payload, timeout):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


_RETRYABLE = ('502', 'bad gateway', '503', 'service unavailable', 'connection reset',
              'timed out', 'timeout')

# Deterministic failures that must NOT be retried, even though the engine
# reports them with an "HTTP 502:" prefix (run.py/server.js map every engine
# error to 502, so the bare "502" token would otherwise make them look like
# transient upstream hiccups worth retrying).
#
# These mean the engine ALREADY burned its full stall/timeout budget and the
# exact same condition will reproduce on retry — e.g. an n2 team that produced
# no worker output in its whole stall window, or a single-agent call that timed
# out / stalled. Retrying only re-burns the budget AND re-writes the same
# worker workdir (n2/<seq>) from scratch (transcript.txt / events-*.jsonl /
# final_answer.txt), which is how a run that should have failed fast instead
# keeps generating files in one path for minutes. Match on the engine's own
# stable error wording, which is more precise than the HTTP-status prefix.
_ENGINE_DETERMINISTIC = ('no worker output', 'model timeout', 'model stalled',
                         'no assistant output', 'sdk init failed', 'n2 timeout',
                         'n2 team failed')


def _deterministic(err):
    """True when `err` is a deterministic engine failure (not worth retrying).

    A deterministic failure is one the engine reached after spending its full
    time/stall budget — the same inputs under the same conditions will fail
    again. Retrying a deterministic failure is pure waste and re-burns the burn
    budget; callers should treat it as final and move on.
    """
    e = str(err or '').lower()
    return any(k in e for k in _ENGINE_DETERMINISTIC)


def _retryable(err):
    # First exclude deterministic engine failures (stall / timeout / team-fail).
    # These carry an "HTTP 502:" prefix but are NOT transient — retrying them
    # only re-runs the full stall window and re-writes the same worker dirs.
    if _deterministic(err):
        return False
    e = str(err or '').lower()
    return any(k in e for k in _RETRYABLE)


def _sleep_backoff(attempt, base=3.0, cap=60.0, jitter=1.5):
    """Exponential backoff + jitter between retries. `attempt` is 0-based."""
    delay = min((base * (2 ** attempt)) + random.uniform(0, jitter), cap)
    time.sleep(delay)


# ── live progress ────────────────────────────────────────────────────────────
class Progress:
    def __init__(self, total):
        self.lock = threading.Lock()
        self.total = total
        self.t0 = time.time()
        self.answer_done = {'single': 0, 'n2': 0}
        self.judge_done = {'single': 0, 'n2': 0}
        self.correct = {'single': 0, 'n2': 0}   # by the opposite engine / verifier
        self.failed = {'single': 0, 'n2': 0}
        self._last = ''

    def tick_answer(self, mode, ok):
        with self.lock:
            self.answer_done[mode] += 1
            if not ok:
                self.failed[mode] += 1

    def tick_judge(self, mode, correct):
        with self.lock:
            self.judge_done[mode] += 1
            if correct:
                self.correct[mode] += 1

    def line(self, active_modes):
        el = time.time() - self.t0
        parts = []
        for m in active_modes:
            est = ''
            if self.answer_done[m]:
                rate = self.answer_done[m] / el
                left = (self.total - self.answer_done[m]) / rate if rate else 0
                est = f' eta={int(left)}s' if left > 0 else ''
            parts.append(
                f'{m}: ans {self.answer_done[m]}/{self.total} · '
                f'正确 {self.correct[m]} · 判 {self.judge_done[m]} · 失败 {self.failed[m]}{est}')
        return f'[{el:6.0f}s] ' + ' | '.join(parts)


class LiveStatus:
    """Background thread printing a single refreshing status line."""

    def __init__(self, prog, active_modes, stop):
        self.prog = prog
        self.active_modes = active_modes
        self.stop = stop

    def start(self):
        def loop():
            import sys as _sys
            while not self.stop.is_set():
                _sys.stdout.write('\r\033[K' + self.prog.line(self.active_modes))
                _sys.stdout.flush()
                time.sleep(1)
            _sys.stdout.write('\r\033[K')
            _sys.stdout.flush()
        t = threading.Thread(target=loop, daemon=True)
        t.start()
        return t


# ── incremental save (resumable) ─────────────────────────────────────────────
_results_path = None


def init_save(out, no_resume):
    """Prepare the incremental results.jsonl target for this run."""
    global _results_path
    os.makedirs(out, exist_ok=True)
    _results_path = os.path.join(out, 'results.jsonl')
    if no_resume:
        # fresh run: discard any prior incremental log
        open(_results_path, 'w', encoding='utf-8').close()


def save(prob_id, rec, lock):
    """Append one problem's current row. Caller must already hold `lock`.

    Last line wins on reload, so answer-phase then judge-phase updates for the
    same id both append and the newest is kept when resuming.
    """
    if not _results_path:
        return
    with open(_results_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def persist(results, args):
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, 'results.jsonl')
    with open(path, 'w', encoding='utf-8') as f:
        for it in sorted(results.values(), key=lambda x: x['id']):
            f.write(json.dumps(it, ensure_ascii=False) + '\n')
    return path


# ── reporting helpers ────────────────────────────────────────────────────────
def md_escape(s, limit=None):
    s = str(s or '').replace('|', '\\|').replace('\n', ' ')
    return (s[:limit] + '…') if limit and len(s) > limit else s


# ── selection helpers ────────────────────────────────────────────────────────
def parse_ids(value):
    """Resolve --ids: if `value` is an existing file, read ids from it (one per
    line, ',' also allowed, '#' comments ignored); else treat as a CSV list."""
    ids = set()
    if value and os.path.isfile(value):
        with open(value, encoding='utf-8') as f:
            for line in f:
                line = line.split('#', 1)[0].strip()
                if line:
                    ids.update(x.strip() for x in line.split(',') if x.strip())
    else:
        for x in (value or '').split(','):
            x = x.strip()
            if x:
                ids.add(x)
    return ids


def load_questions(path):
    """Load problems from a JSON-lines file: one {id, question, truth, seq?}
    object per line ('#' comments and blank lines allowed). `seq` optional —
    auto-numbered in file order when absent. This lets a demo/ problem set be
    run directly without pointing at a problems directory."""
    out = []
    with open(path, encoding='utf-8') as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            # A line is a comment ONLY when the WHOLE line starts with '#'.
            # Do NOT split on a '#' inside a JSON string — questions
            # legitimately contain '#' (markdown headers), and truncating
            # there breaks the JSON.
            if not line or line.startswith('#'):
                continue
            try:
                obj = json.loads(line)
            except Exception as e:  # noqa: BLE001
                raise SystemExit(f'[run] bad JSON at line {i} of {path}: {e}\n  {line[:120]}')
            if not (obj.get('question') and obj.get('truth') is not None):
                continue
            obj.setdefault('seq', i)
            out.append(obj)
    return out


# ── output-dir resolution ────────────────────────────────────────────────────
def default_out(args, default_server, here):
    """Resolve the report/result output dir when --out isn't given.

    The server owns the timestamped work dir (work/<stamp>/); workers live at
    work/<stamp>/<id>/. We align our report dir to the SAME server by asking
    GET / for its workRoot and writing to <workRoot>/result — so each run's
    report, results.json/.jsonl sit right next to that run's worker dirs.
    Falls back to a fresh local work/<stamp>/result if no server is reachable.
    """
    srv = (getattr(args, 'server', '') or default_server).rstrip('/')
    try:
        req = urllib.request.Request(srv + '/', method='GET')
        with urllib.request.urlopen(req, timeout=3) as r:
            info = json.loads(r.read().decode('utf-8'))
        wr = info.get('workRoot')
        if wr:
            return os.path.join(wr, 'result')
    except Exception:  # noqa: BLE001
        pass
    stamp = time.strftime('%Y%m%d%H%M%S')
    return os.path.join(here, 'work', stamp, 'result')
