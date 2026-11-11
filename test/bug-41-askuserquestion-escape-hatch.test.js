// bug-41: AskUserQuestion has no escape hatch when no option fits and
// Esc hangs the flow.
//
// User-reported (verbatim, from the plan-item dispatch):
//   Problem: When AskUserQuestion is shown and none of the presented
//   options match the user's intent, there is no way to cancel or
//   provide free-form input to redirect the agent.
//   Expected: User can cancel the question or supply free-text input
//   to steer the flow when no option fits.
//   Actual: Hitting Esc does not cancel; the entire process gets stuck
//   with no way to proceed or adjust.
//
// Root cause (verified end-to-end):
//   - The SDK's AskUserQuestion description (in Claude's system prompt)
//     promises: "Users will always be able to select 'Other' to provide
//     custom text input."
//   - myco's _askNextSubQuestion (server/src/agent-session.js) renders
//     ONLY the options the model passed in input.questions[i].options.
//     It does NOT auto-append an Other affordance.
//   - The client-side Esc handler in _bindPermModalKeys
//     (web/public/app.js) sets state.permModalDismissed = true — that
//     just hides the modal. The canUseTool Promise stays unresolved
//     and the agent is stuck waiting forever.
//
// The fix:
//   1. Server: _askNextSubQuestion auto-appends TWO synthetic options
//      to every AskUserQuestion menu — Other (free-text) and Cancel.
//      They're tagged with a `synthetic` flag.
//   2. Server: resolveMenuPick branches on the synthetic flag:
//      - synthetic='cancel' → resolve canUseTool with behavior:'deny'
//      - synthetic='freeText' → resolve with answer='Other' (the
//        existing client free-text path then focuses chat input)
//   3. Client: Esc handler in _bindPermModalKeys finds the cancel
//      option's n in the current menu and calls sendMenuPick(n, hash)
//      INSTEAD of merely hiding the modal.
//
// Test shape mirrors fr-87r / fr-88r: pure-logic helper + static-grep
// guards on prod source.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Pure-logic helpers mirroring the server's resolution branch ──

function buildMenuOptions(modelOptions, isMulti) {
  // Mirrors _askNextSubQuestion after the bug-41 fix: append two
  // synthetic options after the model-provided ones.
  const rendered = modelOptions.map((o, k) => ({
    n: k + 1,
    label: String(o.label || ''),
    description: o.description || '',
    ...(isMulti ? { checkbox: true, checked: false } : {}),
  }));
  rendered.push({
    n: rendered.length + 1,
    label: 'Other — type a custom answer',
    description: 'Pick this to type your own answer in the chat input.',
    synthetic: 'freeText',
  });
  rendered.push({
    n: rendered.length + 1,
    label: 'Cancel',
    description: 'Cancel this question. Claude will pick a different approach.',
    synthetic: 'cancel',
  });
  return rendered;
}

function resolvePick(menuOpts, n) {
  // Mirrors resolveMenuPick's ask-branch after the bug-41 fix.
  const picked = menuOpts.find((o) => o.n === n);
  if (!picked) return { kind: 'invalid' };
  if (picked.synthetic === 'cancel') {
    return { kind: 'cancel', behavior: 'deny', message: 'User cancelled' };
  }
  if (picked.synthetic === 'freeText') {
    return { kind: 'freeText', answer: 'Other' };
  }
  return { kind: 'pick', answer: picked.label };
}

console.log('── bug-41: AskUserQuestion escape hatch ──');

// ── Synthetic-option presence ──

t('buildMenuOptions appends Other + Cancel after model options', () => {
  const out = buildMenuOptions([
    { label: 'Option A', description: '' },
    { label: 'Option B', description: '' },
  ], false);
  assert.strictEqual(out.length, 4, 'must have 2 model options + 2 synthetic');
  assert.strictEqual(out[0].label, 'Option A');
  assert.strictEqual(out[1].label, 'Option B');
  assert.strictEqual(out[2].synthetic, 'freeText', 'option 3 must be the freeText escape hatch');
  assert.strictEqual(out[3].synthetic, 'cancel', 'option 4 must be Cancel');
});

t('synthetic options have monotonic n starting at modelCount+1', () => {
  const out = buildMenuOptions([{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }], false);
  assert.strictEqual(out[3].n, 4, 'freeText n must be 4 with 3 model options');
  assert.strictEqual(out[4].n, 5, 'cancel n must be 5 with 3 model options');
});

t('even an empty model-options list still gets the two synthetic options', () => {
  // Edge case: model could pass empty options[] (shouldn't happen but
  // defensively). User still gets a way out.
  const out = buildMenuOptions([], false);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].synthetic, 'freeText');
  assert.strictEqual(out[1].synthetic, 'cancel');
});

t('multi-select options retain checkbox shape; synthetic options are NOT checkboxes', () => {
  const out = buildMenuOptions([{ label: 'A', description: '' }], true);
  assert.strictEqual(out[0].checkbox, true);
  assert.strictEqual(out[0].checked, false);
  assert.strictEqual(out[1].checkbox, undefined,
    'freeText synthetic must NOT be a checkbox — picking it short-circuits multi-select selection');
  assert.strictEqual(out[2].checkbox, undefined,
    'cancel synthetic must NOT be a checkbox — picking it short-circuits multi-select selection');
});

