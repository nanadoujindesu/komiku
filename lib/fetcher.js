/**
 * HTTP client with anti-detection headers, cookie jar, retry logic,
 * and request deduplication.
 *
 * Anti-detection strategy mirrors what botasaurus does:
 *   • Realistic browser TLS fingerprint headers
 *   • Rotating User-Agents
 *   • Persistent cookie jar (tough-cookie)
 *   • Proper Referer for cross-origin image requests
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const config = require('./config');

// --------------- Cookie jar ---------------
const jar = new CookieJar();

async function getCookies(url) {
  try {
    return await jar.getCookieString(url);
  } catch {
    return '';
  }
}
async function storeCookies(url, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of list) {
    try {
      await jar.setCookie(raw, url);
    } catch { /* ignore invalid cookies */ }
  }
}

// --------------- User-Agent rotation ---------------
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];
let uaIndex = 0;
function nextUA() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

// --------------- Header presets ---------------
function documentHeaders(ua, cookie) {
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    DNT: '1',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

/**
 * Derive the best Referer for a given image URL.
 * CDN subdomains should use their root domain as referer.
 */
function getImageReferer(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const host = parsed.hostname.toLowerCase();
    // For subdomains of komiku.co.id (e.g. cdn.komiku.co.id)
    if (host.endsWith('.komiku.co.id') || host === 'komiku.co.id') {
      return 'https://komiku.co.id/';
    }
    // For subdomains of komiku.org (e.g. i.komiku.org, thumbnail.komiku.org)
    if (host.endsWith('.komiku.org') || host === 'komiku.org') {
      return 'https://komiku.org/';
    }
    // For subdomains of komikid.org (e.g. update.komikid.org)
    if (host.endsWith('.komikid.org') || host === 'komikid.org') {
      return 'https://komikid.org/';
    }
    // For WordPress/Jetpack CDN (i0-i3.wp.com)
    if (host.endsWith('.wp.com')) {
      return 'https://komiku.co.id/';
    }
  } catch { /* ignore */ }
  return `${config.originProtocol}://${config.originHost}/`;
}

