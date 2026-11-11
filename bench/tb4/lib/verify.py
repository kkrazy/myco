# tb4/lib/verify.py — run a TB4 task's official verifier against an agent
# workspace and return pass/fail.
#
# Each task's tests image (tasks/<name>/tests/Dockerfile + test.sh) knows how to
# grade the agent's output: we bind-mount the agent workspace at /app and a
# results dir at /logs/verifier, run /tests/test.sh, then read the reward
# (reward.txt with a 0/1, falling back to reward.json / reward-details.json).
import json
import os
import workspace as ws


def build_tests_image(task, tag, build_timeout=1200):
    if ws.image_exists(tag):
        return
    cmd = ws._build_cmd(ws._proxy(), ws._base_images(task['tests_dir']), tag,
                        os.path.join(task['tests_dir'], 'Dockerfile'),
                        task['tests_dir'])
    r = ws.sh(cmd, timeout=build_timeout)
    if r.returncode != 0:
        raise RuntimeError(f'[tb4:verify] build {task["name"]} tests failed:\n'
                           + (r.stdout + r.stderr)[-2500:])


def _read_reward(result_dir):
    for name in ('reward.txt', 'reward.json', 'reward-details.json'):
        p = os.path.join(result_dir, name)
        if not os.path.isfile(p):
            continue
        try:
            s = open(p, encoding='utf-8').read().strip()
            if name == 'reward.txt':
                if s in ('1', '0'):
                    return s == '1'
                return bool(int(s)) if s else None
            d = json.loads(s)
            # reward.json / reward-details.json carry e.g. {"reward": 1.0}
            if isinstance(d, dict) and 'reward' in d:
                return bool(d['reward'])
        except Exception:  # noqa: BLE001
            continue
    return None


def verify_task(task, workspace, result_dir, tag,
                verifier_timeout=3600, build_timeout=1200):
    """Grade `workspace` with the task's official verifier.

    Returns (correct, exit_code, log_tail). `correct` is None if no reward file
    was produced (verifier failed to run / didn't grade).
    """
    build_tests_image(task, tag, build_timeout)
    os.makedirs(result_dir, exist_ok=True)
    ws._rmtree_contents(result_dir)
    cmd = (f'docker run --rm -v "{workspace}:/app" -v "{result_dir}:/logs/verifier" '
           f'{tag} bash -c "/tests/test.sh"')
    r = ws.sh(cmd, timeout=verifier_timeout)
    correct = _read_reward(result_dir)
    return correct, r.returncode, (r.stdout + r.stderr)[-3000:]
