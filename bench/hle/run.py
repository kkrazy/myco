#!/usr/bin/env python3
# run.py — HLE benchmark orchestration.
#
# Calls the myco bench HTTP server (server.js) blocking POST endpoints, runs
# the single-agent and run-n2 pipelines in PARALLEL, and cross-judges:
#   single-agent answer -> judged by run-n2
#   run-n2      answer -> judged by single-agent
# against each problem's ground-truth `## Answer`.
#
# Live progress is printed per problem; results are written incrementally to
# results/results.jsonl (resumable) and reported as results/results.json +
# results/report.md (per-question comparison, correctness winners, speed
# comparison, totals).
import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor


HERE = os.path.dirname(os.path.abspath(__file__))    # bench/hle
BENCH_ROOT = os.path.dirname(HERE)                    # bench
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, BENCH_ROOT)
from loader import load_problems  # noqa: E402
from utils import orch  # noqa: E402

DEFAULT_PROBLEMS = '/data/s00791175/myco-test/agent-bench/bench/hle/problems'
DEFAULT_SERVER = os.environ.get('HLE_SERVER', 'http://127.0.0.1:8787')
MODES = ('single', 'n2')


def call_answer(server, mode, prob, timeout_ms, system=None, retries=1):
    payload = {'mode': mode, 'id': prob['id'], 'seq': prob.get('seq'),
               'question': prob['question'], 'timeoutMs': timeout_ms}
    if system:
        payload['system'] = system
    # Retry transient failures (502/503/timeout/connection reset) with
    # exponential backoff + jitter, so a slow/timing-out upstream call gets a
    # few chances instead of failing after one 1200s wait.
    r = None
    for attempt in range(retries + 1):
        r = _answer_once(server, payload, timeout_ms)
        if r.get('ok') is True or attempt >= retries or not orch._retryable(r.get('error')):
            return r
        orch._sleep_backoff(attempt)
    return r


def _answer_once(server, payload, timeout_ms):
    try:
        r = orch.http_post(server + '/answer', payload, timeout=(timeout_ms / 1000) + 60)
        return {'ok': r.get('ok'), 'mode': payload['mode'], 'answer': r.get('answer', ''),
                'ms': r.get('ms', 0), 'error': r.get('error')}
    except urllib.error.HTTPError as e:
        # The bench server replies 502 with a JSON body {ok:false, error:...}
        # when the engine fails (timeout/stall/sdk error). urllib raises on the
        # status code and hides the body — read it so results.jsonl carries the
        # REAL reason instead of a bare "HTTP Error 502: Bad Gateway".
        detail = ''
        try:
            detail = (json.loads(e.read().decode('utf-8')) or {}).get('error', '')
        except Exception:  # noqa: BLE001
            pass
        return {'ok': False, 'mode': payload['mode'], 'answer': '', 'ms': 0,
                'error': f'HTTP {e.code}: {detail or e.reason}'}


def call_judge(server, engine, prob, answer, timeout_ms, retries=1):
    payload = {'engine': engine, 'id': prob['id'], 'seq': prob.get('seq'), 'question': prob['question'],
               'answer': answer or '', 'truth': prob['truth'], 'timeoutMs': timeout_ms}
    # Same retry-with-backoff as call_answer: a transient judge failure
    # shouldn't knock a whole answer out of the cross-judge.
    r = None
    for attempt in range(retries + 1):
        r = _judge_once(server, payload, timeout_ms)
        if r.get('ok') is True or attempt >= retries or not orch._retryable(r.get('error')):
            return r
        orch._sleep_backoff(attempt)
    return r


def _judge_once(server, payload, timeout_ms):
    try:
        r = orch.http_post(server + '/judge', payload, timeout=(timeout_ms / 1000) + 60)
        return {'ok': r.get('ok'), 'engine': payload['engine'], 'correct': r.get('correct'),
                'extracted': r.get('extracted', ''), 'answer': r.get('answer', ''),
                'ms': r.get('ms', 0), 'error': r.get('error')}
    except urllib.error.HTTPError as e:
        # Same as _answer_once: the 502 body carries the engine's real error.
        detail = ''
        try:
            detail = (json.loads(e.read().decode('utf-8')) or {}).get('error', '')
        except Exception:  # noqa: BLE001
            pass
        return {'ok': False, 'engine': payload['engine'], 'correct': None, 'extracted': '',
                'answer': '', 'ms': 0, 'error': f'HTTP {e.code}: {detail or e.reason}'}


