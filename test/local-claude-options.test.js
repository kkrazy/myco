// Task B — "走本机 claude / 自定义模型" option on all direct Claude/Gemini
// call sites.
//
// User request: enumerate every myco logic path that calls Claude or Gemini
// directly, and give each a "use local claude / custom model" option. The
// confirmed design (AskUserQuestion):
//   1. critic 本机 claude → reuse the session's active gateway profile
//   2. summarizer → auto-fallback to local claude when no ANTHROPIC_API_KEY
//   3. btw / claude-cli → reuse the session's active gateway profile
//
// Implementation: a shared one-shot local-claude helper
// (server/src/local-claude.js) routes the SDK query() + optional gateway
// overlay, consumed by the critic plugin, anthropic fallback, btw, claude-cli.
//
// These are static-shape guards (no live model calls): they assert the wiring
// exists so the feature can't silently regress.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const LOCAL = _read('server/src/local-claude.js');
const CLAUDE_CRITIC = _read('server/src/critics/claude.js');
const CRITICS_IDX = _read('server/src/critics/index.js');
const CRITIQUE = _read('server/src/critique.js');
const ANTHROPIC = _read('server/src/anthropic.js');
const SUMMARIZER = _read('server/src/summarizer.js');
const BTW = _read('server/src/btw.js');
const CLI = _read('server/src/claude-cli.js');
const SLASHC = _read('server/src/slashcmds.js');
const EXTRACTOR = _read('server/src/extractor.js');
const ATTACH = _read('server/src/attach.js');
const WHATSNEXT = _read('server/src/whatsnext.js');
const INDEX = _read('server/src/index.js');
const HTML = _read('web/public/index.html');

console.log('── local-claude-options: 本机 claude / 自定义模型 on all call sites ──');

