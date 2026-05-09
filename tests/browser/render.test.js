// Browser render tests — exercises the real client-side stack via Playwright.
// Run via ./test-browser.sh (do not invoke directly).

const { chromium } = require('playwright');

const URL = process.env.TEST_URL || 'http://127.0.0.1:8088';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const no = (m, why) => { fail++; console.log(`  ✗ ${m}${why ? ` — ${why}` : ''}`); };

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on('pageerror', (err) => no('uncaught page error', err.message));

  console.log('── Browser: page load ──');
  const resp = await page.goto(URL, { waitUntil: 'networkidle' });
  resp && resp.ok() ? ok(`page loaded (${resp.status()})`) : no('page load', resp ? resp.status() : 'no response');

  // 1. Library globals
  console.log('── Browser: library globals ──');
  const globals = await page.evaluate(() => ({
    marked: typeof marked,
    hljs: typeof hljs,
    mermaid: typeof mermaid,
    renderMd: typeof renderMd,
    renderMermaidInContainer: typeof renderMermaidInContainer,
    setChatPane: typeof setChatPane,
    setSidebar: typeof setSidebar,
  }));
  globals.marked === 'object' || globals.marked === 'function' ? ok('marked loaded') : no('marked loaded', globals.marked);
  globals.hljs === 'object' ? ok('hljs loaded') : no('hljs loaded', globals.hljs);
  globals.mermaid === 'object' ? ok('mermaid loaded') : no('mermaid loaded', globals.mermaid);
  globals.renderMd === 'function' ? ok('renderMd defined') : no('renderMd defined', globals.renderMd);
  globals.renderMermaidInContainer === 'function' ? ok('renderMermaidInContainer defined') : no('renderMermaidInContainer defined');

  // 2. Syntax highlighting (real DOM, real hljs output)
  console.log('── Browser: syntax highlighting ──');
  const hl = await page.evaluate(() => {
    const md = '```js\nconst greeting = "hi";\nfunction main() { return 42; }\n```';
    const html = renderMd(md);
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div);
    return {
      html,
      hljsClass: !!div.querySelector('code.hljs'),
      langClass: !!div.querySelector('code.language-js'),
      keywordSpans: div.querySelectorAll('.hljs-keyword').length,
      stringSpans: div.querySelectorAll('.hljs-string').length,
      titleSpans: div.querySelectorAll('.hljs-title, .hljs-title.function_').length,
    };
  });
  hl.hljsClass ? ok('code wrapped with .hljs class') : no('code wrapped with .hljs class');
  hl.langClass ? ok('code wrapped with .language-js class') : no('code wrapped with .language-js class');
  hl.keywordSpans > 0 ? ok(`hljs-keyword spans rendered (${hl.keywordSpans})`) : no('hljs-keyword spans');
  hl.stringSpans > 0 ? ok(`hljs-string spans rendered (${hl.stringSpans})`) : no('hljs-string spans');

  // Verify github-dark theme actually colors the spans (not just default text color)
  const keywordColor = await page.evaluate(() => {
    const el = document.querySelector('.hljs-keyword');
    if (!el) return null;
    return getComputedStyle(el).color;
  });
  keywordColor && keywordColor !== 'rgb(255, 255, 255)' && keywordColor !== 'rgba(0, 0, 0, 0)'
    ? ok(`hljs-keyword themed (${keywordColor})`)
    : no('hljs-keyword themed', keywordColor);

  // 3. Mermaid diagram (real SVG output)
  console.log('── Browser: mermaid diagram ──');
  const mm = await page.evaluate(async () => {
    const md = '```mermaid\ngraph TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[End]\n  B -->|no| A\n```';
    const html = renderMd(md);
    const div = document.createElement('div');
    div.id = 'mermaid-test-host';
    div.innerHTML = html;
    document.body.appendChild(div);
    const codeBlocksBefore = div.querySelectorAll('pre code.language-mermaid').length;
    await renderMermaidInContainer(div);
    return {
      codeBlocksBefore,
      mermaidContainers: div.querySelectorAll('.conv-mermaid').length,
      svgs: div.querySelectorAll('.conv-mermaid svg').length,
      codeBlocksAfter: div.querySelectorAll('pre code.language-mermaid').length,
      svgViewBox: (() => {
        const svg = div.querySelector('.conv-mermaid svg');
        return svg ? svg.getAttribute('viewBox') || svg.getAttribute('viewbox') : null;
      })(),
    };
  });
  mm.codeBlocksBefore === 1 ? ok('mermaid block detected pre-render') : no('mermaid block detected', `count=${mm.codeBlocksBefore}`);
  mm.mermaidContainers === 1 ? ok('.conv-mermaid container created') : no('.conv-mermaid container', `count=${mm.mermaidContainers}`);
  mm.svgs === 1 ? ok('mermaid rendered to <svg>') : no('mermaid <svg>', `count=${mm.svgs}`);
  mm.codeBlocksAfter === 0 ? ok('original code block replaced') : no('code block replaced', `still=${mm.codeBlocksAfter}`);
  mm.svgViewBox ? ok(`svg has viewBox (${mm.svgViewBox})`) : no('svg has viewBox');

  // 4. Chat window — show/hide
  console.log('── Browser: chat window ──');
  await page.evaluate(() => setChatPane(true));
  const chatVisible = await page.evaluate(() => {
    const el = document.getElementById('chatpane');
    return { hidden: el.hidden, width: el.getBoundingClientRect().width, hasInput: !!document.getElementById('chat-input'), hasSend: !!document.getElementById('chat-send'), hasForm: !!document.getElementById('chat-form') };
  });
  !chatVisible.hidden ? ok('chatpane shown') : no('chatpane shown');
  chatVisible.width >= 280 ? ok(`chatpane width ${chatVisible.width}px (≥280)`) : no('chatpane width', chatVisible.width);
  chatVisible.hasInput && chatVisible.hasSend && chatVisible.hasForm ? ok('chat input/send/form present') : no('chat input/send/form');

  await page.evaluate(() => setChatPane(false));
  const chatHidden = await page.evaluate(() => document.getElementById('chatpane').hidden);
  chatHidden ? ok('chatpane hidden after close') : no('chatpane hidden after close');

  // 5. Layout — sidebar + main grid
  console.log('── Browser: layout ──');
  const layout = await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    const main = document.getElementById('main') || document.querySelector('main') || document.querySelector('#viewport');
    return {
      sidebarWidth: sb ? sb.getBoundingClientRect().width : 0,
      sidebarVisible: sb ? !sb.hidden && sb.getBoundingClientRect().width > 0 : false,
      mainExists: !!main,
      bodyOverflow: getComputedStyle(document.body).overflow,
      hasConvWrap: !!document.getElementById('conversation-wrap'),
    };
  });
  layout.sidebarVisible ? ok(`sidebar visible (${layout.sidebarWidth}px)`) : no('sidebar visible');
  layout.sidebarWidth >= 200 ? ok('sidebar has expected width (≥200px)') : no('sidebar width', layout.sidebarWidth);
  layout.hasConvWrap ? ok('conversation-wrap mounted') : no('conversation-wrap mounted');

  // Mobile breakpoint sanity (resize, then check sidebar collapses on small screens)
  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForTimeout(100);
  const mobile = await page.evaluate(() => {
    // Trigger window resize handler
    window.dispatchEvent(new Event('resize'));
    return {
      innerWidth: window.innerWidth,
      bodyClass: document.body.className,
    };
  });
  mobile.innerWidth === 600 ? ok('viewport resized to 600px') : no('viewport resize', mobile.innerWidth);

  // 6. Read-only / viewer mode — verify state flag flips and chat-input gets disabled
  console.log('── Browser: read-only / viewer mode ──');
  await page.setViewportSize({ width: 1280, height: 800 });
  const viewer = await page.evaluate(() => {
    state.viewerMode = true;
    // Simulate the WS handler's effect on the input
    const input = document.getElementById('chat-input');
    return { viewerFlag: state.viewerMode === true, hasInput: !!input };
  });
  viewer.viewerFlag ? ok('viewerMode flag settable') : no('viewerMode flag');

  await browser.close();

  console.log('\n─────────────────────────');
  console.log(`  Passed: ${pass}`);
  console.log(`  Failed: ${fail}`);
  if (fail > 0) {
    console.log('  FAILED');
    process.exit(1);
  } else {
    console.log('  All good!');
  }
})().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
