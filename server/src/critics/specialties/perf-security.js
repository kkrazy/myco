// fr-95: Perf/Security critic specialty. Fires alongside the General
// critic on every FINAL critique. Verdict is informational — does NOT
// gate the run queue (only General gates).
//
// Focus splits cleanly into two narrow buckets:
//
//   PERF — quantifiable runtime regressions: O(N²) where O(N) would
//   do, unbounded loops, repeated parsing of the same large input,
//   sync-fs in a hot path, n+1 DB/HTTP patterns. NOT premature
//   optimization scolding — only call out perf regressions that would
//   show up under realistic load (the myco context: ~1-100 sessions
//   per host, each with ~1-100 plan items, ~100 KB of chat history;
//   files under ~64 KB; tests run in <30 s).
//
//   SECURITY — concrete, exploitable risks: secrets logged to stdout
//   or persisted to artifacts; unsanitized user input flowing into
//   shell / SQL / HTML / regex; auth checks missing on routes that
//   touch /data; CORS / CSRF gaps; PATs / tokens / .env contents
//   appearing in error messages or returned by API. Cite the specific
//   line + the exact attack vector. NOT theoretical risks ("could be
//   exploited if an attacker had X" where X is implausible).
//
// The General critic still covers broad QA + security; this critic
// owns the deeper pass on perf-regressions + concrete security
// risks, with sharper expectations on specificity.

// bug-65: systemSuffix extracted to perf-security.md sibling (loaded
// via fs.readFileSync at module-load time). Edit perf-security.md to
// change the prompt; server restart picks up the new content. Also
// bug-63 (in flight): the "✓ AGREED is INFORMATIONAL" framing was
// REMOVED — Perf/Security findings now participate in the overall
// hasDisagreement aggregation per the bug-63 flip.
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'perf-security',
  name: 'Perf / Security',
  systemSuffix: '\n' + fs.readFileSync(path.join(__dirname, 'perf-security.md'), 'utf8'),
};
