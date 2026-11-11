// Multi-expert team: expert CRUD + validation.
//
// An "expert" is a named team member defined by one or more SKILLS from
// the skill market (or the session's personal skill store). The set of
// experts is persisted per session on rec.experts:
//
//   rec.experts = [
//     { name: 'sql-migration-dev', skills: ['sql-migrations', 'testing'] },
//     …
//   ]
//
// `skills` holds skill dirNames — the same identifier the SDK's
// `sdkOpts.skills` filter and GET /sessions/:id/skills use. When a task
// is started with the expert team (/run-team <task>), the server maps
// each expert to a worker (worker-A…worker-N) whose AgentSession is
// constructed with enabledSkills = the expert's skills (the SDK pins
// the skill-context filter to exactly those) and whose system prompt is
// built by prompts-team.js expertPrompt() from the skills' names +
// descriptions. The board-queue collaboration core (prompts-n2) is
// reused verbatim — only the per-worker ROLE definition changes.
//
// This module is deliberately free of SDK/lane concerns: callers
// (index.js routes, slashcmds.js /experts, compare-lanes.js
// startTeamLane) read rec.experts and resolve skill metadata via
// resolveExpertSkills().

'use strict';

const MAX_EXPERTS = 12;          // roster cap — board actors + UI columns
const MAX_NAME_LEN = 40;
// Same shape as skills.js assertSkillName: a conservative dirName charset.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function err(code, msg) {
  return Object.assign(new Error(msg), { code });
}

// Normalize + validate one expert entry. Returns a plain object
// { name, skills:[string] } or throws ERR_BAD_INPUT.
function normalizeExpert({ name, skills } = {}) {
  const n = String(name || '').trim();
  if (!n) throw err('ERR_BAD_INPUT', 'expert name required');
  if (n.length > MAX_NAME_LEN) throw err('ERR_BAD_INPUT', `expert name too long (max ${MAX_NAME_LEN} chars)`);
  if (!NAME_RE.test(n)) {
    throw err('ERR_BAD_INPUT', 'expert name may only contain letters, digits, dot, dash, underscore (and must start with a letter/digit)');
  }
  const sk = Array.isArray(skills) ? skills : [];
  for (const s of sk) {
    if (typeof s !== 'string' || !s.trim()) {
      throw err('ERR_BAD_INPUT', 'skills must be non-empty strings (skill dirNames)');
    }
  }
  return { name: n, skills: sk.map((s) => s.trim()).filter(Boolean) };
}

// Read the session's experts (always an array — a legacy record without
// the field reads as []).
function listExperts(rec) {
  if (!rec) return [];
  return Array.isArray(rec.experts) ? rec.experts : [];
}

// Add one expert (validated, unique by name). Caller persists the store.
// Returns the new full list.
function addExpert(rec, entry) {
  const e = normalizeExpert(entry);
  if (!Array.isArray(rec.experts)) rec.experts = [];
  if (rec.experts.some((x) => x && x.name === e.name)) {
    throw err('ERR_EXISTS', `expert "${e.name}" already exists`);
  }
  if (rec.experts.length >= MAX_EXPERTS) {
    throw err('ERR_BAD_INPUT', `too many experts (max ${MAX_EXPERTS})`);
  }
  rec.experts.push(e);
  return rec.experts.slice();
}

// Remove one expert by name. Caller persists the store. Throws
// ERR_NOT_FOUND when absent. Returns the remaining list.
function removeExpert(rec, name) {
  const n = String(name || '').trim();
  if (!Array.isArray(rec.experts) || !rec.experts.some((x) => x && x.name === n)) {
    throw err('ERR_NOT_FOUND', `expert "${n}" not found`);
  }
  rec.experts = rec.experts.filter((x) => !(x && x.name === n));
  return rec.experts.slice();
}

module.exports = { listExperts, addExpert, removeExpert, normalizeExpert, MAX_EXPERTS };
