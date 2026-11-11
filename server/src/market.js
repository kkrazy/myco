// delm-11: generic MARKET for EXPERTS / EXPERT TEAMS / MCP SERVERS.
// Complements the skill market (skill-market.js). The user request:
// the market must be LAYERED — skill market, expert market, expert
// team market, mcp market — and every expert/team/mcp item has a
// PERSONAL (user-private) copy plus a one-click PUBLISH step; only
// published items are visible in the market tab (market = cross-user
// shared store).
//
// Layout in the shared state dir ($MYCO_STATE_DIR/market/):
//   market/personal/<user>/<type>/<name>.json  — private drafts
//   market/store/<type>.json                   — published index (0600)
//   market/<type>/<name>.json                  — published item files
//   market/delete-code                         — system delete code
//     (SHARED with skill-market/skills — same file, same policy:
//     uploader may delete their own item; anyone proving the system
//     delete code may delete any item; constant-time compare +
//     per-user failure throttle).
//
// Item shapes (all carry name + description; type-specific fields):
//   expert { name, description, prompt }            — prompt = system-prompt
//                                                     persona definition
//   team   { name, description, experts:[{name,role}] } — expert team
//   mcp    { name, description, transport:'stdio'|'http'|'sse',
//            command?, args?, env?, url? }          — MCP server config
//                                                     (stdio: command+args,
//                                                      http/sse: url)
//
// Errors reuse the tagged-code vocabulary: ERR_BAD_INPUT / ERR_NOT_FOUND
// / ERR_EXISTS / ERR_PERM / ERR_FORBIDDEN / ERR_THROTTLED / ERR_TOO_LARGE.

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const MARKET_ROOT = path.join(STATE_DIR, 'market');
const PERSONAL_ROOT = path.join(MARKET_ROOT, 'personal');
const ITEMS_ROOT = path.join(MARKET_ROOT, 'items');
const STORE_ROOT = path.join(MARKET_ROOT, 'store');
// The delete code file is SHARED with the skill market (skills.js /
// skill-market.js read $MYCO_STATE_DIR/skill-market/delete-code).
// One code, one policy, one file — never a second source.
const DELETE_CODE_FILE = path.join(STATE_DIR, 'skill-market', 'delete-code');

const TYPES = ['expert', 'team', 'mcp', 'harness'];
const NAME_RE = /^[A-Za-z0-9\u{4e00}-\u{9fa5}][A-Za-z0-9\u{4e00}-\u{9fa5}._ -]{0,63}$/u;
const MAX_ITEM_BYTES = 64 * 1024;         // per item JSON
const MAX_EXPERTS = 20;                   // per team

// Delete-code throttle (mirrors skill-market.js).
const CODE_FAIL_LIMIT = 10;
const CODE_FAIL_WINDOW_MS = 60 * 1000;
const codeFails = new Map();

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function assertType(type) {
  const raw = String(type == null ? '' : type).trim();
  if (!TYPES.includes(raw)) {
    throw err('ERR_BAD_INPUT', `unknown market type "${raw}" (expected one of ${TYPES.join(', ')})`);
  }
  return raw;
}

function assertName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw || !NAME_RE.test(raw)) {
    throw err('ERR_BAD_INPUT', 'invalid item name (letters, digits, CJK, . _ - space; max 64 chars)');
  }
  return raw;
}

function assertUser(user) {
  const raw = String(user == null ? '' : user).trim();
  if (!raw) throw err('ERR_FORBIDDEN', 'not signed in');
  // keep the user path safe for the filesystem
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
    throw err('ERR_FORBIDDEN', 'invalid user for personal store');
  }
  return raw;
}

// ─── item validation (per type) ───

function str(v) { return (typeof v === 'string') ? v : ''; }

