// Detects Claude Code's TUI menus by scanning the headless terminal's bottom
// rows. Claude renders a numbered-option dialog whenever it pauses for a
// human decision (plan-mode finalization, tool-use permission prompts when
// the CLI isn't running with --dangerously-skip-permissions, occasional
// model-asked confirmations). Mycelium's web GUI can't navigate these
// dialogs, so we capture them and forward them to the discussion panel
// where the user can pick via `/decide <n>`.
//
// Detection is heuristic: look for ≥2 consecutive lines matching a numbered
// option pattern, plus a question-shaped line above them. We hash the
// (question + options) so the same dialog doesn't re-fire on every render
// tick — only on transitions (new dialog, replaced dialog, dialog cleared).

// All TUI-output regexes live in pty-patterns.js — one place to patch
// when claude code's rendering shifts. See that file for the per-pattern
// rationale + the exact dialog text that motivated each rule.
const {
  MENU_OPT_MARKER_RE: OPT_MARKER_RE,
  MENU_CURSOR_RE,
  MENU_MAX_OPTION_GAP_LINES,
  MENU_QUESTION_TAIL_RE,
  MENU_QUESTION_VERB_RE,
  MENU_KIND_PERMISSION_RE,
  MENU_KIND_PLAN_RE,
} = require('./pty-patterns');

class MenuInterceptor {
  constructor() {
    // Hash of the last fired dialog, or null when there is no active dialog.
    this.currentHash = null;
  }

  // Returns one of:
  //   { kind: 'newMenu', menu: {hash, question, options, kind, rawText} }
  //   { kind: 'sameMenu' }    — the previously detected dialog is still on screen
  //   { kind: 'cleared' }     — there was a dialog, now there isn't
  //   null                    — never had one, still don't
  detectChange(headless) {
    const parsed = this._scan(headless);
    if (!parsed) {
      if (this.currentHash !== null) {
        this.currentHash = null;
        return { kind: 'cleared' };
      }
      return null;
    }
    if (parsed.hash === this.currentHash) return { kind: 'sameMenu' };
    this.currentHash = parsed.hash;
    return { kind: 'newMenu', menu: parsed };
  }

  reset() { this.currentHash = null; }

  // Scan the entire visible viewport of the headless terminal for a menu
  // pattern. We used to only scan the bottom 16 rows on the theory that
  // Claude's menus always render at the bottom — but the trust-folder
  // dialog on first-run renders near the TOP of a fresh alt-screen, and
  // with a tall terminal (Android phones can have rows ≥ 33) the options
  // land above the bottom-16 window and the menu is missed entirely.
  // Scanning all visible rows is cheap (rows ≤ 80) and bulletproof.
  // Returns null if nothing menu-shaped is on screen, else
  // {hash, question, options: [{n, label}], kind, rawText}.
  _scan(headless) {
    if (!headless || !headless.buffer) return null;
    let lines;
    try {
      const buf = headless.buffer.active;
      const rows = headless.rows;
      lines = [];
      for (let i = 0; i < rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line) lines.push(line.translateToString(true).replace(/\s+$/, ''));
        else lines.push('');
      }
    } catch { return null; }

    // Collect candidate options. Each marker on a line is a candidate, and
    // its label is the text between this marker and the next one (or the
    // end of the line). Multi-option-per-line is supported because some
    // dialogs pack options compactly: "[4] Type something. [5] Chat …".
    const allOptions = [];
    for (let i = 0; i < lines.length; i++) {
      for (const o of extractOptionsOnLine(lines[i], i)) allOptions.push(o);
    }
    if (allOptions.length < 2) return null;

    // Split into maximal runs of contiguously-numbered options (each
    // option's n must equal the previous + 1 AND lines must be within
    // MENU_MAX_OPTION_GAP_LINES). Without this split, a claude
    // assistant turn that contains BOTH a numbered plan body
    // ("1. DB schema 2. Bus 3. Worker 4. Gateway 5. SDK 6. Inbox") AND
    // a real menu below it ("❯ 1. Yes  2. No  3. Refine  4. Tell Claude")
    // would have its options collected as [1..6, 1..4] — the 6 → 1
    // discontinuity used to abort detection. Splitting lets us
    // recognise the bottom menu as its own complete run.
    const runs = [];
    let cur = [];
    for (const o of allOptions) {
      if (cur.length === 0) { cur.push(o); continue; }
      const prev = cur[cur.length - 1];
      const numOK = o.n === prev.n + 1;
      const gapOK = o.lineIdx - prev.lineIdx <= MENU_MAX_OPTION_GAP_LINES;
      if (numOK && gapOK) cur.push(o);
      else { if (cur.length >= 2) runs.push(cur); cur = [o]; }
    }
    if (cur.length >= 2) runs.push(cur);
    if (!runs.length) return null;

