/**
 * HTML / CSS / XML rewriter.
 *
 * Handles every SEO issue reported in Google Search Console:
 *  1. Canonical — always self-referencing to mirror domain
 *  2. Structured data (JSON-LD) — URLs rewritten; malformed blocks removed
 *  3. Breadcrumb structured data — itemListElement URLs rewritten
 *  4. Open Graph / Twitter meta — rewritten
 *  5. Image/asset URLs — proxied through /_img/
 *  6. Inline styles & <style> blocks — url() rewritten
 *  7. Inline <script> — origin domain strings rewritten
 *  8. Sitemap XML — <loc> rewritten
 */

const cheerio = require('cheerio');
const config = require('./config');

// ==================== URL helpers ====================

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true when `hostname` is in the IMAGE_DOMAINS whitelist
 * or is a subdomain of the origin.
 */
function isImageDomain(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  if (config.imageDomains.some((d) => lower === d || lower.endsWith('.' + d))) return true;
  // Any subdomain of the origin base domain (but NOT the origin itself)
  if (lower !== config.originHost && lower.endsWith('.' + config.originBaseDomain)) return true;
  return false;
}

/**
 * Rewrite a single URL from origin → mirror.
 *  • Same-host → https://mirror/path
 *  • Subdomain of origin → https://mirror/path (proxied through main proxy)
 *  • Image CDN  → https://mirror/_img/cdn-host/path
 *  • External   → untouched
 */
function rewriteUrl(url) {
  if (!url || typeof url !== 'string') return url;
  url = url.trim();

  // Protocol-relative
  if (url.startsWith('//')) url = 'https:' + url;

  // Only touch absolute HTTP(S) URLs
  if (!/^https?:\/\//i.test(url)) return url;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Main origin domain (with or without www)
    if (host === config.originHost || host === 'www.' + config.originBaseDomain) {
      return config.mirrorBaseUrl + parsed.pathname + parsed.search + parsed.hash;
    }

    // Origin alias domains (e.g. komikid.org, secure.komikid.org)
    if (config.originAliases.some((alias) => host === alias || host.endsWith('.' + alias))) {
      return config.mirrorBaseUrl + parsed.pathname + parsed.search + parsed.hash;
    }

    // Image / CDN domain → proxy route
    if (isImageDomain(host)) {
      return config.mirrorBaseUrl + '/_img/' + host + parsed.pathname + parsed.search;
    }

    // Any other subdomain of the origin base domain → proxy through mirror
    if (host.endsWith('.' + config.originBaseDomain)) {
      return config.mirrorBaseUrl + '/_img/' + host + parsed.pathname + parsed.search;
    }
  } catch { /* malformed URL → return as-is */ }

  return url;
}

/** Rewrite `srcset` / `data-srcset` attribute values. */
function rewriteSrcset(srcset) {
  if (!srcset) return srcset;
  return srcset
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts[0]) parts[0] = rewriteUrl(parts[0]);
      return parts.join(' ');
    })
    .join(', ');
}

// ==================== CSS rewriting ====================

function rewriteCss(css) {
  if (!css) return css;
  // Rewrite url() references
  css = css.replace(
    /url\s*\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi,
    (_match, quote, href) => `url(${quote}${rewriteUrl(href)}${quote})`,
  );
  return css;
}

// ==================== JSON-LD / structured data ====================

/**
 * Recursively rewrite every URL-valued field in a JSON-LD object.
 * This fixes breadcrumb, article, website, organization schemas, etc.
 */
function rewriteJsonLd(data) {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(rewriteJsonLd);
  if (typeof data === 'string') {
    return /^https?:\/\//i.test(data) ? rewriteUrl(data) : data;
  }
  if (typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = rewriteJsonLd(v);
    }
    return out;
  }
  return data;
}

// ==================== HTML rewriting ====================

