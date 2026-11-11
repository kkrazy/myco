// Was 500. Bumped 2026-05-14 so the /loop diagnostic tick (every 30 min)
// catches ~30 min of log activity instead of ~10 min — at the current
// chatty rate (mostly /sessions polling + state-update bursts) the 500
// cap was wrapping inside one tick window and the loop lost the middle.
const CAPACITY = 5000;

const buffer = [];
let writeIdx = 0;
let count = 0;
const listeners = [];

const origLog = console.log;
const origError = console.error;

function classify(msg) {
  if (typeof msg !== 'string') return 'info';
  if (/\bWARNING\b/i.test(msg) || /^\[\s*warn\s*\]/i.test(msg)) return 'warn';
  return 'info';
}

function push(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  const entry = { ts: new Date().toISOString(), level, msg };
  if (count < CAPACITY) {
    buffer.push(entry);
    count++;
  } else {
    buffer[writeIdx] = entry;
  }
  writeIdx = (writeIdx + 1) % CAPACITY;
  for (const fn of listeners) fn(entry);
}

function init() {
  console.log = function (...args) {
    origLog.apply(console, args);
    push(classify(args[0]), args);
  };
  console.error = function (...args) {
    origError.apply(console, args);
    push('error', args);
  };
}

function getRecent(n = 100) {
  const limit = Math.min(n, count);
  if (count < CAPACITY) return buffer.slice(-limit);
  const start = (writeIdx - limit + CAPACITY) % CAPACITY;
  if (start < writeIdx) return buffer.slice(start, writeIdx);
  return buffer.slice(start).concat(buffer.slice(0, writeIdx));
}

function onLog(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

module.exports = { init, getRecent, onLog };
