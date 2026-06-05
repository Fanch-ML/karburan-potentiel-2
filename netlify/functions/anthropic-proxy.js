exports.handler = async function(event) {
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const siren = body.siren;
    const company = body.company || '';
    const minYear = new Date().getFullYear() - 2;

    // Try Pappers with SIREN if provided
    if(siren && /^\d{9}$/.test(siren)){
      const result = await fetchPappers(siren, minYear);
      if(result) return jsonResponse(result);
    }

    // Fallback: use Claude with web_search
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if(!apiKey) return jsonResponse({found: false, reason: 'unavailable'});

    const cy = new Date().getFullYear();
    const prompt = siren
      ? `Cherche le résultat net et CA de la société SIREN ${siren} sur pappers.fr pour l'exercice ${minYear} ou ${cy-1}. Réponds UNIQUEMENT en JSON : {"found":true,"name":"NOM","year":${minYear},"resultatNet":2079037,"chiffreAffaires":38052900,"source":"pappers.fr"} ou {"found":false,"tooOld":false}`
      : `Société française "${company}". Cherche résultat net et CA sur pappers.fr pour exercice ${minYear} ou ${cy-1}. JSON uniquement : {"found":true,"name":"NOM","year":${minYear},"resultatNet":123456,"chiffreAffaires":789000,"source":"pappers.fr"} ou {"found":false,"tooOld":false}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    let t = '';
    if(data.content) for(const b of data.content) if(b.type === 'text') t += b.text;
    const allMatches = t.match(/\{"found"[\s\S]*?\}/g) || t.match(/\{[\s\S]*?"found"[\s\S]*?\}/g);
    if(allMatches){
      for(const m of allMatches){
        try{ const p = JSON.parse(m); if('found' in p) return jsonResponse(p); }catch(e){}
      }
    }
    return jsonResponse({found: false, reason: 'unavailable'});
  } catch(e) {
    return { statusCode: 500, headers: {'Access-Control-Allow-Origin':'*'}, body: JSON.stringify({found: false, reason: 'error', message: e.message}) };
  }
};

async function fetchPappers(siren, minYear){
  try {
    const url = `https://www.pappers.fr/entreprise/${siren}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
    const html = await r.text();
    // Extract company name
    const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    // Extract financial data - look for résultat net patterns
    const rnMatch = html.match(/sultat\s+net[^0-9]*([0-9\s]+)\s*€/i) ||
                    html.match(/([0-9\s]{4,})\s*€[^<]*net/i);
    const caMatch = html.match(/chiffre\s+d.affaires[^0-9]*([0-9\s]+)\s*€/i);
    const yearMatch = html.match(/20(2[0-9])/);
    const year = yearMatch ? parseInt('20'+yearMatch[1]) : null;
    if(name && rnMatch && year && year >= minYear){
      const rn = parseInt(rnMatch[1].replace(/\s/g,''));
      const ca = caMatch ? parseInt(caMatch[1].replace(/\s/g,'')) : null;
      if(rn > 0) return { found: true, name, year, resultatNet: rn, chiffreAffaires: ca, source: 'pappers.fr' };
    }
    return null;
  } catch(e) { return null; }
}

function jsonResponse(data){
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) };
}
