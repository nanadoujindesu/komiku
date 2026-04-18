/**
 * Komiku Mirror Server
 *
 * Full reverse-proxy mirror for komiku.org that is deployable on
 * Railway, Render, or any VPS.
 *
 * SEO fixes applied:
 *  ✓ Canonical URLs — always self-referencing to mirror domain
 *  ✓ Structured data — JSON-LD rewritten; unparseable blocks removed
 *  ✓ Breadcrumb data — itemListElement URLs rewritten
 *  ✓ Redirect chains — collapsed server-side into single 301
 *  ✓ 404 pages — proper status codes forwarded
 *  ✓ Open Graph / Twitter meta — rewritten
 *  ✓ Image proxying — all CDN images served through /_img/
 *  ✓ Sitemap / robots.txt — URLs rewritten
 *
 * Anti-Cloudflare (equivalent to botasaurus anti-detect):
 *  ✓ Realistic browser headers (TLS fingerprint, sec-ch-ua, etc.)
 *  ✓ Rotating User-Agents
 *  ✓ Persistent cookie jar
 *  ✓ Optional puppeteer-extra stealth browser (USE_BROWSER=true)
 */

require('dotenv').config();

const express = require('express');
const compression = require('compression');
const config = require('./lib/config');
const fetcher = require('./lib/fetcher');
const rewriter = require('./lib/rewriter');
const cache = require('./lib/cache');
const browser = require('./lib/browser');

const app = express();

// --------------- Middleware ---------------

app.set('trust proxy', true);
app.use(compression());

// Parse POST bodies (for proxying form submissions)
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// Detect mirror domain from first request (if not configured)
app.use((req, _res, next) => {
  config.setMirrorDomain(req.hostname);
  next();
});

// Security headers
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer-when-downgrade');
  next();
});

// Request logging
app.use((req, _res, next) => {
  if (config.logLevel === 'debug' || req.path.startsWith('/_img/')) {
    console.log(`[req] ${req.method} ${req.path.substring(0, 120)}`);
  }
  next();
});

// --------------- Utility ---------------

function isHtml(contentType) {
  return /text\/html/i.test(contentType || '');
}
function isCss(contentType) {
  return /text\/css/i.test(contentType || '');
}
function isJs(contentType) {
  return /javascript/i.test(contentType || '');
}
function isXml(contentType) {
  return /xml/i.test(contentType || '');
}

/** Strip unwanted response headers from origin. */
function cleanOriginHeaders(headers) {
  const blocked = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'strict-transport-security',
    'x-frame-options',
    'x-xss-protection',
    'alt-svc',
    'cf-ray',
    'cf-cache-status',
    'server',
    'set-cookie',
    'transfer-encoding',
    'content-encoding',
    'content-length',
  ]);
  const clean = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) clean[k] = v;
  }
  return clean;
}

// --------------- Routes ---------------

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', cache: cache.stats() });
});

// Cache purge (clear all cached data)
app.get('/_purge', (_req, res) => {
  cache.clear();
  res.json({ status: 'ok', message: 'Cache cleared' });
});

// Robots.txt
app.get('/robots.txt', async (_req, res) => {
  try {
    const cacheKey = 'robots.txt';
    const hit = cache.get(cacheKey);
    if (hit) return res.type('text/plain').send(hit);

    const resp = await fetcher.fetchPage(`${config.originUrl}/robots.txt`);
    let body = fetcher.decodeBody(resp);
    body = rewriter.rewriteRobots(body);
    // Ensure mirror sitemap is referenced
    if (!body.includes('Sitemap:')) {
      body += `\nSitemap: ${config.mirrorBaseUrl}/sitemap.xml\n`;
    }
    cache.set(cacheKey, body, config.cacheTTL.assets);
    res.type('text/plain').send(body);
  } catch (err) {
    console.error('[robots.txt]', err.message);
    const fallback = `User-agent: *\nAllow: /\nSitemap: ${config.mirrorBaseUrl}/sitemap.xml\n`;
    res.type('text/plain').send(fallback);
  }
});