function validateItem(type, body) {
  const b = body || {};
  const name = assertName(b.name);
  const description = str(b.description).slice(0, 1000);
  const item = { name, description };

  if (type === 'expert') {
    const prompt = str(b.prompt);
    if (!prompt.trim()) throw err('ERR_BAD_INPUT', 'expert requires a prompt (the persona system prompt)');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_ITEM_BYTES) {
      throw err('ERR_TOO_LARGE', 'expert prompt exceeds max size');
    }
    item.prompt = prompt;
  } else if (type === 'team') {
    const experts = b.experts;
    if (!Array.isArray(experts) || experts.length === 0) {
      throw err('ERR_BAD_INPUT', 'team requires experts:[{name, role}]');
    }
    if (experts.length > MAX_EXPERTS) throw err('ERR_TOO_LARGE', `team exceeds ${MAX_EXPERTS} experts`);
    item.experts = experts.map((e) => {
      if (!e || typeof e !== 'object') throw err('ERR_BAD_INPUT', 'each expert must be an object {name, role}');
      return {
        name: assertName(e.name),
        role: str(e.role).slice(0, 200),
      };
    });
  } else if (type === 'mcp') {
    const transport = ['stdio', 'http', 'sse'].includes(b.transport) ? b.transport : 'stdio';
    item.transport = transport;
    if (transport === 'stdio') {
      const command = str(b.command);
      if (!command.trim()) throw err('ERR_BAD_INPUT', 'stdio MCP server requires a command');
      item.command = command;
      item.args = Array.isArray(b.args) ? b.args.map(str).slice(0, 50) : [];
      const envIn = (b.env && typeof b.env === 'object' && !Array.isArray(b.env)) ? b.env : {};
      item.env = {};
      for (const [k, v] of Object.entries(envIn)) {
        item.env[String(k).slice(0, 100)] = String(v == null ? '' : v).slice(0, 2000);
      }
    } else {
      const url = str(b.url);
      if (!/^https?:\/\//i.test(url)) throw err('ERR_BAD_INPUT', `${transport} MCP server requires an http(s) url`);
      item.url = url;
    }
  } else if (type === 'harness') {
    // Harness items carry a c1..c8 file tree. surface is always 'myco'.
    const surface = str(b.surface) || 'myco';
    if (!['myco'].includes(surface)) {
      throw err('ERR_BAD_INPUT', `harness surface must be 'myco', got '${surface}'`);
    }
    item.surface = surface;
    item.files = (b.files && typeof b.files === 'object' && !Array.isArray(b.files)) ? b.files : {};
    // _fileContent is the installation payload (name→text). Stored alongside the item;
    // excluded from the size guard below because it can legitimately be large.
    if (b._fileContent && typeof b._fileContent === 'object') item._fileContent = b._fileContent;
    if (b.sweepTag)      item.sweepTag      = str(b.sweepTag).slice(0, 100);
    if (b.task)          item.task          = str(b.task).slice(0, 200);
    if (b.mode)          item.mode          = str(b.mode).slice(0, 20);
    if (b.k != null)     item.k             = Number.isInteger(+b.k) && +b.k > 0 ? +b.k : 1;
    if (b.domain)        item.domain        = str(b.domain).slice(0, 50);
    if (b.selectionWhy)  item.selectionWhy  = str(b.selectionWhy).slice(0, 2000);
  }

  // Size guard excludes _fileContent so harness install payloads are not truncated.
  const sizeCheck = { ...item };
  delete sizeCheck._fileContent;
  if (Buffer.byteLength(JSON.stringify(sizeCheck), 'utf8') > MAX_ITEM_BYTES) {
    throw err('ERR_TOO_LARGE', 'item exceeds max size');
  }
  return item;
}

// ─── storage helpers ───

