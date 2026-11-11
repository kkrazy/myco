// fr-55: lean-ctx integration — stdio MCP sidecar.
//
// Anthropic Agent SDK spawns one `lean-ctx mcp` process per session,
// scoped to the session's workspace via CTX_PROJECT_ROOT. Agent sees
// 62+ ctx_* tools alongside the built-in Read/Edit/Bash. The
// best-practices template nudges the agent to prefer ctx_read --mode map
// for context-only reads.
//
// Validated unknowns (recorded on the fr-55 plan item):
//   • License: Apache-2.0 (commercially safe)
//   • Multi-arch: npm postinstall picks x86_64-unknown-linux-musl or
//     aarch64-unknown-linux-musl based on the build host's arch/glibc
//   • Footprint: 10 MB RSS / 397 MB jemalloc cap
//   • Network: no outbound calls at runtime (postinstall downloads
//     the binary once at Docker build time)
//   • Token savings: 60 KB JS file → ~250 bytes via `ctx_read --mode map`
//   • Concurrent-session safety: deferred to post-deploy observation
//
// Static guards on prod sources only — running `lean-ctx mcp` would
// require the binary installed, which is part of the prod Docker
// image. Test env compatibility validated via `lean-ctx --version`
// during development (recorded in commit).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const DOCKERFILE = fs.readFileSync(
  path.join(__dirname, '..', 'docker', 'Dockerfile'), 'utf8');
const AGENT_SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const BP_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'best-practices-template.md'), 'utf8');
const GITIGNORE = fs.readFileSync(
  path.join(__dirname, '..', '.gitignore'), 'utf8');

console.log('── fr-55: lean-ctx MCP integration ──');

// ──────────────────────────────────────────────────────────────────────
// Dockerfile: install lean-ctx + multi-arch Caddy
// ──────────────────────────────────────────────────────────────────────

t('Dockerfile installs lean-ctx from a staged tarball', () => {
  // Install-mechanism history: npm -g (original) → curl of the upstream
  // release tarball (proxy-fix 6ab2ea6) → COPY of build-assets/lean-ctx.tar.gz
  // (deploy-adjust feeb637, 2026-11-02: the build-time corporate proxy drops
  // the download entirely, so deploy-local.sh stages the tarball on the HOST
  // and the Dockerfile COPYs it in — the build step is network-free).
  // The contract that matters to downstream callers is unchanged: `lean-ctx`
  // resolves on PATH at runtime. This test pins that the install step is
  // present in some form so a future Dockerfile refactor doesn't silently
  // drop it. Mechanism is intentionally loose — npm OR curl OR COPY is fine.
  const hasNpm  = /npm\s+install\s+-g\s+lean-ctx-bin/.test(DOCKERFILE);
  const hasCurl = /curl\s+[^\n]*lean-ctx[^\n]*\.tar\.gz/.test(DOCKERFILE);
  const hasCopy = /COPY\s+build-assets\/lean-ctx\.tar\.gz/.test(DOCKERFILE);
  assert.ok(hasNpm || hasCurl || hasCopy,
    'Dockerfile must install lean-ctx (`npm install -g lean-ctx-bin`, `curl … lean-ctx-…tar.gz`, or `COPY build-assets/lean-ctx.tar.gz`)');
});

t('Dockerfile symlinks lean-ctx into /usr/local/bin', () => {
  // The symlink target is what the SDK\'s `command: "lean-ctx"`
  // resolves to. Mechanism varies (npm path vs /usr/local/lib path)
  // but the destination is invariant.
  const npmSym  = /ln\s+-sf[^\n]*lean-ctx-bin[^\n]*\/usr\/local\/bin\/lean-ctx/.test(DOCKERFILE);
  const libSym  = /ln\s+-sf[^\n]*\/usr\/local\/lib\/lean-ctx\/lean-ctx[^\n]*\/usr\/local\/bin\/lean-ctx/.test(DOCKERFILE);
  assert.ok(npmSym || libSym,
    'Dockerfile must symlink lean-ctx into /usr/local/bin so the SDK\'s `command: "lean-ctx"` resolves on PATH');
});

t('Dockerfile smoke-tests lean-ctx after install (catches arch mismatch at build time)', () => {
  assert.ok(/\/usr\/local\/bin\/lean-ctx\s+--version/.test(DOCKERFILE),
    'Dockerfile should run `lean-ctx --version` after install to fail the build early if the binary is broken');
});

