// bug-88: /git clone should reuse the stored clone PAT automatically
// and default to the main project dir.
//
// Pre-fix (fr-54 passthrough): `/git clone https://github.com/owner/repo`
// ran git verbatim. For a private repo with no credential helper hit,
// git failed with "could not read Username" — even though the user had
// already saved a PAT via /setpat. The user had to know to embed the
// token in the URL manually (leaking it into chat history).
//
// Post-fix (bug-88): handleGit detects `clone <https-url>` with no
// embedded credentials, looks up the stored PAT (per-repo slot first,
// then the user-level slot), and rewrites the URL before exec. The
// token NEVER appears in the echoed command or any output.
//
// Contract under test:
//   1. _hostFromCloneUrl classifies github/gitee/codehub URLs.
//   2. _cloneUrlWithStoredPat:
//      - rewrites clone URLs with the per-repo PAT
//      - falls back to the user-level PAT
//      - respects URLs that already embed credentials (no double-inject)
//      - passes non-clone subcommands through unchanged (null)
//      - passes SSH urls through unchanged (null)
//      - returns null when no token is on file
//      - skips option flags between `clone` and the URL (--depth 1)
//      - gitee uses the stored gitee login as the username (bug-91)
//   3. handleGit runs git from ctx.absCwd when set (fr-106 alignment).
//   4. Redaction: the echoed `$ git …` line + scrub() keep the token
//      out of every reply surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-88: /git clone reuses stored PAT ──');

// Stub sessions + permissions so slashcmds.js can be required without
// a live /data store (same pattern as bug-90-critic-disable.test.js).
const sessionsStub = {
  _rec: null, _owners: new Set(),
  getSessionRecord(_id) { return this._rec; },
  isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
  saveStore() {},
  appendChatMessage() {},
  resolveAgentCwd(rec) { return rec && rec.absCwd; },
};
function _installStubs() {
  const sessPath = require.resolve('../server/src/sessions');
  require.cache[sessPath] = {
    exports: sessionsStub, id: sessPath, filename: sessPath, loaded: true,
  };
  const permPath = require.resolve('../server/src/permissions');
  require.cache[permPath] = {
    exports: { matchesPattern() { return false; } },
    id: permPath, filename: permPath, loaded: true,
  };
  delete require.cache[require.resolve('../server/src/slashcmds')];
}

// ──────────────────────────────────────────────────────────────────────
// Group A: pure helpers, token-store stubbed via git-tokens cache.

