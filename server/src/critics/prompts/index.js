// bug-65: prompt loader. Loads the critic prompt content from .md
// siblings at module-load time (synchronous; cached on first
// require). Edit the .md files to change prompts; server restart
// picks them up on next module load.
//
// Why .md siblings instead of inline template strings:
//   · Easier review — prompts diff cleanly without JS escape noise.
//   · Editable by non-engineers (the user can tune prompts).
//   · Per CLAUDE.md §1 high-cohesion-low-coupling — content
//     (prompts) and logic (the wiring) live in separate modules.
//
// Consumers:
//   · server/src/critique.js — uses .base + .stageAnalyze /
//     .stageCode / .stageVerify / .stageFinal to compose the
//     systemPromptPrefix + userPrompt's stageAddendum.
//   · server/src/critics/specialties/*.js — each specialty module
//     loads its sibling .md for systemSuffix (not done by this
//     loader; specialties handle their own .md siblings).

const fs = require('fs');
const path = require('path');

function _load(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

module.exports = {
  base: _load('base.md'),
  stageAnalyze: _load('stage-analyze.md'),
  stageCode: _load('stage-code.md'),
  stageVerify: _load('stage-verify.md'),
  stageFinal: _load('stage-final.md'),
};
