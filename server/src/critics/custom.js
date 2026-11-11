async function runCritique(prompt, systemInstruction = '') {
  let endpoint = process.env.CUSTOM_CRITIC_ENDPOINT || 'http://localhost:11434/v1';
  // Normalize endpoint URL
  endpoint = endpoint.replace(/\/+$/, '');
  const url = `${endpoint}/chat/completions`;

  const apiKey = process.env.CUSTOM_CRITIC_KEY || '';
  const model = process.env.CUSTOM_CRITIC_MODEL || 'llama3';

  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: headers,
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
    return data.choices?.[0]?.message?.content?.trim() || '(Local model returned no text)';
  } catch (err) {
    return `(Self-hosted call failed: ${err.message} on endpoint ${url})`;
  }
}

module.exports = {
  id: 'custom',
  name: 'Self-Hosted Model',
  runCritique
};
