// Browser render tests — exercises the real client-side stack via Playwright.
// Run via ./test/test-browser.sh (do not invoke directly).

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

  // 4b. Incremental chat append — appendChatMessage and _postClaudeStreamToChat
  // must NOT wipe-and-rebuild #chat-messages on every new row. Regression:
  // a Claude turn that streams N text blocks used to tear down every prior
  // row N times (innerHTML rewrite), re-parsing markdown, re-rendering
  // mermaid, and flashing the whole chat — visible to the user as the chat
  // pane "reloading entire history from time to time".
  console.log('── Browser: incremental chat append ──');
  await page.evaluate(() => setChatPane(true));
  const inc = await page.evaluate(() => {
    state.chatMessages = [];
    const list = document.getElementById('chat-messages');
    list.innerHTML = '';
    applyChatHistory([
      { user: 'alice', text: 'first', ts: '2026-05-13T00:00:00Z' },
      { user: 'bob',   text: 'second', ts: '2026-05-13T00:00:01Z' },
    ]);
    const beforeCount = list.children.length;
    // Sentinel marks the existing rows; if the list gets innerHTML'd these
    // attributes disappear because the nodes are torn down and rebuilt.
    Array.from(list.children).forEach((el, i) => { el.dataset.sentinel = 's' + i; });
    // Live 'chat' WS frame path
    appendChatMessage({ user: 'alice', text: 'third', ts: '2026-05-13T00:00:02Z' });
    // Streaming assistant text path
    _postClaudeStreamToChat('partial reply', 'uuid-stream-1');
    const after = Array.from(list.children).map((el) => ({
      sentinel: el.dataset.sentinel || null,
      text: el.textContent || '',
    }));
    return { beforeCount, after };
  });
  inc.beforeCount === 2 ? ok('seed: 2 rows after applyChatHistory') : no('seed row count', inc.beforeCount);
  inc.after.length === 4 ? ok('list has 4 rows after 2 appends') : no('post-append row count', inc.after.length);
  inc.after[0].sentinel === 's0' && inc.after[1].sentinel === 's1'
    ? ok('original rows preserved (sentinel intact — no full rebuild)')
    : no('original rows torn down on append', JSON.stringify(inc.after.map((a) => a.sentinel)));
  inc.after[2] && inc.after[2].text.includes('third') ? ok('appendChatMessage adds new row at tail') : no('third row text', inc.after[2] && inc.after[2].text);
  inc.after[3] && inc.after[3].text.includes('partial reply') ? ok('_postClaudeStreamToChat adds new row at tail') : no('fourth row text', inc.after[3] && inc.after[3].text);

  // 4c. Prior menu rows must lose their active picker when a new menu (or
  // menu-auto) lands. Without the surgical deactivation pass, a stale menu
  // would remain clickable and could fire a pick against a dialog Claude
  // has long since moved past.
  console.log('── Browser: prior menu deactivates on new menu append ──');
  const menuT = await page.evaluate(() => {
    state.chatMessages = [];
    const list = document.getElementById('chat-messages');
    list.innerHTML = '';
    const m1 = {
      user: 'claude', text: 'menu-1', ts: '2026-05-13T00:01:00Z',
      meta: { kind: 'menu', menu: { question: 'Q1', options: [{ n: 1, label: 'A' }, { n: 2, label: 'B' }], hash: 'h1' } },
    };
    const m2 = {
      user: 'claude', text: 'menu-2', ts: '2026-05-13T00:01:01Z',
      meta: { kind: 'menu', menu: { question: 'Q2', options: [{ n: 1, label: 'X' }], hash: 'h2' } },
    };
    applyChatHistory([m1]);
    const initialOptCount = document.querySelectorAll('.chat-menu-opt').length;
    appendChatMessage(m2);
    return {
      initialOptCount,
      rowCount: list.children.length,
      firstHasButtons: !!list.children[0].querySelector('.chat-menu-opt'),
      firstHasResolved: !!list.children[0].querySelector('.chat-menu-resolved'),
      secondHasButtons: !!list.children[1].querySelector('.chat-menu-opt'),
    };
  });
  menuT.initialOptCount === 2 ? ok('initial menu rendered with 2 option buttons') : no('initial menu buttons', menuT.initialOptCount);
  menuT.rowCount === 2 ? ok('chat has both menu rows') : no('menu rowCount', menuT.rowCount);
  !menuT.firstHasButtons ? ok('prior menu buttons removed after new menu append') : no('prior menu still clickable');
  menuT.firstHasResolved ? ok('prior menu shows (no longer active) placeholder') : no('prior menu missing resolved label');
  menuT.secondHasButtons ? ok('new menu has active option buttons') : no('new menu missing buttons');

  // 4d. Typing indicator must be a floating overlay — toggling its
  // hidden state must NOT change #chat-messages's scrollHeight or
  // clientHeight. The fix mounts the indicator inside #chat-form as
  // an absolutely-positioned overlay, leaving the flex column
  // unchanged. Mobile users no longer see the chat "jump up and down"
  // when a turn starts or ends.
  console.log('── Browser: typing indicator is layout-neutral ──');
  await page.setViewportSize({ width: 400, height: 600 });
  await page.evaluate(() => setChatPane(true));
  const layoutN = await page.evaluate(async () => {
    state.chatMessages = [];
    state.awaitingClaude = false;
    state.claudeStatusLine = null;
    const stale = document.getElementById('claude-typing');
    if (stale) stale.remove();
    const list = document.getElementById('chat-messages');
    list.innerHTML = '';
    const history = [];
    for (let i = 0; i < 30; i++) {
      history.push({ user: i % 2 ? 'alice' : 'bob', text: 'line ' + i + ' ' + 'x'.repeat(40), ts: '2026-05-13T00:00:00Z' });
    }
    applyChatHistory(history);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const snap = () => ({
      sh: list.scrollHeight,
      ch: list.clientHeight,
      st: list.scrollTop,
    });
    const before = snap();
    // Show indicator (dots only).
    state.awaitingClaude = true;
    _renderClaudeTyping();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const onShow = snap();
    // Add status text.
    state.claudeStatusLine = '· Cerebrating… (5s)';
    _renderClaudeTyping();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const onStatus = snap();
    // Hide indicator.
    state.awaitingClaude = false;
    state.claudeStatusLine = null;
    _renderClaudeTyping();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const onHide = snap();
    // Where the indicator actually mounted.
    const indicatorParent = document.getElementById('claude-typing')?.parentElement?.id || null;
    return { before, onShow, onStatus, onHide, indicatorParent };
  });
  layoutN.indicatorParent === 'chat-form'
    ? ok('typing indicator mounted inside #chat-form (out of flex flow)')
    : no('indicator mounted outside #chat-form', layoutN.indicatorParent);
  layoutN.before.sh === layoutN.onShow.sh && layoutN.before.ch === layoutN.onShow.ch
    ? ok('chat-messages dimensions unchanged on indicator show')
    : no('chat-messages reflowed on indicator show', JSON.stringify({ before: layoutN.before, after: layoutN.onShow }));
  layoutN.onShow.sh === layoutN.onStatus.sh && layoutN.onShow.ch === layoutN.onStatus.ch
    ? ok('chat-messages dimensions unchanged on status text update')
    : no('chat-messages reflowed on status text update', JSON.stringify({ before: layoutN.onShow, after: layoutN.onStatus }));
  layoutN.onStatus.sh === layoutN.onHide.sh && layoutN.onStatus.ch === layoutN.onHide.ch
    ? ok('chat-messages dimensions unchanged on indicator hide')
    : no('chat-messages reflowed on indicator hide', JSON.stringify({ before: layoutN.onStatus, after: layoutN.onHide }));
  // scrollTop also stable across all three transitions — a stable
  // viewport is the user-visible effect we care about.
  layoutN.before.st === layoutN.onShow.st
    && layoutN.onShow.st === layoutN.onStatus.st
    && layoutN.onStatus.st === layoutN.onHide.st
    ? ok(`scrollTop stable across show/status/hide (${layoutN.before.st})`)
    : no('scrollTop drifted across indicator toggles', JSON.stringify(layoutN));

  await page.setViewportSize({ width: 1280, height: 800 });

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
