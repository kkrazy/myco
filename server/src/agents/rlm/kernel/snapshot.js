// RLM kernel namespace snapshot — structured serialization.
//
// Node has no pickle equivalent, so snapshots are structured JSON
// (design doc §2.2): JSON-able values serialize directly; objects keep
// a prototype description (class name + method name list); anything
// unserializable becomes a `__unserializable__` placeholder. Caps align
// with prime's spirit: single variable 4 MiB (default), snapshot total
// 64 MiB; over-cap variables are dropped and counted in `truncated`.
//
// Format (see kernel/protocol.md):
// {
//   magic: 'MYCO-RLM-KERNEL-SNAPSHOT-V1',
//   ts, vars: [ {name, kind, value|proto|placeholder, bytes} ],
//   truncated: N, warnings: []
// }

'use strict';

const MAGIC = 'MYCO-RLM-KERNEL-SNAPSHOT-V1';
const DEFAULT_MAX_VAR_BYTES = 4 * 1024 * 1024;   // 4 MiB
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB

// Which namespace keys are runtime plumbing, not agent state.
const BUILTIN_KEYS = new Set([
  'console', 'require', 'Buffer', 'process', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'rlm', 'state_placeholder',
]);

function byteLength(str) {
  return Buffer.byteLength(String(str), 'utf8');
}

// Serialize one value into a descriptor.
function serializeValue(value, depth = 0) {
  const t = typeof value;
  if (value === null) return { kind: 'json', value: null };
  if (t === 'undefined') return { kind: 'undefined' };
  if (t === 'number' || t === 'boolean' || t === 'string' || t === 'bigint') {
    return { kind: 'json', value: t === 'bigint' ? { __bigint: String(value) } : value };
  }
  if (t === 'function') {
    return { kind: 'function', name: value.name || 'anonymous' };
  }
  if (t === 'symbol') return { kind: 'symbol', value: value.toString() };
  if (value instanceof Error) {
    return { kind: 'error', name: value.name, message: value.message };
  }
  // Try a straight JSON round-trip first.
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return { kind: 'json', value: JSON.parse(json) };
  } catch {
    // fall through to structural
  }
  if (depth >= 4) return { kind: 'unserializable', reason: 'depth' };
  if (Array.isArray(value)) {
    return { kind: 'array', items: value.slice(0, 1000).map((v) => serializeValue(v, depth + 1)) };
  }
  // Plain-ish object: keep prototype description (class name + own
  // method names) plus serialized own enumerable props.
  let proto = 'Object';
  try { proto = (value.constructor && value.constructor.name) || 'Object'; } catch {}
  const props = {};
  const methodNames = [];
  let count = 0;
  for (const k of Object.keys(value)) {
    if (count++ >= 1000) break;
    try {
      const v = value[k];
      if (typeof v === 'function') methodNames.push(k);
      else props[k] = serializeValue(v, depth + 1);
    } catch {
      props[k] = { kind: 'unserializable', reason: 'getter threw' };
    }
  }
  return { kind: 'object', proto, methodNames, props };
}

function isAgentStateKey(nsEnv, name) {
  // Snapshot everything the cell code could have defined. The vm
  // context's own property names are the user-visible globals; we
  // exclude the injected builtins and internal sentinels.
  if (BUILTIN_KEYS.has(name)) return false;
  if (name === '__last' || name === '_') return true; // keep completion
  // vm context globals include all standard built-ins (Object, Math…);
  // only snapshot keys whose value differs from a fresh context's —
  // too clever to detect cheaply, so instead snapshot only keys that
  // appear in the `state` object plus keys the manager tracked as
  // user-defined. The child tags them: any key NOT in the fresh
  // context is user-defined. We approximate: skip well-known globals.
  return true;
}

