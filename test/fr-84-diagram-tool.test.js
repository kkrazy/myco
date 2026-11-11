// fr-84: embedded diagram drawing tool launched from chat field icon.
//
// User: "Add embedded diagram drawing tool launched from chat field
// icon" + "the diagram drawing should be as light as possible and
// runs together with myco".
//
// Shape:
//   - Composer button (#chat-diagram) between Speak and Send.
//   - Modal (#diagram-modal) with an SVG canvas (#diagram-canvas) +
//     5-tool palette (pen / rect / ellipse / line / text), 4 colors,
//     3 stroke widths, undo / clear / cancel / save.
//   - Save POSTs the serialized SVG to /sessions/:id/diagrams, server
//     persists under _myco_/diagrams/<ts>-<hex>.svg, returns URL.
//     Client appends `![diagram](<url>)` to the chat input.
//
// "Light as possible" → zero new vendor weight (no excalidraw, no
// tldraw). Pure browser SVG + mouse/touch events. This test pins the
// load-bearing pieces of that contract so a future refactor can't
// silently swap in a heavy library.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const SERVER = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');

console.log('── fr-84: embedded diagram drawing tool ──');

// ── HTML: composer button + modal markup ─────────────────────────────

t('html: #chat-diagram composer button lives between #chat-mic and #chat-send', () => {
  const micIdx  = HTML.search(/id="chat-mic"/);
  const drawIdx = HTML.search(/id="chat-diagram"/);
  const sendIdx = HTML.search(/id="chat-send"/);
  assert.ok(micIdx > -1,  '#chat-mic must exist');
  assert.ok(drawIdx > -1, '#chat-diagram must exist');
  assert.ok(sendIdx > -1, '#chat-send must exist');
  assert.ok(micIdx < drawIdx && drawIdx < sendIdx,
    `order must be Speak → Draw → Send (got mic=${micIdx}, draw=${drawIdx}, send=${sendIdx})`);
  // Same composer-btn class so the chrome stays unified.
  const block = HTML.slice(drawIdx, drawIdx + 600);
  assert.ok(/composer-btn/.test(block),
    '#chat-diagram must use the composer-btn class for visual unity');
  assert.ok(/<svg\b/.test(block),
    '#chat-diagram must contain an inline SVG icon (matches composer family)');
});

