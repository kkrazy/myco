# lib/loader.py — parse the HLE problem markdown files.
#
# Each problem file (agent-bench/bench/hle/problems/<24-hex-id>.md) carries:
#   ## Question\n<question>
#   ## Answer\n<ground truth>\n## Rationale\n...
# We extract id, question and the ground-truth answer. The id pattern
# (24 hex chars) is how we tell problems apart from index.md / images/.
import os
import re

PROBLEM_RE = re.compile(r'^[0-9a-f]{24}\.md$')   # legacy: 24-hex-id filename
NUM_RE = re.compile(r'^\d+\.md$')                # problemsNum: numbered 1..2500


def parse_problem(path):
    with open(path, encoding='utf-8') as f:
        txt = f.read()
    stem = os.path.splitext(os.path.basename(path))[0]

    # id: for legacy 24-hex files it's the filename; for numbered files we take
    # the 24-hex id from the title line "# <hex>" (fall back to the numeric stem)
    if PROBLEM_RE.match(os.path.basename(path)):
        pid = stem
    else:
        m = re.match(r'^\s*#\s*([0-9a-f]{24})\b', txt)
        pid = m.group(1) if m else stem

    # question: the block after "## Question" up to the next "## " heading
    q_m = re.search(r'^##\s+Question\s*\n(.*?)(\n\s*##\s+|\Z)', txt, re.S | re.M)
    question = q_m.group(1).strip() if q_m else ''

    # answer: the block after "## Answer" up to the next "## " heading
    a_m = re.search(r'^##\s+Answer\s*\n(.*?)(\n\s*##\s+|\Z)', txt, re.S | re.M)
    truth = a_m.group(1).strip() if a_m else ''

    return {'id': pid, 'question': question, 'truth': truth, 'file': path}


def _name_key(name):
    # natural sort: numbered files (1,2,...,2500) before/naturally-ordered;
    # everything else falls back to plain string order
    if NUM_RE.match(name):
        return (0, int(name[:-3]))
    return (1, name)


def load_problems(problems_dir):
    """Return the list of problems (accepts both 24-hex-id filenames and the
    numbered problemsNum/ layout)."""
    out = []
    try:
        names = sorted(os.listdir(problems_dir), key=_name_key)
    except FileNotFoundError:
        return out
    for i, name in enumerate(names, 1):
        if not (PROBLEM_RE.match(name) or NUM_RE.match(name)):
            continue
        full = os.path.join(problems_dir, name)
        if not os.path.isfile(full):
            continue
        p = parse_problem(full)
        if p['question'] and p['truth']:
            # Work-dir seq: problemsNum uses the numbered filename itself
            # (1..2500); legacy problems/ (24-hex filenames) fall back to the
            # load order. This is what names work/<stamp>/n2/<seq> dirs.
            p['seq'] = int(name[:-3]) if NUM_RE.match(name) else i
            out.append(p)
    return out