const STANDARD_GLOBALS = new Set([
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt',
  'Infinity', 'NaN', 'isFinite', 'isNaN', 'Boolean', 'String', 'Symbol',
  'Date', 'Promise', 'RegExp', 'Error', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'globalThis',
  'JSON', 'Math', 'console', 'DataView', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'Intl', 'ArrayBuffer', 'Uint8Array', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray',
  'BigInt', 'WeakRef', 'FinalizationRegistry', 'TextEncoder',
  'TextDecoder', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'structuredClone', 'fetch', 'queueMicrotask',
  'atob', 'btoa', 'clearInterval', 'clearTimeout', 'setInterval',
  'setTimeout', 'crypto', 'performance', 'WebAssembly', 'global',
  'Buffer', 'require', 'process', 'rlm', 'console_',
]);

// Serialize the whole namespace. Returns the snapshot object.
function serializeNamespace(nsEnv, { maxVarBytes = DEFAULT_MAX_VAR_BYTES,
                                     maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
  const vars = [];
  const warnings = [];
  let truncated = 0;
  let total = 0;
  const names = Object.getOwnPropertyNames(nsEnv)
    .filter((n) => STANDARD_GLOBALS.has(n) === false && !BUILTIN_KEYS.has(n));
  for (const name of names) {
    let value;
    try { value = nsEnv[name]; } catch { warnings.push(`skip ${name}: getter threw`); continue; }
    const desc = serializeValue(value);
    const bytes = byteLength(JSON.stringify(desc));
    if (bytes > maxVarBytes) {
      truncated++;
      warnings.push(`var ${name} was ${bytes}B > ${maxVarBytes}B cap — replaced with placeholder`);
      vars.push({ name, kind: 'placeholder', reason: 'over var cap', bytes });
      continue;
    }
    total += bytes;
    if (total > maxTotalBytes) {
      truncated++;
      warnings.push(`var ${name} skipped: snapshot total exceeded ${maxTotalBytes}B`);
      continue;
    }
    vars.push({ name, ...desc, bytes });
  }
  return { magic: MAGIC, ts: new Date().toISOString(), vars, truncated, warnings };
}

// Restore a snapshot into a namespace object (mutates nsEnv).
function deserializeNamespace(nsEnv, snap) {
  if (!snap || snap.magic !== MAGIC) {
    throw new Error(`bad snapshot magic: ${snap && snap.magic}`);
  }
  let restored = 0;
  const warnings = [];
  for (const v of snap.vars || []) {
    try {
      if (v.kind === 'placeholder') {
        nsEnv[v.name] = { __unserializable__: true, reason: v.reason };
        continue;
      }
      nsEnv[v.name] = reviveValue(v);
      restored++;
    } catch (err) {
      warnings.push(`restore ${v.name} failed: ${err.message}`);
    }
  }
  return { restored, warnings: warnings.concat(snap.warnings || []) };
}

function reviveValue(desc) {
  switch (desc.kind) {
    case 'json':
      if (desc.value && typeof desc.value === 'object' && desc.value.__bigint) {
        return BigInt(desc.value.__bigint);
      }
      return desc.value;
    case 'undefined': return undefined;
    case 'function':
      // Functions can't be revived — leave a stub marker.
      return { __unserializable__: true, reason: `function ${desc.name}` };
    case 'symbol': return Symbol(desc.value);
    case 'error': { const e = new Error(desc.message); e.name = desc.name; return e; }
    case 'array': return desc.items.map(reviveValue);
    case 'object': {
      const out = {};
      for (const k of Object.keys(desc.props || {})) out[k] = reviveValue(desc.props[k]);
      // prototype description survives as metadata, not a real prototype
      // (reviving live classes across processes is not sound).
      if (desc.proto && desc.proto !== 'Object') out.__proto__desc = desc.proto;
      return out;
    }
    case 'unserializable':
      return { __unserializable__: true, reason: desc.reason };
    default:
      return { __unserializable__: true, reason: `unknown kind ${desc.kind}` };
  }
}

module.exports = {
  MAGIC,
  DEFAULT_MAX_VAR_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  serializeNamespace,
  deserializeNamespace,
};