# ── pipelines ────────────────────────────────────────────────────────────────
def answer_pipeline(mode, args, probs, prog, lock, results):
    """Answer every problem in `probs` via /answer for `mode`."""
    def one(prob):
        with lock:
            rec0 = results.get(prob['id'])
        if rec0 and rec0.get(mode) and not args.no_resume:
            return rec0.get(mode)          # already answered on a prior run
        r = call_answer(args.server, mode, prob, args.timeout, retries=args.retries)
        with lock:
            results.setdefault(prob['id'], {'id': prob['id'], 'question': prob['question'],
                                            'truth': prob['truth'], 'single': None, 'n2': None,
                                            'judge_single_by_n2': None, 'judge_n2_by_single': None})
            results[prob['id']][mode] = {'ok': r.get('ok'), 'answer': r.get('answer', ''),
                                         'ms': r.get('ms', 0), 'error': r.get('error')}
            orch.save(prob['id'], results[prob['id']], lock)
        prog.tick_answer(mode, bool(r.get('ok')))
        return r

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as ex:
        list(ex.map(one, probs))


def judge_pipeline(target_mode, engine, args, probs, prog, lock, results):
    """Judge the `target_mode` answers using `engine` as the judge."""
    jkey = 'judge_single_by_n2' if target_mode == 'single' else 'judge_n2_by_single'

    def one(prob):
        with lock:
            rec0 = results.get(prob['id'])
        if rec0 and rec0.get(jkey) and not args.no_resume:
            return rec0.get(jkey)          # already judged on a prior run
        ans = (rec0 or {}).get(target_mode, {}).get('answer', '')
        if not (ans or '').strip():
            return                       # answer failed/empty -> nothing to judge
        r = call_judge(args.server, engine, prob, ans, args.judge_timeout, retries=args.retries)
        with lock:
            results[prob['id']][jkey] = {
                'correct': r.get('correct'), 'extracted': r.get('extracted', ''),
                'answer': r.get('answer', ''), 'ms': r.get('ms', 0), 'ok': r.get('ok')}
            orch.save(prob['id'], results[prob['id']], lock)
        prog.tick_judge(target_mode, bool(r.get('correct')))
        return r

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as ex:
        list(ex.map(one, probs))


# ── reporting ────────────────────────────────────────────────────────────────
def _has_answer(it, mode):
    """True when `mode` ('single'|'n2') produced a non-empty answer."""
    rec = it.get(mode) or {}
    return bool((rec.get('answer') or '').strip())


def build_report(results, probs, args, wall):
    ids_in_order = [p['id'] for p in probs if p['id'] in results]
    items = [results[i] for i in ids_in_order]

    def ok_single(it):
        j = it.get('judge_single_by_n2')
        return bool(j and j.get('correct'))

    def ok_n2(it):
        j = it.get('judge_n2_by_single')
        return bool(j and j.get('correct'))

    # 「双方都有答案」子集：只有单agent 和 run-n2 都产出非空答案的题，
    # 才算入正确率分析（分母）。只出一边的题从正确率分析中剔除——
    # 两边都没判分基准时无法做公平对比。
    has_s = [it for it in items if _has_answer(it, 'single')]
    has_n = [it for it in items if _has_answer(it, 'n2')]
    both = [it for it in items if _has_answer(it, 'single') and _has_answer(it, 'n2')]
    nb = len(both)

    cs = sum(1 for it in both if ok_single(it))
    cn = sum(1 for it in both if ok_n2(it))

    def acc(c, d):
        return f'{100 * c / d:.2f}%' if d else 'n/a'

    L = []
    A = L.append
    A('# HLE 正确率报告 — 单agent vs run-n2')
    A('')
    A(f'- 题目总数：{len(probs)} · 已完成：{len(items)} · 总耗时：{wall:.1f}s')
    A(f'- 单agent 有答案：{len(has_s)} · run-n2 有答案：{len(has_n)} · **双方都有答案（纳入正确率分析）：{nb}**')
    A('')
    A('> 正确率只统计「双方都有答案」的题目：这 {nb} 题单agent 与 run-n2 都给出了回答，'
      '分母一致，两模式可公平对比；只出一边的题已被剔除。'.format(nb=nb) if nb else
      '> 正确率只统计「双方都有答案」的题目。当前没有双方都有答案的题。')
    A('')
    A('## 汇总')
    A('')
    A('| 模式 | 判分引擎 | 答对 | 双方都有答案 | 正确率 |')
    A('|---|---|---|---|---|')
    if nb:
        A(f'| 单agent | run-n2 | {cs} | {nb} | `{acc(cs, nb)}` |')
        A(f'| run-n2 | single | {cn} | {nb} | `{acc(cn, nb)}` |')
        A('')
        if cs != cn:
            leader = 'run-n2' if cn > cs else '单agent'
            A(f'**结论：{leader} 正确率更高**（{max(cs, cn)} 对 {min(cs, cn)}）。')
        A('')
    A('## 逐题明细（仅「双方都有答案」的 {nb} 题，便于人眼复核）'.format(nb=nb))
    A('')
    if not both:
        A('（无）')
        A('')
    for i, it in enumerate(both, 1):
        sa = (it.get('single') or {})
        na = (it.get('n2') or {})
        a = ok_single(it)
        b = ok_n2(it)
        a_str = '对 ✓' if a is True else ('错 ✗' if a is False else '无答案/未判 —')
        b_str = '对 ✓' if b is True else ('错 ✗' if b is False else '无答案/未判 —')
        A(f'### {i}. `{it["id"]}`')
        A('')
        A(f'- **run-n2**:  `{orch.md_escape(na.get("answer"), 60)}` → **{b_str}**（{na.get("ms", 0)}ms）')
        A(f'- **single**:  `{orch.md_escape(sa.get("answer"), 60)}` → **{a_str}**（{sa.get("ms", 0)}ms）')
        A('')

    summary = {
        'total_problems': len(probs),
        'completed': len(items),
        'wall_seconds': round(wall, 1),
        'single_answered': len(has_s),
        'n2_answered': len(has_n),
        'both_answered': nb,
        'single': {'correct': cs, 'total': nb,
                   'accuracy': (round(100 * cs / nb, 2) if nb else None)},
        'n2': {'correct': cn, 'total': nb,
               'accuracy': (round(100 * cn / nb, 2) if nb else None)},
    }
    return '\n'.join(L), summary


