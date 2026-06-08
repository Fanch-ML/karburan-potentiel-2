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

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const ok = (data) => ({
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  try {
    const body = JSON.parse(event.body || '{}');
    const siren = (body.siren || '').replace(/[^0-9]/g, '');
    const cy = new Date().getFullYear();
    const minYear = cy - 2;
    const apiKey = process.env.PAPPERS_API_KEY;

    if (!siren || siren.length !== 9) return ok({ found: false, reason: 'no_siren' });
    if (!apiKey) return ok({ found: false, reason: 'no_key' });

    console.log('Fetching Pappers for SIREN:', siren);

    const resp = await get(
      'api.pappers.fr',
      `/v2/entreprise?siren=${siren}&api_token=${apiKey}&extrait_financier=true&finances=true`
    );

    console.log('Pappers status:', resp.status);

    if (resp.status !== 200) {
      console.log('Pappers error body:', resp.body.substring(0, 200));
      return ok({ found: false, reason: 'api_error' });
    }

    const data = JSON.parse(resp.body);
    const name = data.nom_entreprise || data.denomination || '';

    // finances is an array sorted by year desc
    const finances = data.finances || [];
    console.log('Finances count:', finances.length);

    for (const f of finances) {
      const year = parseInt(f.annee || f.year || 0);
      if (year >= minYear) {
        const rn = f.resultat_net !== undefined ? f.resultat_net :
                   f.resultatNet !== undefined ? f.resultatNet : null;
        const ca = f.chiffre_affaires !== undefined ? f.chiffre_affaires :
                   f.chiffreAffaires !== undefined ? f.chiffreAffaires : null;
        if (rn !== null) {
          console.log('Found:', { name, year, rn, ca });
          return ok({ found: true, name, year, resultatNet: rn, chiffreAffaires: ca, source: 'pappers.fr' });
        }
      }
    }

    // Data found but too old
    if (finances.length > 0) {
      const lastYear = parseInt(finances[0].annee || finances[0].year || 0);
      return ok({ found: false, reason: 'too_old', year: lastYear, name });
    }

    return ok({ found: false, reason: 'unavailable' });

  } catch (e) {
    console.log('Error:', e.message);
    return ok({ found: false, reason: 'error', message: e.message });
  }
};
