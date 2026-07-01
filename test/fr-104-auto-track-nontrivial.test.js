// fr-104: auto-track non-trivial work — promote sizeable bare chat
// turns to a plan item before starting, so §9's stage gates apply.
//
// Contract (all static-grep against web/public/best-practices-template.md
// and the injection mechanism in server/src/sessions.js):
//
//   - Template has a §10 heading naming the behavior + referencing fr-104.
//   - §10 names the three trigger conditions (real user, no run-marker,
//     sizeable).
//   - §10 documents the "sizeable" heuristic AND the "NOT sizeable"
//     skip-list, so the LLM has explicit yes/no examples.
//   - §10 documents the procedure: mint via mcp__myco__add_plan_items,
//     acknowledge with a specific shape ("Captured as `<id>`"), emit
//     `[run:plan#<id>]` in the SAME reply, enter §9 analyze.
//   - §10 names the layer-pick rules (bug/fr/td).
//   - §10 covers the edge cases (strict-mode interaction, dup-avoidance,
//     multiple asks).
//   - §9's Scope paragraph cross-references §10 so a reader of §9
//     doesn't conclude "bare turns are exempt full stop."
//   - server/src/sessions.js still injects the template into spawned
//     CLAUDE.md files (unchanged plumbing — guard against accidental
//     regression of the injection path).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-104: auto-track non-trivial work in CLAUDE.md template ──');

const TEMPLATE_PATH = 'web/public/best-practices-template.md';