// git-tokens.js reads $MYCO_STATE_DIR/git-tokens.json. Point it at a
// temp dir per test and reset its cache so each case starts clean.
const os = require('os');
function _withTokenStore(tokensObj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-88-'));
  fs.writeFileSync(path.join(dir, 'git-tokens.json'), JSON.stringify(tokensObj), { mode: 0o600 });
  process.env.MYCO_STATE_DIR = dir;
  delete require.cache[require.resolve('../server/src/git-tokens')];
  delete require.cache[require.resolve('../server/src/git-hosts')];
  delete require.cache[require.resolve('../server/src/slashcmds')];
  try {
    return fn(require('../server/src/slashcmds'));
  } finally {
    delete process.env.MYCO_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await t('_hostFromCloneUrl: github/gitee/codehub HTTPS + SSH + .git variants', () => {
    _installStubs();
    const { _hostFromCloneUrl } = require('../server/src/slashcmds');
    assert.deepStrictEqual(_hostFromCloneUrl('https://github.com/owner/repo'),
      { provider: 'github', owner: 'owner', repo: 'repo' },
      'plain github https URL must classify');
    assert.deepStrictEqual(_hostFromCloneUrl('https://gitee.com/kk/myco.git'),
      { provider: 'gitee', owner: 'kk', repo: 'myco' },
      'gitee .git URL must classify + strip .git');
    assert.deepStrictEqual(_hostFromCloneUrl('git@github.com:owner/repo.git'),
      { provider: 'github', owner: 'owner', repo: 'repo' },
      'SSH github URL must classify');
    assert.deepStrictEqual(_hostFromCloneUrl('https://codehub-dg-g.huawei.com/o/r'),
      { provider: 'codehub', owner: 'o', repo: 'r' },
      'codehub URL must classify');
    assert.strictEqual(_hostFromCloneUrl('https://example.com/o/r'), null,
      'unknown host must return null (no rewrite attempted)');
    assert.strictEqual(_hostFromCloneUrl(''), null, 'empty URL → null');
  });

  await t('_cloneUrlWithStoredPat: rewrites with per-repo PAT (github)', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_testtoken123' } }, (slash) => {
      const out = slash._cloneUrlWithStoredPat(['clone', 'https://github.com/owner/repo'], 'alice');
      assert.ok(out, 'must rewrite when a per-repo PAT is on file');
      assert.strictEqual(out[0], 'clone', 'subcommand stays first');
      assert.ok(out[1].startsWith('https://x-access-token:ghp_testtoken123@github.com/owner/repo'),
        `rewritten URL must embed the github PAT as x-access-token (got ${out[1]})`);
    });
  });

  await t('_cloneUrlWithStoredPat: falls back to user-level PAT', () => {
    _installStubs();
    _withTokenStore({ alice: { github: 'ghp_userlevel456' } }, (slash) => {
      const out = slash._cloneUrlWithStoredPat(['clone', 'https://github.com/owner/repo'], 'alice');
      assert.ok(out && out[1].includes('ghp_userlevel456@'),
        'user-level token must be picked up when no per-repo PAT exists');
    });
  });

  await t('_cloneUrlWithStoredPat: per-repo PAT WINS over user-level', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_repo_wins', github: 'ghp_user_loses' } }, (slash) => {
      const out = slash._cloneUrlWithStoredPat(['clone', 'https://github.com/owner/repo'], 'alice');
      assert.ok(out[1].includes('ghp_repo_wins@'),
        'per-repo slot must take precedence over the user-level slot');
    });
  });

  await t('_cloneUrlWithStoredPat: URL already embedding credentials is left alone', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_stored' } }, (slash) => {
      const url = 'https://user:ghp_explicit@github.com/owner/repo';
      const out = slash._cloneUrlWithStoredPat(['clone', url], 'alice');
      assert.strictEqual(out, null,
        'an explicit embedded credential must NOT be double-injected (user chose their identity)');
    });
  });

  await t('_cloneUrlWithStoredPat: non-clone subcommands pass through (null)', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_stored' } }, (slash) => {
      assert.strictEqual(slash._cloneUrlWithStoredPat(['status'], 'alice'), null, 'status → null');
      assert.strictEqual(slash._cloneUrlWithStoredPat(['push', 'origin', 'main'], 'alice'), null, 'push → null (credential helper owns push auth)');
      assert.strictEqual(slash._cloneUrlWithStoredPat(['fetch'], 'alice'), null, 'fetch → null');
    });
  });

  await t('_cloneUrlWithStoredPat: SSH urls pass through (null)', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_stored' } }, (slash) => {
      assert.strictEqual(slash._cloneUrlWithStoredPat(['clone', 'git@github.com:owner/repo.git'], 'alice'), null,
        'SSH URLs can\'t carry an embedded https token — must pass through');
    });
  });

  await t('_cloneUrlWithStoredPat: no token on file → null (clone runs verbatim)', () => {
    _installStubs();
    _withTokenStore({ bob: { 'github/other/repo': 'ghp_bobs' } }, (slash) => {
      assert.strictEqual(slash._cloneUrlWithStoredPat(['clone', 'https://github.com/owner/repo'], 'alice'), null,
        'alice has no PAT for owner/repo — no rewrite');
    });
  });

  await t('_cloneUrlWithStoredPat: option flags between clone and URL are preserved', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_flagtest' } }, (slash) => {
      const out = slash._cloneUrlWithStoredPat(['clone', '--depth', '1', 'https://github.com/owner/repo', 'mydir'], 'alice');
      assert.ok(out, 'flags must not block the rewrite');
      assert.strictEqual(out[1], '--depth', 'flag order must be preserved');
      assert.strictEqual(out[2], '1', 'flag values must be preserved');
      assert.ok(out[3].includes('ghp_flagtest@github.com'), 'URL must carry the PAT (got ' + out[3] + ')');
      assert.strictEqual(out[4], 'mydir', 'trailing target dir must be preserved');
    });
  });

  await t('_cloneUrlWithStoredPat: gitee uses the stored gitee login as username (bug-91)', () => {
    _installStubs();
    _withTokenStore({
      alice: {
        'gitee/kk/myco': 'gitee_tok_789',
        giteeLogin: 'kkrazy',
      },
    }, (slash) => {
      const out = slash._cloneUrlWithStoredPat(['clone', 'https://gitee.com/kk/myco.git'], 'alice');
      assert.ok(out, 'gitee clone must rewrite with the stored PAT');
      assert.ok(out[1].startsWith('https://kkrazy:gitee_tok_789@gitee.com/kk/myco.git'),
        `gitee URL must embed the gitee login as username — gitee rejects mismatched usernames (got ${out[1]})`);
    });
  });

  await t('_cloneUrlWithStoredPat: gitee without a stored login falls back to the myco-user', () => {
    _installStubs();
    _withTokenStore({ alice: { 'gitee/kk/myco': 'gitee_tok_x' } }, (slash) => {
      const out = slash._cloneUrlWithStoredPat(['clone', 'https://gitee.com/kk/myco'], 'alice');
      assert.ok(out[1].startsWith('https://alice:gitee_tok_x@gitee.com'),
        'no stored login → fall back to the myco-user as the username line');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Group B: handleGit integration (stubs execFile via child_process).

  await t('handleGit: clone runs with the PAT-embedded argv + ctx.absCwd wins for cwd', () => {
    _installStubs();
    sessionsStub._rec = { user: 'alice', absCwd: '/wks/alice/sess' };
    sessionsStub._owners = new Set(['alice']);

    let captured = null;
    const cpPath = require.resolve('child_process');
    const realCp = require('child_process');
    require.cache[cpPath] = {
      exports: Object.assign({}, realCp, {
        execFile: (bin, argv, opts, cb) => {
          captured = { bin, argv, opts };
          cb(null, 'Cloning into…\n', '');
        },
      }),
      id: cpPath, filename: cpPath, loaded: true,
    };

    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_secret_DO_NOT_LEAK' } }, (slash) => {
      const replies = [];
      const ctx = {
        sessionId: 'sid', user: 'alice',
        args: 'clone https://github.com/owner/repo',
        absCwd: '/wks/alice/sess/mainproj',
        reply: (m) => replies.push(String(m)),
      };
      slash.handleGit(ctx);
      assert.ok(captured, 'execFile must have been called');
      assert.ok(captured.argv[1].includes('ghp_secret_DO_NOT_LEAK@github.com'),
        'git must receive the PAT-embedded URL');
      assert.strictEqual(captured.opts.cwd, '/wks/alice/sess/mainproj',
        `cwd must prefer ctx.absCwd (main project dir, bug-88 + fr-106) — got ${captured.opts.cwd}`);
      const joined = replies.join('\n');
      assert.ok(!joined.includes('ghp_secret_DO_NOT_LEAK'),
        'the PAT must NEVER appear in the chat reply (redaction contract)');
      assert.ok(joined.includes('$ git clone https://github.com/owner/repo'),
        'the echoed command line must show the ORIGINAL user-typed URL');
    });
    delete require.cache[cpPath];
  });

  await t('handleGit: non-clone git runs with the original argv (no rewrite)', () => {
    _installStubs();
    sessionsStub._rec = { user: 'alice', absCwd: '/wks/alice/sess' };
    sessionsStub._owners = new Set(['alice']);

    let captured = null;
    const cpPath = require.resolve('child_process');
    const realCp = require('child_process');
    require.cache[cpPath] = {
      exports: Object.assign({}, realCp, {
        execFile: (bin, argv, opts, cb) => {
          captured = { bin, argv, opts };
          cb(null, 'ok', '');
        },
      }),
      id: cpPath, filename: cpPath, loaded: true,
    };

    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_stored' } }, (slash) => {
      const ctx = {
        sessionId: 'sid', user: 'alice', args: 'status',
        absCwd: '/wks/alice/sess', reply() {},
      };
      slash.handleGit(ctx);
      assert.deepStrictEqual(captured.argv, ['status'],
        'non-clone subcommands must run verbatim');
    });
    delete require.cache[cpPath];
  });

  await t('handleGit: owner gate still applies (non-owner refused, no exec)', () => {
    _installStubs();
    sessionsStub._rec = { user: 'alice', absCwd: '/wks/alice/sess' };
    sessionsStub._owners = new Set(['alice']);
    _withTokenStore({ alice: { 'github/owner/repo': 'ghp_x' } }, (slash) => {
      const replies = [];
      slash.handleGit({
        sessionId: 'sid', user: 'eve', args: 'clone https://github.com/owner/repo',
        absCwd: '/wks/alice/sess', reply: (m) => replies.push(String(m)),
      });
      assert.ok(replies.length === 1 && /owner\+admin only/i.test(replies[0]),
        'non-owner must get the owner+admin refusal and nothing else');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Group C: static guards (source-level invariants that survive refactors).

  await t('static: handleGit redacts embedded-credential URLs from stdout/stderr/err.message', () => {
    const src = _read('server/src/slashcmds.js');
    const at = src.indexOf('function handleGit(');
    assert.ok(at >= 0, 'handleGit must exist');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.ok(/const scrub = \(s\) =>/.test(body) && /https:\\\/\\\/\[\^\/\\s\]\*@/.test(body),
      'scrub() must strip https://user:token@ credentials from every echoed surface');
    assert.ok(/lines\.push\('\(using stored PAT for auth — token not shown\)'\)/.test(body),
      'the reply must tell the user a stored PAT was used without revealing it');
    assert.ok(/echo/i.test(body) === false || true, 'noop');
    assert.ok(/\$ git \$\{argsRaw\}/.test(body),
      'the echo line must use argsRaw (the ORIGINAL user-typed args), never the rewritten argv');
  });

  await t('static: /git usage text mentions the automatic PAT reuse', () => {
    const src = _read('server/src/slashcmds.js');
    const at = src.indexOf('function handleGit(');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.ok(/clone.*reuses a stored PAT automatically/.test(body),
      'the bare-usage help must document the bug-88 behavior');
  });

  await t('static: slashcmds exports handleGit + _cloneUrlWithStoredPat + _hostFromCloneUrl', () => {
    _installStubs();
    const slash = require('../server/src/slashcmds');
    assert.strictEqual(typeof slash.handleGit, 'function', 'handleGit must be exported');
    assert.strictEqual(typeof slash._cloneUrlWithStoredPat, 'function', '_cloneUrlWithStoredPat must be exported');
    assert.strictEqual(typeof slash._hostFromCloneUrl, 'function', '_hostFromCloneUrl must be exported');
  });

  await t('static: git-tokens.js getToken still resolves per-repo → user-level (bug-88 lookup chain)', () => {
    _installStubs();
    _withTokenStore({ alice: { 'github/o/r': 'repo_tok', github: 'user_tok' } }, () => {
      const { getToken } = require('../server/src/git-tokens');
      assert.strictEqual(getToken('alice', 'github', 'o', 'r'), 'repo_tok', 'per-repo wins');
      assert.strictEqual(getToken('alice', 'github', 'o', 'other'), 'user_tok', 'user-level fallback');
      assert.strictEqual(getToken('alice', 'gitlab', 'o', 'r'), null, 'unknown provider → null');
    });
  });


}

main().then(() => {
  console.log(`── bug-88: ${passed} passed, ${failed} failed ──`);
  process.exit(failed ? 1 : 0);
});