// Sitemaps (matches /sitemap.xml, /sitemap-*.xml, /wp-sitemap-*.xml, /wp-sitemap-index.xsl, etc.)
app.get(/^\/(?:wp-)?sitemap[^/]*\.(?:xml|xsl)$/, async (req, res) => {
  try {
    const cacheKey = `sitemap:${req.path}`;
    const hit = cache.get(cacheKey);
    if (hit) return res.type('application/xml').send(hit);

    // Follow redirects — origin may redirect wp-sitemap-*.xml to a different domain
    const result = await fetcher.fetchPageFollowRedirects(`${config.originUrl}${req.path}`);
    const resp = result.response;
    if (resp.status === 404) return res.status(404).type('text/plain').send('Sitemap not found');

    let body = fetcher.decodeBody(resp);
    body = rewriter.rewriteSitemap(body);
    cache.set(cacheKey, body, config.cacheTTL.assets);
    res.type('application/xml').send(body);
  } catch (err) {
    console.error('[sitemap]', err.message);
    res.status(502).send('Failed to fetch sitemap');
  }
});

// ========== Image / asset proxy ==========
app.get('/_img/*', async (req, res) => {
  try {
    const fullPath = req.params[0]; // "cdn.komiku.co.id/path/to/img.jpg"
    if (!fullPath) return res.status(400).send('Bad request');

    const firstSlash = fullPath.indexOf('/');
    if (firstSlash < 1) return res.status(400).send('Invalid image path');

    const hostname = fullPath.substring(0, firstSlash).toLowerCase();
    const imgPath = fullPath.substring(firstSlash);

    // SECURITY: only proxy whitelisted domains to prevent SSRF
    if (!rewriter.isImageDomain(hostname)) {
      return res.status(403).send('Domain not allowed');
    }

    const cacheKey = `img:${fullPath}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      res.set('Content-Type', hit.contentType);
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(hit.data);
    }

    const imageUrl = `https://${hostname}${imgPath}`;
    let resp;

    // Try regular fetch first
    resp = await fetcher.fetchImage(imageUrl);

    // If Cloudflare-blocked and browser mode enabled, retry with stealth browser
    if (resp.status === 403 && browser.isAvailable()) {
      console.log(`[img] CF blocked ${hostname}, retrying with browser…`);
      try {
        const browserResp = await browser.fetchWithBrowser(imageUrl, { binary: true });
        resp = { data: browserResp.data, status: browserResp.status, headers: browserResp.headers };
      } catch (e) {
        console.warn('[img] Browser fetch also failed:', e.message);
      }
    }

    if (resp.status !== 200) {
      return res.status(resp.status).send('Image fetch failed');
    }

    const contentType = resp.headers['content-type'] || 'application/octet-stream';
    const data = Buffer.from(resp.data);

    cache.set(cacheKey, { data, contentType }, config.cacheTTL.images);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(data);
  } catch (err) {
    console.error('[img]', err.message);
    res.status(502).send('Image proxy error');
  }
});

