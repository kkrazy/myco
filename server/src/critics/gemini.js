// Gemini critic wrapper. The model + sampling config below were
// last reviewed 2026-06-02 after `gemini-1.5-pro` returned 404
// against v1beta (Google retired the 1.5 family). Three calibration
// changes shipped at the same time:
//
//   1. Model: `gemini-1.5-pro` → `gemini-2.5-flash`. 2.5 is the
//      current family; flash is the cost-effective sharp tier
//      (cheaper + faster than -pro, sharp enough for diff review).
//      Bump to `gemini-2.5-pro` if verdict quality degrades.
//   2. Sampling: explicit `temperature: 0.2` (was default 1.0),
//      `topP: 0.8` (was 0.95). Adversarial code review wants
//      determinism. Defaults are tuned for creative chat, not
//      judgment.
//   3. Failure surface: model + sampling values pulled into named
//      constants so a future test can grep them + a future model
//      bump is one place to edit.
//
// 2026-06-03 calibration — maxOutputTokens 1024 → 8192:
//   The 1024-token cap silently truncated verdicts on large diffs
//   (>~40k chars). The model's preamble ("Overall Assessment: ...")
//   alone could consume the entire budget, leaving the actual
//   verdict line (✓ AGREED / flagged-issues) NEVER WRITTEN. Three
//   times in a single session, fr-94 Phase 2 + bug-51 + fr-81
//   Phase A critiques came back as truncated preambles that LOOKED
//   like "Gemini flagged issues" but were actually unverdicted
//   buffers. 8192 was empirically verified to fit ~3,800-char
//   detailed verdicts on a 53k-char diff. Env override
//   `MYCO_CRITIC_MAX_TOKENS` lets ops bump higher without a code
//   change if a future critic-prompt change pushes longer.
const { GoogleGenAI } = require('@google/genai');

const CRITIC_MODEL = 'gemini-2.5-flash';
// Floor at 4096 to prevent regressing back into the truncation
// failure mode if someone overrides the env to a small value.
const CRITIC_MAX_OUTPUT_TOKENS = Math.max(
  4096,
  parseInt(process.env.MYCO_CRITIC_MAX_TOKENS || '', 10) || 8192,
);
const CRITIC_SAMPLING = {
  temperature: 0.2,
  topP: 0.8,
  maxOutputTokens: CRITIC_MAX_OUTPUT_TOKENS,
};

async function runCritique(prompt, systemInstruction = '') {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return '(Gemini API key missing; please set GEMINI_API_KEY or API_KEY in your environment)';
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const config = {
      ...CRITIC_SAMPLING,
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    const response = await ai.models.generateContent({
      model: CRITIC_MODEL,
      contents: prompt,
      config,
    });
    return response.text.trim();
  } catch (err) {
    return `(Gemini call failed: ${err.message})`;
  }
}

module.exports = {
  id: 'gemini',
  name: 'Gemini-2.5-Flash',
  runCritique,
};
