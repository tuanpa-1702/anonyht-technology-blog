// Profile social links (Facebook, GitHub, LinkedIn, X, YouTube, website),
// stored as JSON in users.social_links. Shown on a profile only to visitors
// who are signed in (server/routes/users.js) and to the owner.
//
// Every value is normalised to an https URL; the named networks must point at
// their own domain, so a "GitHub" link cannot be a phishing page. Anything
// that does not pass is dropped rather than stored.
const NETWORKS = {
  facebook: ['facebook.com', 'fb.com', 'm.facebook.com'],
  github: ['github.com'],
  linkedin: ['linkedin.com'],
  x: ['x.com', 'twitter.com'],
  youtube: ['youtube.com', 'youtu.be'],
  website: null, // any https host
};
const MAX_LEN = 200;

function hostMatches(host, domains) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

function cleanLink(network, value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  if (v.length > MAX_LEN) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const domains = NETWORKS[network];
  if (domains && !hostMatches(url.hostname, domains)) return null;
  if (!domains && !url.hostname.includes('.')) return null;
  url.protocol = 'https:';
  return url.toString();
}

// Input object -> { links, error }. Unknown keys are ignored.
function cleanSocialLinks(input) {
  const links = {};
  if (!input || typeof input !== 'object') return { links };
  for (const network of Object.keys(NETWORKS)) {
    if (!(network in input)) continue;
    const cleaned = cleanLink(network, input[network]);
    if (cleaned === null) {
      const label = { facebook: 'Facebook', github: 'GitHub', linkedin: 'LinkedIn', x: 'X', youtube: 'YouTube', website: 'Website' }[network];
      return { error: `Liên kết ${label} không hợp lệ.` };
    }
    if (cleaned) links[network] = cleaned;
  }
  return { links };
}

function parseSocialLinks(json) {
  try {
    const obj = JSON.parse(json || '{}');
    const out = {};
    for (const network of Object.keys(NETWORKS)) {
      if (typeof obj[network] === 'string' && obj[network]) out[network] = obj[network];
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = { NETWORKS, cleanSocialLinks, parseSocialLinks };
