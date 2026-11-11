// Sidebar user-manual link.
//
// Adds a book-open icon next to the "+" New-session button in the
// sidebar header. Click opens an in-app modal that fetches
// /USER_MANUAL.md (served by an explicit server route since the file
// lives at the project root, not under web/public/) and renders it
// via the existing renderMd → marked.parse path.
//
// Static-grep guards on prod sources + a server route smoke check.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const SERVER = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');

console.log('── sidebar: user-manual link + modal ──');

// ──────────────────────────────────────────────────────────────────────
// HTML: button + modal scaffolding
// ──────────────────────────────────────────────────────────────────────

t('sidebar header has a #btn-manual button next to #btn-spawn', () => {
  // Both buttons must exist; #btn-manual must appear AFTER #btn-spawn
  // so the icon sits to the right of the "+" (matches the user's
  // "beside the +" request).
  const spawnIdx = HTML.search(/<button\s+id=["']btn-spawn["']/);
  const manualIdx = HTML.search(/<button\s+id=["']btn-manual["']/);
  assert.ok(spawnIdx > -1, '#btn-spawn must exist');
  assert.ok(manualIdx > -1, '#btn-manual must exist');
  assert.ok(manualIdx > spawnIdx, '#btn-manual must appear AFTER #btn-spawn (beside the "+")');
});

t('#btn-manual carries an aria-label + title for accessibility', () => {
  const m = HTML.match(/<button\s+id=["']btn-manual["'][^>]*>/);
  assert.ok(m, '#btn-manual element must exist');
  assert.ok(/title=["']User manual["']/.test(m[0]),
    'button must have title="User manual"');
  assert.ok(/aria-label=["']User manual["']/.test(m[0]),
    'button must have aria-label="User manual"');
});

t('#btn-manual contains an inline SVG icon', () => {
  // Extract the button block; assert it contains an <svg>.
  const m = HTML.match(/<button\s+id=["']btn-manual["'][\s\S]*?<\/button>/);
  assert.ok(m, '#btn-manual block must exist');
  assert.ok(/<svg[\s\S]*?<\/svg>/.test(m[0]),
    '#btn-manual must contain an inline <svg> icon (lucide-style book-open to match the chrome icons)');
});

t('manual modal scaffolding exists (#manual-modal + dialog + body + close)', () => {
  assert.ok(/<div\s+id=["']manual-modal["']/.test(HTML),
    '#manual-modal container must exist');
  assert.ok(/<div\s+id=["']manual-dialog["']/.test(HTML),
    '#manual-dialog must exist');
  assert.ok(/<div\s+id=["']manual-body["']/.test(HTML),
    '#manual-body must exist (target for the rendered markdown)');
  assert.ok(/<button\s+id=["']manual-close["']/.test(HTML),
    '#manual-close button must exist');
});

// ──────────────────────────────────────────────────────────────────────
// Client wiring (app.js)
// ──────────────────────────────────────────────────────────────────────

t('app.js binds #btn-manual click → openManualModal', () => {
  assert.ok(/getElementById\(['"]btn-manual['"]\)\.addEventListener\(['"]click['"]\s*,\s*openManualModal\)/.test(APP),
    'btn-manual must be wired to openManualModal');
});

t('app.js binds #manual-close → closeManualModal', () => {
  assert.ok(/getElementById\(['"]manual-close['"]\)\.addEventListener\(['"]click['"]\s*,\s*closeManualModal\)/.test(APP),
    'manual-close must be wired to closeManualModal');
});

t('app.js closes on Escape + clicks outside the dialog', () => {
  // Escape handler
  assert.ok(/Escape.*manual-modal|manual-modal.*Escape/s.test(APP),
    'Escape key must close the manual modal');
  // Click-outside (target.id === manual-modal in the modal click handler)
  assert.ok(/manual-modal['\s]+\)\.addEventListener\(['"]click['"]/.test(APP),
    'the modal overlay must have a click handler for click-outside-to-close');
});

t('openManualModal fetches /USER_MANUAL.md and renders via renderMd', () => {
  const start = APP.search(/async\s+function\s+openManualModal\s*\(/);
  assert.ok(start > -1, 'openManualModal must exist');
  const body = sliceFn(APP, start);
  assert.ok(/fetch\(['"]\/USER_MANUAL\.md['"]/.test(body),
    'openManualModal must fetch /USER_MANUAL.md');
  assert.ok(/renderMd\(/.test(body),
    'openManualModal must render the markdown via renderMd');
});

t('manual content is cached on first open (no re-fetch on subsequent opens)', () => {
  // Cache variable should exist + be checked before re-fetching.
  assert.ok(/_manualHtmlCache/.test(APP),
    'a cache variable must exist so subsequent opens are instant');
});

// ──────────────────────────────────────────────────────────────────────
// Server route
// ──────────────────────────────────────────────────────────────────────

t('server registers GET /USER_MANUAL.md', () => {
  assert.ok(/app\.get\(['"]\/USER_MANUAL\.md['"]/.test(SERVER),
    'server must register the GET /USER_MANUAL.md route');
});

t('server route serves with text/markdown content type', () => {
  // Extract the route handler body; assert Content-Type is text/markdown.
  const m = SERVER.match(/app\.get\(['"]\/USER_MANUAL\.md['"][\s\S]*?\}\);/);
  assert.ok(m, 'route handler must exist');
  assert.ok(/text\/markdown/.test(m[0]),
    'Content-Type must be text/markdown (browsers correctly identify the file)');
});

t('server route smoke: file exists at the path the route reads', () => {
  // The route reads `path.join(__dirname, '..', '..', 'USER_MANUAL.md')`.
  // From server/src/, that resolves to <project-root>/USER_MANUAL.md.
  const manualPath = path.join(__dirname, '..', 'USER_MANUAL.md');
  assert.ok(fs.existsSync(manualPath),
    'USER_MANUAL.md must exist at the project root — the server route reads it from there');
  const head = fs.readFileSync(manualPath, 'utf8').slice(0, 200);
  assert.ok(/^# myco/m.test(head),
    'USER_MANUAL.md must start with the expected "# myco" heading');
});

t('Dockerfile copies USER_MANUAL.md into the image', () => {
  // Without this COPY the file ships in dev (where __dirname/../..
  // resolves to the source tree which already has the file) but
  // returns 404 in prod — what the user actually hit. Pin the COPY
  // so a future Dockerfile refactor can't silently drop it.
  const dockerfile = fs.readFileSync(
    path.join(__dirname, '..', 'docker', 'Dockerfile'), 'utf8');
  assert.ok(/^COPY\s+USER_MANUAL\.md\s+\.\/USER_MANUAL\.md/m.test(dockerfile),
    'Dockerfile must contain `COPY USER_MANUAL.md ./USER_MANUAL.md` so the manual is in the prod image (not just the dev source tree)');
});

// ──────────────────────────────────────────────────────────────────────
// CSS
// ──────────────────────────────────────────────────────────────────────

t('CSS: #btn-manual shares the sidebar-button styling', () => {
  assert.ok(/#btn-manual/.test(CSS),
    'CSS must style #btn-manual');
  // Should share the rule with btn-spawn + btn-collapse so it looks
  // like a sidebar button.
  assert.ok(/#btn-spawn[\s\S]*?#btn-manual|#btn-manual[\s\S]*?#btn-spawn/.test(CSS) ||
            /#btn-spawn,\s*#btn-collapse,\s*#btn-manual/.test(CSS),
    '#btn-manual should be in the same selector group as #btn-spawn/#btn-collapse for consistent styling');
});

t('CSS: #manual-modal has overlay + dialog styling', () => {
  assert.ok(/#manual-modal\s*\{[^}]*position:\s*fixed/.test(CSS),
    'modal must use position: fixed for full-viewport overlay');
  assert.ok(/#manual-modal\s*\{[^}]*background:\s*rgba\(/.test(CSS),
    'modal overlay must have a dim background');
  assert.ok(/#manual-body/.test(CSS),
    '#manual-body must have scrollable styling');
});

t('CSS: mobile rule makes the modal full-screen on ≤900px', () => {
  // The user manual is long-form; on mobile it should fill the screen
  // so there's room to read.
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]*?#manual-(modal|dialog)/.test(CSS),
    'mobile rule must adapt the manual modal for small screens');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
