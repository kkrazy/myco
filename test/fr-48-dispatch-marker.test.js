// fr-48 bugfix (root cause of "queue stuck at running"): the queue
// dispatch path called handleChatMessage with text from
// buildArtifactRunText, which did NOT include the [run:plan#<id>]
// marker. handleChatMessage's marker-parsing regex
// (/\[run:(plan|test|arch|td|fr|bug)#…]/) only set
// session._activeRunItem when the marker was present — so queue
// dispatches never set _activeRunItem, and ANY terminal event
// (turn_result OR iteration_aborted OR fatal) found a null active
// and short-circuited. The queue entry stayed `running` forever.
//
// Fix: buildArtifactRunText + buildArtifactQuorumText now prepend
// the [run:<type>#<id>] marker to the header line. Both manual
// ▶ Run (chat-input submit, pre-unification) and queue dispatch
// (post-unification) now produce text that handleChatMessage parses
// correctly.

const assert = require('assert');
const artifacts = require('../server/src/artifacts');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── fr-48 bugfix: dispatch text includes [run:<type>#<id>] marker ──');

t('buildArtifactRunText output starts with [run:plan#<id>] marker', () => {
  const item = { id: 'bug-1', text: 'fix the thing', layer: 'Bug' };
  const text = artifacts.buildArtifactRunText('plan', item, 'kkrazy');
  assert.match(text, /^\[run:plan#bug-1\]/,
    'first chars must be [run:plan#bug-1] so handleChatMessage marker regex matches → _activeRunItem set');
});

t('buildArtifactRunText output still includes submitter + body text', () => {
  const item = { id: 'fr-43', text: 'add retry loop', layer: 'Feature' };
  const text = artifacts.buildArtifactRunText('plan', item, 'kkrazy');
  assert.match(text, /submitted by @kkrazy/, 'submitter chip preserved');
  assert.match(text, /add retry loop/, 'item body preserved');
});

t('buildArtifactQuorumText output starts with [run:plan#<id>] marker too', () => {
  const item = { id: 'td-22', text: 'do the thing', voters: ['alice', 'bob'] };
  const text = artifacts.buildArtifactQuorumText('plan', item);
  assert.match(text, /^\[run:plan#td-22\]/,
    'quorum-fired dispatches also need the marker — same handleChatMessage code path');
});

t('marker regex (from attach.js handleChatMessage) matches buildArtifactRunText output', () => {
  // Mirror the exact regex in attach.js so we know handleChatMessage
  // will set _activeRunItem on this text.
  const RUN_MARKER_RE = /\[run:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/;
  for (const id of ['bug-1', 'fr-43', 'td-22', 'bug-16']) {
    const text = artifacts.buildArtifactRunText('plan', { id, text: 'x' }, 'kkrazy');
    const m = text.match(RUN_MARKER_RE);
    assert.ok(m, `marker regex must match buildArtifactRunText output for ${id}`);
    assert.strictEqual(m[1], 'plan');
    assert.strictEqual(m[2], id);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
