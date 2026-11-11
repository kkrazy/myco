#!/usr/bin/env python3
# tb4/run.py — Terminal-Bench orchestration: compare myco single-agent vs run-n2
# as AGENTS on a curated set of TB4 terminal tasks.
#
# Per task:
#   1. materialize the task's /app workspace (docker build env image + cp) into
#      work/tb4-<stamp>/<task>/seed/, then copy to single/ and n2/.
#   2. run single AgentSession (POST /run mode=single) and n2 TeamSession
#      (POST /run mode=n2) in their workspaces.
#   3. verify each workspace with the task's official verifier (docker) -> 0/1.
#   4. write results.jsonl (resumable) + report.md / results.json.
#
# Agent generation runs under the Node server (tb4/server.js); docker-heavy
# workspace/verify logic lives in lib/workspace.py + lib/verify.py.
import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))    # bench/tb4
BENCH_ROOT = os.path.dirname(HERE)                    # bench
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, BENCH_ROOT)
from loader import load_tasks            # noqa: E402
from workspace import materialize_workspace, copy_workspace  # noqa: E402
from verify import verify_task           # noqa: E402
from utils import orch                   # noqa: E402

DEFAULT_SERVER = os.environ.get('TB4_SERVER', 'http://127.0.0.1:8790')
MODES = ('single', 'n2')
RESULTS = ['results.jsonl', 'report.md', 'results.json']


# ── HTTP / workspace helpers ─────────────────────────────────────────────────
def server_work_root(server):
    """Ask the tb4 server for its workRoot (co-locates workspaces + report)."""
    try:
        req = urllib.request.Request(server + '/', method='GET')
        with urllib.request.urlopen(req, timeout=3) as r:
            return (json.loads(r.read().decode('utf-8')) or {}).get('workRoot')
    except Exception:  # noqa: BLE001
        return None


def call_run(server, mode, task, cwd, timeout_ms, retries=2):
    payload = {'mode': mode, 'taskId': task['name'], 'cwd': cwd,
               'instruction': task['instruction'], 'timeoutMs': timeout_ms}
    r = None
    for attempt in range(retries + 1):
        try:
            r = orch.http_post(server + '/run', payload, timeout=(timeout_ms / 1000) + 60)
            return {'ok': r.get('ok'), 'mode': mode, 'ms': r.get('ms', 0), 'error': r.get('error')}
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = (json.loads(e.read().decode('utf-8')) or {}).get('error', '')
            except Exception:  # noqa: BLE001
                pass
            r = {'ok': False, 'mode': mode, 'ms': 0, 'error': f'HTTP {e.code}: {detail or e.reason}'}
            if attempt >= retries or not orch._retryable(r.get('error')):
                return r
            orch._sleep_backoff(attempt)
        except Exception as e:  # noqa: BLE001
            r = {'ok': False, 'mode': mode, 'ms': 0, 'error': str(e)}
            if attempt >= retries:
                return r
            orch._sleep_backoff(attempt)
    return r


# ── reporting ────────────────────────────────────────────────────────────────
def persist_tb4(results, out):
    """Rewrite results.jsonl (sorted by task) — tb4 rows are keyed by task name,
    not HLE's `id`, so we don't reuse orch.persist's `x['id']` sort."""
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'results.jsonl'), 'w', encoding='utf-8') as f:
        for it in sorted(results.values(), key=lambda x: x['task']):
            f.write(json.dumps(it, ensure_ascii=False) + '\n')


