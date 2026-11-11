const { GoogleGenAI } = require('@google/genai');

async function runGeminiP(prompt, systemInstruction = '') {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return '(Gemini API key missing; please set GEMINI_API_KEY or API_KEY in your environment)';
  }
  
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-pro',
      contents: prompt,
      config: systemInstruction ? { systemInstruction } : undefined,
    });
    return response.text.trim();
  } catch (err) {
    return `(Gemini call failed: ${err.message})`;
  }
}

module.exports = {
  runGeminiP
};
