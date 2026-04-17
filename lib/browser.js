/**
 * Optional browser-based fetcher using puppeteer-extra + stealth plugin.
 *
 * This is the Node.js equivalent of botasaurus's anti-detect browser:
 *   • Stealth plugin patches all common bot-detection vectors
 *   • Human-like viewport, user-agent, WebGL, etc.
 *   • Persistent browser instance (reused across requests)
 *
 * Enable by setting USE_BROWSER=true in .env.
 * Requires: puppeteer, puppeteer-extra, puppeteer-extra-plugin-stealth
 * Also requires Chromium installed (see Dockerfile).
 */

let browser = null;
let puppeteer = null;
let available = false;

async function init() {
  if (browser) return true;
  try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--single-process',
        '--no-zygote',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    available = true;
    console.log('[browser] Stealth browser launched');
    return true;
  } catch (err) {
    console.warn('[browser] Could not launch stealth browser:', err.message);
    available = false;
    return false;
  }
}

/**
 * Fetch a URL using the stealth browser. Returns { data, status, headers }.
 * data is a Buffer (binary) or string (HTML).
 */
async function fetchWithBrowser(url, { binary = false } = {}) {
  if (!browser) throw new Error('Browser not initialized');

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    if (binary) {
      // For images: intercept the response and grab the buffer
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const buffer = await resp.buffer();
      return {
        data: buffer,
        status: resp.status(),
        headers: resp.headers(),
      };
    }

    // For HTML pages
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    return {
      data: html,
      status: resp.status(),
      headers: resp.headers(),
    };
  } finally {
    await page.close();
  }
}

async function close() {
  if (browser) {
    await browser.close();
    browser = null;
    available = false;
  }
}

function isAvailable() {
  return available;
}

module.exports = { init, fetchWithBrowser, close, isAvailable };
