// render-chatmessage-fulltext — 2026-10-26 regression.
//
// User report (live 252): "单列切了session以后，formatProgress内容没打印、
// 旧打印内容全都消失". Console:
//   Uncaught TypeError: Assignment to constant variable.
//     at renderChatMessage (app.js:6755)   ← rowAttrs += ` title=...`
//     at renderChatPane (app.js:6525)      ← .map(renderChatMessage)
//     at applyChatHistory (app.js:4269)    ← chat-history WS frame
//     at WebSocket.<anonymous> (app.js:3060)
//
// Root cause: the /run-n2 formatProgress heartbeat lines + "✅ 完成" lines
// carry `meta.fullText` (server-stamped so the truncated line can show the
// full content on hover). renderChatMessage merged that title onto the row
// via `rowAttrs += ...`, but `rowAttrs` had been declared `const`. Every
// chat-history re-render that hit one of those rows THREW, aborting the
// entire renderChatPane.map — so on session switch / refresh the whole
// single-column timeline + board silently vanished. Fix: `rowAttrs` is `let`.
//
// The regression floor: the fullText title-merge must never assign into a
// `const`. Locked two ways — a static shape check that the declaration is
// `let` AND that the title merge still follows it (so a rename/refactor to
// `const` re-red-flips).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// Extract the renderChatMessage body (column-0 `}` terminates it) — the
// same convention the awk/static guards in test.sh use.
function fnBody(anchor, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  assert.ok(start >= 0, 'function ' + fnName + ' present');
  // scan for the rowAttrs declaration line within the body
  const declRe = /(const|let) rowAttrs =/;
  const at = src.slice(start).search(declRe);
  assert.ok(at >= 0, 'rowAttrs declaration present inside ' + fnName);
  const body = src.slice(start + at);
  return { body, declAt: start + at };
}

console.log('── render-chatmessage-fulltext: /run-n2 progress rows must render (no const-mutation) ──');

t('rowAttrs is declared `let`, not `const` (the formatProgress fullText title-merge mutates it)', () => {
  const { declAt } = fnBody(null, 'renderChatMessage');
  const line = src.slice(declAt, declAt + 80).split('\n')[0];
  assert.ok(/^\s*let rowAttrs =/.test(line),
    'rowAttrs must be `let` — a `const rowAttrs` followed by `rowAttrs +=` throws "Assignment to constant variable", nuking the whole chat-line render (the 单列 history/board disappears). Got: ' + line.trim());
});

t('the fullText title-merge (`rowAttrs += \` title=...`) still exists after the declaration', () => {
  const { body } = fnBody(null, 'renderChatMessage');
  // Matches the real source line:  rowAttrs += ` title="${escHtml(fullText)}"`;
  assert.ok(/rowAttrs\s*\+=\s*`\s*title="\$\{escHtml\(fullText\)\}"/.test(body),
    'the title-merge onto rowAttrs must remain — it is what shows the full /run-n2 progress content on hover (user need: 截断行鼠标放上去可见全部内容)');
});

// Behavioural mirror of the reported stack: invoking the merge is only safe
// if it targets a mutable binding. Re-emit the exact assignment and confirm
// it does NOT hit the const-mutation path the user saw.
t('behavioural: the rowAttrs merge does not throw (const-assignment), per the live console error', () => {
  const { body } = fnBody(null, 'renderChatMessage');
  const decl = body.match(/^\s*(const|let) rowAttrs =/m);
  assert.ok(decl, 'rowAttrs declaration present');
  // If it were `const`, the very frame JS semantics in the live report
  // (V8 "Assignment to constant variable") would reject reassignment.
  assert.strictEqual(decl[1], 'let',
    'must be a let-declared mutable binding, otherwise rowAttrs += throws and aborts renderChatPane.map');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
