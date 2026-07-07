// fr-107: file explorer inline preview for HTML / PDF / SVG / images /
// audio / video.
//
// Contract:
//   - Server: GET /sessions/:id/file/raw?path=X returns the raw bytes
//     with a MIME-guessed Content-Type + Content-Disposition: inline
//     + Cache-Control: no-store + X-Content-Type-Options: nosniff.
//     Same auth + containment as /file/download.
//   - Client:
//     * _previewKindForExt maps ext → 'html' | 'svg' | 'pdf' | 'image'
//       | 'audio' | 'video' | null. Table mirrors the server's MIME_BY_EXT.
//     * openFileInViewer branches on _previewKindForExt at the top;
//       preview-capable exts skip the /file JSON call and hit
//       /file/raw instead.
//     * opts.forceSource on openFileInViewer bypasses the preview
//       branch so the ⧉ Source toggle can flip back to the code view.
//     * _renderPreviewByKind dispatches to per-kind render helpers.
//     * HTML + SVG render via `<iframe sandbox="">` (empty allow list)
//       to neutralize scripts.
//     * PDF renders via unsandboxed iframe (browser's own PDF viewer).
//     * Images render via `<img>` (scripts inside images don't run).
//     * Audio + video render via native `<audio>` / `<video controls>`.
//     * Toggle button visible ONLY for text-sourced preview kinds
//       (html / svg). Binary kinds (pdf/image/audio/video) hide it.
//   - styles.css ships .file-preview-iframe / -image / -media /
//     -audio / -video + #files-preview-toggle.
//   - index.html has the toggle button element (hidden by default).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-107: file-explorer inline preview (HTML/PDF/image/audio/video) ──');

// ──────────────────────────────────────────────────────────────────
// Group A: server /file/raw route.

t('server: GET /sessions/:id/file/raw route is registered', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.get\s*\(\s*['"]\/sessions\/:id\/file\/raw['"]/.test(src),
    'index.js must register GET /sessions/:id/file/raw');
});

