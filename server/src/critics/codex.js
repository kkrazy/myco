async function runCritique(prompt, systemInstruction = '') {
  const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
  if (!apiKey) {
    return '(OpenAI/Codex API key missing; please set OPENAI_API_KEY or CODEX_API_KEY in your environment)';
  }

  const model = process.env.OPENAI_CRITIC_MODEL || 'gpt-4o';
  
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '(OpenAI returned no text)';
  } catch (err) {
    return `(OpenAI call failed: ${err.message})`;
  }
}

module.exports = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  runCritique
};
