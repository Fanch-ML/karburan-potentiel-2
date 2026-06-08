const https = require('https');

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body);
    const siren = body.siren;
    const company = body.company || '';
    const cy = new Date().getFullYear();
    const minYear = cy - 2;

    console.log('Request received:', { siren, company, minYear });

    // Step 1: Claude with web_search
    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log('API key present:', !!apiKey);

    if (apiKey) {
      const prompt = siren
        ? `Cherche sur pappers.fr le résultat net et le chiffre d affaires de la société avec le SIREN ${siren} pour l exercice ${minYear} ou ${cy-1}. Réponds UNIQUEMENT avec ce JSON sans aucun autre texte: {"found":true,"name":"NOM SOCIETE","year":${minYear},"resultatNet":1234567,"chiffreAffaires":9876543,"source":"pappers.fr"} Si données introuvables ou trop anciennes: {"found":false}`
        : `Cherche sur pappers.fr le résultat net et CA de la société française "${company}" pour l exercice ${minYear} ou ${cy-1}. Réponds UNIQUEMENT avec ce JSON: {"found":true,"name":"NOM","year":${minYear},"resultatNet":1234567,"chiffreAffaires":9876543,"source":"pappers.fr"} Si introuvable: {"found":false}`;

      const reqBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      });

      console.log('Calling Anthropic API...');

      const resp = await httpsRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reqBody),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, reqBody);

      console.log('API status:', resp.status);
      console.log('API response (first 500):', resp.body.substring(0, 500));

      const d = JSON.parse(resp.body);
      let t = '';
      if (d.content) for (const b of d.content) if (b.type === 'text') t += b.text;

      console.log('Text extracted:', t.substring(0, 300));

      // Try to find JSON with "found" key
      const jsonMatches = t.match(/\{[^{}]{5,500}\}/g) || [];
      for (const m of jsonMatches) {
        try {
          const p = JSON.parse(m);
          if ('found' in p) {
            console.log('Found result:', JSON.stringify(p));
            if (p.found && p.year && p.year < minYear) {
              return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false, reason: 'too_old', year: p.year, name: p.name }) };
            }
            return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(p) };
          }
        } catch(e) {}
      }
      console.log('No valid JSON found in response');
    }

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false, reason: 'unavailable' }) };

  } catch (e) {
    console.log('Error:', e.message);
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false, reason: 'error', message: e.message }) };
  }
};
