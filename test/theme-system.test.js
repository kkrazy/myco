// Theme system — premium hacker palette + one-click dark ⇄ light toggle.
//
// Requirements (user, 2026-10-23):
//   1. 配色增加高级感（黑客）— a premium hacker aesthetic as the DEFAULT
//      (dark) palette, expressed entirely through CSS variables.
//   2. 增加配色系统 — a real theme TOKEN system, not scattered hex values.
//   3. 支持黑白两种配色（一键切换夜间模式）— a light ("white") palette
//      alongside the dark one, switchable with ONE click, persisted.
//
// Static-grep guards (same style as sidebar-manual-link.test.js):
//   styles.css  — both palettes exist, same token set, keyed off
//                 data-theme on :root; legacy aliases (--surface, --muted)
//                 kept so existing rules re-theme for free.
//   index.html  — #btn-theme toggle button with moon/sun SVGs; meta
//                 theme-color updated to the new dark floor.
//   app.js      — applyTheme()/currentTheme()/toggleTheme()/bindThemeToggle();
//                 persisted in localStorage `myco_theme`; wired at
//                 DOMContentLoaded boot.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── theme system: tokens + dark/light one-click toggle ──');

// ── styles.css: both palettes, same token set ──
t('styles.css: dark palette on ":root, :root[data-theme=dark]"', () => {
  assert.ok(/:root,\s*:root\[data-theme="dark"\]\s*\{/.test(CSS),
    'the default dark palette must be keyed on :root AND :root[data-theme="dark"] so an explicit dark attribute (set by applyTheme) resolves identically');
});

t('styles.css: light palette on :root[data-theme=light]', () => {
  assert.ok(/:root\[data-theme="light"\]\s*\{/.test(CSS),
    'the light palette must be keyed on :root[data-theme="light"] — the single attribute applyTheme flips');
});

// Extract the variable NAMES declared inside each theme block.
function themeVarNames(attr) {
  const re = attr === 'dark'
    ? /:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/
    : /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/;
  const m = CSS.match(re);
  assert.ok(m, 'theme block ' + attr + ' must exist');
  return [...m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]);
}

t('styles.css: both palettes declare the SAME color token set (no half-themed mode)', () => {
  const colorish = (n) => /^--(bg|bg-elev|surface|surface-2|panel|border|text|text-dim|muted|accent|danger|sel|shadow|link)/.test(n);
  const dark = new Set(themeVarNames('dark').filter(colorish));
  const light = new Set(themeVarNames('light').filter(colorish));
  for (const tok of light) {
    assert.ok(dark.has(tok),
      'token ' + tok + ' exists in light but not dark — every themed color must exist in BOTH palettes');
  }
  for (const tok of ['--bg', '--surface', '--border', '--text', '--accent', '--accent-2', '--danger']) {
    assert.ok(dark.has(tok) && light.has(tok),
      'core token ' + tok + ' missing from a palette');
  }
});

t('styles.css: dark default = hacker palette (deep green-black floor + neon mint accent)', () => {
  const m = CSS.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  const block = m[1];
  assert.ok(/--accent:\s*#00ff9c/.test(block),
    'dark --accent must be the neon mint #00ff9c (hacker brand signal)');
  assert.ok(/--accent-2:\s*#23d5ff/.test(block),
    'dark --accent-2 must be the cyan secondary #23d5ff');
  assert.ok(/--bg:\s*#0a0e0c/.test(block),
    'dark --bg must be the near-black green-cast floor #0a0e0c');
});

t('styles.css: light palette is a readable white (paper/ink, darkened accent for AA)', () => {
  const m = CSS.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
  const block = m[1];
  assert.ok(/--bg:\s*#f4f6f5/.test(block) && /--surface:\s*#ffffff/.test(block),
    'light --bg/--surface must be near-white');
  assert.ok(/--text:\s*#17211c/.test(block),
    'light --text must be near-black ink for contrast');
  assert.ok(/--accent:\s*#00a86a/.test(block),
    'light --accent must be #00a86a (neon mint darkened for AA on white — NOT #00ff9c which fails contrast)');
});

t('styles.css: light theme flips the top-right chrome cluster to white bg + ink icons', () => {
  // The floating top-right icon band (#btn-chat home, #btn-files folder,
  // #btn-plan/#btn-arch/#btn-test/#btn-skills) hardcodes a dark-glass bg
  // (rgba(40,40,40,.85)) — under the light theme it rendered as black
  // squares on the white pane. The light override must cover every
  // cluster button with a white background + ink (currentColor) icons.
  const cluster = ['btn-chat', 'btn-files', 'btn-plan', 'btn-arch', 'btn-test', 'btn-skills'];
  for (const id of cluster) {
    const m = CSS.match(new RegExp(':root\\[data-theme="light"\\] #' + id + '[^{]*\\{([^}]*)\\}'));
    assert.ok(m, 'light override for #' + id + ' must exist — black square on white pane otherwise');
    assert.ok(/background:\s*rgba\(255,\s*255,\s*255/.test(m[1]),
      '#' + id + ' light override must set a white background');
    assert.ok(/color:\s*#17211c/.test(m[1]),
      '#' + id + ' light override must set ink foreground so the SVG (currentColor) goes black-on-white');
  }
  // Active state must stay readable on white: light accent tint, not the
  // dark-mode blue-alpha + #aac8ff pastel icon.
  assert.ok(/:root\[data-theme="light"\] #btn-files\.active[^{]*\{[^}]*var\(--accent-dim\)/.test(CSS),
    'light active state must use var(--accent-dim) tint — rgba(80,120,200,.35) is a dark-theme treatment');
  assert.ok(/:root\[data-theme="light"\] #btn-files\.active[^{]*\.chrome-icon-svg\s*\{\s*color:\s*#007a4d/.test(CSS),
    'light active icon tint must be ink-green — #aac8ff pastel washes out on white');
  // Dark theme must stay unchanged: the dark-glass bg still exists for
  // the base (non-light-scoped) rule.
  assert.ok(/#btn-files\s*\{[^}]*rgba\(40, 40, 40, \.85\)/.test(CSS),
    'dark theme keeps the original dark-glass chrome buttons — light rules must be additive only');
});

t('styles.css: legacy aliases kept (--surface, --muted, --text-dim aliasing)', () => {
  const dark = CSS.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)[1];
  const light = CSS.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(/--panel:\s*#121a16/.test(dark) && /--panel:\s*#ffffff/.test(light),
    '--panel alias must exist in both palettes');
  assert.ok(/--muted:\s*var-compatible/.test(dark) || /--muted:\s*#7fa595/.test(dark),
    'dark --muted alias must exist');
  assert.ok(/--text-dim:\s*#5b6f65/.test(light),
    'light --text-dim must exist');
});

t('styles.css: global scrollbar is theme-aware (var-driven, no fixed rgba)', () => {
  assert.ok(/::-webkit-scrollbar-thumb\s*\{[^}]*var\(--border-strong\)/.test(CSS),
    'scrollbar thumb must use var(--border-strong) so it re-themes');
});

t('styles.css: global select rule is theme-aware (no hardcoded white/black)', () => {
  const selects = [...CSS.matchAll(/select,\nselect option\s*\{([\s\S]*?)\}/g)];
  assert.ok(selects.length >= 1, 'global select rule must exist');
  for (const s of selects) {
    assert.ok(!/background:\s*#ffffff/.test(s[1]),
      'a global select rule still hardcodes #ffffff — must be var(--bg-elev)');
    assert.ok(/background:\s*var\(--bg-elev\)/.test(s[1]) && /color:\s*var\(--text\)/.test(s[1]),
      'global select must use var(--bg-elev)/var(--text)');
  }
});

// ── styles.css: files/file-tree panes follow the theme (user report
//    2026-10-23: 文件夹界面还是黑色 + 图标配色和黑色复用不太好看) ──
t('styles.css: #files-tree-pane background is theme-aware (no hardcoded dark)', () => {
  const m = CSS.match(/#files-tree-pane\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '#files-tree-pane rule must exist');
  assert.ok(/background:\s*var\(--bg-elev\)/.test(m[1]),
    '#files-tree-pane background must use var(--bg-elev) so the folder panel goes white in light mode — was hardcoded #0a0e14');
  assert.ok(!/background:\s*#0a0e14/.test(m[1]),
    'a hardcoded dark background on the tree pane leaves a black panel under the white theme');
});

t('styles.css: light theme re-tints the file-tree icons (ft-ic overrides exist)', () => {
  assert.ok(/:root\[data-theme="light"\]\s+#files-tree li \.ft-ic\.kind-dir\s*\{\s*color:\s*#b87400/.test(CSS),
    'light theme must darken the folder icon tint (#ffc56b on black → #b87400 on white) — the dark-only tints wash out on white');
  const overrides = [...CSS.matchAll(/:root\[data-theme="light"\] #files-tree li \.ft-ic\.ext-(js|ts|md|css|py|yml)\s*\{([^}]*)\}/g)];
  assert.ok(overrides.length >= 6,
    'light theme must re-tint per-extension file icons — reusing the dark pastel palette on white is the reported defect');
  for (const o of overrides) {
    assert.ok(/color:\s*#/.test(o[2]) && !/rgba\(255,\s*255,\s*255/.test(o[2]),
      'light ext-' + o[1] + ' tint must be a solid ink color, not a white-alpha (invisible on white)');
  }
});

t('styles.css: light theme re-tints the git-status chips + download button', () => {
  const chips = [...CSS.matchAll(/:root\[data-theme="light"\] #files-tree li \.ft-git-([MADRCU])\s*\{([^}]*)\}/g)];
  assert.ok(chips.length === 6, 'all six git-status chips need light overrides, got ' + chips.length);
  assert.ok(/:root\[data-theme="light"\] #files-tree li \.ft-download\s*\{[^}]*rgba\(23, 33, 28, \.4\)/.test(CSS),
    'light theme download button must flip from white-alpha to ink-alpha so it is visible on white');
});

t('styles.css: files-pane chrome (headers/ctx-menu/action bar) is token-driven', () => {
  const treePane = CSS.match(/#files-tree-pane\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(/border-right:\s*1px solid var\(--border\)/.test(treePane),
    'tree pane border must use var(--border) — white-alpha hairlines are invisible on white');
  const ctx = CSS.match(/\.files-ctx-menu\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(/background:\s*var\(--bg-elev\)/.test(ctx),
    'right-click context menu must use var(--bg-elev) — hardcoded #10151d left a black menu in light mode');
  const bar = CSS.match(/:root\[data-theme="light"\] #files-action-bar\s*\{([\s\S]*?)\n\}/);
  assert.ok(bar && /rgba\(255, 255, 255, \.97\)/.test(bar[1]),
    'light theme needs a white override for the floating #files-action-bar (dark glass panel on white)');
});

// ── index.html: the toggle button ──
t('index.html: #btn-theme toggle button exists in the sidebar header', () => {
  const headerAt = HTML.indexOf('<aside id="sidebar">');
  const btn = HTML.search(/<button\s+id=["']btn-theme["']/);
  assert.ok(btn > -1, '#btn-theme must exist');
  assert.ok(btn > headerAt, '#btn-theme must live inside the sidebar header chrome row');
  assert.ok(/<button\s+id=["']btn-theme["'][^>]*aria-label=["']Toggle theme["']/.test(HTML),
    '#btn-theme needs an aria-label');
});

t('index.html: moon + sun SVGs inside #btn-theme (icon swap on toggle)', () => {
  const m = HTML.match(/<button\s+id=["']btn-theme["'][\s\S]*?<\/button>/);
  assert.ok(m, '#btn-theme block must exist');
  assert.ok(/id=["']theme-icon-moon["']/.test(m[0]), 'moon SVG must exist (shown in light mode)');
  assert.ok(/id=["']theme-icon-sun["']/.test(m[0]), 'sun SVG must exist (shown in dark mode = click for light)');
});

t('index.html: meta theme-color matches the new dark floor', () => {
  assert.ok(/<meta name="theme-color" content="#0a0e0c"/.test(HTML),
    'meta theme-color must be the dark floor #0a0e0c (applyTheme rewrites it on toggle)');
});

// ── app.js: the toggle logic ──
t('app.js: applyTheme sets data-theme on <html>, syncs icon + meta', () => {
  assert.ok(/function applyTheme\s*\(/.test(APP), 'applyTheme must exist');
  const body = APP.slice(APP.indexOf('function applyTheme'), APP.indexOf('function currentTheme'));
  assert.ok(/documentElement\.setAttribute\(['"]data-theme['"]/.test(body),
    'applyTheme must set data-theme on document.documentElement');
  assert.ok(/localStorage\.setItem\(THEME_KEY/.test(body),
    'applyTheme must persist the choice');
  assert.ok(/theme-icon-moon/.test(body) && /theme-icon-sun/.test(body),
    'applyTheme must swap the moon/sun icons');
  assert.ok(/meta\[name="theme-color"\]/.test(body),
    'applyTheme must sync meta[name=theme-color]');
});

// § theme polish (2026-10-23): mermaid keeps its initialize()-time theme,
// so a light/dark toggle would leave stale dark-on-dark (or light-on-light)
// diagrams. applyTheme must call _reinitMermaidTheme so the palette follows.
t('app.js: applyTheme re-initializes mermaid with the new palette', () => {
  const body = APP.slice(APP.indexOf('function applyTheme'), APP.indexOf('function currentTheme'));
  assert.ok(/_reinitMermaidTheme\(/.test(body),
    'applyTheme must call _reinitMermaidTheme(t) so mermaid diagrams follow the toggle');
  const reinit = APP.slice(APP.indexOf('function _reinitMermaidTheme'), APP.indexOf('function currentTheme'));
  assert.ok(/typeof mermaid === ['"]undefined['"]/.test(reinit),
    '_reinitMermaidTheme must no-op before the mermaid bundle is lazy-loaded');
  assert.ok(/mermaid\.initialize\(\{\s*startOnLoad:\s*false,\s*theme:\s*t\s*\}\)/.test(reinit),
    '_reinitMermaidTheme must re-initialize mermaid with startOnLoad:false and the new theme');
  assert.ok(/renderMermaidInContainer[\s\S]{0,600}mermaid\.initialize\(\{\s*startOnLoad:\s*false,\s*theme:\s*currentTheme\(\)\s*\}\)/.test(APP),
    'first lazy-load initialize must use currentTheme() so a pre-mermaid toggle is honored');
});

t('app.js: THEME_KEY = myco_theme; default dark; only dark|light accepted', () => {
  assert.ok(/THEME_KEY = 'myco_theme'/.test(APP), 'storage key must be myco_theme');
  const body = APP.slice(APP.indexOf('function currentTheme'), APP.indexOf('function toggleTheme'));
  assert.ok(/saved === 'light' \|\| saved === 'dark'/.test(body),
    'currentTheme must validate the persisted value (guard against corrupt storage)');
  assert.ok(/return 'dark'/.test(body), 'default must be dark (hacker palette is the default look)');
});

// § theme fix (2026-10-23): night mode is ALWAYS the default for fresh
// visitors — currentTheme must not fall back to prefers-color-scheme —
// and the dark-mode toggle icon must be the SUN (click → light), with
// the MOON shown in light mode.
t('app.js: currentTheme never consults the OS prefers-color-scheme', () => {
  const body = APP.slice(APP.indexOf('function currentTheme'), APP.indexOf('function toggleTheme'));
  assert.ok(!/prefers-color-scheme/.test(body),
    'currentTheme must default to dark without honoring prefers-color-scheme');
});

t('app.js: dark mode shows the SUN icon; light mode shows the MOON', () => {
  const body = APP.slice(APP.indexOf('function applyTheme'), APP.indexOf('function currentTheme'));
  assert.ok(/if \(moon\) moon\.hidden = \(t !== 'light'\)/.test(body),
    'moon must be shown only in light mode (moon.hidden = t !== light)');
  assert.ok(/if \(sun\) sun\.hidden = \(t === 'light'\)/.test(body),
    'sun must be shown in dark mode (sun.hidden = t === light)');
});

t('app.js: toggleTheme one-click flip; bindThemeToggle restores + wires click', () => {
  assert.ok(/function toggleTheme\s*\(\)\s*\{\s*applyTheme\(currentTheme\(\) === 'light' \? 'dark' : 'light'\);?\s*\}/.test(APP),
    'toggleTheme must flip light↔dark in one click');
  const body = APP.slice(APP.indexOf('function bindThemeToggle'), APP.indexOf('function bindThemeToggle') + 800);
  assert.ok(/applyTheme\(currentTheme\(\)\)/.test(body),
    'bindThemeToggle must restore the persisted theme at boot');
  assert.ok(/addEventListener\(['"]click['"],\s*toggleTheme\)/.test(body),
    'bindThemeToggle must wire #btn-theme click → toggleTheme');
});

t('app.js: bindThemeToggle called from the DOMContentLoaded boot block', () => {
  const bootAt = APP.indexOf("document.addEventListener('DOMContentLoaded', () => {");
  const callAt = APP.indexOf('bindThemeToggle();', bootAt);
  assert.ok(bootAt > -1 && callAt > bootAt,
    'bindThemeToggle must be invoked in the canonical boot block');
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
