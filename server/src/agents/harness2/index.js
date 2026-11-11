// server/src/agents/harness2/index.js — Harness² integration façade.
//
// Mirrors the pattern of agents/rlm/index.js: a single require target
// that re-exports every public surface of the Harness² integration.
//
// Consumers can either:
//   const h2 = require('./agents/harness2');
//   h2.startSweep(...)           — sweep lifecycle
//   h2.adoptHarness(...)         — result surface
//   h2.installIntoSession(...)   — market install
//
// Or import the sub-module they need directly:
//   const runner = require('./agents/harness2/runner');
//   const result = require('./agents/harness2/result');
//   const market = require('./agents/harness2/market');

'use strict';

// Re-export the three sub-modules as named surfaces.
const runner = require('./runner');
const result = require('./result');
const market = require('./market');

module.exports = {
  // ── sweep lifecycle (runner) ───────────────────────────────────────────
  startSweep:       runner.startSweep,
  cancelSweep:      runner.cancelSweep,
  getStatus:        runner.getStatus,
  latestSweepId:    runner.latestSweepId,
  sweepOrphans:     runner.sweepOrphans,
  formatStatus:     runner.formatStatus,
  parseProgress:    runner.parseProgress,
  sweepArgv:        runner.sweepArgv,
  sweepEnv:         runner.sweepEnv,
  newSweepId:       runner.newSweepId,
  sweepDir:         runner.sweepDir,
  sweepsRoot:       runner.sweepsRoot,
  isAlive:          runner.isAlive,
  splitQuoted:      runner.splitQuoted,
  DEFAULT_WALL_CAP_S: runner.defaultWallCapS(1),  // back-compat: k=1 budget
  defaultWallCapS:  runner.defaultWallCapS,
  ROLLOUT_TIMEOUT_S: runner.ROLLOUT_TIMEOUT_S,
  POLL_MS:          runner.POLL_MS,
  TERMINAL:         runner.TERMINAL,

  // ── result surface (diff / adopt / rollback) ───────────────────────────
  readResult:       result.readResult,
  findSelection:    result.findSelection,
  diffHarness:      result.diffHarness,
  adoptHarness:     result.adoptHarness,
  rollbackHarness:  result.rollbackHarness,
  saveSnapshot:     result.saveSnapshot,
  loadSnapshot:     result.loadSnapshot,
  listSnapshots:    result.listSnapshots,
  formatDiff:       result.formatDiff,
  harnessDir:       result.harnessDir,

  // ── harness market (publish / install) ────────────────────────────────
  validateTree:        market.validateTree,
  buildFromSweep:      market.buildFromSweep,
  publishFromSweep:    market.publishFromSweep,
  installIntoSession:  market.installIntoSession,
  listHarnesses:       market.listHarnesses,
};
