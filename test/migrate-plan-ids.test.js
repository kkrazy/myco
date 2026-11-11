// Regression for migrate-plan-ids.js. Builds a fake state dir with a
// few sessions whose plan items have hex ids (the pre-2026-05-15
// scheme), invokes the migration script as a subprocess, and asserts:
//   - hex-id items get rewritten to <prefix>-N (per layer, addedAt
//     order)
//   - items that are ALREADY prefixed stay put (idempotent re-run)
//   - sessions.json and each session's _myco_/plan.json end up with
//     the same item ids
//   - --dry-run reports rewrites but doesn't touch disk

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'migrate-plan-ids.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-migrate-'));
}

// Build a minimal sessions.json with one session that has 4 plan
// items (2 Todo + 1 Feature + 1 Bug), all with hex ids, plus an
// existing prefixed item in Todo to exercise the "skip already-
// migrated" path.
function seedStore(stateDir) {
  const proj = path.join(stateDir, 'proj-test');
  fs.mkdirSync(proj, { recursive: true });
  const sid = 'sess-mig-1';
  const store = {
    sessions: {
      [sid]: {
        id: sid,
        user: 'kkrazy',
        absCwd: proj,
        artifacts: {
          plan: {
            updatedAt: '2026-05-14T00:00:00Z',
            items: [
              { id: 'aaaaaaaaaaaa', text: 'first todo',  layer: 'Todo',    addedAt: '2026-05-10T00:00:00Z', source: 'user' },
              { id: 'td-7',         text: 'already-prefixed todo',
                                                          layer: 'Todo',    addedAt: '2026-05-11T00:00:00Z', source: 'user' },
              { id: 'bbbbbbbbbbbb', text: 'second todo', layer: 'Todo',    addedAt: '2026-05-12T00:00:00Z', source: 'user' },
              { id: 'cccccccccccc', text: 'a feature',   layer: 'Feature', addedAt: '2026-05-10T00:00:00Z', source: 'user' },
              { id: 'dddddddddddd', text: 'a bug',       layer: 'Bug',     addedAt: '2026-05-10T00:00:00Z', source: 'user' },
            ],
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify(store, null, 2));
  return { sid, proj };
}

function readStore(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'));
}

function runMigrate(stateDir, extraArgs = []) {
  return execFileSync('node', [SCRIPT, ...extraArgs], {
    env: { ...process.env, MYCO_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
}

console.log('── migrate-plan-ids: hex → prefixed (addedAt order) ──');

t('rewrites hex ids in addedAt order, skips already-prefixed items', () => {
  const dir = mkTmpDir();
  try {
    const { sid, proj } = seedStore(dir);
    const out = runMigrate(dir);
    const items = readStore(dir).sessions[sid].artifacts.plan.items;
    const byText = Object.fromEntries(items.map((it) => [it.text, it.id]));
    // Todo layer: existing td-7 stays, hex items take the next counter
    // values STARTING at td-8 (max existing + 1). addedAt order is
    // 'first todo' (2026-05-10) < 'second todo' (2026-05-12).
    assert.strictEqual(byText['already-prefixed todo'], 'td-7', 'already-prefixed id unchanged');
    assert.strictEqual(byText['first todo'],  'td-8', 'first hex todo (older addedAt) → td-8');
    assert.strictEqual(byText['second todo'], 'td-9', 'second hex todo → td-9');
    // Feature + Bug each had no prior prefixed items, so they start fresh.
    assert.strictEqual(byText['a feature'], 'fr-1');
    assert.strictEqual(byText['a bug'],     'bug-1');
    // _myco_/plan.json mirror must match sessions.json
    const mirror = JSON.parse(fs.readFileSync(path.join(proj, '_myco_', 'plan.json'), 'utf8'));
    const mirrorIds = Object.fromEntries(mirror.items.map((it) => [it.text, it.id]));
    assert.deepStrictEqual(mirrorIds, byText, '_myco_/plan.json must agree with sessions.json');
    // Script must report what it did
    assert.match(out, /4 rewrites/, 'output should report 4 rewrites');
    assert.match(out, /aaaaaaaaaaaa\s+→\s+td-8/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('idempotent: re-running on already-migrated store touches nothing', () => {
  const dir = mkTmpDir();
  try {
    seedStore(dir);
    runMigrate(dir);                     // first pass — migrates
    const beforeMtime = fs.statSync(path.join(dir, 'sessions.json')).mtimeMs;
    // Tiny delay so a no-op re-run can be distinguished by mtime.
    const out = runMigrate(dir);         // second pass — should be no-op
    const afterMtime = fs.statSync(path.join(dir, 'sessions.json')).mtimeMs;
    assert.match(out, /no sessions needed migration/, 'second pass should be a no-op');
    assert.strictEqual(afterMtime, beforeMtime, 'sessions.json must not be rewritten on idempotent re-run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('--dry-run reports rewrites without touching disk', () => {
  const dir = mkTmpDir();
  try {
    const { sid, proj } = seedStore(dir);
    const beforeStore = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    const planJsonPath = path.join(proj, '_myco_', 'plan.json');
    assert.ok(!fs.existsSync(planJsonPath), '_myco_/plan.json should not exist before run');
    const out = runMigrate(dir, ['--dry-run']);
    assert.match(out, /DRY RUN/, 'should announce dry-run mode');
    assert.match(out, /would rewrite 4 ids across 1 session/);
    const afterStore = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    assert.strictEqual(afterStore, beforeStore, 'sessions.json must be untouched by --dry-run');
    assert.ok(!fs.existsSync(planJsonPath), '_myco_/plan.json must not be created by --dry-run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('--session limits the migration to one id', () => {
  const dir = mkTmpDir();
  try {
    const { sid } = seedStore(dir);
    // Add a second session that should be UNTOUCHED when --session is set.
    const store = readStore(dir);
    store.sessions['sess-other'] = {
      id: 'sess-other',
      user: 'kkrazy',
      absCwd: dir,
      artifacts: { plan: { items: [{ id: 'ffffffffffff', text: 'untouched todo', layer: 'Todo', addedAt: '2026-05-10T00:00:00Z', source: 'user' }] } },
    };
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(store, null, 2));
    runMigrate(dir, ['--session', sid]);
    const after = readStore(dir);
    // First session migrated
    assert.ok(after.sessions[sid].artifacts.plan.items.some((it) => it.id === 'td-8'));
    // Second session left alone
    assert.strictEqual(after.sessions['sess-other'].artifacts.plan.items[0].id, 'ffffffffffff');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