function imageHeaders(ua, cookie, imageUrl) {
  const referer = imageUrl ? getImageReferer(imageUrl) : `${config.originProtocol}://${config.originHost}/`;
  return {
    'User-Agent': ua,
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: referer,
    Origin: referer.replace(/\/$/, ''),
    DNT: '1',
    Connection: 'keep-alive',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function assetHeaders(ua, cookie) {
  return {
    'User-Agent': ua,
    Accept: '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: `${config.originProtocol}://${config.originHost}/`,
    DNT: '1',
    Connection: 'keep-alive',
    'Sec-Fetch-Dest': 'script',
    'Sec-Fetch-Mode': 'no-cors',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

// --------------- Request deduplication ---------------
const inflight = new Map();

function deduplicated(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// --------------- Core fetch helpers ---------------

/**
 * Fetch a page/document. Does NOT follow redirects automatically so the
 * caller can decide how to handle them (important for SEO).
 */
async function fetchPage(url) {
  return deduplicated(`page:${url}`, async () => {
    const ua = nextUA();
    const cookie = await getCookies(url);
    const resp = await axios({
      method: 'GET',
      url,
      headers: documentHeaders(ua, cookie),
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      decompress: true,
      timeout: 30000,
    });
    await storeCookies(url, resp.headers['set-cookie']);
    return resp;
  });
}

/**
 * Follow redirect chain and return final response + metadata.
 * Collapses multiple hops into one redirect for the client.
 */
async function fetchPageFollowRedirects(url, maxHops = 10) {
  let current = url;
  let hops = 0;
  let resp;
  while (hops < maxHops) {
    resp = await fetchPage(current);
    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      current = new URL(resp.headers.location, current).href;
      hops++;
    } else {
      break;
    }
  }
  return { response: resp, finalUrl: current, wasRedirected: hops > 0 };
}

/**
 * Alternate referers to try when the primary one gets 403.
 */
const FALLBACK_REFERERS = [
  'https://komiku.co.id/',
  'https://komiku.org/',
  'https://www.google.com/',
];

/**
 * Fetch a binary resource (image, font, etc.).
 * Follows redirects automatically.
 * Retries with alternate Referer/Origin if 403 is returned.
 */
async function fetchImage(url) {
  return deduplicated(`img:${url}`, async () => {
    const ua = nextUA();
    const cookie = await getCookies(url);

    // First attempt with smart referer
    const resp = await axios({
      method: 'GET',
      url,
      headers: imageHeaders(ua, cookie, url),
      maxRedirects: 10,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      decompress: true,
      timeout: 30000,
    });
    await storeCookies(url, resp.headers['set-cookie']);

    if (resp.status !== 403) return resp;

    // Retry with fallback referers
    const primaryReferer = getImageReferer(url);
    for (const referer of FALLBACK_REFERERS) {
      if (referer === primaryReferer) continue;
      console.log(`[img] 403 for ${url}, retrying with Referer: ${referer}`);
      try {
        const retryResp = await axios({
          method: 'GET',
          url,
          headers: {
            ...imageHeaders(ua, cookie, url),
            Referer: referer,
            Origin: referer.replace(/\/$/, ''),
          },
          maxRedirects: 10,
          validateStatus: () => true,
          responseType: 'arraybuffer',
          decompress: true,
          timeout: 30000,
        });
        await storeCookies(url, retryResp.headers['set-cookie']);
        if (retryResp.status !== 403) return retryResp;
      } catch (e) {
        console.warn(`[img] Retry failed for ${url}:`, e.message);
      }
    }

    // Last resort: try with no Referer at all
    try {
      const noRefResp = await axios({
        method: 'GET',
        url,
        headers: {
          'User-Agent': ua,
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        maxRedirects: 10,
        validateStatus: () => true,
        responseType: 'arraybuffer',
        decompress: true,
        timeout: 30000,
      });
      if (noRefResp.status !== 403) return noRefResp;
    } catch { /* ignore */ }

    return resp; // return original 403 response
  });
}

/**
 * Fetch a static asset (CSS, JS, font, etc.).
 */
async function fetchAsset(url) {
  return deduplicated(`asset:${url}`, async () => {
    const ua = nextUA();
    const cookie = await getCookies(url);
    const resp = await axios({
      method: 'GET',
      url,
      headers: assetHeaders(ua, cookie),
      maxRedirects: 10,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      decompress: true,
      timeout: 30000,
    });
    await storeCookies(url, resp.headers['set-cookie']);
    return resp;
  });
}

/**
 * POST helper (for search forms, etc.).
 */
async function postPage(url, body, contentType) {
  const ua = nextUA();
  const cookie = await getCookies(url);
  const resp = await axios({
    method: 'POST',
    url,
    data: body,
    headers: {
      ...documentHeaders(ua, cookie),
      'Content-Type': contentType || 'application/x-www-form-urlencoded',
    },
    maxRedirects: 0,
    validateStatus: () => true,
    responseType: 'arraybuffer',
    decompress: true,
    timeout: 30000,
  });
  await storeCookies(url, resp.headers['set-cookie']);
  return resp;
}

// --------------- Response helpers ---------------

/** Decode arraybuffer to string using the response's charset. */
function decodeBody(resp) {
  const ct = resp.headers['content-type'] || '';
  const match = ct.match(/charset=([^\s;]+)/i);
  const charset = match ? match[1].replace(/['"]/g, '') : 'utf-8';
  try {
    return new TextDecoder(charset).decode(resp.data);
  } catch {
    return new TextDecoder('utf-8').decode(resp.data);
  }
}

/** Check if content-type is text-based. */
function isTextContent(resp) {
  const ct = (resp.headers['content-type'] || '').toLowerCase();
  return (
    ct.includes('text/') ||
    ct.includes('application/json') ||
    ct.includes('application/xml') ||
    ct.includes('application/xhtml') ||
    ct.includes('javascript') ||
    ct.includes('application/rss') ||
    ct.includes('application/atom')
  );
}

module.exports = {
  fetchPage,
  fetchPageFollowRedirects,
  fetchImage,
  fetchAsset,
  postPage,
  decodeBody,
  isTextContent,
};
