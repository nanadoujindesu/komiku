# Komiku Mirror

Full reverse-proxy mirror for **komiku.org** — optimized for SEO indexing and deployable on Railway, Render, or any VPS.

## SEO Fixes (Google Search Console)

| Masalah GSC | Solusi |
|---|---|
| **Duplikat — Google memilih versi kanonis berbeda** | Setiap halaman memiliki `<link rel="canonical">` yang mengarah ke domain mirror |
| **Tidak ditemukan (404)** | Status code dari origin diteruskan apa adanya; redirect chain di-collapse |
| **Halaman dengan pengalihan** | Redirect chain server-side di-collapse jadi 1 redirect 301 ke mirror |
| **Data terstruktur Breadcrumb** | Semua URL di JSON-LD (termasuk `itemListElement`) di-rewrite ke mirror |
| **Data terstruktur tidak dapat diurai** | JSON-LD yang tidak valid di-hapus otomatis |

## Fitur Lengkap

- **Full HTML rewriting** — canonical, og:url, og:image, twitter meta, JSON-LD, breadcrumbs, microdata, hreflang, inline scripts, inline CSS
- **Image proxy** (`/_img/`) — proxy gambar dari CDN subdomain (thumbnail.komiku.org, cdn.komiku.co.id, dll) dengan header anti-block
- **Anti-Cloudflare** — User-Agent rotation, browser-like headers, cookie jar, opsional puppeteer-stealth (setara botasaurus anti-detect)
- **Caching** — LRU cache HTML (5 min), assets (24 jam), gambar (7 hari)
- **Request deduplication** — request ke URL yang sama secara bersamaan di-deduplicate
- **Sitemap & robots.txt** — URL di-rewrite otomatis
- **POST form support** — form search dan lainnya berfungsi

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy dan edit env
cp .env.example .env
# Edit MIRROR_DOMAIN sesuai domain mirror kamu

# 3. Jalankan
npm start
```

## Deploy

### Railway
1. Push repo ke GitHub
2. Connect di [railway.app](https://railway.app)
3. Set environment variables (terutama `MIRROR_DOMAIN`)
4. Deploy otomatis via `railway.json`

### Render
1. Push repo ke GitHub
2. Connect di [render.com](https://render.com)
3. Config otomatis via `render.yaml`
4. Set `MIRROR_DOMAIN` di environment

### VPS (Docker)
```bash
# Build & run
docker compose up -d

# Atau tanpa browser mode (lebih ringan):
docker build -f Dockerfile.light -t komiku-mirror .
docker run -d -p 3000:3000 --env-file .env komiku-mirror
```

### VPS (Direct)
```bash
npm install
cp .env.example .env
# Edit .env
node server.js
# Gunakan PM2 untuk production: pm2 start server.js
```

## Browser Mode (Anti-Cloudflare Lanjutan)

Jika gambar CDN di-block Cloudflare, aktifkan browser mode yang menggunakan puppeteer-extra-plugin-stealth (setara botasaurus anti-detect):

```bash
# Install optional dependencies
npm install

# Set di .env
USE_BROWSER=true

# Gunakan Dockerfile (bukan Dockerfile.light) agar Chromium tersedia
```

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port server |
| `MIRROR_DOMAIN` | auto-detect | Domain mirror (WAJIB untuk SEO) |
| `MIRROR_PROTOCOL` | `https` | Protocol mirror |
| `ORIGIN_HOST` | `komiku.org` | Host origin |
| `IMAGE_DOMAINS` | (lihat .env.example) | Domain CDN gambar |
| `CACHE_TTL_HTML` | `300` | Cache HTML (detik) |
| `CACHE_TTL_IMAGES` | `604800` | Cache gambar (detik) |
| `USE_BROWSER` | `false` | Aktifkan puppeteer stealth |

## Struktur

```
server.js           # Entry point + Express routing
lib/
  config.js         # Konfigurasi dari env vars
  fetcher.js        # HTTP client + anti-detection headers + cookie jar
  rewriter.js       # HTML/CSS/XML/JSON-LD rewriting + SEO fixes
  cache.js          # LRU cache wrapper
  browser.js        # Opsional: puppeteer-stealth browser
Dockerfile          # Full image (dengan Chromium)
Dockerfile.light    # Ringan (tanpa Chromium)
docker-compose.yml  # Docker Compose untuk VPS
railway.json        # Railway config
render.yaml         # Render config
```