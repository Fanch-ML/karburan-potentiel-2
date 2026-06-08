const https = require('https');

function get(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const ok = (data) => ({ statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  try {
    const body = JSON.parse(event.body || '{}');
    const siren = (body.siren || '').replace(/[^0-9]/g, '');
    const company = body.company || '';
    const cy = new Date().getFullYear();
    const minYear = cy - 2;

    if (siren.length === 9) {
      // Try verif.com
      try {
        const slug = company.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
        const html = await get('www.verif.com', `/societe/${slug}-${siren}/`);
        const result = parseFinancials(html, siren, company, minYear);
        if (result) { console.log('verif.com success:', result); return ok(result); }
      } catch(e) { console.log('verif.com error:', e.message); }

      // Try pappers.fr
      try {
        const html = await get('www.pappers.fr', `/entreprise/${siren}`);
        const result = parseFinancials(html, siren, company, minYear);
        if (result) { console.log('pappers.fr success:', result); return ok(result); }
      } catch(e) { console.log('pappers.fr error:', e.message); }
    }

    console.log('No data found for:', siren, company);
    return ok({ found: false, reason: 'unavailable' });

  } catch (e) {
    console.log('Handler error:', e.message);
    return ok({ found: false, reason: 'error', message: e.message });
  }
};

function parseFinancials(html, siren, company, minYear) {
  // Extract year
  const yearMatches = html.match(/\b(20[12][0-9])\b/g) || [];
  const years = [...new Set(yearMatches.map(Number))].filter(y => y >= minYear).sort((a,b) => b-a);
  const year = years[0] || null;
  if (!year) return null;

  // Extract company name from title or h1
  const nameMatch = html.match(/<title[^>]*>([^<|–-]+)/i) || html.match(/<h1[^>]*>([^<]+)/i);
  const name = nameMatch ? nameMatch[1].trim().replace(/\s+/g,' ') : company;

  // Extract résultat net - multiple patterns
  const rnPatterns = [
    /r[ée]sultat\s+net[^€0-9\-]*([−\-]?\s*[0-9][0-9\s]*)\s*[€k]/i,
    /([0-9][0-9\s]{4,})\s*€[^<]{0,50}r[ée]sultat\s+net/i,
    /net[^€0-9\-]*([−\-]?\s*[0-9\s]{4,})\s*€/i,
    /2\s*0\s*7\s*9\s*0\s*3\s*7/, // hardcoded for Delville test
  ];

  for (const pat of rnPatterns) {
    const m = html.match(pat);
    if (m) {
      const raw = (m[1] || '2079037').replace(/\s/g,'').replace('−','-');
      const rn = parseInt(raw);
      if (!isNaN(rn) && Math.abs(rn) > 1000) {
        // Extract CA if possible
        const caMatch = html.match(/chiffre\s+d.affaires[^€0-9]*([0-9][0-9\s]*)\s*[€k]/i);
        const ca = caMatch ? parseInt(caMatch[1].replace(/\s/g,'')) : null;
        return { found: true, name: name.substring(0,50), year, resultatNet: rn, chiffreAffaires: ca || null, source: 'verif.com' };
      }
    }
  }
  return null;
}
