// explore-prompts — prompts-explore.js (路径探索 /run-explore).
//
// Locks the exploration prompt content WITHOUT touching the live SDK:
//   - explorerPrompt() emits the correct role text per roster position
//     (path-1 seeds paths, others claim+deep-dive)
//   - the nPaths placeholder is substituted (no '${nPaths}' survives)
//   - the collaboration core (BOARD_COMMANDS / WAITING / QUEUE_POLICY)
//     is reused verbatim from prompts-n2-shared
//   - the deep-dive discipline + convergence rule are present
//   - the task text and workspace are embedded

const assert = require('assert');
const { explorerPrompt, PATH_LEAD, PATH_MEMBER, PATH_DISCIPLINE, PATH_CONVERGE } = require('../server/src/prompts-explore.js');
const { BOARD_COMMANDS, WAITING } = require('../server/src/prompts-n2-shared.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

async function main() {
  console.log('── explore-prompts: N-path exploration prompt ──');

  await t('lead (roster index 0) gets the path-seeding role', () => {
    const p = explorerPrompt({ task: 'T', actor: 'path-1', roster: ['path-1', 'path-2', 'path-3'], workspace: '/w', nPaths: 3 });
    assert.ok(p.includes('You are path-1, one of 3 explorers'), 'intro names actor + roster size');
    assert.ok(p.includes('the path seeder'), 'lead role text present');
    assert.ok(p.includes('publish UP TO 3 distinct candidate solution'),
      'nPaths placeholder substituted with 3 (got prompt without it)');
    assert.ok(!p.includes('__N__'), 'no unsubstituted __N__ placeholder survives');
  });

  await t('members get the claim + deep-dive role', () => {
    const p = explorerPrompt({ task: 'T', actor: 'path-2', roster: ['path-1', 'path-2'], workspace: '/w', nPaths: 2 });
    assert.ok(p.includes('claim one open path item'), 'member role text present');
    assert.ok(!p.includes('the path seeder'), 'member does NOT carry the seeder role');
  });

  await t('collaboration core reused verbatim from prompts-n2-shared', () => {
    const p = explorerPrompt({ task: 'T', actor: 'path-1', roster: ['path-1', 'path-2'], workspace: '/w', nPaths: 2 });
    assert.ok(p.includes(BOARD_COMMANDS), 'BOARD_COMMANDS block reused verbatim');
    assert.ok(p.includes(WAITING), 'WAITING block reused verbatim');
  });

  await t('deep-dive discipline + convergence rule present for every explorer', () => {
    for (const actor of ['path-1', 'path-2', 'path-3']) {
      const p = explorerPrompt({ task: 'T', actor, roster: ['path-1', 'path-2', 'path-3'], workspace: '/w', nPaths: 3 });
      assert.ok(p.includes('minimal benchmark'), `${actor}: quantify-early discipline`);
      assert.ok(p.includes('FAIL note'), `${actor}: dead-end closure rule`);
      assert.ok(p.includes('RESERVES the\nintegration item') || p.includes('integration item'),
        `${actor}: convergence/integration rule`);
    }
  });

  await t('task + workspace embedded; workspace guard text present', () => {
    const p = explorerPrompt({ task: 'beat zlib on ratio at 1GBps', actor: 'path-1', roster: ['path-1', 'path-2'], workspace: '/wks/x/curly-braces', nPaths: 2 });
    assert.ok(p.includes('beat zlib on ratio at 1GBps'), 'task text embedded');
    assert.ok(p.includes('Task workspace: /wks/x/curly-braces'), 'workspace embedded');
    assert.ok(p.includes('Never access credential files'), 'credential guard present');
  });

  await t('nPaths defaults to roster length when omitted', () => {
    const p = explorerPrompt({ task: 'T', actor: 'path-1', roster: ['path-1', 'path-2', 'path-3', 'path-4'], workspace: '/w' });
    assert.ok(p.includes('publish UP TO 4 distinct candidate solution'),
      'default nPaths = roster.length (4)');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
