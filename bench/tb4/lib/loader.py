# tb4/lib/loader.py — load Terminal-Bench 4.0 task metadata.
#
# Each task lives at <TASKS_ROOT>/<name>/ with:
#   task.toml        # manifest (schema_version, artifacts, [task],[verifier],[agent],[environment])
#   instruction.md   # the prompt shown to the agent
#   environment/     # agent workspace image (data lands in /app)
#   tests/           # verifier image (test.sh + checks.py / pytest)
#
# We parse task.toml + instruction.md into a uniform dict the harness drives.
import os
import tomllib

# Override with TB4_TASKS_ROOT if the checkout lives elsewhere.
TASKS_ROOT = os.environ.get(
    'TB4_TASKS_ROOT', '/data/s00791175/myco-test/terminal-bench/tasks')

# Curated default list: fast (small expert_time_estimate_hours) + architecture-
# agnostic on this arm64/no-GPU host (no GPU/CUDA, no mcr-playwright images).
# Fewer tasks, faster finish. Edit freely or pass --tasks <name1,name2,...>.
DEFAULT_TASKS = [
    'photonic-waveguide-routing',  # 0.75h, python:3.13-slim
    'music-harmony',               # 1.0h,  python:3.11-slim
    'bun-sourcemap-leak',          # 1.5h,  oven/bun
    'foodstuff-beta-activity',     # 1.5h,  python:3.12-slim
    'interleaved-vigenere',        # 2h,    python:3.13-slim
]


def list_tasks():
    try:
        return sorted(n for n in os.listdir(TASKS_ROOT)
                      if n != 'README.md' and n != 'dataset.toml'
                      and os.path.isfile(os.path.join(TASKS_ROOT, n, 'task.toml')))
    except FileNotFoundError:
        return []


def load_task(name):
    """Parse one task's task.toml + instruction.md -> uniform dict."""
    d = os.path.join(TASKS_ROOT, name)
    toml_path = os.path.join(d, 'task.toml')
    if not os.path.isfile(toml_path):
        raise FileNotFoundError(f'no task.toml at {d}')
    with open(toml_path, 'rb') as f:
        t = tomllib.load(f)
    instr_path = os.path.join(d, 'instruction.md')
    with open(instr_path, encoding='utf-8') as f:
        instruction = f.read().strip()
    meta = t.get('metadata', {}) or {}
    return {
        'name': name,
        'dir': d,
        'task_name': (t.get('task') or {}).get('name', name),
        'instruction': instruction,
        'expert_hours': meta.get('expert_time_estimate_hours'),
        'agent_timeout': (t.get('agent') or {}).get('timeout_sec', 28800),
        'verifier_timeout': (t.get('verifier') or {}).get('timeout_sec', 7200),
        'env_mode': (t.get('verifier') or {}).get('environment_mode', 'separate'),
        'artifacts': t.get('artifacts', []),
        'env_dir': os.path.join(d, 'environment'),
        'tests_dir': os.path.join(d, 'tests'),
    }


def load_tasks(names):
    """Load a list of task names (falling back to DEFAULT_TASKS if empty)."""
    if not names:
        names = DEFAULT_TASKS
    out = []
    missing = []
    for n in names:
        n = n.strip()
        if not n:
            continue
        try:
            out.append(load_task(n))
        except FileNotFoundError:
            missing.append(n)
    if missing:
        raise SystemExit(f'[tb4] unknown task(s): {sorted(set(missing))}')
    return out
