// USER_MANUAL.md must stay onboarding-focused — keeps internal jargon
// + ticket IDs out of the user-facing surface.
//
// User report (kkrazy 2026-05-26): "update the user manual focusing
// on getting user onboard. Shouldn't mention fr-82, shouldn't have
// stderr, etc."
//
// Static-grep guards. Specific banned strings (`fr-82`, `stderr`) +
// a few sibling category leaks the user implied with "etc." (raw
// env-var caps, container-path internals). If a future edit re-adds
// any of them this test red-flips.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const MANUAL = fs.readFileSync(
  path.join(__dirname, '..', 'USER_MANUAL.md'), 'utf8');

console.log('── USER_MANUAL.md: onboarding-focused, no internal jargon ──');

t('manual: must not mention `fr-82` (or the multi-account aliases system as a feature name)', () => {
  assert.ok(!/\bfr-82\b/i.test(MANUAL),
    'USER_MANUAL.md must not reference `fr-82` (user explicitly said no)');
  // The feature surface (`/setpat ... --as <alias>`) can stay if it's
  // ever needed, but the user's onboarding pass shouldn't lead with
  // a multi-account section — pin that there is no `--as <alias>`
  // worked example on the first page either.
  assert.ok(!/--as\s+<alias>/.test(MANUAL),
    'manual should not advertise the `--as <alias>` multi-account form on the onboarding surface');
});

t('manual: must not mention `stderr` (internal stream-cap detail)', () => {
  assert.ok(!/\bstderr\b/i.test(MANUAL),
    'USER_MANUAL.md must not reference `stderr` (user explicitly said no)');
});

t('manual: must not leak raw env-var or filesystem-internal jargon', () => {
  // Things the user calls out as "etc." — env-var caps, container
  // paths, daemon options. None belong in a user-facing onboarding
  // guide.
  const banned = [
    /GIT_TERMINAL_PROMPT/,
    /MAX_CHAT_(MESSAGES|BYTES)/,
    /\/data\//,
    /\/wks\//,
  ];
  for (const re of banned) {
    assert.ok(!re.test(MANUAL),
      `manual must not leak internal token matching ${re}`);
  }
});

t('manual: leads with the onboarding flow (Sign in → New session → /git clone)', () => {
  // The first 800 chars should set up the path a brand-new user takes
  // before any reference doc. Pin that the three load-bearing steps
  // appear in order near the top.
  const head = MANUAL.slice(0, 1200);
  const signIdx  = head.search(/[Ss]ign in/);
  const newIdx   = head.search(/New session/);
  const cloneIdx = head.search(/\/git clone/);
  assert.ok(signIdx > -1,  'manual must mention Sign in early');
  assert.ok(newIdx  > -1,  'manual must mention New session early');
  assert.ok(cloneIdx > -1, 'manual must mention /git clone early');
  assert.ok(signIdx < newIdx && newIdx < cloneIdx,
    'order must be Sign in → New session → /git clone (the user\'s actual first 60 seconds)');
});

t('manual: keeps the load-bearing slash-commands present as a quick reference', () => {
  // Reference section still needs to exist — trimming for onboarding
  // doesn\'t mean dropping the surface.
  for (const cmd of ['/td', '/fr', '/bug', '/git', '/queue', '/setpat']) {
    assert.ok(MANUAL.includes(cmd),
      `manual must still list ${cmd} in the reference section`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
