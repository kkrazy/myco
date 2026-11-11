// bug-39: model output with LaTeX math is not rendered — e.g.
//   $$\frac{100}{10 - 1} = 11.\overline{1} \text{ 秒}$$
//   $$v(t) = \lim_{h \to 0} \frac{x(t+h) - x(t)}{h}$$
// marked mangles the $$...$$ (underscores → emphasis, backslashes
// dropped) instead of rendering math.
//
// Fix: vendor KaTeX (offline) and render math inside renderMd via a
// protect-before-marked / restore-after-sanitize placeholder swap.
// KaTeX.renderToString is synchronous, so the change is localized to
// renderMd (renderMarkdownFileView already delegates to it).
//
// Guards:
//   1. KaTeX is vendored + loads in node, and renders the user's exact
//      display-math strings without throwing → produces .katex HTML.
//   2. index.html loads katex.min.js + katex.min.css from /vendor.
//   3. renderMd protects math BEFORE marked.parse and restores it AFTER
//      _postProcessRenderedMd (so KaTeX HTML isn't stripped by the
//      tag-allowlist sanitizer).
//   4. _extractMath handles $$…$$, \[…\], \(…\), $…$ and renders via
//      katex.renderToString.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'public', 'index.html'), 'utf8');

console.log('── bug-39: LaTeX math renders via vendored KaTeX ──');

t('KaTeX is vendored and renders the user\'s exact display-math (no throw)', () => {
  const katexPath = path.join(ROOT, 'web', 'public', 'vendor', 'katex.min.js');
  assert.ok(fs.existsSync(katexPath), 'web/public/vendor/katex.min.js must exist');
  const katex = require(katexPath);
  assert.strictEqual(typeof katex.renderToString, 'function',
    'vendored katex must expose renderToString');
  // The two exact strings from the bug report.
  const samples = [
    '\\frac{100}{10 - 1} = 11.\\overline{1} \\text{ 秒}',
    'v(t) = \\lim_{h \\to 0} \\frac{x(t+h) - x(t)}{h}',
  ];
  for (const tex of samples) {
    let out;
    assert.doesNotThrow(() => {
      out = katex.renderToString(tex, { displayMode: true, throwOnError: true });
    }, `katex must render ${JSON.stringify(tex)} without throwing`);
    assert.ok(/class="katex/.test(out),
      'katex output must contain a .katex element');
  }
});

t('KaTeX fonts are vendored (woff2) so it renders offline', () => {
  const fontsDir = path.join(ROOT, 'web', 'public', 'vendor', 'fonts');
  assert.ok(fs.existsSync(fontsDir), 'vendor/fonts dir must exist');
  const woff2 = fs.readdirSync(fontsDir).filter((f) => /^KaTeX_.*\.woff2$/.test(f));
  assert.ok(woff2.length >= 15,
    `expected the KaTeX woff2 font set to be vendored (got ${woff2.length})`);
});

t('index.html loads katex.min.js + katex.min.css from /vendor', () => {
  assert.ok(/<script[^>]+src=["']\/vendor\/katex\.min\.js["']/.test(HTML),
    'index.html must load /vendor/katex.min.js');
  assert.ok(/<link[^>]+href=["']\/vendor\/katex\.min\.css["']/.test(HTML),
    'index.html must load /vendor/katex.min.css');
});

t('renderMd protects math before marked.parse and restores after sanitize', () => {
  const idx = APP.search(/function\s+renderMd\s*\(/);
  assert.ok(idx > -1, 'renderMd must be defined');
  const fn = sliceFn(APP, idx);
  const extractIdx = fn.search(/_extractMath\s*\(/);
  const parseIdx = fn.search(/marked\.parse\s*\(/);
  const postIdx = fn.search(/_postProcessRenderedMd\s*\(/);
  const restoreIdx = fn.search(/_restoreMath\s*\(/);
  assert.ok(extractIdx > -1, 'renderMd must call _extractMath');
  assert.ok(restoreIdx > -1, 'renderMd must call _restoreMath');
  assert.ok(extractIdx < parseIdx,
    '_extractMath must run BEFORE marked.parse (protect math from markdown mangling)');
  assert.ok(restoreIdx > postIdx,
    '_restoreMath must run AFTER _postProcessRenderedMd (so KaTeX HTML bypasses the tag sanitizer)');
});

t('_extractMath handles $$…$$ / \\[…\\] / \\(…\\) / $…$ via katex.renderToString', () => {
  const idx = APP.search(/function\s+_extractMath\s*\(/);
  assert.ok(idx > -1, '_extractMath must be defined');
  const fn = sliceFn(APP, idx);
  assert.ok(/katex\.renderToString/.test(fn),
    '_extractMath must render via katex.renderToString');
  // Display + inline delimiter handling.
  assert.ok(/\\\$\\\$|\$\$/.test(fn), '_extractMath must handle $$ display math');
  assert.ok(/displayMode/.test(fn), '_extractMath must pass displayMode for block math');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
