// bug-36 (kkrazy 2026-05-27): "the 'build' button doesn't send the
// full content including the description and the comments, it only
// send the title — claude is rewriting this into issue format,
// should cover fix and run buttons".
//
// Root cause: after fr-80 r6 introduced item.description (the
// Problem/Expected/Actual body the auto-rewrite drops there),
// buildArtifactRunText + buildArtifactQuorumText in
// server/src/artifacts.js still only emitted item.text + comments.
// So when the user clicks ▶ Run / Fix / Implement / Do (all four
// labels route through the same dispatcher), claude only saw the
// one-line title and the comment thread — the description was
// silently dropped, and claude often rewrote the prompt to fill
// the gap instead of using the body the user already wrote.
//
// Fix: insert item.description between item.text and the comments
// block in BOTH builders. Empty / missing description renders
// nothing (preserving the pre-fr-80 shape for old items).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const artifacts = require('../server/src/artifacts');
const { buildArtifactRunText, buildArtifactQuorumText } = artifacts;

console.log('── bug-36: Run/Fix/Implement dispatch must include item.description ──');

t('artifacts.js: buildArtifactRunText + buildArtifactQuorumText are exported', () => {
  // Both builders live on the module\'s public surface — used by
  // attach.js + artifacts.js itself for the queue + quorum paths.
  assert.ok(typeof buildArtifactRunText === 'function',
    'artifacts.buildArtifactRunText must be exposed');
  assert.ok(typeof buildArtifactQuorumText === 'function',
    'artifacts.buildArtifactQuorumText must be exposed');
});

t('buildArtifactRunText: includes item.description when present', () => {
  const item = {
    id: 'fr-99',
    text: 'add dark-mode toggle',
    description: '**Problem:** users squinting at night.\n**Expected:** a toggle in the settings.\n**Actual:** no toggle.',
    comments: [],
  };
  const out = buildArtifactRunText('plan', item, 'kkrazy');
  assert.ok(out.includes('add dark-mode toggle'),
    'dispatch must include item.text (title)');
  assert.ok(out.includes('**Problem:** users squinting'),
    'dispatch must include item.description body — was silently dropped pre-bug-36');
  assert.ok(out.includes('**Expected:** a toggle'),
    'dispatch must include the rest of the description, not just the first line');
});

t('buildArtifactRunText: description sits between text and comments (clear ordering)', () => {
  const item = {
    id: 'fr-99',
    text: 'TITLE',
    description: 'DESCRIPTION',
    comments: [{ user: 'alice', text: 'COMMENT' }],
  };
  const out = buildArtifactRunText('plan', item, 'kkrazy');
  const titleIdx = out.indexOf('TITLE');
  const descIdx  = out.indexOf('DESCRIPTION');
  const commIdx  = out.indexOf('COMMENT');
  assert.ok(titleIdx > -1 && descIdx > -1 && commIdx > -1,
    'all three sections must be present');
  assert.ok(titleIdx < descIdx,
    'title must come before description (description is the body, not a footer)');
  assert.ok(descIdx < commIdx,
    'description must come before the Comments block (descriptions are the item body; comments are discussion atop it)');
});

t('buildArtifactRunText: omits description when absent (back-compat with pre-fr-80 items)', () => {
  const item = {
    id: 'fr-99',
    text: 'pre-fr-80 item with no description',
    comments: [],
  };
  const out = buildArtifactRunText('plan', item, 'kkrazy');
  assert.ok(out.includes('pre-fr-80 item with no description'),
    'title still present');
  // No extra blank lines / stray "undefined" / "null" leak when no description.
  assert.ok(!/\bundefined\b/.test(out), 'no "undefined" in output');
  assert.ok(!/\bnull\b/.test(out),      'no "null" in output');
});

t('buildArtifactRunText: handles empty-string description as absent', () => {
  const item = {
    id: 'fr-99',
    text: 'title',
    description: '',
    comments: [],
  };
  const out = buildArtifactRunText('plan', item, 'kkrazy');
  // Empty description should produce the same shape as missing one
  // (no stray blank lines before Comments).
  assert.ok(!/\n\n\n/.test(out),
    'empty description must not introduce triple-blank-lines (looks like the body is missing)');
});

t('buildArtifactQuorumText: also includes item.description (quorum auto-fire uses same shape)', () => {
  const item = {
    id: 'fr-99',
    text: 'TITLE',
    description: 'DESCRIPTION-BODY',
    voters: ['alice', 'bob', 'carol'],
    comments: [],
  };
  const out = buildArtifactQuorumText('plan', item);
  assert.ok(out.includes('TITLE'), 'quorum text must include title');
  assert.ok(out.includes('DESCRIPTION-BODY'),
    'quorum text must include description — same fr-80 r6 fix needed here');
});

t('buildArtifactRunText: comments still included (no regression of original Comments block)', () => {
  const item = {
    id: 'fr-99',
    text: 'title',
    description: 'body',
    comments: [
      { user: 'alice', text: 'first comment' },
      { user: 'bob',   text: 'second comment' },
    ],
  };
  const out = buildArtifactRunText('plan', item, 'kkrazy');
  assert.ok(out.includes('Comments:'),
    'Comments: header must still appear');
  assert.ok(out.includes('first comment'),  'comment 1 must appear');
  assert.ok(out.includes('second comment'), 'comment 2 must appear');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
