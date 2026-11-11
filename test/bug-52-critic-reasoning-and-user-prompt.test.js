// bug-52: critic must explain reasoning on ✓ AGREED + user can ask
// the critic to look into something specific via an input field on
// the verdict pane.
//
// Two user-reported observations consolidated into one fix:
//   (1) "when the critic agrees, should still show the reasoning of
//       the agreement with explanation" — the original critique
//       prompt told Gemini to write JUST "✓ AGREED" on agreement,
//       so several runs this session came back as 8-char bare
//       sentinels with no reasoning. Fix: prompt now requires 2-4
//       sentences of reasoning even on agreement.
//   (2) "Should let user decide if there is anything user want the
//       critic to look into by providing an input field" — verdict
//       pane grows a textarea + the Retry button reads it + POSTs
//       it as userPrompt to /critique/retry. Server appends a
//       priority block to the critic's user prompt so Gemini centers
//       its review on the user's specific concern.
//
// Pre-existing observation (resolved by piece 1): "Currently it just
// say agreed and then continue." With reasoning + an input field
// present, the verdict pane is worth pausing on — the queue stays
// paused per the td-33 r1 gate, and the user has both context (the
// reasoning) and agency (the input field) to engage with the verdict.
//
// Test shape: static-grep across critique.js, index.js, app.js, styles.css.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-52: critic reasoning on ✓ AGREED + user follow-up prompt ──');

// ── 1. Prompt change — reasoning required on agreement ──

t('server/src/critique.js: the basePrompt requires reasoning AFTER "✓ AGREED" (not just the bare sentinel)', () => {
  // bug-65 follow-up: the basePrompt was moved out of critique.js
  // and into server/src/critics/prompts/base.md. The contract
  // bug-52 locked (agreement requires reasoning, not just the bare
  // sentinel) is satisfied by base.md's verdict-format section
  // ("Write ✓ AGREED on the first line ... then give a concise 2-4
  // sentence explanation ... bare ✓ AGREED with no reasoning is
  // unhelpful (bug-52)"). Look at base.md content.
  const src = _read('server/src/critique.js');
  const md = (() => { try { return _read('server/src/critics/prompts/base.md'); } catch { return ''; } })();
  const haystack = src + '\n' + md;
  // Must mention reasoning / explanation requirement.
  assert.ok(/explanation|reasoning|WHY you agree|2-4 sentence|2–4 sentence|explain/i.test(haystack),
    'the agreement branch (inline OR in base.md) must explicitly require reasoning/explanation — the original bare "write ✓ AGREED" produced sentinels with no reasoning (bug-52).');
  // Must call out the "bare AGREED is unhelpful" framing.
  assert.ok(/bare\s*[`'"]?✓\s*AGREED[`'"]?|terse|unhelpful/i.test(haystack),
    'the agreement branch must explicitly warn against bare/terse "✓ AGREED" so a future prompt-tightener doesn\'t accidentally regress (bug-52).');
});

// ── 2. Server: userPrompt plumbing through retry → triggerGeminiCritique ──

t('server/src/critique.js: triggerGeminiCritique reads opts.userPrompt (capped at ~2KB)', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/opts\.userPrompt|opts\s*&&\s*[a-zA-Z]+\s*===\s*['"]userPrompt['"]/.test(src) ||
            /opts\s*&&[\s\S]{0,60}userPrompt/.test(src),
    'triggerGeminiCritique must read opts.userPrompt so a retry with a user-typed prompt can steer the critic (bug-52).');
  // The cap (2 KB) prevents a misbehaving client from blowing up the
  // prompt budget.
  assert.ok(/slice\(0,\s*2048\)|slice\(0,2048\)|2048/.test(src),
    'triggerGeminiCritique must cap the user follow-up prompt at 2048 chars so a paste-attack can\'t blow up the prompt budget (bug-52).');
});

t('server/src/critique.js: when userPrompt is non-empty, a "[USER FOLLOW-UP]" block is appended to the prompt so Gemini gives it priority', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/USER FOLLOW-UP|user.*follow.*up|user has typed|user is specifically asking/i.test(src),
    'when userPrompt is set, the critique must contain a clearly-marked block telling Gemini to address the user\'s specific concern with priority (bug-52).');
});

t('server/src/critique.js: retryLastCritique accepts + forwards opts.userPrompt to triggerGeminiCritique', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/async\s+function\s+retryLastCritique\s*\(/);
  assert.ok(at > -1, 'retryLastCritique must exist.');
  const body = sliceFn(src, at);
  assert.ok(/opts\s*=\s*\{/.test(body),
    'retryLastCritique signature must accept an opts parameter (bug-52).');
  assert.ok(/userPrompt[\s\S]{0,300}triggerGeminiCritique|triggerGeminiCritique[\s\S]{0,500}userPrompt/.test(body),
    'retryLastCritique must forward opts.userPrompt to triggerGeminiCritique (bug-52).');
});