t('Dockerfile Caddy install is arch-aware (amd64 + arm64)', () => {
  // Pre-fr-55 the Caddy URL hardcoded `arch=amd64`, making the image
  // amd64-only. fr-55 enhancement: detect via uname -m. Deploy-adjust
  // feeb637 (2026-11-02) then moved the download OUT of the Dockerfile
  // entirely: the corporate proxy drops the codeload URL mid-download,
  // so scripts/deploy-local.sh stages the per-arch caddy binary into
  // build-assets/ on the HOST and the Dockerfile COPYs it in. The arch
  // decision now lives in deploy-local.sh's staging step, not here —
  // so the Dockerfile-side contract is just "caddy comes from
  // build-assets/ and lands executable at /usr/bin/caddy".
  const hasStagedCaddy = /COPY\s+build-assets\/caddy\s+\/usr\/bin\/caddy/.test(DOCKERFILE)
    && /chmod\s+\+x\s+\/usr\/bin\/caddy/.test(DOCKERFILE);
  const hasInlineArch = /uname\s+-m/.test(DOCKERFILE)
    && /x86_64\)[^;]*CADDY_ARCH=amd64/.test(DOCKERFILE)
    && /aarch64\)[^;]*CADDY_ARCH=arm64/.test(DOCKERFILE);
  assert.ok(hasStagedCaddy || hasInlineArch,
    'Dockerfile must obtain caddy either arch-aware inline (uname -m → CADDY_ARCH) or via the per-arch build-assets/ staging that deploy-local.sh prepares');
  // Make sure the hardcoded amd64 download URL is GONE either way.
  assert.ok(!/api\/download\?os=linux&arch=amd64/.test(DOCKERFILE),
    'the hardcoded `arch=amd64` Caddy URL must not come back (it made the image amd64-only)');
  // Staged path: the arch decision lives in deploy-local.sh — pin that
  // it consults uname -m so the staged binary matches the build host.
  if (hasStagedCaddy && !hasInlineArch) {
    const dep = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy-local.sh'), 'utf8');
    assert.ok(/uname\s+-m/.test(dep),
      'with staged caddy, scripts/deploy-local.sh must detect arch via uname -m before staging build-assets/');
  }
});

// ──────────────────────────────────────────────────────────────────────
// agent-session.js: lean-ctx in mcpServers
// ──────────────────────────────────────────────────────────────────────

t('agent-session.js registers lean-ctx as a stdio MCP server', () => {
  // Look for the mcpServers block; assert it includes a 'lean-ctx'
  // entry with type:stdio + command:'lean-ctx'.
  const mcpIdx = AGENT_SESSION.search(/mcpServers:\s*\{/);
  assert.ok(mcpIdx > -1, 'mcpServers block must exist');
  const block = AGENT_SESSION.slice(mcpIdx, mcpIdx + 2000);
  assert.ok(/['"]lean-ctx['"]\s*:\s*\{/.test(block),
    'mcpServers must register lean-ctx as a server key');
  assert.ok(/type:\s*['"]stdio['"]/.test(block),
    'lean-ctx must use stdio transport (SDK spawns the process per-session)');
  assert.ok(/command:\s*['"]lean-ctx['"]/.test(block),
    'command must be `lean-ctx`');
  assert.ok(/args:\s*\[\s*['"]mcp['"]\s*\]/.test(block),
    'args must be ["mcp"] — that\'s lean-ctx\'s stdio MCP subcommand');
});

t('lean-ctx receives CTX_PROJECT_ROOT pointing at the session cwd', () => {
  const mcpIdx = AGENT_SESSION.search(/mcpServers:\s*\{/);
  const block = AGENT_SESSION.slice(mcpIdx, mcpIdx + 2000);
  assert.ok(/CTX_PROJECT_ROOT:\s*this\.cwd/.test(block),
    'CTX_PROJECT_ROOT must equal this.cwd so lean-ctx\'s file cache is scoped to the session workspace');
});

t('myco-mcp stays alongside lean-ctx (both MCP servers active)', () => {
  // Regression guard: don\'t accidentally replace myco-mcp.
  const mcpIdx = AGENT_SESSION.search(/mcpServers:\s*\{/);
  const block = AGENT_SESSION.slice(mcpIdx, mcpIdx + 2000);
  assert.ok(/myco:\s*require\(['"]\.\/myco-mcp['"]/.test(block),
    'myco-mcp must still be registered — lean-ctx adds alongside, doesn\'t replace');
});

// ──────────────────────────────────────────────────────────────────────
// Best-practices nudge
// ──────────────────────────────────────────────────────────────────────

t('best-practices template tells the agent to prefer ctx_read for context-only reads', () => {
  assert.ok(/ctx_read/i.test(BP_TEMPLATE),
    'best-practices-template.md must mention ctx_read so the agent learns about it on session spawn');
  assert.ok(/lean-ctx/i.test(BP_TEMPLATE),
    'must mention lean-ctx by name so the agent can map MCP tool names to docs');
  assert.ok(/mcp__lean-ctx__ctx_/i.test(BP_TEMPLATE),
    'must use the full MCP-prefixed tool name (mcp__lean-ctx__ctx_*) so the agent matches against SDK tool advertisements');
});

t('best-practices template surfaces the Read-vs-ctx_read decision', () => {
  // The nudge should mention WHEN to use ctx_read (context-only) vs
  // built-in Read (when editing). Without that guidance the agent
  // might use ctx_read with --mode full and lose the edit workflow.
  assert.ok(/edit/i.test(BP_TEMPLATE) && /Edit\b/.test(BP_TEMPLATE),
    'guidance should clarify the edit-time fallback (built-in Edit) vs the context-read use of ctx_*');
});

// ──────────────────────────────────────────────────────────────────────
// .gitignore: keep per-machine state out of git
// ──────────────────────────────────────────────────────────────────────

t('.gitignore excludes .claude/settings.local.json', () => {
  // lean-ctx writes PostToolUse hooks into settings.local.json on
  // `lean-ctx init --agent claude`. That file is per-machine
  // (matches the `.local.` naming convention) — don\'t track it.
  assert.ok(/^\.claude\/settings\.local\.json$/m.test(GITIGNORE),
    '.claude/settings.local.json must be gitignored — it holds per-machine state (SDK Allow-always picks + lean-ctx hooks)');
});

// ──────────────────────────────────────────────────────────────────────

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