/**
 * Full HTML rewrite.
 * @param {string} html  Raw HTML from origin
 * @param {string} requestPath  The path on the mirror (e.g. /manga/one-piece/)
 * @returns {string} Rewritten HTML
 */
function rewriteHtml(html, requestPath) {
  if (!html) return html;

  const $ = cheerio.load(html, { decodeEntities: false });

  // ---------- 1. CANONICAL ----------
  // Remove ALL existing canonicals → add exactly ONE
  $('link[rel="canonical"]').remove();
  const canonicalUrl = config.mirrorBaseUrl + requestPath;
  $('head').append(`\n<link rel="canonical" href="${canonicalUrl}" />`);

  // ---------- 2. META TAGS ----------
  $('meta[property="og:url"]').attr('content', canonicalUrl);
  $('meta[name="twitter:url"]').attr('content', canonicalUrl);

  // Rewrite other OG / twitter image URLs
  $(
    'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]',
  ).each((_i, el) => {
    const c = $(el).attr('content');
    if (c) $(el).attr('content', rewriteUrl(c));
  });

  // ---------- 3. STRUCTURED DATA (JSON-LD) ----------
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).html();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const fixed = rewriteJsonLd(data);
      $(el).html(JSON.stringify(fixed));
    } catch {
      // Unparseable structured data → remove to fix GSC errors
      console.warn('[rewriter] Removed unparseable JSON-LD block');
      $(el).remove();
    }
  });

  // ---------- 3b. MICRODATA (itemprop="url" etc.) ----------
  $('meta[itemprop="url"], link[itemprop="url"]').each((_i, el) => {
    const c = $(el).attr('content') || $(el).attr('href');
    if (c) {
      if ($(el).attr('content')) $(el).attr('content', rewriteUrl(c));
      if ($(el).attr('href')) $(el).attr('href', rewriteUrl(c));
    }
  });
  // itemprop="image", "thumbnailUrl", "contentUrl" etc.
  $('[itemprop="image"], [itemprop="thumbnailUrl"], [itemprop="contentUrl"]').each((_i, el) => {
    const $el = $(el);
    for (const attr of ['content', 'href', 'src']) {
      const v = $el.attr(attr);
      if (v) $el.attr(attr, rewriteUrl(v));
    }
  });

  // ---------- 4. LINK / A TAGS ----------
  $('link[href]').each((_i, el) => {
    const h = $(el).attr('href');
    if (h) $(el).attr('href', rewriteUrl(h));
  });
  $('a[href]').each((_i, el) => {
    const h = $(el).attr('href');
    if (h) $(el).attr('href', rewriteUrl(h));
  });

  // ---------- 5. IMAGES ----------
  $('img, source, video, audio').each((_i, el) => {
    const $el = $(el);
    ['src', 'data-src', 'data-lazy-src', 'data-original', 'poster', 'data-bg'].forEach((attr) => {
      const v = $el.attr(attr);
      if (v) $el.attr(attr, rewriteUrl(v));
    });
    ['srcset', 'data-srcset'].forEach((attr) => {
      const v = $el.attr(attr);
      if (v) $el.attr(attr, rewriteSrcset(v));
    });
  });

  // ---------- 5b. ANY attribute containing origin/CDN URLs ----------
  // Catches data-*, value*, and any custom attributes with absolute URLs pointing to origin
  const aliasDomainPatterns = config.originAliases.map((a) => `([a-z0-9-]+\\.)?${escapeRegex(a)}`).join('|');
  const originUrlRe = new RegExp(`^https?://(([a-z0-9-]+\\.)?${escapeRegex(config.originBaseDomain)}|${config.imageDomains.map(escapeRegex).join('|')}${aliasDomainPatterns ? '|' + aliasDomainPatterns : ''})`, 'i');
  $('*').each((_i, el) => {
    const attribs = el.attribs || {};
    for (const [attr, val] of Object.entries(attribs)) {
      // Skip standard well-known non-URL attrs
      if (['class', 'id', 'style', 'type', 'name', 'lang', 'dir', 'title', 'alt', 'role', 'tabindex', 'aria-label', 'aria-hidden', 'xmlns', 'viewBox', 'fill', 'd', 'placeholder'].includes(attr)) continue;
      if (typeof val === 'string' && originUrlRe.test(val)) {
        $(el).attr(attr, rewriteUrl(val));
      }
    }
  });

  // ---------- 6. SCRIPTS ----------
  $('script[src]').each((_i, el) => {
    const s = $(el).attr('src');
    if (s) $(el).attr('src', rewriteUrl(s));
  });

  // ---------- 7. FORMS ----------
  $('form[action]').each((_i, el) => {
    const a = $(el).attr('action');
    if (a) $(el).attr('action', rewriteUrl(a));
  });

  // ---------- 8. IFRAMES ----------
  $('iframe[src]').each((_i, el) => {
    const s = $(el).attr('src');
    if (s) $(el).attr('src', rewriteUrl(s));
  });

  // ---------- 9. INLINE STYLES ----------
  $('[style]').each((_i, el) => {
    const st = $(el).attr('style');
    if (st && st.includes('url(')) {
      $(el).attr('style', rewriteCss(st));
    }
  });
  $('style').each((_i, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css));
  });

  // ---------- 10. INLINE SCRIPTS containing origin URLs ----------
  // Build regexes for all origin-related domains
  // Must handle BOTH normal URLs (https://x.org) AND JSON-escaped URLs (https:\/\/x.org)
  const slashVariant = (str) => str.replace(/\//g, '(?:\\/|\\\\/)');  // match / or \/

  const originPatterns = [
    { re: new RegExp(slashVariant(escapeRegex(config.originProtocol + '://' + config.originHost)), 'g'), rep: config.mirrorBaseUrl },
    { re: new RegExp(slashVariant(escapeRegex(config.originProtocol + '://www.' + config.originBaseDomain)), 'g'), rep: config.mirrorBaseUrl },
    // Catch any subdomain of the origin (api.komiku.org, data.komiku.org, etc.)
    { re: new RegExp(`https?:(?:\\/|\\\\/){2}([a-z0-9-]+\\.)?${escapeRegex(config.originBaseDomain)}`, 'gi'), rep: config.mirrorBaseUrl },
  ];
  // Origin alias domains (e.g. komikid.org, secure.komikid.org)
  const aliasPatterns = config.originAliases.map((alias) => ({
    re: new RegExp(`https?:(?:\\/|\\\\/){2}([a-z0-9-]+\\.)?${escapeRegex(alias)}`, 'gi'),
    rep: config.mirrorBaseUrl,
  }));
  // CDN domains — also handle escaped slashes
  const cdnPatterns = config.imageDomains.map((domain) => ({
    re: new RegExp(slashVariant(escapeRegex('https://' + domain)), 'g'),
    rep: config.mirrorBaseUrl + '/_img/' + domain,
  }));

  $('script:not([src])').each((_i, el) => {
    let code = $(el).html();
    if (!code) return;
    let changed = false;
    for (const { re, rep } of cdnPatterns) {
      // CDN domains first (more specific) before generic origin catch-all
      if (re.test(code)) {
        re.lastIndex = 0;
        code = code.replace(re, rep);
        changed = true;
      }
    }
    for (const { re, rep } of originPatterns) {
      if (re.test(code)) {
        re.lastIndex = 0;
        code = code.replace(re, rep);
        changed = true;
      }
    }
    for (const { re, rep } of aliasPatterns) {
      if (re.test(code)) {
        re.lastIndex = 0;
        code = code.replace(re, rep);
        changed = true;
      }
    }
    if (changed) $(el).html(code);
  });

  // ---------- 11. MISC: rewrite placeholder text containing origin domain ----------
  $('input[placeholder]').each((_i, el) => {
    const p = $(el).attr('placeholder');
    if (p && p.includes(config.originBaseDomain)) {
      $(el).attr('placeholder', p.replace(config.originBaseDomain, config.mirrorDomain));
    }
  });

  // ---------- 12. REMOVE GOOGLE LOGIN BUTTON ----------
  $('#btnMainLogin').remove();

  // ---------- 13. HREFLANG (if missing) ----------
  if ($('link[rel="alternate"][hreflang]').length === 0) {
    $('head').append(`\n<link rel="alternate" href="${canonicalUrl}" hreflang="id" />`);
  } else {
    // Rewrite existing hreflang URLs
    $('link[rel="alternate"][hreflang]').each((_i, el) => {
      const h = $(el).attr('href');
      if (h) $(el).attr('href', rewriteUrl(h));
    });
  }

  return $.html();
}