t('server/src/index.js: POST /critique/retry reads req.body.userPrompt + passes to retryLastCritique', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.post\(\s*['"]\/sessions\/:id\/critique\/retry['"]/);
  assert.ok(at > -1);
  const body = src.slice(at, at + 1500);
  assert.ok(/req\.body[\s\S]{0,50}userPrompt|req\.body\.userPrompt/.test(body),
    'POST /critique/retry must read userPrompt from the request body (bug-52).');
  assert.ok(/retryLastCritique[\s\S]{0,200}userPrompt/.test(body),
    'POST /critique/retry must pass userPrompt through to retryLastCritique (bug-52).');
});

// ── 3. Client: textarea on verdict pane + Retry POSTs userPrompt ──

t('web/public/app.js: verdict pane renders a #verdict-user-prompt-input textarea between the critique body and the action buttons', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_renderVerdictPanel\s*\(\)/);
  // 16000-byte window matches td-33's post-bug-71 budget. Pre-bug-71 the
  // function fit in 8000; bug-71's +21 line markdown/mermaid insertion
  // pushed the textarea past the boundary, hiding the placeholder match
  // even though the source was correct. Mirror td-33's bump (bumped from
  // 12000→16000 in commit 3c21cf4) so a future insertion has room before
  // we have to revisit again.
  const body = sliceFn(app, at);
  assert.ok(/verdict-user-prompt-input/.test(body),
    '_renderVerdictPanel must render the #verdict-user-prompt-input textarea (bug-52 — the user input field).');
  assert.ok(/verdict-user-prompt-wrap/.test(body),
    'the textarea must sit inside a .verdict-user-prompt-wrap container so the label + textarea group cleanly.');
  // The placeholder must hint at the use case so users know what to
  // type in. Look for "did you check" or "look into" or "specific".
  assert.ok(/placeholder=["'][^"']*(did you check|look into|specific)/i.test(body),
    'the textarea placeholder must hint at the use case (e.g. "did you check the case where...") so users understand what to type (bug-52).');
});

t('web/public/app.js: Retry button reads #verdict-user-prompt-input + POSTs userPrompt in the request body', () => {
  const app = _read('web/public/app.js');
  // The retry handler must:
  //   (a) read the textarea via querySelector('#verdict-user-prompt-input').
  //   (b) send a JSON body with { userPrompt: ... }.
  // Look at the btnRetry click handler.
  const handlerAt = app.search(/btnRetry\.addEventListener\(\s*['"]click['"]/);
  assert.ok(handlerAt > -1, 'btnRetry click handler must exist.');
  const handlerBody = app.slice(handlerAt, handlerAt + 2500);
  assert.ok(/verdict-user-prompt-input/.test(handlerBody),
    'btnRetry handler must read the #verdict-user-prompt-input value before POSTing (bug-52).');
  assert.ok(/JSON\.stringify\s*\(\s*\{[\s\S]{0,150}userPrompt/.test(handlerBody),
    'btnRetry handler must JSON.stringify({ userPrompt }) into the POST body (bug-52).');
  assert.ok(/Content-Type[\s\S]{0,30}application\/json/i.test(handlerBody),
    'the retry POST must declare Content-Type: application/json so the server\'s body parser populates req.body (bug-52).');
});

// ── 4. Client: CSS for the user-prompt textarea ──

t('web/public/styles.css: .verdict-user-prompt-input + .verdict-user-prompt-wrap + .verdict-user-prompt-label are defined', () => {
  const css = _read('web/public/styles.css');
  for (const klass of ['.verdict-user-prompt-input', '.verdict-user-prompt-wrap', '.verdict-user-prompt-label']) {
    assert.ok(new RegExp(klass.replace('.', '\\.') + '\\s*\\{').test(css),
      `${klass} CSS rule must be defined (bug-52 — verdict-pane textarea styling).`);
  }
});

// ── 5. Marker comment ──

t('a comment naming "bug-52" appears in at least 3 of the touched files', () => {
  const files = [
    'server/src/critique.js',
    'server/src/index.js',
    'web/public/app.js',
    'web/public/styles.css',
  ];
  let found = 0;
  for (const f of files) if (/bug-52/.test(_read(f))) found++;
  assert.ok(found >= 3,
    `at least 3 of the touched files must carry a bug-52 marker comment — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