t('server: /file/raw route is auth-gated (viewer role) + uses safeJoin', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.get\s*\(\s*['"]\/sessions\/:id\/file\/raw['"]/);
  assert.ok(at > 0);
  // Slice from route registration to next app.get so we're inside the
  // handler function body.
  const rest = src.slice(at);
  const nextRoute = rest.slice(1).search(/app\.get\s*\(/);
  const window = rest.slice(0, nextRoute > 0 ? nextRoute + 1 : 3000);
  assert.ok(/fileApiPreamble\s*\(\s*req\s*,\s*res\s*,\s*['"]viewer['"]/.test(window),
    '/file/raw must call fileApiPreamble(req, res, "viewer") for same-as-download auth');
  assert.ok(/filesApi\.safeJoin\s*\(/.test(window),
    '/file/raw must use filesApi.safeJoin for path containment');
});

t('server: /file/raw route sets Content-Disposition: inline + Cache-Control: no-store + X-Content-Type-Options: nosniff', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.get\s*\(\s*['"]\/sessions\/:id\/file\/raw['"]/);
  const rest = src.slice(at);
  const nextRoute = rest.slice(1).search(/app\.get\s*\(/);
  const window = rest.slice(0, nextRoute > 0 ? nextRoute + 1 : 3000);
  assert.ok(/Content-Disposition[\s\S]{0,80}inline/i.test(window),
    'must set Content-Disposition: inline so the browser renders in the iframe (not a download)');
  assert.ok(/Cache-Control[\s\S]{0,80}no-store/i.test(window),
    'must set Cache-Control: no-store so edits show without a hard refresh');
  assert.ok(/X-Content-Type-Options[\s\S]{0,80}nosniff/i.test(window),
    'must set X-Content-Type-Options: nosniff so a strict browser cannot sniff HTML out of a purported PDF');
});

t('server: /file/raw MIME table covers html, htm, svg, pdf, common images, audio, video', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.get\s*\(\s*['"]\/sessions\/:id\/file\/raw['"]/);
  const rest = src.slice(at);
  const nextRoute = rest.slice(1).search(/app\.get\s*\(/);
  const window = rest.slice(0, nextRoute > 0 ? nextRoute + 1 : 3000);
  const required = [
    /html\s*:\s*['"]text\/html/,
    /htm\s*:\s*['"]text\/html/,
    /svg\s*:\s*['"]image\/svg\+xml/,
    /pdf\s*:\s*['"]application\/pdf/,
    /png\s*:\s*['"]image\/png/,
    /jpg\s*:\s*['"]image\/jpeg/,
    /jpeg\s*:\s*['"]image\/jpeg/,
    /gif\s*:\s*['"]image\/gif/,
    /webp\s*:\s*['"]image\/webp/,
    /mp3\s*:\s*['"]audio\/mpeg/,
    /wav\s*:\s*['"]audio\/wav/,
    /mp4\s*:\s*['"]video\/mp4/,
    /webm\s*:\s*['"]video\/webm/,
  ];
  for (const re of required) {
    assert.ok(re.test(window),
      `MIME table must map ${re.source} (missing so browser cannot pick the right renderer)`);
  }
});

// ──────────────────────────────────────────────────────────────────
// Group B: client ext-dispatch behavior.

// Extract _previewKindForExt out of app.js as an inline eval'd function
// so we can exercise it without a browser. The function is pure — no
// DOM access, no side effects.
function _extractPreviewKindForExt() {
  const src = _read('web/public/app.js');
  const body = fnBody(src, /function\s+_previewKindForExt\s*\(/);
  assert.ok(body, '_previewKindForExt must be locatable in app.js');
  // Wrap as an anonymous function so eval can bind it locally.
  const wrapped = `(function() { ${body}\n return _previewKindForExt; })()`;
  // eslint-disable-next-line no-eval
  return eval(wrapped);
}

t('_previewKindForExt: text-sourced kinds (html, svg) → "html" / "svg"', () => {
  const fn = _extractPreviewKindForExt();
  assert.strictEqual(fn('html'), 'html');
  assert.strictEqual(fn('.html'), 'html');
  assert.strictEqual(fn('HTM'), 'html');
  assert.strictEqual(fn('svg'), 'svg');
});

t('_previewKindForExt: pdf → "pdf"', () => {
  const fn = _extractPreviewKindForExt();
  assert.strictEqual(fn('pdf'), 'pdf');
  assert.strictEqual(fn('.PDF'), 'pdf');
});

t('_previewKindForExt: images collapse to "image"', () => {
  const fn = _extractPreviewKindForExt();
  for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.strictEqual(fn(e), 'image', `${e} must map to image`);
  }
});

t('_previewKindForExt: audio and video collapse to "audio" / "video"', () => {
  const fn = _extractPreviewKindForExt();
  for (const e of ['mp3', 'wav', 'ogg', 'm4a']) {
    assert.strictEqual(fn(e), 'audio', `${e} must map to audio`);
  }
  for (const e of ['mp4', 'webm', 'mov']) {
    assert.strictEqual(fn(e), 'video', `${e} must map to video`);
  }
});

t('_previewKindForExt: everything else → null (fallthrough to code viewer)', () => {
  const fn = _extractPreviewKindForExt();
  for (const e of ['js', 'ts', 'py', 'json', 'md', 'yml', 'css', 'sh', '']) {
    assert.strictEqual(fn(e), null, `${e} must map to null so the code viewer handles it`);
  }
});

// ──────────────────────────────────────────────────────────────────
// Group C: static guards on client render logic.

t('static guard: openFileInViewer branches on _previewKindForExt at the top', () => {
  const src = _read('web/public/app.js');
  const body = fnBody(src, /async\s+function\s+openFileInViewer\s*\(/);
  assert.ok(body, 'openFileInViewer body must be locatable');
  assert.ok(/_previewKindForExt\s*\(/.test(body),
    'openFileInViewer must call _previewKindForExt to detect preview-capable files');
  // opts.forceSource → bypass the preview branch (used by the toggle
  // to flip back to source view).
  assert.ok(/forceSource/.test(body),
    'openFileInViewer must honor opts.forceSource so the ⧉ Source toggle can flip to code view');
  assert.ok(/_renderPreviewByKind\s*\(/.test(body),
    'openFileInViewer must dispatch preview-capable files via _renderPreviewByKind');
  // Ordering: the preview branch must come BEFORE the /file JSON fetch,
  // so we don't waste a JSON round-trip for a PDF.
  const previewIdx = body.indexOf('_renderPreviewByKind');
  const fileFetchIdx = body.search(/authedFetch\s*\(\s*url\s*\)/);
  assert.ok(previewIdx > 0 && fileFetchIdx > previewIdx,
    'the preview-mode branch must come BEFORE the /file JSON fetch (no wasted round-trip for binary files)');
});

t('static guard: HTML + SVG render via `sandbox=""` iframe (script-execution neutralized)', () => {
  const src = _read('web/public/app.js');
  const body = fnBody(src, /function\s+_renderIframePreview\s*\(/);
  assert.ok(body, '_renderIframePreview body must be locatable');
  // The sandbox attribute MUST be set to the empty string (no allow-*
  // tokens). Any of `sandbox=''` / `sandbox=""` / `.setAttribute('sandbox', '')`
  // patterns match — but a non-empty sandbox value would let scripts run.
  assert.ok(/setAttribute\s*\(\s*['"]sandbox['"]\s*,\s*['"]{2}\s*\)/.test(body),
    '_renderIframePreview must set sandbox="" (empty allow list) to neutralize scripts + forms + cross-origin fetches (XSS safety for user-controlled HTML)');
});

t('static guard: image preview uses <img>, media uses <audio>/<video controls>', () => {
  const src = _read('web/public/app.js');
  const imgBody = fnBody(src, /function\s+_renderImagePreview\s*\(/);
  assert.ok(imgBody, '_renderImagePreview must exist');
  assert.ok(/createElement\s*\(\s*['"]img['"]\s*\)/.test(imgBody),
    '_renderImagePreview must createElement("img")');
  const mediaBody = fnBody(src, /function\s+_renderMediaPreview\s*\(/);
  assert.ok(mediaBody, '_renderMediaPreview must exist');
  assert.ok(/createElement\s*\(\s*tag\s*\)/.test(mediaBody),
    '_renderMediaPreview must createElement(tag) so it works for both audio + video');
  assert.ok(/setAttribute\s*\(\s*['"]controls['"]/.test(mediaBody),
    '_renderMediaPreview must set controls attribute for playback UI');
});

t('static guard: renderViewerHeader wires the preview-toggle for text-sourced kinds only', () => {
  const src = _read('web/public/app.js');
  const body = fnBody(src, /function\s+renderViewerHeader\s*\(/);
  assert.ok(body, 'renderViewerHeader body must be locatable');
  assert.ok(/files-preview-toggle/.test(body),
    'renderViewerHeader must reference the #files-preview-toggle button');
  // Toggle must gate on _previewKindIsTextSourced so binary kinds
  // (pdf/image/audio/video) hide it — no useful source view for them.
  assert.ok(/_previewKindIsTextSourced\s*\(/.test(body),
    'renderViewerHeader must gate the toggle visibility on _previewKindIsTextSourced (binary kinds hide it)');
});

t('static guard: index.html declares the #files-preview-toggle button', () => {
  const src = _read('web/public/index.html');
  assert.ok(/id=['"]files-preview-toggle['"]/.test(src),
    'index.html must declare the #files-preview-toggle button (fr-107)');
});

t('static guard: styles.css ships .file-preview-* + #files-preview-toggle styling', () => {
  const src = _read('web/public/styles.css');
  const required = [
    /\.file-preview-iframe\b/,
    /\.file-preview-image\b/,
    /\.file-preview-media\b/,
    /#files-preview-toggle\b/,
  ];
  for (const re of required) {
    assert.ok(re.test(src), `styles.css missing rule matching ${re.source}`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