async function ensureDirs() {
  try {
    await fsp.mkdir(PERSONAL_ROOT, { recursive: true });
    await fsp.mkdir(ITEMS_ROOT, { recursive: true });
    await fsp.mkdir(STORE_ROOT, { recursive: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback;
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

async function writeJson(file, data, mode = 0o600) {
  await ensureDirs();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
}

function personalFile(user, type, name) {
  return path.join(PERSONAL_ROOT, assertUser(user), assertType(type), `${name}.json`);
}

function itemFile(type, name) {
  // sanitize name for filename: keep display name inside JSON
  const safe = name.replace(/[^\w一-龥.-]/g, '_');
  return path.join(ITEMS_ROOT, assertType(type), `${safe}.json`);
}

function storeFile(type) {
  return path.join(STORE_ROOT, `${assertType(type)}.json`);
}

// ─── system delete code (shared file with skill-market) ───

async function getDeleteCode() {
  try {
    const raw = (await fsp.readFile(DELETE_CODE_FILE, 'utf8')).trim();
    if (raw) return raw;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    }
  }
  const code = crypto.randomBytes(24).toString('hex');
  await fsp.mkdir(path.dirname(DELETE_CODE_FILE), { recursive: true });
  try {
    await fsp.writeFile(DELETE_CODE_FILE, code + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return (await fsp.readFile(DELETE_CODE_FILE, 'utf8')).trim();
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  try { fs.chmodSync(DELETE_CODE_FILE, 0o600); } catch { /* best effort */ }
  return code;
}

function codeMatches(provided, actual) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(String(provided).trim()).digest();
  const b = crypto.createHash('sha256').update(String(actual).trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

function noteCodeFailure(user) {
  const now = Date.now();
  let rec = codeFails.get(user);
  if (!rec || now - rec.windowStart > CODE_FAIL_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
    codeFails.set(user, rec);
  }
  rec.count += 1;
}

function isThrottled(user) {
  const rec = codeFails.get(user);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > CODE_FAIL_WINDOW_MS) {
    codeFails.delete(user);
    return false;
  }
  return rec.count >= CODE_FAIL_LIMIT;
}

// ─── personal store (user-private; NOT visible in the market) ───

// List a user's personal items of one type (or all types).
async function listPersonal(user, typeIn) {
  assertUser(user);
  const out = {};
  const types = typeIn ? [assertType(typeIn)] : TYPES;
  for (const t of types) {
    const dir = path.join(PERSONAL_ROOT, user, t);
    const files = await fsp.readdir(dir).catch((e) => {
      if (e.code === 'ENOENT') return [];
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    });
    out[t] = [];
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue;
      const item = await readJson(path.join(dir, f), null);
      if (!item || !item.name) continue;
      item.published = !!item.publishedAt;      // informational
      out[t].push(item);
    }
  }
  return out;
}

async function readPersonal(user, type, name) {
  const item = await readJson(personalFile(user, type, name), null);
  if (!item) throw err('ERR_NOT_FOUND', 'personal item not found');
  return item;
}

// Create or replace a personal item. Overwrite is the norm here — the
// personal store is a private scratchpad; the market publish is the
// gated, no-clobber step.
async function savePersonal(user, type, body) {
  assertUser(user);
  const t = assertType(type);
  const item = validateItem(t, body);
  // preserve publishedAt across edits so a re-publish is idempotent
  const prev = await readJson(personalFile(user, t, item.name), null);
  if (prev && prev.publishedAt) item.publishedAt = prev.publishedAt;
  const file = personalFile(user, t, item.name);
  await writeJson(file, item, 0o600);
  return { item, created: !prev };
}

async function deletePersonal(user, type, name) {
  assertUser(user);
  const file = personalFile(user, type, name);
  try {
    await fsp.unlink(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'personal item not found');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  return { deleted: true, name };
}

// ─── market (published store — visible to ALL signed-in users) ───

// List published items. Each entry carries uploader + canDelete.
async function listMarket(user) {
  const out = {};
  for (const t of TYPES) {
    const store = await readJson(storeFile(t), { version: 1, items: {} });
    out[t] = Object.values(store.items || {})
      .map((meta) => ({ ...meta, canDelete: !!user && meta.uploader === user }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return out;
}

// Read one published item (full definition).
async function readMarketItem(type, name) {
  const t = assertType(type);
  const item = await readJson(itemFile(t, name), null);
  if (!item) throw err('ERR_NOT_FOUND', 'market item not found');
  const store = await readJson(storeFile(t), { version: 1, items: {} });
  const meta = (store.items || {})[item.name] || {};
  return { ...item, uploader: meta.uploader || 'unknown', uploadedAt: meta.uploadedAt || null };
}

// ONE-CLICK PUBLISH: personal (private) → market (all users).
// The only path by which an item becomes market-visible.
async function publishToMarket(user, type, name) {
  assertUser(user);
  const t = assertType(type);
  const nm = assertName(name);
  const personal = await readPersonal(user, t, nm);
  const store = await readJson(storeFile(t), { version: 1, items: {} });
  store.items = store.items || {};
  if (store.items[nm]) throw err('ERR_EXISTS', 'a market item with this name already exists');
  const now = new Date().toISOString();
  const published = { ...personal, publishedAt: now };
  await writeJson(itemFile(t, nm), published, 0o644);
  store.items[nm] = {
    name: nm,
    description: personal.description || '',
    uploader: user,
    uploadedAt: now,
  };
  await writeJson(storeFile(t), store, 0o600);
  // mark the personal copy as published (informational only)
  personal.publishedAt = now;
  await writeJson(personalFile(user, t, nm), personal, 0o600);
  return { published: true, type: t, name: nm };
}

// Install a market item into the caller's personal store (no-clobber).
async function installFromMarket(user, type, name) {
  assertUser(user);
  const t = assertType(type);
  const nm = assertName(name);
  const market = await readMarketItem(t, nm);
  const file = personalFile(user, t, nm);
  const existing = await readJson(file, null);
  if (existing) throw err('ERR_EXISTS', 'a personal item with this name already exists — delete it first');
  const copy = { ...market };
  delete copy.uploader;
  delete copy.uploadedAt;
  delete copy.canDelete;
  copy.installedAt = new Date().toISOString();
  await writeJson(file, copy, 0o600);
  return { installed: true, type: t, name: nm };
}

// Delete a published item — uploader or system delete code (same
// policy as the skill market).
async function deleteMarketItem(type, name, user, code) {
  const t = assertType(type);
  const nm = assertName(name);
  const store = await readJson(storeFile(t), { version: 1, items: {} });
  store.items = store.items || {};
  const meta = store.items[nm];
  const file = itemFile(t, nm);
  let exists = false;
  try { exists = (await fsp.stat(file)).isFile(); } catch { exists = false; }
  if (!meta && !exists) throw err('ERR_NOT_FOUND', 'market item not found');

  const isUploader = !!user && !!meta && meta.uploader === user;
  if (!isUploader) {
    if (isThrottled(user || 'anon')) {
      throw err('ERR_THROTTLED', 'too many failed delete-code attempts — try again later');
    }
    let codeOk = false;
    if (typeof code === 'string' && code.trim()) {
      codeOk = codeMatches(code, await getDeleteCode());
      if (!codeOk) noteCodeFailure(user || 'anon');
    }
    if (!codeOk) {
      if (!exists && !meta) throw err('ERR_NOT_FOUND', 'market item not found');
      throw err('ERR_FORBIDDEN', 'only the uploading user or a valid system delete code may delete a market item');
    }
    if (user) codeFails.delete(user);
  }

  if (exists) {
    try { await fsp.unlink(file); }
    catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    }
  }
  if (store.items[nm]) {
    delete store.items[nm];
    await writeJson(storeFile(t), store, 0o600);
  }
  return { deleted: true, type: t, name: nm, via: isUploader ? 'uploader' : 'code' };
}

module.exports = {
  TYPES,
  listPersonal,
  readPersonal,
  savePersonal,
  deletePersonal,
  listMarket,
  readMarketItem,
  publishToMarket,
  installFromMarket,
  deleteMarketItem,
  getDeleteCode,
};
