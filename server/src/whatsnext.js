// fr-49: "what's next" priority queue.
//
// Hybrid ranking: a fast, deterministic heuristic picks a shortlist of
// at most TOP_N=20 candidates, then a single-turn LLM call reorders
// them by reading each item's text. The LLM rerank is best-effort —
// any failure (timeout, no API key, empty reply) falls back silently
// to the heuristic order so /whatsnext always returns something useful.
//
// Cached in plan.whatsNext = { items, generatedAt, llmReranked }
// with a 2-hour TTL ("refresh-on-read"). Background cron deliberately
// avoided so we don't burn API tokens when no one is looking.
//
// Exports:
//   computeHeuristicShortlist(items, runQueue, opts)   // pure
//   formatItemForLLM(item)                              // pure
//   parseLLMRerank(text, candidateIds)                  // pure
//   rerankWithLLM(shortlist, cwd)                       // async
//   generateWhatsNext(rec, cwd)                         // async
//   getCachedOrGenerate(rec, cwd, opts)                 // async
//
// Top-level constants live up here so a future tuning pass touches one
// spot. Bug > Feature > Todo is the default layer bias; flip via opts.

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TOP_N_SHORTLIST = 20;             // max candidates handed to the LLM
const RETURN_N = 10;                    // top entries kept in the cache

const LAYER_WEIGHTS = { Bug: 2.0, Feature: 1.0, Todo: 0.5 };

const SCORE_WEIGHTS = {
  voter: 3.0,                 // each unique voter adds 3
  comment: 1.0,               // each comment adds 1 (with diminishing returns capped at 5)
  layer: 1.0,                 // LAYER_WEIGHTS[item.layer] × this
  recencyBoost: 2.0,          // <7d old gets a boost
  agePenalty: -0.5,           // >90d old gets a penalty
  runFailurePenalty: -1.5,    // last run failed/aborted/errored → demote
};

const COMMENT_CAP = 5;        // diminishing returns above 5 comments
const RECENT_DAYS = 7;        // "recent" cutoff for the boost
const STALE_DAYS = 90;        // "old" cutoff for the penalty

// ─── heuristic ───────────────────────────────────────────────────────

// Score one item. Returns { score, reasons } — reasons is a short
// array of strings the UI surfaces so the user understands why an
// item ranked where it did.
function scoreItem(item, { runQueueIds = new Set(), now = Date.now() } = {}) {
  if (!item || item.done) return null;
  if (runQueueIds.has(item.id)) return null;     // already queued — skip

  const reasons = [];
  let score = 0;

  // Votes — each unique voter adds weight. Highest-signal of intent.
  const voters = Array.isArray(item.voters) ? item.voters.length : 0;
  if (voters > 0) {
    const delta = voters * SCORE_WEIGHTS.voter;
    score += delta;
    reasons.push(`${voters} voter${voters === 1 ? '' : 's'} (+${delta.toFixed(1)})`);
  }

  // Comments — discussion signal, capped so chatty items don't dominate.
  const cm = Array.isArray(item.comments) ? Math.min(item.comments.length, COMMENT_CAP) : 0;
  if (cm > 0) {
    const delta = cm * SCORE_WEIGHTS.comment;
    score += delta;
    reasons.push(`${cm} comment${cm === 1 ? '' : 's'} (+${delta.toFixed(1)})`);
  }

  // Layer bias — Bug > Feature > Todo by default. The weight scales
  // the per-layer multiplier in LAYER_WEIGHTS.
  const layerW = LAYER_WEIGHTS[item.layer] != null ? LAYER_WEIGHTS[item.layer] : 0.5;
  const layerDelta = layerW * SCORE_WEIGHTS.layer;
  score += layerDelta;
  reasons.push(`${item.layer || '(no layer)'} bias (+${layerDelta.toFixed(1)})`);

  // Recency / staleness windows. addedAt parses to a millis; fall
  // back to "ageless" if missing.
  const addedAtMs = item.addedAt ? Date.parse(item.addedAt) : NaN;
  if (Number.isFinite(addedAtMs)) {
    const ageDays = (now - addedAtMs) / (1000 * 60 * 60 * 24);
    if (ageDays < RECENT_DAYS) {
      score += SCORE_WEIGHTS.recencyBoost;
      reasons.push(`fresh <${RECENT_DAYS}d (+${SCORE_WEIGHTS.recencyBoost.toFixed(1)})`);
    } else if (ageDays > STALE_DAYS) {
      score += SCORE_WEIGHTS.agePenalty;
      reasons.push(`stale >${STALE_DAYS}d (${SCORE_WEIGHTS.agePenalty.toFixed(1)})`);
    }
  }

  // Run-failure history demotes — if the most recent run finished as
  // error/aborted, the item is probably stuck and shouldn't lead the
  // next-up list until someone investigates.
  if (Array.isArray(item.runs) && item.runs.length) {
    const last = item.runs[item.runs.length - 1];
    if (last && (last.status === 'error' || last.status === 'aborted')) {
      score += SCORE_WEIGHTS.runFailurePenalty;
      reasons.push(`last run ${last.status} (${SCORE_WEIGHTS.runFailurePenalty.toFixed(1)})`);
    }
  }

  return { id: item.id, layer: item.layer, score: Math.round(score * 10) / 10, reasons };
}

