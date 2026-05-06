#!/usr/bin/env node
// myco CLI — connects an interactive terminal to a live mycod session over
// the same /attach/<id> WebSocket the web UI uses. Designed to run on the
// same host as mycod (e.g. inside a VS Code Remote-SSH terminal).

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const MYCO_HOME = process.env.MYCO_HOME || path.resolve(__dirname, '..');

function readEnvFile(p) {
  const out = {};
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
  } catch {}
  return out;
}

function discover() {
  const env = readEnvFile(path.join(MYCO_HOME, '.env'));
  const tlsCert = process.env.TLS_CERT_PATH || env.TLS_CERT_PATH || path.join(MYCO_HOME, '.tls/cert.pem');
  const tls = fs.existsSync(tlsCert);
  const port = parseInt(process.env.PORT || env.PORT, 10) || (tls ? 443 : 3000);
  const me = process.env.USER || os.userInfo().username;

  let token = '';
  const tokens = process.env.MYCO_TOKENS || env.MYCO_TOKENS || '';
  for (const pair of tokens.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const u = pair.slice(0, idx).trim();
    const t = pair.slice(idx + 1).trim();
    if (u === me) { token = t; break; }
  }
  if (!token) token = process.env.MYCO_TOKEN || env.MYCO_TOKEN || '';

  return { tls, port, token, user: me };
}

function usage() {
  process.stderr.write('usage: myco attach <session-id>\n');
  process.exit(2);
}

function attachCmd(sessionId) {
  if (!sessionId) usage();

  const { tls, port, token } = discover();
  const wsProto = tls ? 'wss' : 'ws';
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `${wsProto}://127.0.0.1:${port}/attach/${encodeURIComponent(sessionId)}${qs}`;

  const ws = new WebSocket(url, { rejectUnauthorized: false });

  let stdinWasRaw = false;
  let detachPrev = false;
  let exited = false;

  function cleanup(code = 0) {
    if (exited) return;
    exited = true;
    try { if (process.stdin.isTTY && stdinWasRaw) process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
    try { ws.close(); } catch {}
    process.exit(code);
  }

  process.on('SIGINT', () => { /* forward to PTY, don't exit ourselves */ });

  ws.on('open', () => {
    process.stderr.write('\x1b[2m[myco] attached — detach: Ctrl-] then q\x1b[0m\r\n');
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); stdinWasRaw = true; } catch {}
    }
    process.stdin.resume();
    if (process.stdout.isTTY) {
      ws.send(JSON.stringify({ t: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
    }
  });

  process.stdout.on('resize', () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (process.stdout.isTTY) {
      ws.send(JSON.stringify({ t: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
    }
  });

  process.stdin.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const out = [];
    for (const b of chunk) {
      if (detachPrev) {
        detachPrev = false;
        if (b === 0x71 /* q */) { cleanup(0); return; }
        out.push(0x1d, b);
      } else if (b === 0x1d /* Ctrl-] */) {
        detachPrev = true;
      } else {
        out.push(b);
      }
    }
    if (!out.length) return;
    ws.send(JSON.stringify({ t: 'input', data: Buffer.from(out).toString('base64') }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'output' && typeof msg.data === 'string') {
      process.stdout.write(Buffer.from(msg.data, 'base64'));
    } else if (msg.t === 'exit') {
      process.stderr.write(`\r\n\x1b[2m[myco] session ended (code ${msg.code})\x1b[0m\r\n`);
      cleanup(0);
    } else if (msg.t === 'error') {
      process.stderr.write(`\r\n\x1b[31m[myco] ${msg.message}\x1b[0m\r\n`);
      cleanup(1);
    }
  });

  ws.on('close', (code) => {
    process.stderr.write(`\r\n\x1b[2m[myco] disconnected (${code})\x1b[0m\r\n`);
    cleanup(0);
  });

  ws.on('error', (err) => {
    process.stderr.write(`\r\n\x1b[31m[myco] ${err.message}\x1b[0m\r\n`);
    cleanup(1);
  });
}

const [, , cmd, arg] = process.argv;
if (cmd === 'attach') attachCmd(arg);
else usage();
