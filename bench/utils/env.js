// utils/env.js — load the model + proxy configuration that myco itself uses
// from a state .env (or the process environment), so the harness (hle / tb4)
// drives the SAME model gateway as the deployed myco instance.
//
// Extracted verbatim from bench/hle/lib/config.js (which was the standalone
// copy). Shared by bench/hle and bench/tb4. Behavior-neutral.
'use strict';

const fs = require('fs');
const path = require('path');

// Default state .env used by the user's myco instance. Override with
// MYCO_ENV env var or --env <path>.
const DEFAULT_ENV = process.env.MYCO_ENV || '/data/s00791175/Delm/mycoFile/state/.env';

// The KEYS relevant to running the Claude Agent SDK through myco's configured
// model gateway + enterprise proxy.
const APPLY_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'MYCO_ENTERPRISE_PROXY',
  'MYCO_ENTERPRISE_PROXY_URL',
  'MYCO_ENTERPRISE_NO_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];

function parseDotEnv(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// Apply the config file into process.env so process.env has the gateway +
// proxy vars set (the SDK / myco modules read process.env). File values always
// win over inherited env so the harness targets the intended model.
function applyEnv(envPath) {
  const vars = parseDotEnv(envPath || DEFAULT_ENV);
  for (const k of APPLY_KEYS) {
    if (vars[k] !== undefined) process.env[k] = vars[k];
  }
  return vars;
}

// Non-sensitive summary of the resolved model config (never the token).
function modelInfo(envPath) {
  const v = parseDotEnv(envPath || DEFAULT_ENV);
  const pick = (k) => v[k] !== undefined ? v[k] : (process.env[k] || '');
  return {
    model: pick('ANTHROPIC_MODEL'),
    baseUrl: pick('ANTHROPIC_BASE_URL'),
    hasToken: !!(pick('ANTHROPIC_AUTH_TOKEN') || pick('ANTHROPIC_API_KEY')),
    envPath: envPath || DEFAULT_ENV,
  };
}

module.exports = { applyEnv, modelInfo, parseDotEnv, DEFAULT_ENV, APPLY_KEYS };
