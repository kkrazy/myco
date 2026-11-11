// agent-n2 resume: run the next pending queue item through the DUAL-agent
// lane (worker-A + worker-B) instead of the single-agent dispatch.
//
// User request: "build点击以后，任务不是会进入队列，队列的resume 在加个
// agent-n2 resume" — clicking build queues a plan item for a single-agent
// run; the run-queue strip should also offer an agent-n2 action that runs
// the next pending item via compare-lanes.startN2Lane and flips the queue
// entry pending → running → success on lane completion.
//
// Static-shape guards (no live HTTP / no real lane): asserts the artifacts
// route + app.js button/handler + styles.css rule exist so the wiring can't
// silently regress.

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

const ART = _read('server/src/artifacts.js');
const APP = _read('web/public/app.js');
const CSS = _read('web/public/styles.css');

console.log('── queue-n2-resume: dual-agent run for the run-queue strip ──');

t('artifacts.js: POST /queue/n2 route exists and starts the N2 lane', () => {
  assert.ok(/app\.post\(['"`]\/sessions\/:id\/queue\/n2/.test(ART) ||
            /['"`]\/queue\/n2['"`]/.test(ART),
    'must register a /queue/n2 route');
  assert.ok(/startN2Lane\(/.test(ART),
    'must call compare-lanes.startN2Lane to launch the dual-agent lane');
  assert.ok(/runQueue\.markRunning\(ctx\.rec,/.test(ART),
    'must markRunning the queue entry before launching the lane');
  assert.ok(/runQueue\.markFinished\(ctx\.rec, itemId, true\)/.test(ART),
    'must markFinished(success) the queue entry when the lane completes');
});

t('app.js: run-queue strip renders the ◓ agent-n2 button + posts to /queue/n2', () => {
  assert.ok(/runqueue-n2-resume/.test(APP),
    'app.js must render a .runqueue-n2-resume button in the queue strip');
  assert.ok(/◓ agent-n2/.test(APP),
    'the button label must read "◓ agent-n2"');
  assert.ok(/function\s+onArtifactQueueN2Resume/.test(APP),
    'must define onArtifactQueueN2Resume');
  assert.ok(/['"`]\/sessions\/\$\{encodeURIComponent\(sid\)\}\/queue\/n2['"`]/.test(APP),
    'onArtifactQueueN2Resume must POST /sessions/:id/queue/n2');
});

t('styles.css: .runqueue-n2-resume rule exists (dual-agent tint)', () => {
  assert.ok(/\.runqueue-n2-resume/.test(CSS),
    'styles.css must style the agent-n2 button');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
