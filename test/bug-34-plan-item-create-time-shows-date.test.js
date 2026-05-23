// bug-34 regression: the plan-item "filed at" timestamp must include
// the date — not just the hour:minute.
//
// User report: "Plan item view's create time is ambiguous because
// it only shows time-of-day. Expected: Create time displays the
// date (and time)."
//
// Pre-fix: the renderItem helper inside renderArtifact used
// formatChatTs(it.addedAt), which returns only HH:MM — fine for chat
// bubbles in a same-day session but genuinely ambiguous for plan
// items that can be days, weeks, or months old.
//
// Fix: new helper formatChatTsWithDate(iso) returns "MMM D, YYYY,
// HH:MM" (browser/Node toLocaleString shape). Wired into the
// "filed by …" byline at line ~6568 of web/public/app.js.
//
// Scope: ONLY the plan-item byline. Adjacent timestamps (comment ts,
// artifact "Updated" banner) still use the time-only formatChatTs —
// they're inside different visual contexts and were not in the
// user's bug-34 report. If the same ambiguity bites those, a
// follow-up bug should switch them.
//
// Static guards on app.js + a behavior simulation of the formatter
// against a fixed-instant input so the output shape is pinned
// across locales.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-34: plan-item create time includes the date ──');

// ──────────────────────────────────────────────────────────────────────
// formatChatTsWithDate must exist and have the right shape
// ──────────────────────────────────────────────────────────────────────

t('formatChatTsWithDate is defined in app.js', () => {
  assert.ok(/function\s+formatChatTsWithDate\s*\(/.test(APP),
    'app.js must declare a `formatChatTsWithDate(iso)` helper (separate from formatChatTs so chat bubbles can keep their compact time-only display)');
});

t('formatChatTsWithDate uses toLocaleString with year + month + day + hour + minute', () => {
  // Anchor the format options so future locale tweaks can\'t silently
  // regress to time-only.
  const start = APP.search(/function\s+formatChatTsWithDate\s*\(/);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/toLocaleString\s*\(/.test(body),
    'formatChatTsWithDate must call toLocaleString (not toLocaleTimeString, which is what made bug-34 happen for plan items)');
  // Each of the four required parts must be requested in the options.
  for (const part of [
    /year:\s*['"]numeric['"]/,
    /month:\s*['"](?:short|long|numeric|2-digit)['"]/,
    /day:\s*['"](?:numeric|2-digit)['"]/,
    /hour:\s*['"]2-digit['"]/,
    /minute:\s*['"]2-digit['"]/,
  ]) {
    assert.ok(part.test(body),
      'formatChatTsWithDate options must include ' + part);
  }
});

t('formatChatTsWithDate is null-safe (no Jan 1, 1970 footgun)', () => {
  // new Date(null) resolves to epoch; with default formatting that
  // surfaces as "Jan 1, 1970" — a clear failure mode for a "filed at"
  // line. The helper must short-circuit on null / undefined / ''.
  const start = APP.search(/function\s+formatChatTsWithDate\s*\(/);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/iso\s*===\s*null|iso\s*==\s*null|!iso/.test(body),
    'formatChatTsWithDate must short-circuit on null/undefined/"" so it doesn\'t render "Jan 1, 1970"');
});

// ──────────────────────────────────────────────────────────────────────
// The byline call site must use the new helper (was formatChatTs)
// ──────────────────────────────────────────────────────────────────────

t('plan-item byline uses formatChatTsWithDate (not formatChatTs)', () => {
  // The byline shape contains "filed by @" + addedBy + the ts. Pin
  // that the ts formatter is the new one.
  const bylineRe = /artifact-item-by[\s\S]{0,300}formatChatTsWithDate\s*\(\s*it\.addedAt\s*\)/;
  assert.ok(bylineRe.test(APP),
    'The artifact-item-by div (plan-item "filed by … · <ts>" line) must call formatChatTsWithDate(it.addedAt) — not formatChatTs which is time-only and caused bug-34');
  // Negative: the OLD formatChatTs call on it.addedAt must be gone.
  assert.ok(!/artifact-item-by[\s\S]{0,300}formatChatTs\s*\(\s*it\.addedAt\s*\)/.test(APP),
    'The plan-item byline must NOT still call formatChatTs(it.addedAt) — that re-introduces bug-34 (time-only display)');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — re-implement the helper inline + assert its
// shape on fixed inputs. Locale-independent: we check that the
// numeric year + 2-digit hour:minute pattern appear in the output.
// ──────────────────────────────────────────────────────────────────────

function formatChatTsWithDateRef(iso) {
  if (iso === null || iso === undefined || iso === '') return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

t('behavior: valid ISO produces a year + time string', () => {
  const out = formatChatTsWithDateRef('2026-04-12T09:15:00Z');
  // The output must contain "2026" (the year — bug-34 fix) AND a
  // 2-digit hour:minute (the time). Locale formatting may put them
  // in different orders but both must appear.
  assert.ok(/2026/.test(out), 'output must include the year — got: ' + out);
  assert.ok(/\d{2}:\d{2}/.test(out), 'output must include HH:MM — got: ' + out);
  assert.ok(/Apr/.test(out) || /04/.test(out) || /\b4\b/.test(out),
    'output must include the month (Apr / 04 / 4) — got: ' + out);
});

t('behavior: null / undefined / "" return empty string (no epoch footgun)', () => {
  assert.strictEqual(formatChatTsWithDateRef(null), '',
    'null input must return "" — not "Jan 1, 1970"');
  assert.strictEqual(formatChatTsWithDateRef(undefined), '',
    'undefined input must return "" — not "Jan 1, 1970"');
  assert.strictEqual(formatChatTsWithDateRef(''), '',
    'empty string must return "" — not "Jan 1, 1970"');
});

t('behavior: invalid date string returns empty', () => {
  assert.strictEqual(formatChatTsWithDateRef('not-a-date'), '',
    'unparseable date must return ""');
});

t('behavior: bug-34 repro — two items same time-of-day different days are distinguishable', () => {
  // Pre-fix both would render as "14:32" — ambiguous. Post-fix the
  // year/month/day prefix makes them visibly different.
  const a = formatChatTsWithDateRef('2026-04-12T14:32:00Z');
  const b = formatChatTsWithDateRef('2026-05-23T14:32:00Z');
  assert.notStrictEqual(a, b,
    'Two items filed at the same time-of-day on different days must produce DIFFERENT output strings (the whole point of bug-34) — got identical: ' + a);
});

// ──────────────────────────────────────────────────────────────────────
// Scope guard — adjacent timestamps STILL use formatChatTs (not the
// new helper). This is intentional per the bug-34 report scope, and
// pinning it prevents an accidental over-broad refactor.
// ──────────────────────────────────────────────────────────────────────

t('chat-bubble timestamps still use formatChatTs (intentional scope guard)', () => {
  // The renderChatMessage path that builds chat bubble ts must keep
  // formatChatTs — those are same-day inside a session, time-only is
  // the right shape.
  const callers = (APP.match(/formatChatTs\s*\(/g) || []).length;
  // Pre-bug-34: 5 calls. Post-fix: -1 (the plan-item byline) = 4.
  // We allow >=3 to keep some slack for future call-site additions.
  assert.ok(callers >= 3,
    'formatChatTs is still used for chat bubbles + (intentionally) comment + Updated banner timestamps. Found only ' + callers + ' calls — looks like an over-broad refactor that swept past the bug-34 scope.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
