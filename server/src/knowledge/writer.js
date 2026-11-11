// Automatic knowledge write-back at the end of a turn.
//
// Research mode closes the loop: after a successful turn the assistant's
// own result is mined for reusable findings and POSTed to the KB service.
// The KB service owns the Markdown format, dedup/merge and indexing — myco
// only decides WHAT to extract and WHEN.
//
// Trigger: turn_result with subtype=success, in research mode, when the
// result is substantive. Throttled per session so a chatty session cannot
// flood the KB. Extraction uses the existing one-shot LLM helper
// (btw.runClaudeP) and fails open — a bad extraction never affects the
// turn the user is waiting on.

'use strict';

const client = require('./client');

const MIN_RESULT_CHARS = 400;          // shorter turns are chat/confirmations
const THROTTLE_MS = 60 * 1000;         // at most one extraction per minute
const MAX_ITEMS = 3;
const MAX_ITEM_CHARS = 4000;
const EXTRACT_TIMEOUT_MS = 45000;

// Per-session throttle state. In-memory: a restart just allows one more
// extraction, which is harmless.
const lastRunAt = new Map();

const KINDS = ['insight', 'method', 'counterexample', 'failure', 'lemma', 'reference'];

const EXTRACTION_PROMPT = `You are mining a research assistant's turn output for reusable
knowledge. Extract ONLY findings that would help a future session on the same
or a related problem. Ignore process narration, restatements of the question,
tool logs, and anything already obvious.

Good findings:
- a proved or refuted statement (kind: insight / counterexample)
- a method or technique that worked (kind: method)
- a dead end with a concrete reason (kind: failure) — these are the most valuable
- a reusable lemma or bound (kind: lemma)
- a pointer to a key reference (kind: reference)

Return ONLY a JSON array (no prose, no code fences). Each element:
{
  "title": "one-line statement, <=120 chars",
  "kind": "insight|method|counterexample|failure|lemma|reference",
  "content": "markdown, <=2000 chars, sections: ## 结论 / ## 依据 / ## 适用边界",
  "tags": ["<=4 short tags"],
  "confidence": "low|medium|high"
}
Return [] if the turn produced nothing reusable. Never invent results that
are not supported by the text.

== Turn output ==
`;

function shouldExtract(rec, result, subtype, sessionId) {
  if (!rec || rec.researchMode !== true) return false;
  if (rec.kbAutoWrite === false) return false;
  if (!client.isEnabled()) return false;
  if (subtype !== 'success') return false;
  const text = String(result || '').trim();
  if (text.length < MIN_RESULT_CHARS) return false;
  const last = lastRunAt.get(sessionId) || 0;
  if (Date.now() - last < THROTTLE_MS) return false;
  return true;
}

// Parse the model's JSON array. Tolerates code fences and stray prose.
function parseExtraction(reply) {
  if (!reply || typeof reply !== 'string') return [];
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      title: String(x.title || '').trim().slice(0, 160),
      kind: KINDS.includes(x.kind) ? x.kind : 'insight',
      content: String(x.content || '').trim().slice(0, MAX_ITEM_CHARS),
      tags: Array.isArray(x.tags) ? x.tags.slice(0, 4).map(String) : [],
      confidence: ['low', 'medium', 'high'].includes(x.confidence) ? x.confidence : 'medium',
    }))
    .filter((x) => x.title.length >= 3 && x.content.length >= 10)
    .slice(0, MAX_ITEMS);
}

// Extract findings from one turn and write them to every mounted KB.
// Returns { written: [{kb, slug}], skipped, errors } — never throws.
async function extractAndWrite({ sessionId, rec, result, subtype, cwd, gw }) {
  const out = { written: [], skipped: 0, errors: [] };
  if (!shouldExtract(rec, result, subtype, sessionId)) return out;
  lastRunAt.set(sessionId, Date.now());

  let btw;
  try { btw = require('../btw'); } catch (e) {
    out.errors.push(`extractor unavailable: ${e.message}`);
    return out;
  }

  let reply;
  try {
    reply = await Promise.race([
      btw.runClaudeP(cwd || process.cwd(), EXTRACTION_PROMPT + String(result).slice(0, 12000), gw || {}),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('extraction timed out')), EXTRACT_TIMEOUT_MS)),
    ]);
  } catch (e) {
    out.errors.push(`extraction failed: ${e.message}`);
    return out;
  }
  if (!reply || /^\(claude /.test(reply)) {
    out.skipped++;
    return out;
  }

  const items = parseExtraction(reply);
  if (!items.length) { out.skipped++; return out; }

  const kbs = Array.isArray(rec.knowledgeBases) ? rec.knowledgeBases : [];
  for (const kb of kbs) {
    for (const item of items) {
      const res = await client.remember(kb, {
        ...item,
        source: { session: sessionId },
      });
      if (res.ok) out.written.push({ kb, slug: res.data.slug, kind: res.data.kind });
      else out.errors.push({ kb, error: res.error });
    }
  }
  return out;
}

function resetThrottle(sessionId) {
  if (sessionId) lastRunAt.delete(sessionId);
  else lastRunAt.clear();
}

module.exports = {
  shouldExtract,
  parseExtraction,
  extractAndWrite,
  resetThrottle,
  EXTRACTION_PROMPT,
  MIN_RESULT_CHARS,
  THROTTLE_MS,
  MAX_ITEMS,
};
