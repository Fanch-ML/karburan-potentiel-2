const https = require('https');

function post(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const ok = (d) => ({ statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(d) });

  try {
    const body = JSON.parse(event.body || '{}');
    const siren = (body.siren || '').replace(/[^0-9]/g, '');
    const company = (body.company || '').trim();
    const cy = new Date().getFullYear();
    const minYear = cy - 2;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    console.log('Request:', { siren, company, minYear, hasKey: !!apiKey });
    if (!apiKey) return ok({ found: false, reason: 'no_key' });

    const query = siren
      ? `SIREN ${siren} résultat net chiffre affaires ${minYear} site:pappers.fr OR site:verif.com OR site:societe.com`
      : `"${company}" résultat net chiffre affaires ${minYear} site:pappers.fr OR site:verif.com`;

    const prompt = `Recherche les données financières de ${siren ? 'la société SIREN '+siren : '"'+company+'"'} pour l'exercice ${minYear} ou ${cy-1} sur pappers.fr, verif.com ou societe.com.
Retourne UNIQUEMENT ce JSON (valeurs en euros entiers) :
{"found":true,"name":"NOM","year":${minYear},"resultatNet":2079037,"chiffreAffaires":38052900,"source":"pappers.fr"}
Si données introuvables ou antérieures à ${minYear} : {"found":false}`;

    const resp = await post('api.anthropic.com', '/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: 'Tu es un assistant qui recherche des données financières publiques françaises. Réponds UNIQUEMENT avec le JSON demandé, sans aucun autre texte.',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      },
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    );

    console.log('Anthropic status:', resp.status);
    const d = JSON.parse(resp.body);

    if (d.error) {
      console.log('Anthropic error:', JSON.stringify(d.error));
      // web_search not available - try without
      const resp2 = await post('api.anthropic.com', '/v1/messages',
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system: 'Tu es une base de données financières françaises. Réponds UNIQUEMENT avec le JSON demandé, sans aucun autre texte.',
          messages: [{ role: 'user', content: prompt }]
        },
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      );
      const d2 = JSON.parse(resp2.body);
      let t2 = '';
      if (d2.content) for (const b of d2.content) if (b.type === 'text') t2 += b.text;
      console.log('Fallback response:', t2.substring(0, 200));
      const m2 = t2.match(/\{"found"[^}]+\}/);
      if (m2) try { return ok(JSON.parse(m2[0])); } catch(e) {}
      return ok({ found: false, reason: 'no_websearch' });
    }

    let t = '';
    if (d.content) for (const b of d.content) if (b.type === 'text') t += b.text;
    console.log('Response text:', t.substring(0, 400));

    // Extract JSON - try multiple patterns
    const patterns = [
      /\{"found"\s*:\s*true[^}]{10,300}\}/,
      /\{"found"\s*:\s*false[^}]{0,100}\}/,
      /\{[^{}]*"resultatNet"[^{}]*\}/,
      /\{[^{}]*"found"[^{}]*\}/
    ];
    for (const pat of patterns) {
      const m = t.match(pat);
      if (m) {
        try {
          const p = JSON.parse(m[0]);
          if ('found' in p) {
            if (p.found && p.year && p.year < minYear) return ok({ found: false, reason: 'too_old', year: p.year, name: p.name });
            console.log('Found:', p);
            return ok(p);
          }
        } catch(e) {}
      }
    }

    console.log('No valid JSON found');
    return ok({ found: false, reason: 'unavailable' });

  } catch (e) {
    console.log('Error:', e.message);
    return ok({ found: false, reason: 'error', message: e.message });
  }
};
