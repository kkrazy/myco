// sdk/server.js — HTTP interface over myco's single-agent and run-n2 engines.
//
// The SDK's HTTP surface. The engines behind it are reused verbatim from
// bench/hle/lib (see ./index.js); this file is only the transport interface —
// one small concurrency pool + blocking POST endpoints:
//
//   GET  /             -> service info (model/mock/workRoot)
//   GET  /health       -> alias of /
//   POST /answer       {mode:'single'|'n2', question, system?, timeoutMs?, id?, seq?}
//                      -> blocks until the myco engine answers -> {ok,mode,answer,ms,error?}
//   POST /judge        {engine:'single'|'n2', question, answer, truth, timeoutMs?}
//                      -> blocks until the myco engine judges -> {ok,engine,correct,extracted,answer,ms,error?}
//
// Flags mirror bench/hle/server.js so it can be a drop-in for existing bench
// consumers (run.py etc.):
//   --port <n> (default 8787)  --concurrency <n> (default 4)
//   --timeout <ms> (default 600000)  --env <state/.env path>
//   --stamp <YYYYMMDDHHMMSS>   --mock 1   (offline canned results)
//
// Model+proxy config is loaded from a myco state .env (see bench/hle/lib/config.js).
'use strict';

const http = require('http');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    if (k === '--mock') { a.mock = '1'; continue; }
    a[k.slice(2)] = argv[i + 1];
    i++;
  }
  return a;
}

// Parse args + set env BEFORE loading the engine, which reads BENCH_MOCK at
// require time. `applyEnv` must also run before any model call.
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.mock) process.env.BENCH_MOCK = '1';
const sdk = require('./index');
sdk.init(ARGS.env);
const engine = sdk.engine;
const judge = sdk.judgeMod;

// One timestamped work dir per server process (= per eval run); `--stamp`
// lets a launcher pin the same timestamp the orchestration report uses.
const WORK_STAMP = engine.setWorkRoot(ARGS.stamp);

const PORT = Number(ARGS.port) || Number(process.env.HLE_PORT) || 8787;
const DEFAULT_TIMEOUT_MS = Number(ARGS.timeout) || 600000;
const POOL_SIZE = Number(ARGS.concurrency) || 4;

const info = sdk.info(ARGS.env);
console.log(`[sdk-server] work root -> ${WORK_STAMP}`);
console.log(`[sdk-server] port=${PORT} mock=${!!ARGS.mock} concurrency=${POOL_SIZE}`);
console.log(`[sdk-server] model=${info.model || '(default)'} baseUrl=${info.baseUrl || '(default)'} hasToken=${info.hasToken}`);

// ── tiny concurrency pool (cap concurrent in-flight model calls) ───────────
function createPool(n) {
  let active = 0;
  const queue = [];
  function run(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
      };
      if (active < n) task();
      else queue.push(task);
    });
  }
  return { run };
}
// Single-agent (one SDK call) and n2 (dual-worker) get SEPARATE pools so a
// long-running n2 problem can never starve single-agent requests.
const poolSingle = createPool(Math.max(1, POOL_SIZE));
const poolN2 = createPool(Math.max(1, POOL_SIZE));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function respond(res, code, obj, reqUrl) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
  if (process.env.SDK_DEBUG) console.log(`[sdk-server] ${reqUrl || '?'} -> ${code} ${body.slice(0, 200)}`);
}

// ── OpenAI-compatible bridge ────────────────────────────────────────────────
// Lets an OpenAI-compatible client (evalscope's Web model connection uses the
// official `openai` SDK) treat this SDK as an OpenAI `Chat Completions` model
// endpoint. We are NOT a real LLM service — this shim pulls a *question* out
// of the request and routes it to the myco single-agent / run-n2 engines,
// returning the answer as the assistant message. Mode is chosen by the
// requested model name: anything containing "n2" runs run-n2, else single.
const OPENAI_MODELS = [
  { id: 'myco-single', object: 'model', owned_by: 'myco', description: 'myco single-agent engine' },
  { id: 'myco-n2', object: 'model', owned_by: 'myco', description: 'myco run-n2 (dual-worker) engine' },
];

