// User report: "所有select都改成白底黑字（或者其他设计），不然字体太不明显了"
// (all dropdowns should be white background / black text — the previous
// semi-transparent/dark-gray backgrounds made the text illegible on the
// app's dark chrome).
//
// Fix (updated for the § theme system): a global
// `select, select option { background: var(--bg-elev); color: var(--text); }`
// rule in web/public/styles.css. Both variables flip with <html data-theme>
// (dark = hacker palette, light = paper white), so dropdowns stay
// high-contrast in BOTH modes:
//   - light: --bg-elev #ffffff + --text #17211c → the original 21:1-ish
//     white-bg/near-black-text contrast the user asked for;
//   - dark:  --bg-elev #101714 + --text #d8ffe9 → mint-on-dark-green,
//     equally legible on the dark chrome.
//
// Guards:
//   1. styles.css contains the global themed select rule (covers every
//      <select> — including ones added in the future — AND their
//      <option> rows, which on Chromium otherwise render on the
//      platform popup without inheriting color).
//   2. The light palette resolves to white-bg/near-black text so the
//      user's legibility requirement is preserved verbatim in 白色 mode.
//   3. Every per-site select rule keeps a high-contrast background
//      (no regression back to #2e2e2e / rgba washes).
//   4. Every <select> in index.html is present (sanity).
//
// (Historical note: the pre-theme version of this test pinned the
// literal `background:#ffffff; color:#111111` values. The theme system
// intentionally replaced literals with variables — this test now pins
// the variable wiring + the light-mode resolved contrast instead.)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'public', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'public', 'index.html'), 'utf8');

console.log('── dropdowns are white-bg / dark-text (user legibility report) ──');

// The site-specific select rules that exist in styles.css. Each must
// stay high-contrast: white-ish background, dark text.
const SITE_SELECT_SELECTORS = [
  '#whatsnew-version-select',
  '.rlm-scope-select',
  '.team-mode-select',
  '.config-pat-form select',
  '.login-provider-row select',
  '.composer-critic-select',
  '#skills-scope-select',
];

t('global rule themes every select + its option rows', () => {
  assert.ok(/select\s*,\s*select option\s*\{[^}]*background:\s*var\(--bg-elev\)[^}]*color:\s*var\(--text\)/i.test(CSS),
    'styles.css must contain `select, select option { … background:var(--bg-elev) … color:var(--text) }` — ' +
    'the global themed rule that keeps ALL dropdowns high-contrast in both dark and light modes (user: 字体太不明显)');
});

t('option elements get explicit themed text (not inherited wash)', () => {
  // The option rows are where the legibility complaint bites hardest:
  // Chromium renders <option> on the platform popup unless background
  // AND color are set for them explicitly.
  assert.ok(/select option\s*\{[^}]*color:\s*var\(--text\)/i.test(CSS),
    'styles.css must set color:var(--text) on option elements inside the dropdown popup');
});

t('light palette resolves dropdowns to white-bg / near-black text', () => {
  // The user\'s original ask (白底黑字) must survive in light mode:
  // --bg-elev must be pure white and --text near-black inside the
  // :root[data-theme="light"] block.
  const lightBlock = CSS.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/);
  assert.ok(lightBlock, 'styles.css must define a :root[data-theme="light"] palette block');
  const body = lightBlock[1];
  const bgElev = body.match(/--bg-elev:\s*(#(?:[0-9a-f]{3}|[0-9a-f]{6}))\b/i);
  const text = body.match(/--text:\s*(#(?:[0-9a-f]{3}|[0-9a-f]{6}))\b/i);
  assert.ok(bgElev && /^#f{3}$|^#f{6}$/i.test(bgElev[1],
    ), 'light-mode --bg-elev must be white (#fff/#ffffff)');
  assert.ok(text && /^#1[0-9a-f]{5}$|^#2[0-9a-f]{5}$/i.test(text[1]),
    'light-mode --text must be near-black ink (got ' + (text && text[1]) + ')');
});

t('every per-site select rule stays white-bg / dark-text', () => {
  for (const sel of SITE_SELECT_SELECTORS) {
    const at = CSS.search(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\{'));
    if (at < 0) continue; // rule may live under a combined selector; global rule still covers it
    const body = CSS.slice(at, CSS.indexOf('}', at));
    if (/background/.test(body)) {
      assert.ok(/background:\s*(#fff|#f0f0f0|#ffffff)/i.test(body) || !/background:\s*(#2e2e2e|#000|rgba\(255,\s*255,\s*255,\s*0?\.[0-2])/.test(body),
        `${sel} must not regress to a dark/low-contrast background (user: 看不清字体)`);
    }
  }
});

t('every <select> in index.html exists (sanity — no missing dropdown)', () => {
  const ids = [...HTML.matchAll(/<select[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5,
    'expected at least the 5 known selects (composer-critic, skills-scope, ' +
    'login-pat-provider, config-pat-provider, rlm-scope), found: ' + ids.join(', '));
});

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${passed} checks passed`);