// ==================== JavaScript rewriting ====================

/**
 * Rewrite origin domain references inside JS files.
 * Handles strings like "https://komiku.org", "https:\/\/komiku.org" (JSON-escaped), etc.
 */
function rewriteJs(js) {
  if (!js) return js;
  let out = js;

  // CDN domains first (more specific) — handle both normal and escaped slashes
  for (const domain of config.imageDomains) {
    out = out.replace(
      new RegExp(`https?:(?:\\/|\\\\/)(?:\\/|\\\\/)${escapeRegex(domain)}`, 'gi'),
      config.mirrorBaseUrl + '/_img/' + domain,
    );
  }

  // Any subdomain of origin — handle both normal and escaped slashes
  out = out.replace(
    new RegExp(`https?:(?:\\/|\\\\/)(?:\\/|\\\\/)([a-z0-9-]+\\.)?${escapeRegex(config.originBaseDomain)}`, 'gi'),
    config.mirrorBaseUrl,
  );
  // Origin alias domains — handle both normal and escaped slashes
  for (const alias of config.originAliases) {
    out = out.replace(
      new RegExp(`https?:(?:\/|\\/)(?:\/|\\/)([a-z0-9-]+\\.)?${escapeRegex(alias)}`, 'gi'),
      config.mirrorBaseUrl,
    );
  }
  return out;
}

