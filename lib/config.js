require('dotenv').config();

const originHost = process.env.ORIGIN_HOST || 'komiku.org';

// Derive the "base" domain (strip leading www.)
const originBaseDomain = originHost.replace(/^www\./, '');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,

  // Origin
  originHost,
  originBaseDomain,
  originProtocol: process.env.ORIGIN_PROTOCOL || 'https',
  get originUrl() {
    return `${this.originProtocol}://${this.originHost}`;
  },

  // Mirror
  mirrorDomain: process.env.MIRROR_DOMAIN || null, // detected from request if unset
  mirrorProtocol: process.env.MIRROR_PROTOCOL || 'https',
  get mirrorBaseUrl() {
    if (!this.mirrorDomain) return ''; // relative URLs until domain detected
    return `${this.mirrorProtocol}://${this.mirrorDomain}`;
  },

  // Image / CDN domains to proxy through /_img/
  imageDomains: (process.env.IMAGE_DOMAINS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),

  // Additional domains whose URLs should be rewritten to the mirror
  // (e.g. komikid.org when origin is komiku.org but backend serves from secure.komikid.org)
  originAliases: (process.env.ORIGIN_ALIASES || 'komikid.org')
    .split(',')
    .map((d) => d.trim().replace(/^www\./, ''))
    .filter(Boolean),

  // Cache
  cacheTTL: {
    html: parseInt(process.env.CACHE_TTL_HTML, 10) || 300,
    assets: parseInt(process.env.CACHE_TTL_ASSETS, 10) || 86400,
    images: parseInt(process.env.CACHE_TTL_IMAGES, 10) || 604800,
  },
  cacheMaxItems: parseInt(process.env.CACHE_MAX_ITEMS, 10) || 2000,

  // Browser mode
  useBrowser: process.env.USE_BROWSER === 'true',

  logLevel: process.env.LOG_LEVEL || 'info',

  /** Set mirrorDomain at runtime (first-request detection). */
  setMirrorDomain(domain) {
    if (!this.mirrorDomain) {
      this.mirrorDomain = domain;
      console.log(`[config] Mirror domain detected: ${domain}`);
    }
  },
};

module.exports = config;
