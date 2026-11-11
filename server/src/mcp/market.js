// myco MCP market — the MCP-server marketplace (mcp-market phase 1).
//
// Design (per the 2026-10-19 方案 doc + the "reuse the skill engine"
// directive): an MCP-market entry is a SKILL PACK. Installing an entry
// copies its skill folders into the session's `.claude/skills/` store
// so the Claude Agent SDK loads them as ordinary skills; each skill's
// SKILL.md documents the MCP server's transport, endpoint, auth env
// vars and per-tool interface (name, parameters, invocation example).
// The agent then calls the MCP server with Bash/curl (HTTP transports)
// or JSON-RPC over stdio — no MCP gateway process, no new runtime
// dependency, full reuse of the existing skills.js engine.
//
// Layout (all under the shared state dir, mirroring skill-market):
//   $MYCO_STATE_DIR/mcp-market/registry.json   — user-published entries (0600)
//   $MYCO_STATE_DIR/mcp-market/skills/<name>/  — published skill dirs
//
// Built-in entries (server/src/mcp/builtin-servers.js) are materialized
// into skills on install straight from their in-code `guide` bodies —
// they are never stored on disk as market files.
//
// Errors use the shared tagged-code vocabulary:
//   ERR_BAD_INPUT / ERR_NOT_FOUND / ERR_EXISTS / ERR_OUTSIDE /
//   ERR_PERM / ERR_TOO_LARGE.

'use strict';

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const { builtinServers } = require('./builtin-servers');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const MARKET_ROOT = path.join(STATE_DIR, 'mcp-market');
const SKILLS_ROOT = path.join(MARKET_ROOT, 'skills');
const REGISTRY_FILE = path.join(MARKET_ROOT, 'registry.json');

// Same caps as the skill market — one shared budget per entry.
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function assertName(name) {
  const raw = (name == null ? '' : String(name)).trim();
  if (!raw || !NAME_RE.test(raw)) {
    throw err('ERR_BAD_INPUT', 'invalid name (use letters, digits, . _ -, no spaces or slashes)');
  }
  return raw;
}

// ─── registry.json (user-published entries index) ───