    // Pick the LAST run that has a `❯` cursor on at least one of its
    // option lines. Claude code's TUI always paints the cursor on the
    // currently-selected option of an active menu; plain numbered prose
    // doesn't. Bottom-most wins when there are multiple cursored runs
    // (rare in practice — the active dialog is always at the bottom).
    let chosen = null;
    for (const run of runs) {
      if (run.some((o) => MENU_CURSOR_RE.test(lines[o.lineIdx] || ''))) chosen = run;
    }
    if (!chosen) return null;

    const options = chosen;
    const firstOptIdx = chosen[0].lineIdx;

    // Each option's label = just the text on the marker line. We
    // intentionally do NOT fold continuation lines into the label any
    // more: claude's TUI puts TUI-only key hints ("shift+tab to
    // approve …", "ctrl-g to edit in Vim · ~/.claude/plans/<file>")
    // immediately under options, plus inline descriptions that bloat
    // the chat picker. Single-line labels are unambiguous enough for
    // a number-pick — anyone who wants the full description can read
    // it in the conv pane.

    // Find the question — look back up to 5 lines from firstOptIdx for a
    // non-empty line. Prefer one with a question mark or recognizable verb.
    let question = '';
    for (let i = firstOptIdx - 1; i >= Math.max(0, firstOptIdx - 5); i--) {
      const t = lines[i].trim();
      if (!t) continue;
      if (MENU_QUESTION_TAIL_RE.test(t) || MENU_QUESTION_VERB_RE.test(t)) {
        question = t;
        break;
      }
      if (!question) question = t;   // fallback: nearest non-empty line
    }

    // Classify so the broadcast can use a friendlier label. Look at both
    // the question and the option labels, since Claude's plan-mode dialog
    // uses a generic "What would you like to do?" question whose options
    // are the "plan" signal. Permission signal is most reliably found on
    // option labels ("Always allow <tool>", "Don't allow", "Yes, run").
    const classBlob = (question + ' ' + options.map((o) => o.label).join(' ')).toLowerCase();
    let kind = 'generic';
    if (MENU_KIND_PERMISSION_RE.test(classBlob)) kind = 'permission';
    else if (MENU_KIND_PLAN_RE.test(classBlob)) kind = 'plan';

    const optsForHash = options.map((o) => ({ n: o.n, label: o.label }));
    const hash = hashMenu(question, optsForHash);
    const rawText = lines.slice(Math.max(0, firstOptIdx - 5)).join('\n');
    return { hash, kind, question, options: optsForHash, rawText };
  }
}

// Pull every option marker out of `line` (multiple if present) and pair
// each with the text running up to the next marker or end-of-line. Returns
// [] when there are no real options on the line. The "real option" guards:
//   - marker must be flanked by whitespace boundaries (so we ignore
//     "v1.0" or in-prose "[1]" references)
//   - number must be 1..9 (single-digit menus only)
//   - label must be ≥2 non-whitespace chars after trim (rejects markers
//     with no body, the most common false-positive shape)
function extractOptionsOnLine(line, lineIdx) {
  if (!line) return [];
  OPT_MARKER_RE.lastIndex = 0;
  const markers = [];
  let m;
  while ((m = OPT_MARKER_RE.exec(line)) !== null) {
    const n = parseInt(m[1] || m[2] || m[3], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 9) {
      markers.push({ n, start: m.index, end: OPT_MARKER_RE.lastIndex });
    }
  }
  if (!markers.length) return [];
  const opts = [];
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const next = markers[i + 1];
    const labelEnd = next ? next.start : line.length;
    const label = line.slice(cur.end, labelEnd).replace(/\s+/g, ' ').trim();
    if (label.length < 2) continue;
    opts.push({ n: cur.n, label, lineIdx });
  }
  return opts;
}

function hashMenu(question, options) {
  // Truncated so trivial re-renders (cursor blink, mouse hover state) don't
  // shift the hash.
  return question.slice(0, 100) + '|' + options.map((o) => `${o.n}:${o.label.slice(0, 60)}`).join('|');
}

module.exports = { MenuInterceptor, hashMenu };