// Slice §10 from the template by anchoring on its heading. §10 ends at
// the closing horizontal-rule + "*Toggle…*" footer that's been the
// template's tail for a long time, so we look for the next blank line
// followed by a literal "---" after the §10 heading. Fallback to
// end-of-file if the footer is reorganized.
function _section10(src) {
  const start = src.search(/^## 10\.\s+Auto-track non-trivial work/m);
  if (start < 0) return '';
  const after = src.slice(start);
  // First standalone --- AFTER the heading marks end-of-section.
  // Skip any inline `---` that might appear mid-section (unlikely but
  // possible) by requiring it to be on its own line preceded by an
  // empty line.
  const endRe = /\n\n---\n/;
  const m = after.match(endRe);
  return m ? after.slice(0, m.index) : after;
}

t('§10 heading exists + names fr-104 explicitly', () => {
  const src = _read(TEMPLATE_PATH);
  assert.ok(/^## 10\.\s+Auto-track non-trivial work/m.test(src),
    'template must have a §10 heading "Auto-track non-trivial work"');
  const sec = _section10(src);
  assert.ok(sec.length > 0, '§10 body must be sliceable');
  assert.ok(/fr-104/.test(sec),
    '§10 must reference fr-104 explicitly so the audit trail ties back to the plan item');
});

t('§10 names all THREE trigger conditions', () => {
  const sec = _section10(_read(TEMPLATE_PATH));
  // (1) real user (not a dispatcher echo). The exact phrasing is up to
  // the author; we just check the concept names something distinguishing
  // "user turn" from a system echo.
  assert.ok(/real user|from a real user|\[stage-/.test(sec),
    '§10 must distinguish a real user turn from dispatcher echos like [stage-accept] / [stage-fix]');
  // (2) no run-marker present
  assert.ok(/\[run:plan#/.test(sec) && /No|no|NOT/.test(sec),
    '§10 must say the no-existing-run-marker condition');
  // (3) sizeable
  assert.ok(/sizeable/i.test(sec),
    '§10 must use the word "sizeable" so the heuristic anchor is consistent with the analyze-stage prose');
});

t('§10 documents the sizeable heuristic AND a NOT-sizeable skip-list', () => {
  const sec = _section10(_read(TEMPLATE_PATH));
  // Sizeable bullets — at least two of: multi-file, new module, multi-
  // step, open-ended language.
  const sizeableHits = [
    /file edit/i,
    /new (file|module)/i,
    /multi[- ]step/i,
    /open[- ]ended/i,
  ].filter((re) => re.test(sec)).length;
  assert.ok(sizeableHits >= 2,
    `§10 must list at least 2 sizeable-trigger examples (got ${sizeableHits} matches)`);
  // NOT sizeable — must explicitly call out single-line tweaks, slash
  // commands, and pure read/explain so the LLM has yes/no anchors.
  assert.ok(/single[- ]line|typo|trivial/i.test(sec),
    '§10 must call out single-line / typo / trivial as NOT-sizeable');
  assert.ok(/read\/explain|read.*explain|pure read/i.test(sec),
    '§10 must call out pure read/explain as NOT-sizeable');
  assert.ok(/slash command/i.test(sec),
    '§10 must call out slash commands as NOT-sizeable');
});

t('§10 documents the procedure: mint → acknowledge → enter analyze', () => {
  const sec = _section10(_read(TEMPLATE_PATH));
  // Mint via mcp__myco__add_plan_items — the in-process MCP tool.
  // Hard-anchor on the tool name so a future refactor that renames it
  // will surface here.
  assert.ok(/mcp__myco__add_plan_items/.test(sec),
    '§10 must name the mcp__myco__add_plan_items tool explicitly so claude knows what to call');
  // Acknowledge shape — "Captured as `<id>`" is the canonical
  // recognition string for audit and other agents.
  assert.ok(/Captured as/.test(sec),
    '§10 must specify the acknowledgment shape ("Captured as `<id>`") so the audit trail and other agents recognize the promotion');
  // The [run:plan#<id>] marker must be emitted in the SAME reply so §9
  // and the server-side run-marker scanner activate.
  assert.ok(/\[run:plan#<id>\]/.test(sec),
    '§10 must say to emit `[run:plan#<id>]` in the SAME reply');
  // Enter §9 analyze stage.
  assert.ok(/analyze stage|enter analyze|§9/i.test(sec),
    '§10 must say to enter §9 analyze stage immediately after the acknowledgment');
});

t('§10 documents the layer-pick rules (bug / fr / td) with word triggers', () => {
  const sec = _section10(_read(TEMPLATE_PATH));
  assert.ok(/bug/i.test(sec) && /\bfix|broken|regression/i.test(sec),
    '§10 layer-pick must map "fix / broken / regression" → bug');
  assert.ok(/(\bfr\b|feature)/i.test(sec) && /\badd|implement|new feature|support/i.test(sec),
    '§10 layer-pick must map "add / implement / new feature" → fr');
  assert.ok(/\btd\b|todo/i.test(sec) && /\brefactor|clean up|consider/i.test(sec),
    '§10 layer-pick must map "refactor / clean up / consider" → td');
});

t('§10 covers strict-mode interaction (fr-38)', () => {
  const sec = _section10(_read(TEMPLATE_PATH));
  assert.ok(/strict[- ]mode|fr-38/i.test(sec),
    '§10 must explain how strict-mode interacts (fr-38 gate already blocks bare turns; §10 doesn\'t fire there)');
});

t('§10 covers duplicate-avoidance (already minted via /fr or already exists)', () => {
  const sec = _section10(_read(TEMPLATE_PATH));
  assert.ok(/(\/fr|already minted|already exists|duplicate)/i.test(sec),
    '§10 must explain not to double-mint when the user already used /fr/td/bug or a matching item already exists');
});

t('§9 Scope paragraph cross-references §10', () => {
  const src = _read(TEMPLATE_PATH);
  const scopeIdx = src.indexOf('**Scope.**');
  assert.ok(scopeIdx > 0, '§9 must have a **Scope.** paragraph');
  // The Scope paragraph runs to the next blank line or sub-heading.
  const scopeBlock = src.slice(scopeIdx, scopeIdx + 1500);
  assert.ok(/§10|fr-104/.test(scopeBlock),
    '§9 Scope paragraph must cross-reference §10 (or fr-104) so a reader of §9 alone doesn\'t conclude "bare turns are exempt full stop"');
});

t('static guard: server/src/sessions.js still injects the template into CLAUDE.md on spawn', () => {
  // fr-104 is a template-content change. The injection plumbing must
  // remain wired so spawned sessions actually see §10. Guard against
  // accidental removal of the injection step (e.g., a future refactor
  // that drops the call site).
  const src = _read('server/src/sessions.js');
  assert.ok(/injectBestPracticesIntoClaudeMd\s*\(/.test(src),
    'sessions.js must still call injectBestPracticesIntoClaudeMd to write the template');
  const body = fnBody(src, /function\s+injectBestPracticesIntoClaudeMd\s*\(/);
  assert.ok(body, 'injectBestPracticesIntoClaudeMd body must be locatable');
  assert.ok(/BP_TEMPLATE_PATH|best-practices-template\.md/.test(body) ||
    /BP_TEMPLATE_PATH|best-practices-template\.md/.test(src),
    'injection must source from best-practices-template.md');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