# ── main ─────────────────────────────────────────────────────────────────────
def parse_args(argv):
    ap = argparse.ArgumentParser(description='HLE: run myco single-agent vs run-n2, cross-judged.')
    ap.add_argument('--problems', default=DEFAULT_PROBLEMS)
    ap.add_argument('--questions', default='',
                    help='load problems from a JSON-lines file (one {"id","question",'
                         '"truth", "seq"?} object per line, "#" comments/blank ok) '
                         'instead of the --problems directory. e.g. demo/01.json')
    ap.add_argument('--server', default=DEFAULT_SERVER)
    ap.add_argument('--mode', choices=['all', 'single', 'n2'], default='all',
                    help='which answering pipelines to run (all = single+n2, always parallel)')
    ap.add_argument('--concurrency', type=int, default=3, help='concurrent /answer or /judge calls per pipeline')
    ap.add_argument('--retries', type=int, default=3,
                    help='retry transient /answer or /judge failures (502/503/timeout) '
                         'this many times with exponential backoff')
    ap.add_argument('--parallel-modes', action='store_true',
                    help='run single-agent and n2 BASELINES in parallel. Default is to run '
                         'them sequentially (single first, then n2) so the slow n2 problems '
                         "can't starve the fast single-agent requests and stall the run.")
    ap.add_argument('--timeout', type=int, default=900000,
                    help='per-call model timeout ms for the ANSWER phase. Default raised from '
                         '600000 to 900000: measured ok-answer durations cluster at median '
                         '~160s but run up to ~600s, so 600s was truncating borderline '
                         'problems that would have finished. The stall watchdog (engine side) '
                         'already fails fast on dead streams, so the higher budget mostly '
                         'waits on productive streams.')
    ap.add_argument('--judge-timeout', type=int, default=600000,
                    help='per-call model timeout ms for the JUDGE phase (judge prompts are '
                         'short; 600s is plenty)')
    ap.add_argument('--out', default=None,
                    help='report/result output dir. Default: auto-align to the server\'s '
                         'work/<stamp>/result so reports sit with the worker dirs for that run.')
    ap.add_argument('--limit', type=int, default=0, help='only first N problems')
    ap.add_argument('--range', default='', help='a:b — only problems [a,b)')
    ap.add_argument('--shard', default='', help='k/n — only shard k of n (distribution)')
    ap.add_argument('--text-only', action='store_true',
                    help='skip image-bearing problems (HLE images are the hardest / often 502)')
    ap.add_argument('--ids', default='',
                    help='only these problem ids, comma-separated OR a file of ids '
                         '(one per line, # comments and "," also ok), '
                         'e.g. "6688...,6694..." or /path/to/ids.txt')
    ap.add_argument('--no-resume', action='store_true', help='ignore existing results.jsonl')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.out:
        args.out = orch.default_out(args, DEFAULT_SERVER, HERE)
    print(f'[run] out dir -> {args.out}')
    orch.init_save(args.out, args.no_resume)
    if args.questions:
        probs = orch.load_questions(args.questions)
        if not probs:
            print(f'[run] no usable problems in {args.questions}')
            return 1
        print(f'[run] --questions: {len(probs)} problems from {args.questions}')
    else:
        probs = load_problems(args.problems)
        if not probs:
            print(f'[run] no problems found in {args.problems}')
            return 1

    # selection: ids / text-only / range / shard / limit
    if args.ids:
        want = orch.parse_ids(args.ids)
        probs = [p for p in probs if p['id'] in want]
        if not probs:
            print(f'[run] --ids matched no problems (ids given: {sorted(want)[:5]} ...)')
            return 1
        print(f'[run] --ids: running {len(probs)} problems')
    if args.text_only:
        probs = [p for p in probs if '![' not in p['question']]
    if args.range:
        a, _, b = args.range.partition(':')
        a = int(a) if a else 0
        b = int(b) if b else len(probs)
        probs = probs[a:b]
    if args.shard:
        k, _, n = args.shard.partition('/')
        k, n = int(k), int(n)
        probs = [p for i, p in enumerate(probs) if i % n == (k % n)]
    if args.limit:
        probs = probs[:args.limit]

    # which modes answer
    active = [m for m in MODES if args.mode in ('all', m)]

    # resume: load prior results
    results = {}
    rl_path = os.path.join(args.out, 'results.jsonl')
    if not args.no_resume and os.path.exists(rl_path):
        with open(rl_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        it = json.loads(line)
                        results[it['id']] = it
                    except Exception:  # noqa: BLE001
                        continue

    # (mode 'single') pipeline: answer via /answer single; judged by n2
    # (mode 'n2')     pipeline: answer via /answer n2;      judged by single
    prog = orch.Progress(len(probs))
    lock = threading.Lock()
    stop = threading.Event()
    live = orch.LiveStatus(prog, active, stop)
    live_t = live.start()
    t0 = time.time()
    try:
        # 1) answer phase. Default: run the enabled pipelines SEQUENTIALLY
        #    (single-agent first, then n2) so a slow dual-worker n2 problem can't
        #    starve the fast single-agent requests (the old parallel mode let a
        #    single stuck n2 occupy the whole server pool and stall everything).
        #    --parallel-modes restores the concurrent behaviour.
        # explicit order: single first, then n2 (NOT sorted() — alphabetically
        # 'n2' < 'single', which would run the slow n2 phase before the fast
        # single-agent phase instead of the other way round).
        mode_order = ['single', 'n2']
        modes_run = [m for m in mode_order if m in active] or sorted(active)
        if args.parallel_modes:
            threads = [threading.Thread(target=answer_pipeline, args=(m, args, probs, prog, lock, results))
                       for m in modes_run]
            for th in threads:
                th.start()
            for th in threads:
                th.join()
        else:
            for m in modes_run:
                print(f'[run] answer phase: {m} ({len(probs)} problems)')
                answer_pipeline(m, args, probs, prog, lock, results)

        # 2) judge phase — cross-judge, parallel
        jthreads = []
        for m in active:
            # single answers judged by n2 engine; n2 answers judged by single engine
            target, engine = (m, 'n2') if m == 'single' else (m, 'single')
            th = threading.Thread(target=judge_pipeline,
                                  args=(target, engine, args, probs, prog, lock, results))
            th.start()
            jthreads.append(th)
        for th in jthreads:
            th.join()
    finally:
        stop.set()
        live_t.join(timeout=2)
        sys.stdout.write('\r\033[K')
        sys.stdout.flush()

    wall = time.time() - t0
    orch.persist(results, args)

    # report
    md, summary = build_report(results, probs, args, wall)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'report.md'), 'w', encoding='utf-8') as f:
        f.write(md + '\n')
    with open(os.path.join(args.out, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump({'summary': summary, 'results': [results[p['id']] for p in probs if p['id'] in results]},
                  f, ensure_ascii=False, indent=2)

    print()
    print(md)
    print(f'\n[run] results.jsonl / report.md / results.json written to {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
