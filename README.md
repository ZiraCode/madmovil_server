<div align="center">

# MadMovil API

**The open API behind [MadMovil](https://github.com/ZiraCode/madmovil_web): all of Madrid's public transport, normalized.**<br>
No API keys. No user accounts. No readable personal data.

**[api.madmovil.es](https://api.madmovil.es)**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](#tech-stack)
[![Hono](https://img.shields.io/badge/Hono-4-E36002)](#tech-stack)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#tech-stack)
[![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)](#tech-stack)
[![User accounts](https://img.shields.io/badge/user%20accounts-none-0F7B5F)](#what-it-does-not-do)
[![License: MIT](https://img.shields.io/badge/license-MIT-0F7B5F)](LICENSE)
[![100% AI-written code](https://img.shields.io/badge/code-100%25%20AI--written-8A5CF6)](#development)

**English** · [Español](README.es.md)

</div>

---

## Why MadMovil API

Madrid's transport data is spread across EMT, the CRTM and Renfe, each with
its own API, formats and quirks. This project puts them together behind one
JSON API:

- 🚊 **Five networks, one API** — EMT city buses plus the CRTM's interurban, urban, Metro Ligero and Metro networks, and Renfe Cercanías: unified search and one consistent response shape.
- ⚡ **Real time** — EMT's SAE for bus arrivals; Renfe's official GTFS-RT for Cercanías (delays, cancellations, platform, train position); the CRTM's SAE widget for buses, Metro Ligero and Metro.
- 🗓 **GTFS schedules done right** — next departures by window or full-day boards by date, overnight services (hours ≥24:00), Metro frequency bands, and graceful, clearly-flagged degradation when a feed goes stale.
- 🔒 **No accounts** — anonymous favorites vault: the client encrypts end-to-end and the server only ever stores an opaque blob it cannot read.
- 🪶 **Cheap to run** — everything is cached in KV, route geometries live in R2, and hot artifacts are memoized per isolate.

## What it does

- **Unified search** of lines and stops across all networks in a single request (`GET /search`), with relevance ranking.
- **Stop pages data**: arrivals in real time, today's theoretical departures and nearby transfers (`GET /connections`).
- **Line pages data**: route geometry in GeoJSON, timetables by direction and service pattern, service alerts.
- **A catalog of indexable URLs** so the frontend can build dynamic sitemaps (`GET /catalog`).
- **Favorites sync without accounts**: an encrypted blob per user with TTL, protected by Turnstile at creation.
- Rate limiting per IP and route family, restricted CORS, bot filtering and Cache-Control per response family.

## API

| Family | Routes |
| --- | --- |
| Health | `GET /health` |
| EMT stops | `GET /stops/search`, `GET /stops/nearby`, `GET /stops/detail/:stopId`, `GET /stops/arrivals/:stopId?line=` |
| EMT lines | `GET /lines`, `GET /lines/detail/:lineId`, `GET /lines/search`, `GET /lines/timetable/:lineId`, `GET /lines/route/:label`, `GET /lines/incidents/:label` (or `all`) |
| CRTM networks | `GET /crtm/stops/search`, `GET /crtm/stops/nearby`, `GET /crtm/stops/schedule/:stopCode`, `GET /crtm/stops/arrivals/:stopCode`, `GET /crtm/lines`, `GET /crtm/lines/detail/:id`, `GET /crtm/lines/timetable/:id`, `GET /crtm/lines/route/:routeId`, `GET /crtm/lines/incidents/:id` (or `all`), `GET /crtm/status` |
| Search | `GET /search?q=&lines=&stops=` |
| Transfers | `GET /connections/:source/:stopId?radius=` |
| Catalog | `GET /catalog` |
| Favorites vault | `POST/GET/PUT/DELETE /api/favorites/vault` |
| Admin | `POST /admin/refresh-cache` |

Responses are JSON with the shape `{ status, message, data?, timestamp }`.
Rate limit: 60 requests/minute per IP and route family.

## What it does NOT do

- ❌ No user accounts, registration or personal data
- ❌ No storing favorites in readable form (the vault is opaque by construction)
- ❌ No redistribution of EMT's OpenAPI spec (it is their copyright) — see [data sources](#data-sources-and-attribution)

## Privacy

The API works without accounts. The only thing tied to a user is the favorites
vault, and the server cannot read it: the client encrypts it end-to-end and
the key never leaves the user's devices. See
[madmovil_web](https://github.com/ZiraCode/madmovil_web) for the full picture.

## Data sources and attribution

The data belongs to its owners; this project only aggregates, caches and
serves it with attribution under their terms:

| Source | Used for | Notes |
| --- | --- | --- |
| **EMT Madrid** ([openapi.emtmadrid.es](https://openapi.emtmadrid.es)) | City bus: stops, lines, timetables, real-time arrivals, incidents | Requires your own credentials from EMT's developer portal; their OpenAPI spec is **not** redistributed here |
| **CRTM** | GTFS for interurban, urban, Metro Ligero and Metro (public ArcGIS Online items, CRTM's LDA license); real time for bus/ML/metro and Cercanías incidents (CRTM's official widget) | Attribution included in `/crtm/status` and in every response that uses the widget |
| **Renfe Cercanías** | Official GTFS-RT (CC BY 4.0) and static GTFS via the [NAP](https://nap.transportes.gob.es) (dataset 929) | CC BY 4.0 attribution in real-time responses |

## Requirements

Any HTTP client to use the public API. To run your own instance: **Node 22**,
a Cloudflare account and EMT API credentials.

## Getting started

You need a KV namespace and an R2 bucket (referenced in `wrangler.toml`) and
your own EMT API credentials.

```bash
git clone https://github.com/ZiraCode/madmovil_server.git
cd madmovil_server
npm install
npm run dev      # wrangler dev → http://localhost:8787
npm test         # vitest
npm run lint     # biome
npm run deploy   # wrangler deploy
```

<details>
<summary>Worker secrets</summary>

Set them with `wrangler secret put <NAME>`, or a local `.dev.vars` file:

| Secret | Purpose |
| --- | --- |
| `EMT_CLIENT_ID`, `EMT_PASS_KEY` | EMT API (developer portal) |
| `ADMIN_SECRET` | `POST /admin/refresh-cache` (`X-Admin-Secret` header) |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification when creating a favorites vault |
| `SSR_INTERNAL_KEY` | Rate-limit bypass for the frontend's SSR (`X-SSR-Key` header) |

`NAP_API_KEY` is only used by the Cercanías ingest (script or GitHub
Actions); it is not a worker secret.

</details>

## Tech stack

| | |
|---|---|
| Runtime | Cloudflare Workers + Hono 4 |
| Language | TypeScript (strict) |
| Storage | Workers KV (cache and favorites vault) · R2 (route geometries) |
| Quality | Vitest (unit, library and route tests) · Biome (lint and format) |
| Data pipeline | `scripts/crtm-ingest.mjs` — GTFS ingest to KV + R2 (Node 22, zero dependencies), daily refresh via GitHub Actions |

## Development

MadMovil was built by a small human–AI team:

| Role | Who |
|---|---|
| Project lead | [Ziracode](https://ziracode.github.io) |
| Senior developer | **GLM** (Z.ai) |
| Code review & security audits | **Claude** (Anthropic) |

Ziracode and GLM planned and built the project together, and **100% of the
code was written by GLM**. Claude contributed independent code reviews and
security audits throughout the development.

## License

Released under the [MIT License](LICENSE). The transport data (EMT, CRTM,
Renfe) belongs to its owners and is consumed under their terms.

---

<div align="center">
<sub>Made by <a href="https://ziracode.github.io">Ziracode</a></sub>
</div>
