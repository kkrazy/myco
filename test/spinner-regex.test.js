// Regression: SPINNER_RUNNING_RE and SPINNER_DURATION_RE drive the
// "claude is actively working NOW" signal that gates the chat-pane
// typing indicator. They previously matched both -ing and -ed verbs,
// which caused past-tense "done with phase" lines like "✻ Brewed for
// 1m 25s" to keep the indicator alive long after claude went idle.
//
// The fix: require -ing (present-continuous = actively running). The
// new SPINNER_DONE_RE captures the -ed shape separately so future
// callers can label completed phases without re-triggering the
// indicator's lifetime.

const assert = require('assert');
const {
  SPINNER_RUNNING_RE,
  SPINNER_DURATION_RE,
  SPINNER_DONE_RE,
} = require('../server/src/pty-patterns');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

const isRunning = (s) => SPINNER_RUNNING_RE.test(s) || SPINNER_DURATION_RE.test(s);
const isDone    = (s) => SPINNER_DONE_RE.test(s);

console.log('── spinner regex: -ing vs -ed ──');

// Active (-ing): drives the typing indicator. The teardrop-asterisk
// (✢=U+2722) and six-pointed/asterisk variants (✶ ✷ ✸ ✱) were missing
// from the original glyph class — a turn like "✢ Writing exportRoutes…"
// silently failed to register and the chat-pane status went blank
// mid-phase.
for (const text of [
  '· Moonwalking',
  '✽ Crunching',
  '✻ Thundering',
  '· Working',
  '· Working for 3s',
  '· Cerebrating for 12s',
  '· Cerebrating for 1m 5s',
  '✽ Cerebrating for 12s · ↓ 3.4k tokens',
  '✢ Writing exportRoutes',
  '✢ Writing exportRoutes for 1m 40s · ↓ 7.6k tokens',
  '✣ Pondering',
  '✱ Brewing',
  '✶ Synthesizing for 8s',
  '✼ Composing',
]) {
  t(`ACTIVE: ${JSON.stringify(text)}`, () => {
    assert.strictEqual(isRunning(text), true, `should match running: ${text}`);
    assert.strictEqual(isDone(text), false, `should not match done: ${text}`);
  });
}

// Done-with-phase (-ed): captured but does NOT drive the indicator.
// The user-reported stuck-indicator value was "Brewed for 1m 25s".
for (const text of [
  '✻ Brewed for 51s',
  '✻ Brewed for 1m 25s',     // ← exact text the user reported as stuck
  '✻ Baked for 15s',
  '✻ Cooked for 13s',
  '✻ Churned for 4s',
]) {
  t(`DONE: ${JSON.stringify(text)}`, () => {
    assert.strictEqual(isRunning(text), false, `must NOT trigger indicator: ${text}`);
    assert.strictEqual(isDone(text), true, `should match done: ${text}`);
  });
}

// Negative cases: incidental prose with -ing or -ed substrings that
// don't have the spinner glyph prefix must NOT match either pattern.
for (const text of [
  'reviewed the diff',
  'something interesting happened',
  '1. Cooking dinner [no glyph]',
  '  ed',                         // bare 'ed'
  '✻',                            // glyph alone
]) {
  t(`NEGATIVE: ${JSON.stringify(text)}`, () => {
    assert.strictEqual(isRunning(text), false, `should not match running: ${text}`);
    assert.strictEqual(isDone(text), false, `should not match done: ${text}`);
  });
}

// Duration tail must tolerate compound formats. Without "1m 25s"
// support, the user-reported stuck state would have escaped both
// regexes — fine for the indicator (it stays null), but the DONE
// regex would no longer label long-phase summaries either.
t('SPINNER_DONE_RE handles 1m 25s and 2h 5m 30s', () => {
  assert.strictEqual(isDone('✻ Brewed for 1m 25s'), true);
  assert.strictEqual(isDone('✻ Brewed for 2h 5m 30s'), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
