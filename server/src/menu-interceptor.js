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

// Accepted numbered-option shapes for the marker only:
//   "1." "1)" "[1]" "(1)"
// The marker must be flanked by a whitespace/start boundary on the LEFT so we
// don't pick up references inside prose ("v1.0", "arr[4]access"). On the
// RIGHT we only forbid another digit — claude code's TUI sometimes renders
// option labels with no space after the marker (e.g. "2.Yes, don't ask
// again"), and a strict trailing-whitespace check rejected the second
// option entirely, silently breaking menu detection. The "no following
// digit" rule still blocks decimals ("3.5", "v1.0").
// Matched globally so multiple options on a single line are all extracted
// (e.g. "[4] Type something. [5] Chat about this").
const OPT_MARKER_RE = /(?<=^|\s)(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)])(?!\d)/g;

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
    const options = [];
    let firstOptIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const lineOpts = extractOptionsOnLine(lines[i], i);
      for (const o of lineOpts) {
        options.push(o);
        if (firstOptIdx === -1) firstOptIdx = i;
      }
    }
    if (options.length < 2) return null;
    // Options must be roughly contiguous in source: allow markers on the
    // same line (lineIdx delta = 0) or up to 1 blank line gap.
    for (let i = 1; i < options.length; i++) {
      if (options[i].lineIdx - options[i - 1].lineIdx > 2) return null;
    }
    // Sanity: numbers must be contiguous (each = previous + 1). We used to
    // require starting at 1, but some Claude Code dialogs (and any partial
    // viewport scan) can show menus that start higher — e.g. "[4] foo /
    // [5] bar" when the viewport cuts off the top of a longer dialog.
    const ns = options.map((o) => o.n);
    for (let i = 1; i < ns.length; i++) {
      if (ns[i] !== ns[i - 1] + 1) return null;
    }

    // Find the question — look back up to 5 lines from firstOptIdx for a
    // non-empty line. Prefer one with a question mark or recognizable verb.
    let question = '';
    for (let i = firstOptIdx - 1; i >= Math.max(0, firstOptIdx - 5); i--) {
      const t = lines[i].trim();
      if (!t) continue;
      if (/\?\s*$/.test(t) || /what would you|allow|do you want|approve|confirm|proceed/i.test(t)) {
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
    if (/allow.*\?|permission|approve.*tool|approve.*bash|bypass.*permission|always allow|don'?t allow|run this command|allow this command/i.test(classBlob)) kind = 'permission';
    else if (/plan|proceed|continue (with|the) plan|keep planning/i.test(classBlob)) kind = 'plan';

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