function openaiModeForModel(model) {
  return /n2/i.test(String(model)) ? 'n2' : 'single';
}

// Pull a plain-text question out of an OpenAI `messages` array (last user
// turn; falls back to the last non-empty content). Multimodal content arrays
// are flattened to their text parts.
function extractQuestion(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = m && m.content;
    if (m && m.role === 'user') {
      if (typeof c === 'string' && c.trim()) return c;
      if (Array.isArray(c)) {
        const txt = c.map((p) => (p && typeof p === 'object' ? p.text : p)).filter(Boolean).join(' ').trim();
        if (txt) return txt;
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i] && messages[i].content;
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

// Serve one /v1/chat/completions request against the myco engines. Handles
// both non-stream (single JSON ChatCompletion) and SSE stream (finish_reason
// + optional usage chunk), so evalscope's openai SDK client works either way.
async function serveChatCompletions(res, body) {
  const model = String(body.model || 'myco-single');
  const mode = openaiModeForModel(model);
  const question = extractQuestion(body.messages);
  if (!question) return respond(res, 400, { error: { message: 'no user message content found in messages', type: 'invalid_request_error' } });
  const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const stream = !!body.stream;
  const includeUsage = !!(body.stream_options && body.stream_options.include_usage);

  const r = await (mode === 'n2' ? poolN2 : poolSingle).run(() => sdk.answer(mode, { question, timeoutMs }));
  if (!r.ok) return respond(res, 502, { error: { message: String(r.error || 'engine failed to answer'), type: 'server_error' } });

  const content = String(r.answer || '');
  const created = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const chunk = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (content) chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
    chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (includeUsage) chunk({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  return respond(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  });
}

function methodNotAllowed(res, url) { return respond(res, 405, { ok: false, error: `method not allowed for ${url}` }); }

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (process.env.SDK_DEBUG) console.log(`[sdk-server] REQ ${req.method} ${req.url}`);
  try {
    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      const i = sdk.info(ARGS.env);
      return respond(res, 200, {
        ok: true,
        service: 'myco-sdk',
        mode: ['answer', 'judge'],
        model: i.model,
        baseUrl: i.baseUrl,
        hasToken: i.hasToken,
        mock: !!ARGS.mock,
        workRoot: WORK_STAMP,
      });
    }
    if (req.method === 'POST' && url === '/answer') {
      const body = await readBody(req);
      const mode = String(body.mode || 'single').toLowerCase();
      if (mode !== 'single' && mode !== 'n2') return respond(res, 400, { ok: false, error: `mode must be single|n2, got ${body.mode}` });
      if (!body.question) return respond(res, 400, { ok: false, error: 'question is required' });
      const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const r = await (mode === 'n2' ? poolN2 : poolSingle).run(() => sdk.answer(mode, {
        question: String(body.question),
        system: body.system !== undefined ? String(body.system) : engine.SYSTEM_ANSWER,
        timeoutMs,
        id: body.id,
        seq: body.seq,
        persist: true,   // persist this answer's work/ dir (judge does NOT persist)
      }));
      return respond(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && url === '/judge') {
      const body = await readBody(req);
      const en = String(body.engine || 'single').toLowerCase();
      if (en !== 'single' && en !== 'n2') return respond(res, 400, { ok: false, error: `engine must be single|n2, got ${body.engine}` });
      if (body.question === undefined || body.answer === undefined || body.truth === undefined) {
        return respond(res, 400, { ok: false, error: 'question, answer, truth are required' });
      }
      const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const r = await (en === 'n2' ? poolN2 : poolSingle).run(() => judge.judge(en, {
        question: String(body.question),
        answer: String(body.answer),
        truth: String(body.truth),
        timeoutMs,
        id: body.id,
        seq: body.seq,
      }));
      return respond(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'GET' && url === '/v1/models') {
      return respond(res, 200, { object: 'list', data: OPENAI_MODELS });
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const body = await readBody(req);
      return serveChatCompletions(res, body);
    }
    if (url === '/' || url === '/health' || url === '/answer' || url === '/judge' || url === '/v1/models' || url === '/v1/chat/completions') {
      return methodNotAllowed(res, url);
    }
    return respond(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return respond(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[sdk-server] listening on :${PORT}`);
});
