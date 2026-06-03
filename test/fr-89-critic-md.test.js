// fr-89 Phase 1: self-growing critic.md to persist effective critic
// rules + anti-patterns across sessions.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem:  There is no persistent store for the critic rules
//             that actually prove effective during real runs, so
//             learnings are lost between sessions.
//   Expected: A `critic.md` file that auto-accumulates the most
//             effective critic rules (e.g. anti-patterns) and grows
//             organically based on real system results.
//
//   Comment from @kkrazy: "The critic.md file should have a myco
//     default and replicate to all myco managed projects when a new
//     project is added to myco."
//   Comment from @labxnow: "Research and initialize the critic.md
//     with some good default best practice"
//
// Phase 1 scope (confirmed via AskUserQuestion — auto-growth deferred
// to a future dispatch):
//   · myco-shipped default at server/templates/critic.md with
//     researched best practices (Core principles, Anti-patterns,
//     Things-NOT-to-flag calibration, Project-specific-lessons
//     section to grow into).
//   · server/src/critique.js _loadProjectCriticRules() reads the
//     project's _myco_/critic.md at the start of every critique
//     run and APPENDS it to the base systemPrompt under a clearly
//     labelled "Project-specific critic rules" header.
//   · On first run for a project (critic.md missing), the helper
//     seeds the file by copying server/templates/critic.md →
//     _myco_/critic.md. Subsequent runs find it and skip the copy.
//     Project owns the file after seeding — myco template updates
//     do NOT overwrite local edits.
//   · This project (_myco_/critic.md) is initialized with the
//     bootstrapped copy so existing runs immediately benefit.
//
// Test shape: static-grep guards across the three layers.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-89 Phase 1: critic.md template + per-run injection ──');

// ── myco-shipped default template ──

t('server/templates/critic.md exists', () => {
  const p = path.join(__dirname, '..', 'server', 'templates', 'critic.md');
  assert.ok(fs.existsSync(p),
    'fr-89 Phase 1 requires a myco-shipped default critic.md at server/templates/critic.md so new projects can be seeded with researched best practices (per @kkrazy comment: "myco default…replicate to all myco managed projects").');
});

t('server/templates/critic.md contains the documented section headers (Core principles, Anti-patterns, …)', () => {
  const src = _read('server/templates/critic.md');
  for (const heading of ['Core review principles', 'Anti-patterns to flag', 'Things NOT to flag', 'Project-specific lessons']) {
    assert.ok(new RegExp('##\\s+' + heading.replace(/[-.]/g, '\\$&'), 'i').test(src),
      `the myco default critic.md must contain a "## ${heading}" section so the template gives the critic structured, organized guidance from day 1.`);
  }
});

// ── critique.js: read + seed + inject ──