// ── Resolution branches ──

t('cancel pick resolves canUseTool with behavior=deny (NOT allow)', () => {
  const opts = buildMenuOptions([{ label: 'A', description: '' }], false);
  const res = resolvePick(opts, 3);                          // n=3 is the cancel synthetic
  assert.strictEqual(res.kind, 'cancel');
  assert.strictEqual(res.behavior, 'deny');
  assert.ok(/cancel/i.test(res.message),
    'cancel resolution message must mention "cancel" so the agent knows why');
});

t('freeText pick resolves with answer="Other" (client then opens chat input)', () => {
  const opts = buildMenuOptions([{ label: 'A', description: '' }], false);
  const res = resolvePick(opts, 2);                          // n=2 is the freeText synthetic
  assert.strictEqual(res.kind, 'freeText');
  assert.strictEqual(res.answer, 'Other');
});

t('regular pick of a model option still works (synthetic addition is non-disruptive)', () => {
  const opts = buildMenuOptions([
    { label: 'Option A', description: '' },
    { label: 'Option B', description: '' },
  ], false);
  const res = resolvePick(opts, 1);
  assert.strictEqual(res.kind, 'pick');
  assert.strictEqual(res.answer, 'Option A');
});

t('pick of an out-of-range n returns invalid (defensive)', () => {
  const opts = buildMenuOptions([{ label: 'A', description: '' }], false);
  const res = resolvePick(opts, 99);
  assert.strictEqual(res.kind, 'invalid');
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: agent-session.js _askNextSubQuestion appends synthetic options', () => {
  const src = _read('server/src/agent-session.js');
  const fnAt = src.indexOf('_askNextSubQuestion(shared)');
  assert.ok(fnAt > 0, 'agent-session.js must define _askNextSubQuestion(shared)');
  // Window covers the function body (~150 lines is generous).
  const window = src.slice(fnAt, fnAt + 6000);
  assert.ok(/synthetic\s*:\s*['"]cancel['"]/.test(window),
    "_askNextSubQuestion must append a synthetic Cancel option (looks for { synthetic: 'cancel' })");
  assert.ok(/synthetic\s*:\s*['"]freeText['"]/.test(window),
    "_askNextSubQuestion must append a synthetic freeText option (looks for { synthetic: 'freeText' })");
  assert.ok(/bug-41/.test(window),
    'a comment naming bug-41 must explain the synthetic-options addition so future readers know why they exist');
});

t('static guard: agent-session.js resolveMenuPick branches on synthetic flag', () => {
  const src = _read('server/src/agent-session.js');
  // Anchor on the function DECLARATION (with the opening brace) — the
  // bare `resolveMenuPick(hash, n)` pattern also matches the multiple
  // comment references at the top of the file, which point the window
  // at the wrong region.
  const fnAt = src.indexOf('resolveMenuPick(hash, n) {');
  assert.ok(fnAt > 0, 'agent-session.js must declare resolveMenuPick(hash, n) {…}');
  // 4000 chars from the actual declaration easily covers the ask
  // branch where the synthetic checks live.
  const window = src.slice(fnAt, fnAt + 4000);
  assert.ok(/synthetic/.test(window),
    'resolveMenuPick must inspect a `synthetic` flag on picked options so cancel + freeText resolve correctly');
  assert.ok(/behavior\s*:\s*['"]deny['"]/.test(window),
    'resolveMenuPick must have a branch that resolves with behavior:"deny" (cancel path)');
});

t('static guard: client Esc handler invokes the cancel synthetic (not just hides modal)', () => {
  const src = _read('web/public/app.js');
  const fnAt = src.indexOf('function _bindPermModalKeys');
  assert.ok(fnAt > 0, 'app.js must define _bindPermModalKeys');
  const window = src.slice(fnAt, fnAt + 2000);
  // The Esc branch must call sendMenuPick with the cancel option's n.
  // We look for a sendMenuPick call near the Escape key check.
  assert.ok(/Escape/.test(window) && /sendMenuPick/.test(window),
    'the Esc-key handler must call sendMenuPick (which actually resolves the AskUserQuestion) — not just toggle state.permModalDismissed');
  // Comment guard — keeps the why discoverable.
  assert.ok(/bug-41/.test(window),
    'a comment naming bug-41 must explain why Esc now resolves the question via Cancel rather than just hiding the modal');
});

t('static guard: client renders synthetic options with appropriate dataset flags', () => {
  // The renderer must distinguish synthetic options from model options
  // so the freeText path triggers chat-input focus (existing behavior
  // for _permOptionIsFreeText still applies).
  const src = _read('web/public/app.js');
  // Look for the perm-modal rendering — should set freeText dataset on
  // synthetic.freeText AND on label-matching options.
  assert.ok(/synthetic|dataset\.synthetic|o\.synthetic/.test(src) || /_permOptionIsFreeText/.test(src),
    'app.js must either read o.synthetic on rendered options OR keep the _permOptionIsFreeText regex (which matches the synthetic "Other — type a custom answer" label). One of these paths must light up the freeText behavior for synthetic options.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