def build_report(results, tasks, wall):
    items = [results[t['name']] for t in tasks if t['name'] in results]

    def ok_single(it):
        v = it.get('single_verify') or {}
        return v.get('correct')

    def ok_n2(it):
        v = it.get('n2_verify') or {}
        return v.get('correct')

    total = len(items)
    cs = sum(1 for it in items if ok_single(it) is True)
    cn = sum(1 for it in items if ok_n2(it) is True)
    ts = sum((it.get('single') or {}).get('ms', 0) for it in items if it.get('single'))
    tn = sum((it.get('n2') or {}).get('ms', 0) for it in items if it.get('n2'))
    ns_ans = sum(1 for it in items if it.get('single'))
    nn_ans = sum(1 for it in items if it.get('n2'))

    def acc(c, d):
        return f'{100 * c / d:.2f}%' if d else 'n/a'

    single_win, n2_win, both, neither = [], [], [], []
    speed_n2_faster, speed_single_faster = [], []
    for it in items:
        a, b = ok_single(it), ok_n2(it)
        ms_s = (it.get('single') or {}).get('ms', 0)
        ms_n = (it.get('n2') or {}).get('ms', 0)
        if a is True and b is False:
            single_win.append(it)
        elif b is True and a is False:
            n2_win.append(it)
        elif a is True and b is True:
            both.append(it)
        if a is False and b is False:
            neither.append(it)
        if ms_s and ms_n:
            if ms_n < ms_s:
                speed_n2_faster.append((it, ms_s - ms_n))
            elif ms_s < ms_n:
                speed_single_faster.append((it, ms_n - ms_s))

    L = []
    A = L.append
    A('# TB4 对比报告 — 单agent vs run-n2（Terminal-Bench 终端任务）')
    A('')
    A(f'- 任务总数：{len(tasks)} · 已完成：{len(items)} · 总耗时：{wall:.1f}s')
    A(f'- 单agent 正确率：`{acc(cs, total)}`（{cs}/{total}，由 TB4 verifier 判分） · 用时 {ts / 1000:.1f}s'
      + (f' · avg {ts / ns_ans:.0f}ms/题' if ns_ans else ''))
    A(f'- run-n2  正确率：`{acc(cn, total)}`（{cn}/{total}，由 TB4 verifier 判分） · 用时 {tn / 1000:.1f}s'
      + (f' · avg {tn / nn_ans:.0f}ms/题' if nn_ans else ''))
    A('')
    A('## 汇总')
    A('')
    A('| 模式 | 判分 | 答对 | 答题数 | 正确率 | 总用时 | avg/题 |')
    A('|---|---|---|---|---|---|---|')
    if ns_ans:
        A(f'| 单agent | TB4 verifier | {cs} | {ns_ans} | {acc(cs, total)} | {ts / 1000:.1f}s | {ts / ns_ans:.0f}ms |')
    if nn_ans:
        A(f'| run-n2 | TB4 verifier | {cn} | {nn_ans} | {acc(cn, total)} | {tn / 1000:.1f}s | {tn / nn_ans:.0f}ms |')
    A('')
    A('## 逐任务结果')
    A('')
    for i, it in enumerate(items, 1):
        sa = it.get('single') or {}
        na = it.get('n2') or {}
        a = ok_single(it)
        b = ok_n2(it)
        a_str = '对 ✓' if a is True else ('错 ✗' if a is False else '未判 —')
        b_str = '对 ✓' if b is True else ('错 ✗' if b is False else '未判 —')
        A(f'### {i}. `{it["task"]}`')
        A('')
        A(f'- **run-n2**:  {b_str}（{na.get("ms", 0)}ms）{(" [" + na.get("error") + "]") if na.get("error") else ""}')
        A(f'- **single**: {a_str}（{sa.get("ms", 0)}ms）{(" [" + sa.get("error") + "]") if sa.get("error") else ""}')
        A('')

    def winner_section(title, lst, note):
        A(f'## {title}')
        A('')
        if not lst:
            A('（无）')
            A('')
            return
        A(f'{note}，共 {len(lst)} 题：')
        A('')
        A('| task | single用时 | n2用时 |')
        A('|---|---|---|')
        for it in lst:
            A(f'| `{it["task"]}` | {(it.get("single") or {}).get("ms", 0)}ms '
              f'| {(it.get("n2") or {}).get("ms", 0)}ms |')
        A('')

    winner_section('单agent 对 而 run-n2 错（single 正确性胜）', single_win, '这些是 single 答对、run-n2 答错')
    winner_section('run-n2 对 而 单agent 错（run-n2 正确性胜）', n2_win, '这些是 run-n2 答对、single 答错')
    winner_section('双方都对', both, '两模式都答对')
    winner_section('双方都错 / 未判', neither, '两模式都错或未判')

    A('## 速度对比')
    A('')
    if speed_n2_faster:
        A(f'- **run-n2 比 单agent 快的题数：{len(speed_n2_faster)}**，累计节省 '
          f'{sum(d for _, d in speed_n2_faster) / 1000:.1f}s。')
    else:
        A('- run-n2 没有比单agent 快的题。')
    A('')
    if speed_single_faster:
        A(f'- **单agent 比 run-n2 快的题数：{len(speed_single_faster)}**。')
    else:
        A('- 单agent 没有比 run-n2 快的题。')
    A('')

    summary = {
        'total_tasks': len(tasks),
        'completed': len(items),
        'wall_seconds': round(wall, 1),
        'single': {'answered': ns_ans, 'total': total, 'correct': cs,
                   'accuracy': (round(100 * cs / total, 2) if total else None),
                   'total_ms': ts, 'avg_ms': (round(ts / ns_ans) if ns_ans else None)},
        'n2': {'answered': nn_ans, 'total': total, 'correct': cn,
               'accuracy': (round(100 * cn / total, 2) if total else None),
               'total_ms': tn, 'avg_ms': (round(tn / nn_ans) if nn_ans else None)},
        'single_beats_n2_correctness': len(single_win),
        'n2_beats_single_correctness': len(n2_win),
        'both_correct': len(both),
        'both_wrong_or_pending': len(neither),
        'n2_faster_count': len(speed_n2_faster),
        'single_faster_count': len(speed_single_faster),
    }
    return '\n'.join(L), summary


