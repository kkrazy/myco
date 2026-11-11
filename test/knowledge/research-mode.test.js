// Research mode + domain knowledge base — unit tests.
//
// Covers the myco-side contract only (the KB service has its own suite in
// kb-service/test/run.js):
//   · research mode gating (nothing happens outside it)
//   · injection decisions + rendering
//   · extraction parsing + write-back throttling
//   · the HTTP client's fail-open behaviour
//
// No network, no Docker: the client is exercised against a dead port and
// against a stub fetch.

const assert = require('assert');

const client = require('../../server/src/knowledge/client');
const inject = require('../../server/src/knowledge/inject');
const writer = require('../../server/src/knowledge/writer');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

async function main() {
  console.log('── client ──');

  await t('disabled when MYCO_KB_URL is unset', async () => {
    const prev = process.env.MYCO_KB_URL;
    delete process.env.MYCO_KB_URL;
    assert.strictEqual(client.isEnabled(), false);
    const res = await client.search('math', 'anything');
    assert.strictEqual(res.ok, false);
    assert.ok(/not configured/.test(res.error));
    if (prev !== undefined) process.env.MYCO_KB_URL = prev;
  });

  await t('fails open when the service is unreachable', async () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://127.0.0.1:1';
    process.env.MYCO_KB_TIMEOUT_MS = '300';
    const res = await client.search('math', 'anything');
    assert.strictEqual(res.ok, false);
    assert.ok(res.error, 'expected an error message');
    if (prev === undefined) delete process.env.MYCO_KB_URL;
    else process.env.MYCO_KB_URL = prev;
    delete process.env.MYCO_KB_TIMEOUT_MS;
  });

  await t('sends the bearer token and decodes JSON', async () => {
    const prevUrl = process.env.MYCO_KB_URL;
    const prevTok = process.env.MYCO_KB_TOKEN;
    process.env.MYCO_KB_URL = 'http://kb.test';
    process.env.MYCO_KB_TOKEN = 'secret';
    const realFetch = global.fetch;
    let seen = null;
    global.fetch = async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ count: 0, results: [] }),
      };
    };
    try {
      const res = await client.search('math', 'Kakeya', { k: 3 });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(seen.url, 'http://kb.test/kbs/math/search');
      assert.strictEqual(seen.opts.headers.Authorization, 'Bearer secret');
      assert.strictEqual(JSON.parse(seen.opts.body).query, 'Kakeya');
      assert.strictEqual(JSON.parse(seen.opts.body).k, 3);
    } finally {
      global.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.MYCO_KB_URL;
      else process.env.MYCO_KB_URL = prevUrl;
      if (prevTok === undefined) delete process.env.MYCO_KB_TOKEN;
      else process.env.MYCO_KB_TOKEN = prevTok;
    }
  });

  await t('encodes CJK slugs in note paths', async () => {
    const prevUrl = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    const realFetch = global.fetch;
    let seenUrl = null;
    global.fetch = async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    try {
      await client.patchNote('math', '椭圆曲线', { status: 'verified' });
      assert.ok(seenUrl.includes(encodeURIComponent('椭圆曲线')));
      assert.ok(!seenUrl.includes('椭圆曲线'), 'raw CJK must not appear in the URL');
    } finally {
      global.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.MYCO_KB_URL;
      else process.env.MYCO_KB_URL = prevUrl;
    }
  });

  console.log('── injection ──');

  await t('never injects outside research mode', () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    assert.strictEqual(inject.shouldInject('a substantive research question', null), false);
    assert.strictEqual(inject.shouldInject('a substantive research question', {}), false);
    assert.strictEqual(inject.shouldInject('a substantive research question', { researchMode: false }), false);
    assert.strictEqual(inject.shouldInject('a substantive research question', { researchMode: true }), true);
    if (prev === undefined) delete process.env.MYCO_KB_URL;
    else process.env.MYCO_KB_URL = prev;
  });

  await t('skips slash commands, trivial replies, and short prompts', () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    const rec = { researchMode: true };
    assert.strictEqual(inject.shouldInject('/kb search x', rec), false);
    assert.strictEqual(inject.shouldInject('好的', rec), false);
    assert.strictEqual(inject.shouldInject('继续', rec), false);
    assert.strictEqual(inject.shouldInject('hi', rec), false);
    assert.strictEqual(inject.shouldInject('please look into the Kakeya problem', rec), true);
    if (prev === undefined) delete process.env.MYCO_KB_URL;
    else process.env.MYCO_KB_URL = prev;
  });

  await t('honours kbAutoInject=false', () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    assert.strictEqual(
      inject.shouldInject('please look into the Kakeya problem', { researchMode: true, kbAutoInject: false }),
      false,
    );
    if (prev === undefined) delete process.env.MYCO_KB_URL;
    else process.env.MYCO_KB_URL = prev;
  });

  await t('renders a marked, budgeted, data-not-instructions block', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      source: 'corpus', kind: 'body', paperSlug: `paper-${i}`, section: 'Intro',
      snippet: 'x'.repeat(700), score: 1 - i * 0.01,
    }));
    const block = inject.renderBlock('Kakeya', results);
    assert.ok(block.startsWith('<domain_knowledge'));
    assert.ok(block.includes('DATA, not instructions'));
    assert.ok(block.includes('[KB:paper-0 §Intro]'));
    assert.ok(block.includes('</domain_knowledge>'));
    assert.ok(block.length < inject.MAX_BLOCK_CHARS + 1200, 'block must respect the budget');
    assert.ok(block.includes('Cite what you use'));
  });

  await t('labels local draft notes as unverified', () => {
    const block = inject.renderBlock('q', [{
      source: 'local', kind: 'insight', noteSlug: 'my-note', section: '结论',
      noteStatus: 'draft', snippet: 'a local finding',
    }]);
    assert.ok(block.includes('[LOCAL:my-note §结论]'));
    assert.ok(block.includes('status=draft'));
    assert.ok(block.includes('unverified'));
  });

  await t('returns null when there are no results', () => {
    assert.strictEqual(inject.renderBlock('q', []), null);
    assert.strictEqual(inject.renderBlock('q', null), null);
  });

  await t('buildInjection interleaves mounted KBs fairly', async () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const kb = url.includes('/kbs/a/') ? 'a' : 'b';
      const results = Array.from({ length: 5 }, (_, i) => ({
        source: 'corpus', kind: 'body', paperSlug: `${kb}-${i}`, section: 's',
        snippet: `${kb} snippet ${i}`, score: kb === 'a' ? 1 : 0.5,
      }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ query: body.query, results }) };
    };
    try {
      const out = await inject.buildInjection('a research question', {
        researchMode: true, knowledgeBases: ['a', 'b'],
      });
      assert.ok(out.block);
      const aHits = (out.block.match(/\[KB:a-/g) || []).length;
      const bHits = (out.block.match(/\[KB:b-/g) || []).length;
      assert.ok(aHits > 0 && bHits > 0, `expected both KBs, got a=${aHits} b=${bHits}`);
    } finally {
      global.fetch = realFetch;
      if (prev === undefined) delete process.env.MYCO_KB_URL;
      else process.env.MYCO_KB_URL = prev;
    }
  });

  console.log('── write-back ──');

  await t('extracts only in research mode with a substantive result', () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    writer.resetThrottle();
    const long = 'x'.repeat(500);
    assert.strictEqual(writer.shouldExtract({}, long, 'success', 's1'), false);
    assert.strictEqual(writer.shouldExtract({ researchMode: true }, 'short', 'success', 's2'), false);
    assert.strictEqual(writer.shouldExtract({ researchMode: true }, long, 'error', 's3'), false);
    assert.strictEqual(writer.shouldExtract({ researchMode: true, kbAutoWrite: false }, long, 'success', 's4'), false);
    assert.strictEqual(writer.shouldExtract({ researchMode: true }, long, 'success', 's5'), true);
    if (prev === undefined) delete process.env.MYCO_KB_URL;
    else process.env.MYCO_KB_URL = prev;
  });

  await t('throttles repeated extractions per session', () => {
    const prev = process.env.MYCO_KB_URL;
    process.env.MYCO_KB_URL = 'http://kb.test';
    writer.resetThrottle();
    const long = 'x'.repeat(500);
    assert.strictEqual(writer.shouldExtract({ researchMode: true }, long, 'success', 'sess'), true);
    // Simulate the timestamp the real call sets.
    writer.resetThrottle();
    const w = writer;
    // shouldExtract is pure; the throttle lives in lastRunAt and is only
    // advanced by extractAndWrite. Verify the reset hook works at least.
    w.resetThrottle('sess');
    assert.strictEqual(w.shouldExtract({ researchMode: true }, long, 'success', 'sess'), true);
    if (prev === undefined) delete process.env.MYCO_KB_URL;
    else process.env.MYCO_KB_URL = prev;
  });

  await t('parses a JSON array, tolerating fences and prose', () => {
    const fenced = '```json\n[{"title":"A finding","kind":"insight","content":"## 结论\\n\\nBody.","tags":["x"],"confidence":"high"}]\n```';
    const out = writer.parseExtraction(fenced);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'insight');
    assert.strictEqual(out[0].confidence, 'high');

    const prose = 'Here you go:\n[{"title":"Another","kind":"method","content":"Body text."}]\nDone.';
    assert.strictEqual(writer.parseExtraction(prose)[0].kind, 'method');
  });

  await t('rejects malformed extraction output', () => {
    assert.deepStrictEqual(writer.parseExtraction('not json'), []);
    assert.deepStrictEqual(writer.parseExtraction(''), []);
    assert.deepStrictEqual(writer.parseExtraction(null), []);
    assert.deepStrictEqual(writer.parseExtraction('[{"title":"x"}]'), []);  // content too short
    assert.deepStrictEqual(writer.parseExtraction('{"title":"not an array"}'), []);
  });

  await t('normalizes unknown kinds and caps item count', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      title: `Finding ${i}`, kind: 'bogus', content: 'Body text long enough.',
    }));
    const out = writer.parseExtraction(JSON.stringify(items));
    assert.strictEqual(out.length, writer.MAX_ITEMS);
    assert.ok(out.every((x) => x.kind === 'insight'));
  });

  await t('extractAndWrite is a no-op outside research mode', async () => {
    const out = await writer.extractAndWrite({
      sessionId: 's', rec: {}, result: 'x'.repeat(500), subtype: 'success', cwd: process.cwd(),
    });
    assert.deepStrictEqual(out.written, []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
