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
//      `topP: 0.8` (was 0.95), `maxOutputTokens: 1024` (was 8192).
//      Adversarial code review wants determinism + concise output.
//      Defaults are tuned for creative chat, not judgment.
//   3. Failure surface: model + sampling values pulled into named
//      constants so a future test can grep them + a future model
//      bump is one place to edit.
const { GoogleGenAI } = require('@google/genai');

const CRITIC_MODEL = 'gemini-2.5-flash';
const CRITIC_SAMPLING = {
  temperature: 0.2,
  topP: 0.8,
  maxOutputTokens: 1024,
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
