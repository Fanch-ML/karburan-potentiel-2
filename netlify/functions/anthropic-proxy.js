const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = { hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
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

    // Step 1: Try direct Pappers fetch with SIREN
    if (siren && /^\d{9}$/.test(siren)) {
      const result = await fetchPappers(siren, minYear);
      if (result) return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
    }

    // Step 2: Claude fallback
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false, reason: 'no_key' }) };

    const prompt = siren
      ? `Cherche résultat net et CA de la société SIREN ${siren} sur pappers.fr pour exercice ${minYear} ou ${cy-1}. JSON uniquement: {"found":true,"name":"NOM","year":${minYear},"resultatNet":2079037,"chiffreAffaires":38052900,"source":"pappers.fr"} ou {"found":false,"tooOld":false}`
      : `Société "${company}" France. Cherche résultat net et CA sur pappers.fr exercice ${minYear} ou ${cy-1}. JSON uniquement: {"found":true,"name":"NOM","year":${minYear},"resultatNet":123456,"chiffreAffaires":789000,"source":"pappers.fr"} ou {"found":false,"tooOld":false}`;

    const resp = await httpsPost('api.anthropic.com', '/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });

    const d = JSON.parse(resp.body);
    let t = '';
    if (d.content) for (const b of d.content) if (b.type === 'text') t += b.text;
    const matches = t.match(/\{[^{}]*"found"[^{}]*\}/g);
    if (matches) {
      for (const m of matches) {
        try { const p = JSON.parse(m); if ('found' in p) return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(p) }; } catch(e) {}
      }
    }
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false, reason: 'unavailable' }) };
  } catch (e) {
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false, reason: 'error', message: e.message }) };
  }
};

async function fetchPappers(siren, minYear) {
  try {
    const r = await httpsGet(`https://www.pappers.fr/entreprise/${siren}`);
    const html = r.body;
    const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    const rnPatterns = [
      /[Rr]ésultat\s+net[^0-9\-]*(-?\s*[0-9][0-9\s]*)\s*[€k]/,
      /([0-9][0-9\s]{3,})\s*€[^<]{0,30}[Rr]ésultat/
    ];
    const yearMatch = html.match(/exercice\s+(\d{4})|bilan\s+(\d{4})|20(2[0-9])/i);
    const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2] || '20'+yearMatch[3]) : null;
    for (const pat of rnPatterns) {
      const m = html.match(pat);
      if (m && year && year >= minYear) {
        const rn = parseInt(m[1].replace(/\s/g, ''));
        if (!isNaN(rn) && rn > 0) return { found: true, name: name||'Société', year, resultatNet: rn, source: 'pappers.fr' };
      }
    }
    return null;
  } catch(e) { return null; }
}
