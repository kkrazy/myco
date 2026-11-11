// bug-38 r2 — fold tool_result back INTO the chrome batch.
//
// This REVERSES bug-23 (which had pulled tool_result OUT of the chrome
// batch to render as its own message bubble). User re-evaluated on the
// live site with a WebSearch turn:
//
//   ✓ result · 0 bytes · for=xbVo66Wj
//   ✓ result · 2078 bytes · for=2jNeLQPg
//   Web search results for query: "Shenzhen weather..."   [raw JSON]
//
// and said the raw tool output showing standalone is noise — "the
// result is shown already with the 'claude' bubble" (claude's summary).
// So tool_result goes back into the collapsible chrome batch; only
// claude's narration bubble stays visible by default. The raw result
// is still reachable when the batch is expanded.
//
// Supersedes test/bug-23-tool-result-bubble.test.js (removed).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-38 r2: tool_result folds into the chrome batch (reverses bug-23) ──');

function _chromeTypesBlock() {
  const start = APP.search(/const\s+AGENT_CHROME_TYPES\s*=\s*new\s+Set\s*\(\s*\[/);
  assert.ok(start > -1, 'AGENT_CHROME_TYPES must exist');
  const end = APP.indexOf(']);', start);
  assert.ok(end > -1, 'AGENT_CHROME_TYPES must have a closing ])');
  return APP.slice(start, end + 3);
}

t('AGENT_CHROME_TYPES INCLUDES tool_result (folds into chrome batch)', () => {
  const block = _chromeTypesBlock();
  assert.ok(/['"]tool_result['"]/.test(block),
    "bug-38 r2: 'tool_result' must be in AGENT_CHROME_TYPES so it folds into the collapsible chrome batch (reverses bug-23)");
});

t('AGENT_CHROME_TYPES still includes the other chrome types (no collateral change)', () => {
  const block = _chromeTypesBlock();
  for (const ty of ['turn_start', 'hook_allow', 'system_init', 'permission_request', 'turn_result']) {
    assert.ok(new RegExp(`['"]${ty}['"]`).test(block),
      `${ty} must remain a chrome event`);
  }
});

t('_isChromeEvent classifies tool_result as chrome (via the set, no special-case needed)', () => {
  // tool_result now lives in AGENT_CHROME_TYPES, so _isChromeEvent
  // returns true on the set membership check. We don't require a
  // dedicated `ev.type === 'tool_result'` special-case branch (the
  // set handles it), but we DO require that the classification result
  // is chrome. Assert the set contains it (covered above) AND that
  // the function still consults the set first.
  const fnIdx = APP.search(/function\s+_isChromeEvent\s*\(/);
  assert.ok(fnIdx > -1, '_isChromeEvent must be defined');
  const body = sliceFn(APP, fnIdx);
  assert.ok(/AGENT_CHROME_TYPES\.has\(\s*ev\.type\s*\)/.test(body),
    '_isChromeEvent must consult AGENT_CHROME_TYPES (which now contains tool_result)');
});

t('no standalone tool_result message-bubble render branch remains in _appendAgentEvent', () => {
  // bug-23 added an `else if (ev.type === 'tool_result')` branch in the
  // fresh-card path that built a .agent-tool-result-preview bubble.
  // Since tool_result now early-returns through the chrome-batch path,
  // that branch is dead and must be removed so it can't accidentally
  // fire (or mislead a future reader into thinking tool_result still
  // renders as a bubble).
  // Target the specific fresh-card render branch:
  //   } else if (ev.type === 'tool_result') { ... agent-tool-result-preview ... }
  // The class name also appears in an unrelated querySelectorAll cleanup
  // elsewhere, so we anchor on the branch head + the preview build to
  // avoid a false match.
  assert.ok(
    !/else if\s*\(\s*ev\.type === ['"]tool_result['"]\s*\)[\s\S]{0,700}agent-tool-result-preview/.test(APP),
    'bug-38 r2: the standalone tool_result bubble branch (else-if building .agent-tool-result-preview) must be removed from the fresh-card render');
});

t('chrome batch still has full tool_result support (aggregator + head label + event line)', () => {
  // Folding relies on the pre-bug-23 chrome tool_result handlers still
  // being present. Spot-check the three load-bearing helpers.
  assert.ok(/function\s+_bumpToolResultAggregator\s*\(/.test(APP),
    '_bumpToolResultAggregator must exist (per-batch byte sum)');
  assert.ok(/ev\.type\s*===\s*['"]tool_result['"]/.test(APP),
    'a tool_result branch must exist in the chrome event-line / details builders');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