async function ensureRoots() {
  try {
    await fsp.mkdir(SKILLS_ROOT, { recursive: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

async function loadRegistry() {
  try {
    const raw = await fsp.readFile(REGISTRY_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !Array.isArray(j.servers)) return { version: 1, servers: [] };
    return j;
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return { version: 1, servers: [] };
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

async function saveRegistry(reg) {
  await ensureRoots();
  await fsp.writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

// ─── catalog listing ───

// Public shape of one catalog entry (both builtin and published):
//   { name, displayName, description, version, category,
//     transport, endpoint, security, sdkTools:[{name,description}],
//     skills:[{dirName,description}],
//     source, uploader?, publishedAt?, fileCount?, size? }
// `sdkTools` (builtin entries only) feeds the catalog card's
// "N server tools" tag — names + descriptions, never params
// internals, so the listing stays small.
function _publicEntry(srv, extra = {}) {
  return {
    name: srv.name,
    displayName: srv.displayName || srv.name,
    description: srv.description || '',
    version: srv.version || '1.0.0',
    category: srv.category || 'custom',
    transport: srv.transport ? { type: srv.transport.type } : null,
    endpoint: srv.endpoint || (srv.transport && srv.transport.command
      ? `${srv.transport.command} ${(srv.transport.args || []).join(' ')}` : null),
    security: srv.security || { level: 'medium', requiresAuth: false, scopes: [] },
    sdkTools: Array.isArray(srv.sdkTools)
      ? srv.sdkTools.map((t) => ({ name: t.name, description: t.description || '' }))
      : [],
    skills: (srv.skills || []).map((sk) => ({ dirName: sk.dirName, description: sk.description || '' })),
    source: srv.source || 'custom',
    ...extra,
  };
}

async function listMarket() {
  const reg = await loadRegistry();
  const servers = [
    ...builtinServers.map((s) => _publicEntry(s, { installedCount: 0 })),
    ...reg.servers.map((s) => _publicEntry(s, {
      uploader: s.uploader || 'unknown',
      publishedAt: s.publishedAt || null,
      fileCount: s.fileCount || null,
      size: s.size || null,
    })),
  ];
  return { servers };
}

// ─── publish (user-defined entries) ───

// Publish a custom entry. Body shape:
//   { name, displayName?, description?, version?, category?,
//     transport: { type, command?, args?, url? }, endpoint?,
//     security?: { level, requiresAuth, scopes },
//     skills: [{ dirName, description, content }] }
// Each skill's `content` becomes SKILL.md (front matter added when
// missing). Written to $STATE/mcp-market/skills/<entryName>/<skillDir>/.
async function publishServer(body, user) {
  if (!body || typeof body !== 'object') throw err('ERR_BAD_INPUT', 'body required');
  const name = assertName(body.name);
  const reg = await loadRegistry();
  if (reg.servers.some((s) => s.name === name)) {
    throw err('ERR_EXISTS', 'an MCP market entry with this name already exists');
  }
  if (builtinServers.some((s) => s.name === name)) {
    throw err('ERR_EXISTS', 'a built-in MCP entry with this name already exists');
  }
  if (!Array.isArray(body.skills) || body.skills.length === 0) {
    throw err('ERR_BAD_INPUT', 'skills: [{dirName, description, content}] required');
  }
  if (body.skills.length > 50) throw err('ERR_TOO_LARGE', 'too many skills in one entry');

  const transport = body.transport && typeof body.transport === 'object'
    ? { type: String(body.transport.type || 'streamable-http') }
    : { type: 'streamable-http' };

  const entryDir = path.join(SKILLS_ROOT, name);
  await ensureRoots();
  try { await fsp.mkdir(entryDir, { recursive: true }); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }

  let fileCount = 0, size = 0;
  const skills = [];
  try {
    for (const sk of body.skills) {
      const dirName = assertName(sk && sk.dirName);
      const description = String((sk && sk.description) || `MCP guide for ${name}`);
      const rawContent = String((sk && sk.content) || '');
      if (!rawContent.trim()) throw err('ERR_BAD_INPUT', `skill ${dirName}: content required`);
      const content = (/^---\r?\n/.test(rawContent) && /^name:/m.test(rawContent.split(/^---\r?\n/)[1] || ''))
        ? rawContent
        : `---\nname: ${dirName}\ndescription: ${description.replace(/\r?\n/g, ' ')}\n---\n\n${rawContent.trim()}\n`;
      if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
        throw err('ERR_TOO_LARGE', `skill ${dirName} exceeds max size`);
      }
      size += Buffer.byteLength(content, 'utf8');
      if (size > MAX_TOTAL_BYTES) throw err('ERR_TOO_LARGE', 'entry exceeds max total size');
      const skDir = path.join(entryDir, dirName);
      await fsp.mkdir(skDir, { recursive: true });
      await fsp.writeFile(path.join(skDir, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
      fileCount += 1;
      skills.push({ dirName, description });
    }
  } catch (e) {
    await fsp.rm(entryDir, { recursive: true, force: true }).catch(() => {});
    if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'a skill dir with this name already exists');
    throw e;
  }

  const entry = {
    name,
    displayName: String(body.displayName || name),
    description: String(body.description || ''),
    version: String(body.version || '1.0.0'),
    category: String(body.category || 'custom'),
    transport,
    endpoint: body.endpoint ? String(body.endpoint) : null,
    security: body.security && typeof body.security === 'object'
      ? {
        level: String(body.security.level || 'medium'),
        requiresAuth: !!body.security.requiresAuth,
        scopes: Array.isArray(body.security.scopes) ? body.security.scopes.map(String) : [],
      }
      : { level: 'medium', requiresAuth: false, scopes: [] },
    source: 'custom',
    uploader: user,
    publishedAt: new Date().toISOString(),
    fileCount,
    size,
    skills,
  };
  reg.servers.push(entry);
  await saveRegistry(reg);
  return _publicEntry(entry, { uploader: user, publishedAt: entry.publishedAt, fileCount, size });
}

// ─── custom-doc import (自定义文档导入) ───

// Import a guidance document (markdown) as a custom market entry.
// The doc becomes a one-skill pack: SKILL.md = front matter + an
// import preamble + the doc body verbatim. Same storage layout as
// publishServer ($STATE/mcp-market/skills/<name>/<skillDir>/SKILL.md),
// same size caps, same registry — so install/uninstall/delete/detail
// work unchanged. Body shape:
//   { name, displayName?, description?, docName?, content }
// `content` is the raw markdown of the guidance document.
async function importDoc(body, user) {
  if (!body || typeof body !== 'object') throw err('ERR_BAD_INPUT', 'body required');
  const name = assertName(body.name);
  const docName = String(body.docName || `${name}-guide.md`);
  const content = String(body.content || '');
  if (!content.trim()) throw err('ERR_BAD_INPUT', 'content required — paste or upload the guidance document');
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    throw err('ERR_TOO_LARGE', 'document exceeds max size');
  }
  // Skill dir mirrors the entry name (assertName already vetted it).
  const skillDirName = `mcp-doc-${name}`;
  const preamble =
`# ${String(body.displayName || name)} — imported guidance document

This skill was imported into the MCP market from the document \`${docName}\`.
It is a REFERENCE GUIDE: read it when the user asks about the topic it
documents, and follow its instructions verbatim. Treat every section below
as authoritative guidance from the document's author.

`;

  return publishServer({
    name,
    displayName: body.displayName || name,
    description: body.description || `Imported guidance document (${docName})`,
    version: '1.0.0',
    category: 'doc-import',
    transport: { type: 'doc' },
    endpoint: null,
    security: { level: 'low', requiresAuth: false, scopes: [] },
    skills: [{
      dirName: skillDirName,
      description: body.description || `Imported guidance document ${docName}`,
      content: preamble + content.trim() + '\n',
    }],
  }, user);
}

// ─── preview ───

// Read one entry's skill SKILL.md bodies (for the detail pane).
// Builtin entries render their in-memory guide.
async function readServer(name) {
  const id = assertName(name);
  const builtin = builtinServers.find((s) => s.name === id);
  if (builtin) {
    return {
      ..._publicEntry(builtin),
      skills: builtin.skills.map((sk) => ({
        dirName: sk.dirName,
        description: sk.description || '',
        content: _skillMd(builtin, sk),
      })),
    };
  }
  const reg = await loadRegistry();
  const srv = reg.servers.find((s) => s.name === id);
  if (!srv) throw err('ERR_NOT_FOUND', 'MCP market entry not found');
  const skills = [];
  for (const sk of srv.skills || []) {
    let content = '';
    try {
      content = await fsp.readFile(path.join(SKILLS_ROOT, id, sk.dirName, 'SKILL.md'), 'utf8');
    } catch { /* tolerate a missing file — listing stays usable */ }
    skills.push({ dirName: sk.dirName, description: sk.description || '', content });
  }
  return { ..._publicEntry(srv, { uploader: srv.uploader, publishedAt: srv.publishedAt }), skills };
}

// Build the SKILL.md body for a builtin entry's skill (front matter + guide).
function _skillMd(srv, sk) {
  return `---\nname: ${sk.dirName}\ndescription: ${String(sk.description || '').replace(/\r?\n/g, ' ')}\n---\n\n${sk.guide.trim()}\n`;
}

// ─── install / uninstall ───

// Install an entry into a session's personal skill store
// (<absRoot>/.claude/skills/<skillDir>). No-clobber per skill dir —
// an existing personal skill of the same name skips with
// {skipped:'exists'} instead of aborting the whole install (unlike
// the skill market's whole-entry ERR_EXISTS: an MCP pack has several
// independent skills; one collision shouldn't block the rest).
async function installServer(absRoot, name) {
  const id = assertName(name);
  const destRoot = path.join(absRoot, '.claude', 'skills');

  const builtin = builtinServers.find((s) => s.name === id);
  let skillList;                                   // [{dirName, content}]
  if (builtin) {
    skillList = builtin.skills.map((sk) => ({ dirName: sk.dirName, content: _skillMd(builtin, sk) }));
  } else {
    const reg = await loadRegistry();
    const srv = reg.servers.find((s) => s.name === id);
    if (!srv) throw err('ERR_NOT_FOUND', 'MCP market entry not found');
    skillList = [];
    for (const sk of srv.skills || []) {
      try {
        skillList.push({
          dirName: sk.dirName,
          content: await fsp.readFile(path.join(SKILLS_ROOT, id, sk.dirName, 'SKILL.md'), 'utf8'),
        });
      } catch (e) {
        if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', `skill ${sk.dirName} missing from entry`);
        throw e;
      }
    }
  }
  if (!skillList.length) throw err('ERR_NOT_FOUND', 'entry has no skills');

  const installed = [], skipped = [];
  for (const sk of skillList) {
    const destDir = path.join(destRoot, sk.dirName);
    if (await _exists(path.join(destDir, 'SKILL.md'))) {
      skipped.push({ dirName: sk.dirName, reason: 'exists' });
      continue;
    }
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(path.join(destDir, 'SKILL.md'), sk.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    installed.push(sk.dirName);
  }
  return { installed: true, name: id, skills: installed, skipped };
}

async function _exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Uninstall an entry's skills from a session store. Removing a skill
// that isn't there is not an error (idempotent), but a completely
// unknown entry is.
async function uninstallServer(absRoot, name) {
  const id = assertName(name);
  const builtin = builtinServers.find((s) => s.name === id);
  let skillDirs;
  if (builtin) {
    skillDirs = builtin.skills.map((sk) => sk.dirName);
  } else {
    const reg = await loadRegistry();
    const srv = reg.servers.find((s) => s.name === id);
    if (!srv) throw err('ERR_NOT_FOUND', 'MCP market entry not found');
    skillDirs = (srv.skills || []).map((sk) => sk.dirName);
  }
  const removed = [], missing = [];
  for (const d of skillDirs) {
    const dir = path.join(absRoot, '.claude', 'skills', d);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(d);
    } catch {
      missing.push(d);
    }
  }
  return { uninstalled: true, name: id, removed, missing };
}

// Delete a user-published entry (uploader-only; builtins are refused).
async function deleteServer(name, user) {
  const id = assertName(name);
  if (builtinServers.some((s) => s.name === id)) {
    throw err('ERR_FORBIDDEN', 'built-in MCP entries cannot be deleted');
  }
  const reg = await loadRegistry();
  const idx = reg.servers.findIndex((s) => s.name === id);
  if (idx < 0) throw err('ERR_NOT_FOUND', 'MCP market entry not found');
  if (reg.servers[idx].uploader !== user) {
    throw err('ERR_FORBIDDEN', 'only the publishing user may delete this entry');
  }
  await fsp.rm(path.join(SKILLS_ROOT, id), { recursive: true, force: true }).catch(() => {});
  reg.servers.splice(idx, 1);
  await saveRegistry(reg);
  return { deleted: true, name: id };
}

module.exports = {
  listMarket,
  readServer,
  publishServer,
  importDoc,
  installServer,
  uninstallServer,
  deleteServer,
  builtinServers,
  MARKET_ROOT,
};