t('html: #diagram-modal is a dialog with canvas + 8 tools + 4 colors + 3 widths', () => {
  assert.ok(/<div\s+id="diagram-modal"[^>]*role="dialog"/.test(HTML),
    '#diagram-modal must exist with role="dialog"');
  // Canvas is an inline SVG with a fixed viewBox so coordinates persist.
  assert.ok(/<svg\s+id="diagram-canvas"[^>]*viewBox="0 0 1000 600"/.test(HTML),
    '#diagram-canvas must be an inline SVG with viewBox 0 0 1000 600');
  // r2: 8 tool buttons — original 5 + select / arrow / diamond.
  for (const tool of ['select', 'pen', 'rect', 'ellipse', 'diamond', 'line', 'arrow', 'text']) {
    const re = new RegExp(`class="diagram-tool[^"]*"[^>]*data-tool="${tool}"`);
    assert.ok(re.test(HTML), `tool '${tool}' must be present in #diagram-toolbar`);
  }
  // r2: arrowhead marker def is inside the canvas so the Arrow tool's
  // `marker-end="url(#diagram-arrowhead)"` resolves.
  assert.ok(/<marker\s+id="diagram-arrowhead"/.test(HTML),
    '#diagram-arrowhead <marker> def must live inside #diagram-canvas');
  // r2: rubber-band <rect> for select-tool drag-to-select.
  assert.ok(/<rect\s+id="diagram-rubber"/.test(HTML),
    '#diagram-rubber rubber-band rect must exist for select-tool drag');
  // 4 colors.
  const colorCount = (HTML.match(/class="diagram-color[^"]*"/g) || []).length;
  assert.ok(colorCount >= 4, `at least 4 .diagram-color buttons expected (got ${colorCount})`);
  // 3 width buttons. Word-boundary after `width` so we don't also
  // catch the container `class="diagram-widths"` (plural).
  const widthCount = (HTML.match(/class="diagram-width(?:\s+[^"]*)?"/g) || []).length;
  assert.ok(widthCount === 3, `exactly 3 .diagram-width buttons expected (got ${widthCount})`);
  // Actions row: undo / clear / cancel / save.
  for (const id of ['diagram-undo', 'diagram-clear', 'diagram-cancel', 'diagram-save']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} button must be present`);
  }
});

// ── Client JS: drawing engine + save flow ───────────────────────────

t('app.js: DIAGRAM_TOOLS registry lists exactly the 8 supported tools (r2)', () => {
  const m = APP.match(/const\s+DIAGRAM_TOOLS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'DIAGRAM_TOOLS constant must be declared');
  const list = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  assert.deepStrictEqual(list.sort(),
    ['arrow', 'diamond', 'ellipse', 'line', 'pen', 'rect', 'select', 'text'],
    'DIAGRAM_TOOLS must contain exactly: select / pen / rect / ellipse / diamond / line / arrow / text');
});

t('app.js: openDiagramModal + closeDiagramModal are defined', () => {
  assert.ok(/function\s+openDiagramModal\s*\(\s*\)/.test(APP),
    'openDiagramModal must be defined');
  assert.ok(/function\s+closeDiagramModal\s*\(\s*\)/.test(APP),
    'closeDiagramModal must be defined');
});

t('app.js: composer "Draw" button wired to openDiagramModal', () => {
  // The button is wired at composer init time.
  assert.ok(/getElementById\(['"]chat-diagram['"]\)[\s\S]{0,300}openDiagramModal\(\)/.test(APP),
    '#chat-diagram click handler must call openDiagramModal()');
});

t('app.js: save flow POSTs to /sessions/:id/diagrams and inserts markdown into composer', () => {
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  assert.ok(idx > -1, '_diagramSave must be defined');
  const win = sliceFn(APP, idx);
  assert.ok(/\/sessions\/\$\{[^}]*sid[^}]*\}\/diagrams/.test(win) ||
            /\/sessions\/.+\/diagrams/.test(win),
    '_diagramSave must POST to /sessions/:id/diagrams');
  assert.ok(/method:\s*['"]POST['"]/.test(win),
    'request method must be POST');
  // SVG body wraps the serialized canvas under key "svg".
  assert.ok(/JSON\.stringify\(\s*\{\s*svg/.test(win),
    'request body must be JSON { svg }');
  // Insert `![diagram](url)` into the chat input.
  assert.ok(/!\[diagram\]\(\$\{[^}]+\}\)/.test(win),
    'must insert `![diagram](<url>)` markdown into the chat input');
});

t('app.js: lightweight-only — no excalidraw / tldraw / fabric / paper / konva / drawio', () => {
  // r2: rough.js (~27 KB) is intentional + whitelisted. Heavier
  // drawing libs stay banned to preserve the "lighter than drawio,
  // richer than vanilla SVG" middle-ground the user picked.
  for (const bannedLib of ['excalidraw', 'tldraw', 'fabric.js', 'paper.js', 'konva', 'drawio', 'diagrams.net']) {
    const re = new RegExp(bannedLib.replace(/\./g, '\\.'), 'i');
    assert.ok(!re.test(APP),
      `app.js must not import "${bannedLib}" — user constraint: as light as possible`);
    assert.ok(!re.test(HTML),
      `index.html must not load "${bannedLib}"`);
  }
});

// ── r2: rough.js + select tool + new shape primitives ──────────────

t('html: rough.js script is loaded from /vendor/ (self-hosted)', () => {
  assert.ok(/<script[^>]*src="\/vendor\/rough\.umd\.js"/.test(HTML),
    'index.html must load /vendor/rough.umd.js');
  // Self-hosted only — no CDN fallback that would break behind firewalls.
  assert.ok(!/(unpkg|cdn|jsdelivr)[^"]*rough/.test(HTML),
    'rough.js must be self-hosted (no CDN reference)');
});

t('vendor: rough.umd.js exists + is reasonably small (≤ 50 KB)', () => {
  const p = path.join(__dirname, '..', 'web', 'public', 'vendor', 'rough.umd.js');
  assert.ok(fs.existsSync(p), '/web/public/vendor/rough.umd.js must exist');
  const stat = fs.statSync(p);
  assert.ok(stat.size > 5000,  'rough.umd.js suspiciously tiny — check it actually downloaded');
  assert.ok(stat.size <= 50 * 1024, `rough.umd.js must be ≤ 50 KB (got ${stat.size} bytes)`);
});

t('app.js: rough.js bound to canvas on modal open + cleared on close-tool-switch', () => {
  const idx = APP.search(/function\s+openDiagramModal\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  assert.ok(/window\.rough\.svg\(/.test(win),
    'openDiagramModal must call window.rough.svg(canvas) to init the generator');
  assert.ok(/_diagramRough\s*=/.test(win),
    'openDiagramModal must store the rough generator in _diagramRough');
});

t('app.js: select-tool state shape — selection Set + selectMode + moveBases', () => {
  // Pin the state-machine shape so a future refactor can't quietly
  // drop multi-select or drag-move.
  const idx = APP.search(/const\s+_diagramState\s*=\s*\{/);
  const win = APP.slice(idx, idx + 800);
  assert.ok(/selection:\s*new\s+Set\(\)/.test(win),
    '_diagramState.selection must be a Set (multi-select)');
  assert.ok(/selectMode:\s*['"]idle['"]/.test(win),
    '_diagramState.selectMode must start at "idle"');
  assert.ok(/moveBases:\s*new\s+Map\(\)/.test(win),
    '_diagramState.moveBases must be a Map for tracking per-shape translate offsets at drag-start');
});

t('app.js: drawing engine has hit-test + rubber-band + drag-to-move helpers', () => {
  // Each piece of the select-tool contract is its own named helper.
  for (const fnName of [
    '_diagramTopmostAt',
    '_diagramHitTest',
    '_diagramBBoxContains',
    '_diagramElementBBox',
    '_diagramSetSelected',
    '_diagramClearSelection',
    '_diagramDeleteSelection',
    '_diagramGetTranslate',
    '_diagramSetTranslate',
  ]) {
    assert.ok(new RegExp(`function\\s+${fnName}\\s*\\(`).test(APP),
      `${fnName} helper must be defined`);
  }
});

t('app.js: Delete / Backspace key removes selected shapes', () => {
  const idx = APP.search(/function\s+_diagramOnKeyDown\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/(['"]Delete['"]|['"]Backspace['"])/.test(win),
    'keydown handler must branch on Delete or Backspace');
  assert.ok(/_diagramDeleteSelection\(/.test(win),
    'keydown handler must call _diagramDeleteSelection() when selection is non-empty');
});

t('app.js: rough.js wrappers used for rect / ellipse / diamond / line in pointer-down', () => {
  const idx = APP.search(/function\s+_diagramOnPointerDown\s*\(/);
  const win = sliceFn(APP, idx);
  // _diagramReplaceCurrent is the single funnel — verify each shape
  // tool flows through it.
  for (const shape of ['rectangle', 'ellipse', 'polygon', 'line']) {
    const re = new RegExp(`_diagramReplaceCurrent\\([\\s\\S]{0,300}rc\\.${shape}\\(`);
    assert.ok(re.test(win),
      `pointer-down must call rc.${shape}() via _diagramReplaceCurrent for the relevant tool`);
  }
});

t('app.js: arrow tool uses plain SVG line + marker-end (rough.js + markers is brittle)', () => {
  // Arrow stays vanilla so the arrowhead lands at the actual tip,
  // not at every sketchy sub-stroke that rough.js would generate.
  const idx = APP.search(/function\s+_diagramOnPointerDown\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/s\.tool === ['"]arrow['"][\s\S]{0,500}marker-end[\s\S]{0,100}#diagram-arrowhead/.test(win),
    'arrow branch must set marker-end="url(#diagram-arrowhead)" on a plain <line>');
});

// ── Server: POST + GET routes for diagram storage ───────────────────

t('server: POST /sessions/:id/diagrams accepts { svg } and persists under _myco_/diagrams/', () => {
  assert.ok(/app\.post\(['"]\/sessions\/:id\/diagrams['"]/.test(SERVER),
    'POST /sessions/:id/diagrams route must be registered');
  // Owner-only — viewers shouldn't be able to inject diagrams.
  const idx = SERVER.search(/app\.post\(['"]\/sessions\/:id\/diagrams['"]/);
  const win = SERVER.slice(idx, idx + 1500);
  assert.ok(/fileApiPreamble\(\s*req\s*,\s*res\s*,\s*['"]owner['"]/.test(win),
    'POST /diagrams must require owner access (drawers, not viewers)');
  assert.ok(/_myco_[\\/]+diagrams/.test(win) || /_myco_['"]\s*,\s*['"]diagrams/.test(win),
    'persisted path must be _myco_/diagrams/');
});

t('server: GET /sessions/:id/diagrams/:filename serves image/svg+xml with strict filename whitelist', () => {
  assert.ok(/app\.get\(['"]\/sessions\/:id\/diagrams\/:filename['"]/.test(SERVER),
    'GET /sessions/:id/diagrams/:filename route must be registered');
  const idx = SERVER.search(/app\.get\(['"]\/sessions\/:id\/diagrams\/:filename['"]/);
  // r3 expanded the route comment + body, so widen the slice past it.
  const win = SERVER.slice(idx, idx + 3000);
  assert.ok(/image\/svg\+xml/.test(win),
    'GET route must set Content-Type: image/svg+xml');
  // r3 (2026-05-27): auth contract was relaxed — see
  // test/fr-84-r3-chat-render.test.js for the new contract (no
  // Bearer gate because <img src> can't carry it; security boundary
  // is {unguessable session-id, unguessable filename}). The original
  // "viewer access" assertion is intentionally removed here, NOT
  // forgotten.
  // Filename whitelist guards path traversal (still required).
  assert.ok(/DIAGRAM_FILENAME_RE/.test(win) || /\\.svg\$/.test(win),
    'GET route must validate filename against a strict whitelist (no path traversal)');
});

t('server: _validateDiagramSvg rejects non-SVG payloads + scripts', () => {
  // Pull the helper out via eval so we can hit it directly without
  // booting Express. Same trick the fr-80 r6 test used.
  const m = SERVER.match(/function\s+_validateDiagramSvg\s*\(raw\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_validateDiagramSvg helper must be defined');
  // Helper closes over DIAGRAM_MAX_BYTES — pull that const value out of
  // the source too and inject it into the eval scope.
  const cm = SERVER.match(/const\s+DIAGRAM_MAX_BYTES\s*=\s*([^;]+);/);
  assert.ok(cm, 'DIAGRAM_MAX_BYTES const must be declared');
  // eslint-disable-next-line no-new-func
  const validate = new Function('Buffer', 'DIAGRAM_MAX_BYTES',
    'return ' + m[0])(Buffer, eval(cm[1]));
  // Valid SVG passes.
  const ok = validate('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10"/></svg>');
  assert.ok(ok.svg && !ok.error, 'minimal valid SVG must pass');
  // Empty / non-string fails.
  assert.ok(validate('').error,    'empty string must be rejected');
  assert.ok(validate(null).error,  'null must be rejected');
  assert.ok(validate(42).error,    'non-string must be rejected');
  // Not-an-SVG fails.
  assert.ok(validate('<div>hi</div>').error,
    'non-SVG markup must be rejected');
  // Embedded script fails.
  assert.ok(validate('<svg><script>alert(1)</script></svg>').error,
    'embedded <script> must be rejected');
});

// ── CSS: modal is full-screen overlay with reasonable layout ─────────

t('css: #diagram-modal full-screen overlay + #diagram-canvas fills its host', () => {
  // Modal is position:fixed inset:0 with a high z-index so it
  // overlays the chat composer.
  assert.ok(/#diagram-modal\s*\{[\s\S]{0,400}position:\s*fixed[\s\S]{0,400}inset:\s*0/.test(CSS),
    '#diagram-modal must be position:fixed; inset:0 (full-screen overlay)');
  // Canvas takes full width/height of its host so drawing area is large.
  assert.ok(/#diagram-canvas\s*\{[\s\S]{0,400}width:\s*100%/.test(CSS),
    '#diagram-canvas must be width:100% inside #diagram-canvas-host');
  // touch-action:none keeps mobile pan/zoom from interfering with drawing.
  assert.ok(/#diagram-canvas\s*\{[\s\S]{0,500}touch-action:\s*none/.test(CSS),
    '#diagram-canvas must set touch-action:none for mobile drawing');
});

// ── Cache busters bumped so the new CSS + JS are served ──────────────

t('index.html: cache busters bumped for r2 (styles.css ≥ v275, app.js ≥ v241)', () => {
  const cssM = HTML.match(/styles\.css\?v=(\d+)/);
  const jsM  = HTML.match(/app\.js\?v=(\d+)/);
  assert.ok(cssM && parseInt(cssM[1], 10) >= 275,
    `styles.css cache-buster must be >= 275 (got ${cssM && cssM[1]}) — rising baseline as more features ship`);
  assert.ok(jsM && parseInt(jsM[1], 10) >= 241,
    `app.js cache-buster must be >= 241 (got ${jsM && jsM[1]}) — rising baseline as more features ship`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