# ── per-task pipeline ────────────────────────────────────────────────────────
def run_task(args, task, work_root, prog, lock, results, env_tags, test_tags):
    """Materialize, run single+n2, and verify one task. Returns the row."""
    name = task['name']
    tdir = os.path.join(work_root, name)
    seed = os.path.join(tdir, 'seed')
    ws = {m: os.path.join(tdir, m) for m in MODES}

    row = {'task': name, 'single': None, 'n2': None,
           'single_verify': None, 'n2_verify': None}

    # 1) workspace
    try:
        materialize_workspace(task, seed, env_tags[name])
    except Exception as e:  # noqa: BLE001
        row['error'] = f'workspace materialize failed: {e}'
        _save_row(lock, results, row)
        return row

    def one_mode(mode):
        copy_workspace(seed, ws[mode])
        r = call_run(args.server, mode, task, ws[mode], args.timeout)
        return {'ok': r.get('ok'), 'ms': r.get('ms', 0), 'error': r.get('error')}

    if args.parallel_modes:
        with ThreadPoolExecutor(max_workers=2) as ex:
            futs = {m: ex.submit(one_mode, m) for m in active_modes(args)}
            for m, f in futs.items():
                row[m] = f.result()
    else:
        for m in active_modes(args):       # single first, then n2
            row[m] = one_mode(m)
    with lock:
        results[name] = dict(row)
        _persist_row(name, results, lock)
    prog.tick_answer('single', bool((row['single'] or {}).get('ok')))
    prog.tick_answer('n2', bool((row['n2'] or {}).get('ok')))

    # 2) verify each completed mode
    for m in active_modes(args):
        if args.skip_verify:
            row[f'{m}_verify'] = {'correct': None, 'rc': None, 'error': 'skipped'}
            continue
        if not (row[m] or {}).get('ok'):
            row[f'{m}_verify'] = {'correct': False, 'rc': None,
                                  'error': (row[m] or {}).get('error') or 'agent run failed'}
            continue
        try:
            correct, rc, log = verify_task(task, ws[m], os.path.join(ws[m], '_verify'),
                                           test_tags[name],
                                           verifier_timeout=args.verify_timeout)
            row[f'{m}_verify'] = {'correct': correct, 'rc': rc, 'log': log[-1500:]}
        except Exception as e:  # noqa: BLE001
            row[f'{m}_verify'] = {'correct': None, 'rc': None, 'error': str(e)}
        prog.tick_judge(m, bool((row[f'{m}_verify'] or {}).get('correct')))

    with lock:
        results[name] = dict(row)
        _persist_row(name, results, lock)
    return row


def active_modes(args):
    return [m for m in MODES if args.mode in ('all', m)]


# incremental save (resumable), keyed by task name. Caller holds `lock`.
def _persist_row(task_name, results, lock):
    orch.save(task_name, results[task_name], lock)


def _save_row(lock, results, row):
    with lock:
        results[row['task']] = dict(row)
        orch.save(row['task'], results[row['task']], lock)


# ── main ─────────────────────────────────────────────────────────────────────
def _resolve_tasks_arg(arg):
    """Resolve the --tasks value.

    If it names an existing JSON FILE (plain path, or `@`-prefixed), read the
    task names from it — the file is either a list of names or {"tasks": [...]}.
    Otherwise treat it as a comma-separated name list. Empty -> None (defaults).
    """
    if not arg:
        return None
    path = arg[1:] if arg.startswith('@') else arg
    if os.path.isfile(path):
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get('tasks'), list):
                data = data['tasks']
            if isinstance(data, list):
                names = [str(t) for t in data if str(t).strip()]
                if names:
                    return names
        except Exception:  # noqa: BLE001
            print(f'[tb4] warning: --tasks file {path} unreadable, falling back to name list')
    return [t for t in arg.split(',') if t.strip()]


