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
    // Options must be roughly contiguous in source. The gap limit is
    // generous (MENU_MAX_OPTION_GAP_LINES) so multi-line option
    // descriptions and a single horizontal divider don't break detection
    // — the contiguous-numbers check below is the real false-positive
    // filter.
    for (let i = 1; i < options.length; i++) {
      if (options[i].lineIdx - options[i - 1].lineIdx > MENU_MAX_OPTION_GAP_LINES) return null;
    }
    // Sanity: numbers must be contiguous (each = previous + 1). We used to
    // require starting at 1, but some Claude Code dialogs (and any partial
    // viewport scan) can show menus that start higher — e.g. "[4] foo /
    // [5] bar" when the viewport cuts off the top of a longer dialog.
    const ns = options.map((o) => o.n);
    for (let i = 1; i < ns.length; i++) {
      if (ns[i] !== ns[i - 1] + 1) return null;
    }
    // False-positive guard: require at least one option's LINE to
    // carry the `❯` cursor marker that claude code's TUI always paints
    // on the currently-selected option. Without this, claude's own
    // generated plan bodies (long numbered bullet lists in assistant
    // text) get falsely broadcast as menus — every plan with 4+
    // numbered points would otherwise pop a callout asking the user
    // to "pick" a bullet. See pty-patterns.js MENU_CURSOR_RE.
    if (!options.some((o) => MENU_CURSOR_RE.test(lines[o.lineIdx] || ''))) return null;
    // Join multi-line option descriptions. For each option, any non-empty
    // line between this option's lineIdx and the NEXT option's lineIdx
    // (exclusive) that isn't itself an option marker line is treated as
    // continuation and appended to the label. Box-drawing / divider lines
    // (composed of └─╌╶ etc.) are skipped — they're claude's section
    // separators inside multi-group menus, not part of any option.
    for (let i = 0; i < options.length; i++) {
      const startLine = options[i].lineIdx;
      const endLine = i + 1 < options.length ? options[i + 1].lineIdx : lines.length;
      const extra = [];
      for (let j = startLine + 1; j < endLine; j++) {
        const t = (lines[j] || '').trim();
        if (!t) continue;
        if (/^[─━─-╌╴╶╴╌\-]+$/.test(t)) continue;          // divider line
        extra.push(t);
      }
      if (extra.length) {
        options[i].label = (options[i].label + ' ' + extra.join(' ')).replace(/\s+/g, ' ').trim();
      }
    }

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