// Pure: takes the plan items + the run-queue + optional now, returns
// the top-N shortlist sorted by score descending. Open items only;
// items already in the run-queue are skipped.
function computeHeuristicShortlist(items, runQueue, { limit = TOP_N_SHORTLIST, now = Date.now() } = {}) {
  const runQueueIds = new Set();
  for (const e of runQueue || []) {
    if (e && e.itemId && (e.status === 'running' || e.status === 'pending')) {
      runQueueIds.add(e.itemId);
    }
  }
  const scored = [];
  for (const it of items || []) {
    const s = scoreItem(it, { runQueueIds, now });
    if (s) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─── LLM rerank (best-effort) ────────────────────────────────────────

// One-line summary for the LLM prompt — keeps the prompt compact.
function _firstLineSnippet(text, maxLen = 140) {
  const first = String(text || '').split('\n').find((l) => l.trim()) || '';
  return first.length > maxLen ? first.slice(0, maxLen - 1) + '…' : first;
}

// Map an item id+layer+snippet line for the LLM input.
function formatItemForLLM(item) {
  return `- ${item.id} [${item.layer || '?'}] — ${_firstLineSnippet(item.text)}`;
}

// Parse the LLM's numbered-list reply into an ordered list of ids,
// keeping only ids the LLM was actually given (defends against
// hallucinated ids). Tolerates `1. id`, `1) id`, `- id`, bare `id`.
function parseLLMRerank(text, candidateIds) {
  const allowed = new Set(candidateIds);
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Strip the numbering / bullet prefix; then split on the first non-
    // identifier char so we capture only the id.
    const stripped = line.replace(/^(\d+[.)]\s*|[-*]\s*)/, '');
    const m = stripped.match(/[A-Za-z0-9_-]+/);
    if (!m) continue;
    const id = m[0];
    if (!allowed.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Single-turn LLM rerank. Returns reordered shortlist (same shape as
// input), with `.llmRank` stamped. Falls back to the original order on
// any failure — never throws.
async function rerankWithLLM(shortlist, cwd) {
  if (!Array.isArray(shortlist) || shortlist.length < 2) return shortlist;
  let btw;
  try { btw = require('./btw'); } catch { return shortlist; }

  // Pull the original items off the rec so we can show text snippets
  // to the LLM. Caller passes them in via shortlist[i].snippet.
  const lines = shortlist.map((s) => `- ${s.id} [${s.layer || '?'}] — ${s.snippet || ''}`).join('\n');
  const prompt = [
    'You are reranking a software project\'s to-do list by priority.',
    'Given the candidate items below, return ONLY a numbered list of their ids',
    'in priority order (most important first). One id per line, no other text.',
    'Use ONLY the ids from the input list — do not invent new ids.',
    '',
    'Priority rubric (in order of weight):',
    '1. User-facing bugs that block normal use rank highest',
    '2. Small, well-scoped fixes that unblock other work',
    '3. Features with high engagement (voters / comments)',
    '4. Cleanup / refactor / docs rank lowest',
    '',
    '== Candidates ==',
    lines,
    '',
    '== Your ranked list (ids only, one per line) ==',
  ].join('\n');

  let reply;
  try {
    reply = await btw.runClaudeP(cwd || process.cwd(), prompt);
  } catch { return shortlist; }
  if (!reply || /^\(claude /.test(reply)) return shortlist;

  const candidateIds = shortlist.map((s) => s.id);
  const orderedIds = parseLLMRerank(reply, candidateIds);
  if (orderedIds.length < 2) return shortlist;        // LLM said nothing useful

  // Reorder shortlist; append any items the LLM omitted at the tail in
  // their original (heuristic) order so nothing disappears.
  const byId = new Map(shortlist.map((s) => [s.id, s]));
  const reordered = [];
  const seen = new Set();
  for (const id of orderedIds) {
    const s = byId.get(id);
    if (s) { reordered.push({ ...s, llmRank: reordered.length + 1 }); seen.add(id); }
  }
  for (const s of shortlist) {
    if (!seen.has(s.id)) reordered.push({ ...s, llmRank: null });
  }
  return reordered;
}

// ─── generate + cache ────────────────────────────────────────────────

// Build the cache payload. Looks up text snippets from the original
// items so the cached entries are self-describing for the slash-
// command output (don't need to cross-ref plan.items at read time).
async function generateWhatsNext(rec, cwd, { now = Date.now() } = {}) {
  const plan = rec && rec.artifacts && rec.artifacts.plan;
  const items = (plan && Array.isArray(plan.items)) ? plan.items : [];
  const shortlist = computeHeuristicShortlist(items, rec && rec.runQueue, { now });
  if (!shortlist.length) {
    return { items: [], generatedAt: new Date(now).toISOString(), llmReranked: false, empty: true };
  }
  // Stamp each shortlist entry with the item's first-line snippet for
  // the LLM input + the cached output.
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const s of shortlist) {
    const it = byId.get(s.id);
    s.snippet = _firstLineSnippet(it && it.text);
    s.heuristicRank = shortlist.indexOf(s) + 1;
  }
  // LLM rerank (best-effort).
  let ranked = shortlist;
  let llmReranked = false;
  try {
    const reordered = await rerankWithLLM(shortlist, cwd);
    if (reordered !== shortlist) {
      ranked = reordered;
      llmReranked = ranked.some((s) => s.llmRank != null);
    }
  } catch { /* fall back to heuristic */ }

  return {
    items: ranked.slice(0, RETURN_N),
    generatedAt: new Date(now).toISOString(),
    llmReranked,
    empty: false,
  };
}

// Read the cache; regenerate if missing or > TTL. Mutates plan.whatsNext.
// Returns the cached payload.
async function getCachedOrGenerate(rec, cwd, { ttlMs = TWO_HOURS_MS, force = false, now = Date.now() } = {}) {
  const plan = rec && rec.artifacts && rec.artifacts.plan;
  if (!plan) return { items: [], generatedAt: new Date(now).toISOString(), llmReranked: false, empty: true };
  const cache = plan.whatsNext;
  const cachedAt = cache && cache.generatedAt ? Date.parse(cache.generatedAt) : 0;
  const stale = !cache || (now - cachedAt) > ttlMs;
  if (!force && !stale) return cache;
  const fresh = await generateWhatsNext(rec, cwd, { now });
  plan.whatsNext = fresh;
  return fresh;
}

module.exports = {
  computeHeuristicShortlist,
  formatItemForLLM,
  parseLLMRerank,
  rerankWithLLM,
  generateWhatsNext,
  getCachedOrGenerate,
  // Exported for tests + tuning visibility.
  TWO_HOURS_MS,
  TOP_N_SHORTLIST,
  RETURN_N,
  LAYER_WEIGHTS,
  SCORE_WEIGHTS,
};
