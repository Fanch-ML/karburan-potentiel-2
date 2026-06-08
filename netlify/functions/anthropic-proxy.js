const https = require('https');

function get(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

async function pappersSearch(query, apiKey) {
  const r = await get('api.pappers.fr', `/v2/recherche?q=${encodeURIComponent(query)}&api_token=${apiKey}&par_page=1`);
  if (r.status !== 200) return null;
  const d = JSON.parse(r.body);
  const results = d.resultats || d.resultats_entreprises || [];
  return results[0] || null;
}

async function pappersEntreprise(siren, apiKey) {
  const r = await get('api.pappers.fr', `/v2/entreprise?siren=${siren}&api_token=${apiKey}&finances=true`);
  if (r.status !== 200) { console.log('Pappers entreprise error:', r.status, r.body.substring(0,200)); return null; }
  return JSON.parse(r.body);
}

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const ok = (data) => ({ statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  try {
    const body = JSON.parse(event.body || '{}');
    const rawSiren = (body.siren || '').toString().replace(/[^0-9]/g, '');
    const company = (body.company || '').trim();
    const cy = new Date().getFullYear();
    const minYear = cy - 2;
    const apiKey = process.env.PAPPERS_API_KEY;

    console.log('Request:', { rawSiren, company, minYear, hasKey: !!apiKey });

    if (!apiKey) return ok({ found: false, reason: 'no_key' });
    if (!rawSiren && !company) return ok({ found: false, reason: 'no_input' });

    let siren = rawSiren.length === 9 ? rawSiren : null;

    // If no SIREN, search by name
    if (!siren && company) {
      console.log('No SIREN, searching by name:', company);
      const result = await pappersSearch(company, apiKey);
      if (result) {
        siren = result.siren;
        console.log('Found SIREN by name:', siren);
      }
    }

    if (!siren) return ok({ found: false, reason: 'not_found' });

    const data = await pappersEntreprise(siren, apiKey);
    if (!data) return ok({ found: false, reason: 'api_error' });

    const name = data.nom_entreprise || data.denomination || company;
    const finances = data.finances || [];
    console.log('Finances entries:', finances.length, finances.map(f => f.annee || f.year));

    for (const f of finances) {
      const year = parseInt(f.annee || f.year || 0);
      if (year >= minYear) {
        const rn = f.resultat_net !== undefined ? f.resultat_net :
                   f.resultat !== undefined ? f.resultat : null;
        const ca = f.chiffre_affaires !== undefined ? f.chiffre_affaires : null;
        if (rn !== null) {
          console.log('Success:', { name, year, rn, ca });
          return ok({ found: true, name, year, resultatNet: rn, chiffreAffaires: ca, source: 'pappers.fr' });
        }
      }
    }

    if (finances.length > 0) {
      const lastYear = parseInt(finances[0].annee || finances[0].year || 0);
      console.log('Data too old, last year:', lastYear);
      return ok({ found: false, reason: 'too_old', year: lastYear, name });
    }

    console.log('No finances data');
    return ok({ found: false, reason: 'unavailable' });

  } catch (e) {
    console.log('Error:', e.message, e.stack);
    return ok({ found: false, reason: 'error', message: e.message });
  }
};