t('local-claude.js: shared helper exists with gateway overlay + sdk query', () => {
  assert.ok(/callLocalClaude/.test(LOCAL), 'must export callLocalClaude');
  assert.ok(/getProfile\(user, activeGw\)/.test(LOCAL), 'must resolve the active gateway profile');
  assert.ok(/ANTHROPIC_BASE_URL/.test(LOCAL) && /ANTHROPIC_AUTH_TOKEN/.test(LOCAL) && /ANTHROPIC_MODEL/.test(LOCAL),
    'must overlay ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL from the gateway');
  assert.ok(/query\(\s*\{\s*prompt: userMessage/.test(LOCAL), 'must call @anthropic-ai/claude-agent-sdk query()');
  assert.ok(/abortController/.test(LOCAL), 'must use the abortController field (bug-14 lesson)');
});

t('local-claude.js: stallTimer is let (not const) so disarming the watchdog cannot throw', () => {
  // Regression for 2026-10-31 HLE bench: `const stallTimer` + `stallTimer = null`
  // on the first assistant message threw "Assignment to constant variable",
  // turning every single-agent answer that produced real output into a spurious
  // `sdk error` failure (14/56 single answers in run hle-20261031163852).
  const stallDecl = LOCAL.match(/let\s+stallTimer\s*=|const\s+stallTimer\s*=/);
  assert.ok(stallDecl && /^let\b/.test(stallDecl[0].trim()),
    'must declare stallTimer with `let` so `stallTimer = null` cannot throw');
  assert.ok(/stallTimer = null/.test(LOCAL),
    'must still null the watchdog on the first assistant message (disarming)');
});

t('critics/claude.js: local-claude critic plugin exists + shape', () => {
  assert.ok(/id:\s*'claude'/.test(CLAUDE_CRITIC), 'must declare id "claude"');
  assert.ok(/runCritique/.test(CLAUDE_CRITIC), 'must export runCritique');
  assert.ok(/callLocalClaude/.test(CLAUDE_CRITIC), 'must delegate to callLocalClaude');
  assert.ok(/opts\s*=\s*\{\}/.test(CLAUDE_CRITIC), 'must accept an opts 3rd arg (gateway context)');
  assert.ok(/\(local claude failed:/.test(CLAUDE_CRITIC), 'must emit a "(local claude failed: ...)" error envelope');
});

t('critics/index.js: claude registered in the critic registry', () => {
  assert.ok(/require\('\.\/claude'\)/.test(CRITICS_IDX), 'must require ./claude');
  assert.ok(/\bclaude,?\s*$/.test(CRITICS_IDX.split('const critics')[1] || '') ||
            /claude,\s*\n\s*none/.test(CRITICS_IDX), 'must register claude in the critics map');
});

t('critique.js: threads gateway context into critic.runCritique (3rd arg)', () => {
  assert.ok(/runCritique\(userPrompt, systemPromptForSpecialty, \{/.test(CRITIQUE),
    'must pass a 3rd arg to runCritique');
  assert.ok(/activeGw:\s*rec\s*&&\s*rec\.activeGw/.test(CRITIQUE),
    'must pass rec.activeGw so the claude critic can overlay the gateway');
  assert.ok(/user:\s*rec\s*&&\s*rec\.user/.test(CRITIQUE), 'must pass rec.user');
});

t('index.html: composer-critic-select offers 本机 Claude', () => {
  assert.ok(/<option value="claude">[^<]*本机 Claude<\/option>/.test(HTML),
    'must add a "本机 Claude" option to the critic dropdown');
});

t('anthropic.js: callAnthropic has local-claude fallback when no ANTHROPIC_API_KEY', () => {
  assert.ok(/localFallback/.test(ANTHROPIC), 'must accept a localFallback option');
  assert.ok(/!apiKey\s*&&\s*localFallback/.test(ANTHROPIC),
    'must route through local claude when the key is missing AND a fallback is provided');
  assert.ok(/callLocalClaude/.test(ANTHROPIC), 'must call the shared local-claude helper');
});

t('summarizer.js: passes localFallback (user/activeGw/cwd) to callAnthropic', () => {
  assert.ok(/localFallback:\s*\{\s*user:\s*rec\.user,\s*activeGw:\s*rec\.activeGw,\s*cwd:\s*rec\.absCwd\s*\}/.test(SUMMARIZER),
    'must pass the session gateway context as localFallback');
});

t('btw.js: runClaudeP accepts gateway ctx + resolves via shared helper', () => {
  assert.ok(/runClaudeP\(cwd, promptBody, gw\s*=\s*\{\}\)/.test(BTW), 'must accept an optional gw arg');
  assert.ok(/_resolveGateway\(gw\s*&&\s*gw\.user/.test(BTW), 'must resolve the gateway profile');
  assert.ok(/require\('\.\/local-claude'\)/.test(BTW), 'must reuse the shared local-claude resolver');
});

t('claude-cli.js: callClaudeCli accepts user/activeGw + delegates to local claude', () => {
  assert.ok(/user,\s*activeGw/.test(CLI), 'must accept user + activeGw params');
  assert.ok(/callLocalClaude/.test(CLI), 'must delegate to the shared local-claude helper');
});

t('slashcmds.js: /fr /bug rewrite + /dedupe pass the session active gateway', () => {
  assert.ok(/activeGw:\s*sessionRec\s*&&\s*sessionRec\.activeGw/.test(SLASHC),
    'rewrite must resolve the session gateway');
  assert.ok(/dedupePlanItems\(items, ctx\.absCwd, \{ user: ctx\.user, activeGw: rec && rec\.activeGw \}\)/.test(SLASHC),
    '/dedupe must pass the gateway context');
  assert.ok(/runClaudeP\(cwd \|\| process\.cwd\(\), promptBody, gw\)/.test(SLASHC),
    'dedupe runClaudeP must receive gw');
});

t('extractor.js / attach.js / index.js / whatsnext.js pass the session active gateway', () => {
  assert.ok(/activeGw:\s*rec\.activeGw/.test(EXTRACTOR), 'extractor must pass rec.activeGw');
  assert.ok(/activeGw:\s*rec\s*&&\s*rec\.activeGw/.test(ATTACH), 'attach /btw must pass the gateway');
  assert.ok(/activeGw:\s*ctx\.rec\s*&&\s*ctx\.rec\.activeGw/.test(INDEX), 'file-viewer review must pass the gateway');
  assert.ok(/activeGw:\s*rec\s*&&\s*rec\.activeGw/.test(WHATSNEXT), 'whatsnext rerank must pass the gateway');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