t('server/src/critique.js loads project _myco_/critic.md (read path present)', () => {
  const src = _read('server/src/critique.js');
  // Loose match: the path 'critic.md' must appear in the file path
  // construction. Anchor on path.join + _myco_ + critic.md OR a
  // direct `_myco_/critic.md` literal — both are valid implementations.
  assert.ok(/_myco_\/critic\.md|['"`]critic\.md['"`]/.test(src),
    "server/src/critique.js must read the project's _myco_/critic.md so its content can be injected into the critic systemPrompt (fr-89 Phase 1).");
});

t('server/src/critique.js seeds the project file from server/templates/critic.md on first run', () => {
  const src = _read('server/src/critique.js');
  // The seed-on-missing copy must reference both the template path
  // and a copy/write call. Loose check: templates/critic.md path +
  // copyFileSync or writeFileSync within the same function window.
  assert.ok(/templates(\/|\\)critic\.md|['"`]templates['"`]\s*,\s*['"`]critic\.md['"`]/.test(src),
    "server/src/critique.js must reference the shipped template at server/templates/critic.md so it can seed a missing project file (fr-89 Phase 1 + @kkrazy's 'replicate to all projects' comment).");
  assert.ok(/copyFileSync|writeFileSync\s*\([^)]*critic\.md/.test(src),
    "server/src/critique.js must actually COPY the template to the project's _myco_/critic.md on first run (the seed step). Reading without writing means new projects start with no critic rules.");
});

t('server/src/critique.js appends the loaded rules to the system prompt', () => {
  const src = _read('server/src/critique.js');
  // The systemPrompt must concat the rules content. Anchor: the prompt
  // string and the rules variable name should both appear near each other
  // — projectCriticRules + systemPrompt(Prefix) within a tight window.
  //
  // fr-95 follow-up: the variable was renamed `systemPrompt` →
  // `systemPromptPrefix` when fr-95 split the system prompt into a
  // STABLE PREFIX (this one — shared across specialties) and a
  // per-specialty TAIL (specialty.systemSuffix). The contract this
  // test locks (projectCriticRules IS appended to the prompt that
  // gets sent to the critic) is unchanged; only the variable name
  // moved. Accept either name so the anchor doesn't break on
  // semantic renames that preserve the contract.
  const sysAt = src.search(/const\s+systemPrompt(?:Prefix)?\s*=/);
  assert.ok(sysAt > -1, 'systemPrompt or systemPromptPrefix must still be defined in critique.js (anchor for the injection-site scan).');
  const win = src.slice(sysAt, sysAt + 1500);
  // The systemPrompt expression must reference the rules — either via a
  // template-literal interpolation of the rules variable or via string
  // concatenation. Loose match: any of the recognized rule-variable names.
  assert.ok(/projectCriticRules|criticRules|\$\{[^}]*critic[^}]*\}/.test(win),
    'the systemPrompt assignment must interpolate / append the project critic rules variable so the critic actually receives them (fr-89 Phase 1).');
});

t('server/src/critique.js falls back gracefully when the file or template is missing', () => {
  const src = _read('server/src/critique.js');
  // If reading critic.md fails the critic must still run. Look for a
  // try/catch around the load AND an empty-string fallback path so the
  // critique doesn't crash on a missing file.
  assert.ok(/try\s*\{[\s\S]*?critic\.md[\s\S]*?\}\s*catch/.test(src) ||
            /catch[\s\S]*?critic\.md/.test(src),
    'critique.js must wrap the critic.md load in try/catch so a missing/unreadable file degrades to running the critique without project rules instead of crashing the run (fr-89 Phase 1).');
});

// ── this project bootstrapped ──

t('this project is bootstrapped: _myco_/critic.md exists with template content', () => {
  const p = path.join(__dirname, '..', '_myco_', 'critic.md');
  assert.ok(fs.existsSync(p),
    'this project (the myco repo itself) must have _myco_/critic.md initialized as part of fr-89 Phase 1 so the critic immediately benefits from project-specific rules. Seed: cp server/templates/critic.md _myco_/critic.md.');
  const projectFile = fs.readFileSync(p, 'utf8');
  const template = _read('server/templates/critic.md');
  // The initial bootstrap should be IDENTICAL to the template (no
  // project-specific drift yet). Future commits may diverge — that's
  // expected and the test should NOT lock identical-forever; check the
  // shared marker comment instead.
  for (const heading of ['Core review principles', 'Anti-patterns to flag']) {
    assert.ok(new RegExp('##\\s+' + heading).test(projectFile),
      `the bootstrapped _myco_/critic.md must carry the "${heading}" section from the template (fr-89 Phase 1).`);
  }
});

// ── marker comment ──

t('a comment naming fr-89 explains the critic.md plumbing', () => {
  const critique = _read('server/src/critique.js');
  assert.ok(/fr-89/.test(critique),
    'a comment naming fr-89 must appear in server/src/critique.js so a future restyle understands why the systemPrompt is being augmented from _myco_/critic.md.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