def parse_args(argv):
    ap = argparse.ArgumentParser(description='TB4: myco single-agent vs run-n2 on TB4 terminal tasks.')
    ap.add_argument('--tasks', default='',
                    help='task names, comma-separated OR a .json file of task names '
                         '(path or @path; list or {"tasks":[...]}). '
                         'e.g. --tasks photonic-waveguide-routing,music-harmony '
                         'or --tasks demo/q5.json')
    ap.add_argument('--server', default=DEFAULT_SERVER, help='tb4 server base URL')
    ap.add_argument('--mode', choices=['all', 'single', 'n2'], default='all')
    ap.add_argument('--timeout', type=int, default=7200000,
                    help='per agent-run model timeout ms (default 2h; each task runs '
                         'single + n2, so 5 tasks x 2 modes x 2h ~ 20h)')
    ap.add_argument('--verify-timeout', type=int, default=3600000,
                    help='per-verifier timeout ms (default 1h)')
    ap.add_argument('--parallel-modes', action='store_true',
                    help='run single and n2 for a task in parallel (default sequential)')
    ap.add_argument('--skip-verify', action='store_true',
                    help='skip the docker verifier (debugging)')
    ap.add_argument('--out', default=None,
                    help='report/result dir. Default: auto-align to the server workRoot/result.')
    ap.add_argument('--limit', type=int, default=0, help='only first N tasks')
    ap.add_argument('--no-resume', action='store_true', help='ignore existing results.jsonl')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    server = args.server.rstrip('/')

    tasks = load_tasks(_resolve_tasks_arg(args.tasks))
    if args.limit:
        tasks = tasks[:args.limit]
    if not tasks:
        print('[tb4] no tasks to run')
        return 1
    print(f'[tb4] {len(tasks)} tasks: {", ".join(t["name"] for t in tasks)}')

    # align output + workspaces to the server's workRoot
    work_root = server_work_root(server)
    if not args.out:
        args.out = (work_root and os.path.join(work_root, 'result')) \
            or os.path.join(HERE, 'work', f'tb4-{time.strftime("%Y%m%d%H%M%S")}', 'result')
    os.makedirs(args.out, exist_ok=True)
    print(f'[tb4] out dir -> {args.out}')

    # image tags (cached per task; env + tests)
    env_tags = {t['name']: f'tb4-env-{t["name"]}' for t in tasks}
    test_tags = {t['name']: f'tb4-test-{t["name"]}' for t in tasks}

    # resume
    results = {}
    rl = os.path.join(args.out, 'results.jsonl')
    if not args.no_resume and os.path.exists(rl):
        with open(rl, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    it = json.loads(line)
                    results[it['task']] = it
                except Exception:  # noqa: BLE001
                    continue

    orch.init_save(args.out, args.no_resume)
    prog = orch.Progress(len(tasks))
    lock = threading.Lock()
    stop = threading.Event()
    live = orch.LiveStatus(prog, active_modes(args), stop)
    live_t = live.start()
    t0 = time.time()
    try:
        amodes = active_modes(args)
        for task in tasks:
            if task['name'] in results and not args.no_resume and _complete(results[task['name']], amodes):
                print(f"[tb4] {task['name']} already done, resuming past it")
                for m in amodes:
                    prog.tick_answer(m, True)
                    prog.tick_judge(m, bool(((results[task['name']].get(f'{m}_verify') or {}).get('correct'))))
                continue
            print(f"[tb4] === {task['name']} ===")
            run_task(args, task, work_root, prog, lock, results, env_tags, test_tags)
    finally:
        stop.set()
        live_t.join(timeout=2)
        import sys as _sys
        _sys.stdout.write('\r\033[K')
        _sys.stdout.flush()

    wall = time.time() - t0
    persist_tb4(results, args.out)
    md, summary = build_report(results, tasks, wall)
    with open(os.path.join(args.out, 'report.md'), 'w', encoding='utf-8') as f:
        f.write(md + '\n')
    with open(os.path.join(args.out, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump({'summary': summary, 'results': [results[t['name']] for t in tasks if t['name'] in results]},
                  f, ensure_ascii=False, indent=2)
    print()
    print(md)
    print(f'\n[tb4] results.jsonl / report.md / results.json written to {args.out}')
    return 0


def _complete(row, modes):
    return all((row.get(m) or {}).get('ok')
               and (row.get(f'{m}_verify') or {}).get('correct') is not None
               for m in modes)


if __name__ == '__main__':
    sys.exit(main())
