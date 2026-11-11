// lib/judge.js — cross-judging. Reuses the SAME myco engines (single/run-n2)
// to judge a candidate answer against the ground-truth answer. The judge
// prompt mirrors the HLE official JUDGE_PROMPT shape (compare response to
// correct_answer, allow numeric tolerance, output extracted answer + verdict).
'use strict';

const engine = require('./engine');

function judgePrompt({ question, answer, truth }) {
  return [
    'You are a strict answer grader. Decide whether the CANDIDATE ANSWER to the QUESTION',
    'is correct, comparing it to the exact CORRECT ANSWER below.',
    'For numerical answers allow small rounding differences (equivalent value, e.g. +/-1%).',
    'For multiple-choice, the candidate must name the matching option letter/value.',
    'Do not argue for any answer different from the CORRECT ANSWER.',
    '',
    'QUESTION:',
    String(question),
    '',
    'CANDIDATE ANSWER:',
    String(answer),
    '',
    'CORRECT ANSWER:',
    String(truth),
    '',
    'Reply with EXACTLY two lines:',
    'FINAL_ANSWER: <the exact final answer extracted from the CANDIDATE ANSWER, or None>',
    'CORRECT: <yes if the candidate matches the correct answer, otherwise no>',
  ].join('\n');
}

function parseVerdict(text) {
  const t = String(text || '');
  const correctM = t.match(/^\s*CORRECT\s*:\s*(yes|no)\b/im);
  const finalM = t.match(/^\s*FINAL_ANSWER\s*:\s*(.*)$/im);
  return {
    correct: correctM ? (correctM[1].toLowerCase() === 'yes') : null,
    extracted: finalM ? finalM[1].trim() : '',
  };
}

// Normalise a short answer for a loose equality fallback (strip markdown /
// bold / spacing / case). Used only when the judge engine failed to emit the
// FINAL_ANSWER:/CORRECT: verdict pair.
function _norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[*_`#>+\s]+/g, '');
}

// Extract a multiple-choice option letter from a candidate/truth string.
// Real-world shapes seen in results.jsonl (hle-20261103091045): "D. Weak
// Non-Sadism", "**Answer: D. 19/20**", "A. Abduction" — the letter IS named
// (as the prompt demands: "the candidate must name the matching option
// letter/value"), but the plain normalised-equality fallback compares
// "d.weaknon-sadism" vs "d" and fails, mis-grading correct answers as wrong
// (observed 4x, all single-mode answers). Recognise the letter explicitly:
//   - leading "D." / "D)" / "D:" (optionated form)
//   - "**Answer: D..." / "answer is D" anywhere in the head of the text
function _mcLetter(s) {
  const t = String(s || '');
  let m = t.match(/^\s*\**\s*([A-Ja-j])\s*[.):]/);
  if (m) return m[1].toUpperCase();
  m = t.match(/answer\s*(?:is)?\s*[:\s]*\**\s*([A-Ja-j])\b/);
  if (m) return m[1].toUpperCase();
  return null;
}

// mode = 'single' | 'n2'  -> which myco engine does the judging
async function judge(mode, { question, answer, truth, timeoutMs, cwd, id, seq } = {}) {
  const prompt = judgePrompt({ question, answer, truth });
  const r = await engine.answer(mode, { question: prompt, system: null, timeoutMs, cwd, id, seq });
  const verdict = parseVerdict(r.answer);
  // The n2 engine judges like it ANSWERS a question (dual-worker + board): it
  // writes just the extracted final answer (e.g. "3") instead of the
  // "FINAL_ANSWER:/CORRECT:" pair, so parseVerdict sees no verdict. Fall back:
  // a judge that lands on the same normalised value as the truth is correct.
  if (verdict.correct === null) {
    const cand = _norm(verdict.extracted || (r.answer ? String(r.answer) : ''));
    if (cand !== '') {
      // Multiple-choice short-circuit first: truth "D" vs candidate
      // "D. Weak Non-Sadism" is a letter match, even though the normalised
      // strings differ. Only applies when BOTH sides yield the same letter.
      const tLetter = _mcLetter(truth) || (String(truth || '').trim().length === 1
        ? String(truth).trim().toUpperCase() : null);
      const cLetter = _mcLetter(verdict.extracted || r.answer);
      if (tLetter && cLetter && tLetter === cLetter) {
        verdict.correct = true;
      } else {
        verdict.correct = (cand === _norm(truth));
      }
    }
  }
  return {
    ok: r.ok,
    engine: mode,
    correct: verdict.correct,
    extracted: verdict.extracted,
    // full judge model answer kept so a human can read/eyeball the verdict
    answer: r.answer,
    ms: r.ms,
    error: r.error,
  };
}

module.exports = { judge, judgePrompt, parseVerdict };