// ==================== Sitemap XML rewriting ====================

function rewriteSitemap(xml) {
  if (!xml) return xml;
  // Replace origin host (with and without www)
  let out = xml.replace(
    new RegExp(`https?://(www\\.)?${escapeRegex(config.originBaseDomain)}`, 'gi'),
    config.mirrorBaseUrl,
  );
  // Replace origin alias domains (e.g. komikid.org, secure.komikid.org)
  for (const alias of config.originAliases) {
    out = out.replace(
      new RegExp(`https?://([a-z0-9-]+\\.)?${escapeRegex(alias)}`, 'gi'),
      config.mirrorBaseUrl,
    );
  }
  // Replace CDN domains in <image:loc> etc.
  for (const domain of config.imageDomains) {
    out = out.replace(
      new RegExp(`https?://${escapeRegex(domain)}`, 'gi'),
      config.mirrorBaseUrl + '/_img/' + domain,
    );
  }
  return out;
}

// ==================== Robots.txt rewriting ====================

function rewriteRobots(txt) {
  if (!txt) return txt;
  let out = txt.replace(
    new RegExp(`https?://(www\\.)?${escapeRegex(config.originBaseDomain)}`, 'gi'),
    config.mirrorBaseUrl,
  );
  // Origin alias domains
  for (const alias of config.originAliases) {
    out = out.replace(
      new RegExp(`https?://([a-z0-9-]+\\.)?${escapeRegex(alias)}`, 'gi'),
      config.mirrorBaseUrl,
    );
  }
  return out;
}

module.exports = {
  rewriteUrl,
  rewriteSrcset,
  rewriteCss,
  rewriteJs,
  rewriteJsonLd,
  rewriteHtml,
  rewriteSitemap,
  rewriteRobots,
  isImageDomain,
};