// ========== Main proxy (catch-all) ==========
app.all('*', async (req, res) => {
  try {
    const path = req.path;
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const originUrl = `${config.originUrl}${path}${qs}`;
    const cacheKey = `page:${req.method}:${path}${qs}`;

    // Only cache GET requests
    if (req.method === 'GET') {
      const hit = cache.get(cacheKey);
      if (hit) {
        res.set(hit.headers || {});
        return res.status(hit.status).send(hit.data);
      }
    }

    let resp;
    if (req.method === 'POST') {
      const body =
        typeof req.body === 'object' && !Buffer.isBuffer(req.body)
          ? new URLSearchParams(req.body).toString()
          : req.body;
      resp = await fetcher.postPage(originUrl, body, req.headers['content-type']);
    } else {
      // Follow redirects and collapse chains
      const result = await fetcher.fetchPageFollowRedirects(originUrl);
      resp = result.response;

      // If origin redirected, emit a single redirect to the mirror-equivalent path
      if (result.wasRedirected) {
        try {
          const finalParsed = new URL(result.finalUrl);
          const finalHost = finalParsed.hostname.toLowerCase();
          // Internal redirect → redirect client to mirror path
          if (
            finalHost === config.originHost ||
            finalHost === 'www.' + config.originBaseDomain
          ) {
            const mirrorTarget = finalParsed.pathname + finalParsed.search;
            return res.redirect(301, mirrorTarget);
          }
          // External redirect → pass through
          return res.redirect(301, result.finalUrl);
        } catch {
          // Can't parse final URL, just serve content
        }
      }
    }

    const contentType = resp.headers['content-type'] || 'application/octet-stream';
    const status = resp.status;
    const safeHeaders = cleanOriginHeaders(resp.headers);

    // --- HTML ---
    if (isHtml(contentType)) {
      const raw = fetcher.decodeBody(resp);
      let html;

      // If Cloudflare challenge page and browser mode available, retry
      if (
        (raw.includes('challenge-platform') || raw.includes('cf-browser-verification')) &&
        browser.isAvailable()
      ) {
        console.log('[proxy] CF challenge detected, retrying with browser…');
        try {
          const br = await browser.fetchWithBrowser(originUrl);
          html = rewriter.rewriteHtml(br.data, path);
        } catch (e) {
          console.warn('[proxy] Browser fallback failed:', e.message);
          html = rewriter.rewriteHtml(raw, path);
        }
      } else {
        html = rewriter.rewriteHtml(raw, path);
      }

      const resHeaders = { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' };
      if (req.method === 'GET') {
        cache.set(cacheKey, { data: html, status, headers: resHeaders }, config.cacheTTL.html);
      }
      res.set(resHeaders);
      return res.status(status).send(html);
    }

    // --- CSS ---
    if (isCss(contentType)) {
      const raw = fetcher.decodeBody(resp);
      const css = rewriter.rewriteCss(raw);
      const resHeaders = {
        ...safeHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      };
      if (req.method === 'GET') {
        cache.set(cacheKey, { data: css, status, headers: resHeaders }, config.cacheTTL.assets);
      }
      res.set(resHeaders);
      return res.status(status).send(css);
    }

    // --- JavaScript ---
    if (isJs(contentType)) {
      const raw = fetcher.decodeBody(resp);
      const js = rewriter.rewriteJs(raw);
      const resHeaders = {
        ...safeHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      };
      if (req.method === 'GET') {
        cache.set(cacheKey, { data: js, status, headers: resHeaders }, config.cacheTTL.assets);
      }
      res.set(resHeaders);
      return res.status(status).send(js);
    }

    // --- XML (RSS, Atom, sitemaps served through non-standard paths) ---
    if (isXml(contentType)) {
      const raw = fetcher.decodeBody(resp);
      const xml = rewriter.rewriteSitemap(raw); // same logic works for RSS/Atom too
      const resHeaders = {
        ...safeHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      };
      if (req.method === 'GET') {
        cache.set(cacheKey, { data: xml, status, headers: resHeaders }, config.cacheTTL.assets);
      }
      res.set(resHeaders);
      return res.status(status).send(xml);
    }

    // --- Binary / other (JS, fonts, images on same domain, etc.) ---
    const data = Buffer.from(resp.data);
    const resHeaders = {
      ...safeHeaders,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    };
    if (req.method === 'GET' && data.length < 5 * 1024 * 1024) {
      // Only cache assets < 5 MB
      cache.set(cacheKey, { data, status, headers: resHeaders }, config.cacheTTL.assets);
    }
    res.set(resHeaders);
    return res.status(status).send(data);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(502).send('Bad Gateway — upstream error');
  }
});

// --------------- Start ---------------

async function start() {
  // Optionally init stealth browser
  if (config.useBrowser) {
    await browser.init();
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n🚀  Komiku Mirror running on port ${config.port}`);
    console.log(`    Origin : ${config.originUrl}`);
    console.log(`    Mirror : ${config.mirrorBaseUrl || '(auto-detect from request)'}`);
    console.log(`    Browser: ${browser.isAvailable() ? 'ON (stealth)' : 'OFF'}`);
    console.log(`    Cache  : max ${config.cacheMaxItems} items\n`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down…`);
    await browser.close();
    process.exit(0);
  });
}
