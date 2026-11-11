// User report (kkrazy 2026-05-27): the in-session agent can't read
// diagram bytes from a chat-rendered `![diagram](url)` — it only
// sees the URL, has no Read access via URL, and when it guesses
// a filesystem path it gets "File does not exist".
//
// Confirmed by the agent's own self-report in chat:
//   "I can't actually see the SVG bytes from here — I only see the
//    path — so I can't tell whether this is the same diagram
//    re-rendered or a modified one."
//
// Fix: the save flow appends the relative filesystem path on a
// second line after the markdown image:
//
//     ![diagram](/sessions/<id>/diagrams/<file>.svg)
//     (saved at: _myco_/diagrams/<file>.svg)
//
// The second line is plain text so the agent can scan its chat
// history, pull `_myco_/diagrams/<file>.svg`, and Read it via the
// standard tool. The relative path works because session cwd is
// always the session workspace.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-84 r4: agent-readable filesystem path appended to diagram insert ──');

t('app.js: _diagramSave appends `(saved at: _myco_/diagrams/...)` after the markdown image', () => {
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  assert.ok(idx > -1, '_diagramSave function must exist');
  const win = sliceFn(APP, idx);
  // Pin the literal "saved at:" hint phrase + that it references
  // body.path (the relative filesystem path the server returned).
  assert.ok(/saved at:/i.test(win),
    '_diagramSave must include a "saved at:" hint after the markdown image so the agent can find the file path');
  assert.ok(/body\.path/.test(win),
    'the hint must use body.path (the relative _myco_/diagrams/... path the server returns)');
});

t('app.js: the hint is a separate line from the markdown image (newline-separated)', () => {
  // The markdown image must render cleanly in chat; the path hint
  // sits on the next line as plain text. Both must be present in
  // the value the textarea ends up with.
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  // Look for a template literal / string concat that includes BOTH
  // `![diagram]` AND a newline AND `(saved at:`.
  assert.ok(
    /!\[diagram\][\s\S]{0,200}\\n[\s\S]{0,200}saved at:/.test(win) ||
    /!\[diagram\][\s\S]{0,200}\(saved at:/.test(win),
    'the markdown image and the (saved at: ...) hint must be on separate lines (newline between them)'
  );
});

t('app.js: hint uses the RELATIVE path (not the URL form) so Read works from session cwd', () => {
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  // The relative path starts with `_myco_/diagrams/` — that's what
  // the agent's Read tool resolves against its cwd (the session
  // workspace).
  assert.ok(/_myco_\/diagrams/.test(win) || /body\.path/.test(win),
    'hint must use the relative `_myco_/diagrams/...` path (returned in body.path)');
  // Negative guard — the hint must NOT use the URL form
  // `/sessions/<id>/diagrams/...` which the agent can't Read.
  // We check that the hint text region doesn't directly use body.url.
  const hintRe = /saved at:\s*\$\{[^}]*\}/;
  const hintMatch = win.match(hintRe);
  if (hintMatch) {
    assert.ok(!/body\.url/.test(hintMatch[0]),
      'the hint must not use body.url — the agent can\'t Read a URL, only a filesystem path');
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
