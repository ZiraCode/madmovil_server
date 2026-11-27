<div align="center">

# API de MadMovil

**La API abierta de [MadMovil](https://github.com/ZiraCode/madmovil_web): todo el transporte público de Madrid, normalizado.**<br>
Sin API keys. Sin cuentas de usuario. Sin datos personales legibles.

**[api.madmovil.es](https://api.madmovil.es)**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](#tecnologías)
[![Hono](https://img.shields.io/badge/Hono-4-E36002)](#tecnologías)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#tecnologías)
[![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)](#tecnologías)
[![Sin cuentas](https://img.shields.io/badge/cuentas-ninguna-0F7B5F)](#qué-no-hace)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-0F7B5F)](LICENSE)
[![100 % código escrito por IA](https://img.shields.io/badge/c%C3%B3digo-100%25%20escrito%20por%20IA-8A5CF6)](#desarrollo)

[English](README.md) · **Español**

</div>

---

## Por qué la API de MadMovil

Los datos del transporte de Madrid están repartidos entre la EMT, el CRTM y
Renfe, cada uno con su API, sus formatos y sus rarezas. Este proyecto los
reúne detrás de una única API JSON:

- 🚊 **Cinco redes, una API** — bus urbano de la EMT más interurbanos, urbanos, Metro Ligero y Metro del CRTM, y Cercanías de Renfe: búsqueda unificada y un formato de respuesta consistente.
- ⚡ **Tiempo real** — SAE de la EMT para las llegadas de bus; GTFS-RT oficial de Renfe para Cercanías (retrasos, cancelaciones, vía, posición del tren); widget SAE del CRTM para bus, Metro Ligero y metro.
- 🗓 **Horarios GTFS bien hechos** — próximas salidas por ventana o tablón completo por fecha, servicios de madrugada (horas ≥24:00), bandas de frecuencia del metro y degradación marcada y distinguible cuando un feed caduca.
- 🔒 **Sin cuentas** — vault de favoritos anónimo: el cliente cifra de extremo a extremo y el servidor solo guarda un blob opaco que no puede leer.
- 🪶 **Barata de mantener** — todo cacheado en KV, geometrías de recorrido en R2 y artefactos calientes memoizados por isolate.

## Qué hace

- **Búsqueda unificada** de líneas y paradas de todas las redes en una sola petición (`GET /search`), con ranking por relevancia.
- **Datos para fichas de parada**: llegadas en tiempo real, salidas teóricas de hoy y transbordos cercanos (`GET /connections`).
- **Datos para fichas de línea**: geometría del recorrido en GeoJSON, horarios por dirección y patrón de servicio, incidencias.
- **Catálogo de URLs indexables** para que el frontend construya sitemaps dinámicos (`GET /catalog`).
- **Sincronización de favoritos sin cuentas**: un blob cifrado por usuario con TTL, protegido con Turnstile en la creación.
- Rate limiting por IP y familia de rutas, CORS restringido, filtro de bots y Cache-Control por familia de respuesta.

## API

| Familia | Rutas |
| --- | --- |
| Salud | `GET /health` |
| Paradas EMT | `GET /stops/search`, `GET /stops/nearby`, `GET /stops/detail/:stopId`, `GET /stops/arrivals/:stopId?line=` |
| Líneas EMT | `GET /lines`, `GET /lines/detail/:lineId`, `GET /lines/search`, `GET /lines/timetable/:lineId`, `GET /lines/route/:label`, `GET /lines/incidents/:label` (o `all`) |
| Redes CRTM | `GET /crtm/stops/search`, `GET /crtm/stops/nearby`, `GET /crtm/stops/schedule/:stopCode`, `GET /crtm/stops/arrivals/:stopCode`, `GET /crtm/lines`, `GET /crtm/lines/detail/:id`, `GET /crtm/lines/timetable/:id`, `GET /crtm/lines/route/:routeId`, `GET /crtm/lines/incidents/:id` (o `all`), `GET /crtm/status` |
| Buscador | `GET /search?q=&lines=&stops=` |
| Transbordos | `GET /connections/:source/:stopId?radius=` |
| Catálogo | `GET /catalog` |
| Vault de favoritos | `POST/GET/PUT/DELETE /api/favorites/vault` |
| Administración | `POST /admin/refresh-cache` |

Las respuestas son JSON con el formato `{ status, message, data?, timestamp }`.
Límite: 60 peticiones/minuto por IP y familia de rutas.

## Qué NO hace

- ❌ Sin cuentas de usuario, registro ni datos personales
- ❌ Sin guardar favoritos en forma legible (el vault es opaco por construcción)
- ❌ Sin redistribuir la spec OpenAPI de la EMT (es su copyright) — ver [fuentes de datos](#fuentes-de-datos-y-atribución)

## Privacidad

La API funciona sin cuentas. Lo único ligado a un usuario es el vault de
favoritos, y el servidor no puede leerlo: el cliente lo cifra de extremo a
extremo y la clave nunca sale de los dispositivos del usuario. Ver
[madmovil_web](https://github.com/ZiraCode/madmovil_web) para el panorama
completo.

## Fuentes de datos y atribución

Los datos pertenecen a sus titulares; este proyecto solo los agrega, cachea y
sirve con atribución conforme a sus términos:

| Fuente | Uso | Notas |
| --- | --- | --- |
| **EMT Madrid** ([openapi.emtmadrid.es](https://openapi.emtmadrid.es)) | Bus urbano: paradas, líneas, horarios, llegadas en tiempo real, incidencias | Requiere credenciales propias del portal de desarrolladores de la EMT; su spec OpenAPI **no** se redistribuye aquí |
| **CRTM** | GTFS de interurbanos, urbanos, Metro Ligero y Metro (items públicos de ArcGIS Online, licencia LDA del CRTM); tiempo real de bus/ML/metro e incidencias de Cercanías (widget oficial del CRTM) | Atribución incluida en `/crtm/status` y en las respuestas que usan el widget |
| **Renfe Cercanías** | GTFS-RT oficial (CC BY 4.0) y GTFS estático vía el [NAP](https://nap.transportes.gob.es) (dataset 929) | Atribución CC BY 4.0 en las respuestas de tiempo real |

## Requisitos

Cualquier cliente HTTP para usar la API pública. Para tu propia instancia:
**Node 22**, una cuenta de Cloudflare y credenciales de la API de la EMT.

## Puesta en marcha

Necesitas un namespace KV y un bucket R2 (referenciados en `wrangler.toml`) y
credenciales propias de la API de la EMT.

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
<summary>Secrets del worker</summary>

Se configuran con `wrangler secret put <NOMBRE>` o con un fichero local
`.dev.vars`:

| Secret | Para |
| --- | --- |
| `EMT_CLIENT_ID`, `EMT_PASS_KEY` | API de la EMT (portal de desarrolladores) |
| `ADMIN_SECRET` | `POST /admin/refresh-cache` (header `X-Admin-Secret`) |
| `TURNSTILE_SECRET_KEY` | Verificación server-side de Turnstile al crear un vault de favoritos |
| `SSR_INTERNAL_KEY` | Bypass del rate limit para el SSR del frontend (header `X-SSR-Key`) |

`NAP_API_KEY` solo la usa la ingesta de Cercanías (script o GitHub Actions);
no es un secret del worker.

</details>

## Tecnologías

| | |
|---|---|
| Entorno | Cloudflare Workers + Hono 4 |
| Lenguaje | TypeScript (strict) |
| Almacenamiento | Workers KV (caché y vault de favoritos) · R2 (geometrías de recorridos) |
| Calidad | Vitest (tests unitarios, de librería y de rutas) · Biome (lint y formato) |
| Pipeline de datos | `scripts/crtm-ingest.mjs` — ingesta GTFS a KV + R2 (Node 22, cero dependencias), refresco diario con GitHub Actions |

## Desarrollo

MadMovil lo ha construido un pequeño equipo de humano e IA:

| Rol | Quién |
|---|---|
| Líder de proyecto | [Ziracode](https://ziracode.github.io) |
| Programador senior | **GLM** (Z.ai) |
| Revisión de código y auditorías | **Claude** (Anthropic) |

Ziracode y GLM planificaron y construyeron el proyecto juntos, y el **100 %
del código lo escribió GLM**. Claude aportó revisiones de código y auditorías
de seguridad independientes durante el desarrollo.

## Licencia

Publicada bajo la [licencia MIT](LICENSE). Los datos de transporte (EMT, CRTM,
Renfe) pertenecen a sus titulares y se consumen conforme a sus términos.

---

<div align="center">
<sub>Hecha por <a href="https://ziracode.github.io">Ziracode</a></sub>
</div>
