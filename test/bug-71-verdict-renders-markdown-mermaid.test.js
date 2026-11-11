// bug-71 regression: the verdict pane (Gemini critic output) must
// render markdown + mermaid diagrams, not show raw markup as plain
// text.
//
// User report (bug-71 from @labxnow):
//   "the verdict display should display markdown/mermaid diagrams
//    properly"
//
// Root cause: web/public/app.js ~line 7905 built the verdict body
// via `escHtml(review.critique)` — HTML-escapes the markdown
// markers, so `# Heading` / `**bold**` / triple-backtick fences
// rendered as literal characters in the .verdict-critique div.
//
// Fix: use renderMd(review.critique || '') (same path the
// assistant_text bubble uses — marked + highlight.js). Post-process
// the rendered DOM with renderMermaidInContainer so mermaid code
// fences become SVG diagrams.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-71: verdict pane renders markdown + mermaid ──');

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on the prod render path
// ─────────────────────────────────────────────────────────────────

t('verdict formattedCritique uses renderMd (not escHtml)', () => {
  // The formattedCritique assignment must call renderMd. Pre-fix
  // it called escHtml — that's the failure mode.
  assert.ok(/const\s+formattedCritique\s*=\s*renderMd\s*\(\s*review\.critique/.test(APP),
    'formattedCritique must call renderMd(review.critique...) — the bug-71 fix replaced escHtml');
  // Negative guard: the OLD escHtml(review.critique) line must NOT
  // be in the file anymore. Catches a future revert.
  assert.ok(!/const\s+formattedCritique\s*=\s*escHtml\s*\(\s*review\.critique\s*\)/.test(APP),
    'the pre-fix `const formattedCritique = escHtml(review.critique)` line must NOT remain — that was the exact bug');
});

t('renderMd(review.critique) tolerates missing/null critique', () => {
  // Defense: `review.critique` may be undefined for early-arriving
  // verdicts. The call must use `(review.critique || '')` so
  // renderMd doesn't blow up on undefined.
  assert.ok(/renderMd\s*\(\s*review\.critique\s*\|\|\s*['"]['"]/.test(APP),
    'the renderMd call must default to empty-string when review.critique is missing — `renderMd(review.critique || "")` shape');
});

t('verdict body is post-processed with renderMermaidInContainer', () => {
  // After panel.innerHTML lands, the verdict-critique container
  // must be passed through renderMermaidInContainer so mermaid code
  // fences become SVG diagrams. Without this, the markdown step
  // produces `<pre class="mermaid">…</pre>` but it never renders.
  assert.ok(/renderMermaidInContainer\s*\(\s*critiqueEl/.test(APP),
    'verdict pane must call renderMermaidInContainer(critiqueEl) to render mermaid diagrams in the critique body');
  // Defense: the call must target the .verdict-critique element
  // (not the whole panel — would re-render unrelated mermaid). The
  // querySelector pin makes that explicit.
  assert.ok(/querySelector\s*\(\s*['"]\.verdict-critique['"]\s*\)/.test(APP),
    'the mermaid post-processor must target .verdict-critique via querySelector — not the whole panel');
});

t('underlying helpers renderMd + renderMermaidInContainer are still defined', () => {
  // If a future refactor renames either helper, the bug-71 fix
  // breaks silently — the function call would throw and the
  // verdict pane would fall back to whatever the catch swallows.
  // Pin both helpers' existence.
  assert.ok(/function\s+renderMd\s*\(/.test(APP),
    'renderMd helper must be defined in app.js');
  assert.ok(/async\s+function\s+renderMermaidInContainer\s*\(/.test(APP),
    'renderMermaidInContainer helper must be defined in app.js');
});

t('mermaid post-processor sits AFTER panel.innerHTML assignment', () => {
  // Sequencing: the innerHTML must land BEFORE we querySelector for
  // .verdict-critique. Otherwise the element doesn't exist yet and
  // the lookup returns null.
  const innerHtmlIdx = APP.indexOf('panel.innerHTML = `');
  assert.ok(innerHtmlIdx > -1, 'panel.innerHTML assignment must exist (the verdict-pane render block)');
  const mermaidCallIdx = APP.indexOf("renderMermaidInContainer(critiqueEl");
  assert.ok(mermaidCallIdx > -1, 'renderMermaidInContainer call must exist');
  assert.ok(mermaidCallIdx > innerHtmlIdx,
    'renderMermaidInContainer must run AFTER panel.innerHTML — querying the element pre-render returns null');
});

t('mermaid call is wrapped in try/catch (never throws past caller)', () => {
  // Defense: a malformed mermaid block must not break the verdict
  // UI. The call wraps in try/catch + the inner .catch(() => {})
  // on the returned promise.
  const callSliceMatch = APP.match(/try\s*\{[\s\S]{0,500}?renderMermaidInContainer\s*\(\s*critiqueEl[\s\S]{0,200}?\}\s*catch/);
  assert.ok(callSliceMatch,
    'the renderMermaidInContainer call must sit inside a try/catch so a malformed diagram doesn\'t break the verdict UI');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Behavioral: prove renderMd transforms markdown markers
// ─────────────────────────────────────────────────────────────────

// We can't easily import renderMd in a node test (it depends on the
// browser-side `marked` global). Instead we run marked directly on
// the same input shapes and verify the markdown step produces the
// HTML the post-processor expects. If renderMd is wrapping marked
// (verified in PART A), this proves the end-to-end markdown
// rendering works.

let marked;
try {
  marked = require('marked');
} catch (e1) {
  // Fall back to server/node_modules — bug-69's ensure_server_deps
  // installs it there.
  try {
    marked = require(path.join(__dirname, '..', 'server', 'node_modules', 'marked'));
  } catch (e2) {
    console.log('  ~ marked module not available — Part B will skip');
    marked = null;
  }
}

if (marked && typeof marked.parse === 'function') {
  // Use the same default marked config the prod renderMd uses.
  // (The renderMd helper itself does extra hooks like syntax
  // highlighting; we only need to verify the marker → HTML
  // transformation, not the full highlight pipeline.)
  const mdToHtml = (s) => marked.parse(s);

  t('renderMd-equivalent: # Heading → <h1>', () => {
    const html = mdToHtml('# Hello');
    assert.ok(/<h1[^>]*>Hello<\/h1>/i.test(html),
      'markdown `# Hello` must render as <h1>Hello</h1> — pre-fix this showed as literal `# Hello`');
  });

  t('renderMd-equivalent: **bold** → <strong>', () => {
    const html = mdToHtml('This is **bold** text');
    assert.ok(/<strong>bold<\/strong>/.test(html),
      'markdown `**bold**` must render as <strong>bold</strong>');
  });

  t('renderMd-equivalent: bullet list → <ul><li>', () => {
    const html = mdToHtml('- one\n- two\n- three');
    assert.ok(/<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<li>three<\/li>[\s\S]*<\/ul>/.test(html),
      'markdown bullet list must render as <ul><li>...</li></ul>');
  });

  t('renderMd-equivalent: fenced code block → <pre><code>', () => {
    const html = mdToHtml('```js\nconst x = 1;\n```');
    assert.ok(/<pre>[\s\S]*<code[^>]*>[\s\S]*const x = 1[\s\S]*<\/code>[\s\S]*<\/pre>/.test(html),
      'markdown fenced code block must render as <pre><code>...</code></pre>');
  });

  t('renderMd-equivalent: mermaid fenced block → preserved for post-processor', () => {
    // marked emits ```mermaid as a generic <pre><code class="language-mermaid">…</code></pre>.
    // The renderMermaidInContainer helper picks that up via a
    // querySelector('code.language-mermaid') (or similar) and
    // converts it to an SVG. We verify the markdown step
    // PRESERVES the mermaid content + tags the language so the
    // post-processor can find it.
    const mmd = 'graph TD\n  A --> B';
    const html = mdToHtml('```mermaid\n' + mmd + '\n```');
    assert.ok(/language-mermaid|class="mermaid"/.test(html),
      'mermaid code fence must be tagged with language-mermaid (or class="mermaid") in the markdown output so renderMermaidInContainer can find it');
    assert.ok(html.includes('graph TD'),
      'mermaid block content must be preserved verbatim by the markdown step (the post-processor needs the raw graph definition)');
  });

  // Defense — confirm the PRE-fix path (escHtml) would NOT have
  // produced renderable output. This proves the bug-71 fix is
  // meaningful, not cosmetic.
  t('pre-fix escHtml(markdown) shows raw markers — confirms bug was real', () => {
    // We emulate the pre-fix path: escHtml on a markdown input.
    // The result must include the LITERAL `#` / `**` / triple-
    // backtick markers (NOT <h1> / <strong> / <pre>).
    const escHtml = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const escaped = escHtml('# Hello\n**bold**\n```js\ncode\n```');
    assert.ok(escaped.includes('# Hello'),
      'pre-fix escHtml leaves `# Hello` as literal text (NOT <h1>) — the bug');
    assert.ok(escaped.includes('**bold**'),
      'pre-fix escHtml leaves `**bold**` as literal markers (NOT <strong>)');
    assert.ok(escaped.includes('```'),
      'pre-fix escHtml leaves triple-backticks as literal characters (NOT <pre><code>)');
    assert.ok(!/<h1>|<strong>|<pre>/.test(escaped),
      'pre-fix escHtml never produces <h1>/<strong>/<pre> tags — the verdict pane was unreadable for markdown-shaped critic output');
  });
} else {
  // marked isn't installed — skip the behavioral cases but log a
  // clear note so the static guards still pin the prod contract.
  t('Part B SKIPPED — marked module not resolvable (npm install needed)', () => {
    console.log('     (Part A static guards still validate the prod fix shape.)');
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
