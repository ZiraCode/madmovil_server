#!/usr/bin/env node
import zlib from 'node:zlib';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEEDS = [
  {
    network: 'interurban',
    itemId: '885399f83408473c8d815e40c5e702b7',
    zipName: 'interurban.zip',
    altZipNames: ['interurbanos.zip'],
    posteService: 'M8_Red/FeatureServer/1',
    postePage: 16000,
  },
  {
    network: 'urban',
    itemId: '357e63c2904f43aeb5d8a267a64346d8',
    zipName: 'urban.zip',
    altZipNames: ['urbanos.zip'],
    posteService: 'M9_Red/FeatureServer/1',
    postePage: 10000,
  },
  {
    // Metro Ligero (M10): sin capa Postes → municipio por parada de bus más cercana.
    // stop_code NO es único entre redes → código público derivado del stop_id (par_10_5 → 10_5)
    network: 'ml',
    itemId: 'aaed26cc0ff64b0c947ac0bc3e033196',
    zipName: 'ml.zip',
    altZipNames: ['google_transit_M10.zip', 'M10.zip'],
    namespaceStopIds: true,
    muniStrategy: 'nn',
  },
  {
    // Metro (M4): mismo patrón que ml (códigos 4_<n>, municipio NN). Usa frequencies.txt:
    // trips plantilla + bandas (se expanden en query time, no se materializan).
    // El feed está stale (calendario caducado 2026-05-27): el gate de frescura lo toma en
    // modo catálogo (líneas/paradas/geometría SIN horarios) hasta que el CRTM lo repubblique
    // — entonces el detector `modified` reescribe los docs completos solo.
    network: 'metro',
    itemId: '5c7f2951962540d69ffe8f640d94c246',
    zipName: 'metro.zip',
    altZipNames: ['google_transit_M4.zip', 'M4.zip'],
    namespaceStopIds: true,
    muniStrategy: 'nn',
  },
  {
    // Cercanías Renfe Madrid (núcleo 10T) desde el NAP (Punto de Acceso Nacional de datos
    // del transporte). El zip trae TODA España (848 rutas): normalizeCercaniasFiles filtra
    // las rutas 10T*, agrupa por route_short_name (cada dirección es un route_id propio en
    // este feed) y sintetiza routeIds 10T_<label> con direction_id derivado de terminales.
    // stop_id es numérico de 5 dígitos y colisionaría con los stop_code de bus → prefijo r_.
    // Feed de ventana móvil: calendario ~30 días republicado a diario (~04:00 UTC, antes
    // del cron de las 05:30) → margen de frescura propio (15 d), no el estándar de 30.
    network: 'cercanias',
    source: 'nap',
    datasetId: 929,
    routeIdPrefix: '10T',
    stopCodePrefix: 'r_',
    zipName: 'cercanias.zip',
    altZipNames: ['RENFE_CERCA.zip'],
    muniStrategy: 'nn',
    freshnessMarginDays: 15,
    destFromTripTerminal: true,
    directionStops: 'longest',
    // Guardar trip_id original (tid) en los docs: el GTFS-RT de Renfe (gtfsrt.renfe.com,
    // CC BY 4.0) identifica los trips con el MISMO trip_id ('10'+día+letra de día de la
    // ventana móvil + trenId + línea, p. ej. 1041L19789C5, y SPECIAL_10_* los refuerzos)
    // → join exacto con el tiempo real en /crtm/arrivals sin heurísticas
    rtTripIds: true,
  },
];

const ARCGIS_ITEM = (itemId) =>
  `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`;
const ARCGIS_DATA = (itemId) => `https://www.arcgis.com/sharing/rest/content/items/${itemId}/data`;
const POSTE_QUERY = (service) =>
  `https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/${service}/query`;
const MUNICIPIOS_URL =
  'https://datos.comunidad.madrid/dataset/0781c37e-bc64-4143-8029-18865bedbc3d/resource/17feaf92-8749-44e4-a81c-6abee0df52e4/download/municipio_comunidad_madrid.json';

const KV_KEYS = {
  STOPS_ALL: 'crtm:stops:all',
  LINES_ALL: 'crtm:lines:all',
  LINE_PREFIX: 'crtm:line:',
  META: 'crtm:meta',
};

const LIMITS = {
  MIN_STOPS: 7000,
  MIN_ROUTES: { interurban: 300, urban: 90, ml: 3, metro: 12, cercanias: 10 },
  MIN_TRIPS: 55000,
  MIN_STOP_TIME_ROWS: 1_400_000,
  MIN_MUNI_COVERAGE: 0.9,
  MAX_VALUE_BYTES: 24 * 1024 * 1024,
  MAX_POSTE_PAGES: 20,
  MAX_FREQ_DEPARTURES: 200_000, // techo de salidas expandibles de frequencies (real M4: ~21,6k)
};

// Gate de frescura: un feed cuyo calendario termina antes de hoy+FRESHNESS_MARGIN_DAYS
// entra en modo catálogo (líneas/paradas/geometría sin horarios) — nunca se sirven
// horarios caducados, pero el catálogo de red sigue visible
const FRESHNESS_MARGIN_DAYS = 30;

// Municipio por vecino más cercano (feeds sin capa Postes): umbral máximo en metros
const NN_MUNI_MAX_M = 1000;

// Geometría de recorridos: los shapes van a R2 (no KV) porque son documentos
// potencialmente grandes y R2 no tiene cuota de escrituras tan ajustada.
export const SHAPES = {
  OBJECT_PREFIX: 'line/', // clave R2: line/<routeId>.json
  GAP_SPLIT_M: 500, // salto entre puntos consecutivos que corta la polilínea en otro tramo
  TOLERANCE_START_M: 1.5, // tolerancia inicial Douglas-Peucker (metros)
  TOLERANCE_MAX_M: 48, // tope si hay que degradar para caber en el presupuesto de tamaño
  MAX_JSON_BYTES: 150 * 1024, // objetivo máx por línea; si se pasa, se sube la tolerancia
  MAX_JSON_BYTES_HARD: 1024 * 1024, // límite duro: validación fallida
  PRECISION: 5, // decimales de coordenadas (~1 m)
};

// ---------- CSV ----------

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function* iterCsvRows(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const cp1252 = new TextDecoder('windows-1252');
  let start = 0;
  let first = true;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    let lineBuf = buf.subarray(start, end);
    if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
      lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
    }
    let text;
    try {
      text = utf8.decode(lineBuf);
    } catch {
      text = cp1252.decode(lineBuf);
    }
    if (first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    yield text;
    start = end + 1;
  }
}

export function parseGtfsTable(buf) {
  if (!buf) return [];
  const rows = iterCsvRows(buf);
  const header = parseCsvRow(rows.next().value).map((h) => h.trim());
  const out = [];
  for (const line of rows) {
    if (line === '') continue;
    const fields = parseCsvRow(line);
    const row = {};
    // trim de claves y valores: algunos feeds (Renfe/NAP) rellenan a ancho fijo con
    // espacios, incluso cabeceras ("end_date   ") y campos intermedios (trip_id)
    for (let i = 0; i < header.length; i++) row[header[i]] = (fields[i] ?? '').trim();
    out.push(row);
  }
  return out;
}

function parseCsvRow(line) {
  return parseCsvLine(line);
}

// ---------- Frescura de feeds (gate por calendario) ----------

function ymdToUtcMs(ymd) {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

export function ymdPlusDays(ymd, days) {
  return new Date(ymdToUtcMs(ymd) + days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

export function madridTodayYmd(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .replaceAll('-', '');
}

/**
 * Última fecha de servicio conocida del feed: max(end_date de calendar.txt, fechas de calendar_dates)
 * @returns {'YYYYMMDD' | null} null si el feed no declara calendario ni excepciones
 */
export function feedCalendarEnd(files) {
  let max = null;
  for (const row of parseGtfsTable(files['calendar.txt'])) {
    if (row.end_date && row.end_date > max) max = row.end_date;
  }
  for (const row of parseGtfsTable(files['calendar_dates.txt'])) {
    if (row.date && row.date > max) max = row.date;
  }
  return max;
}

/**
 * Feed caducado (o a punto de caducar): su horizonte de calendario queda a menos de
 * `marginDays` (default FRESHNESS_MARGIN_DAYS; los feeds de ventana móvil como cercanías
 * declaran uno propio más corto porque su calendario NUNCA supera hoy+30 por diseño).
 * Un feed así se publica en modo catálogo (líneas/paradas sin horarios) — la run NO aborta.
 */
export function feedIsStale(files, todayYmd, marginDays = FRESHNESS_MARGIN_DAYS) {
  const end = feedCalendarEnd(files);
  if (!end) return true;
  return end < ymdPlusDays(todayYmd, marginDays);
}

export function parseHms(value) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (min > 59 || s > 59 || h > 47) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * frequencies.txt GTFS (metro): bandas {from,to,headway} agrupadas por trip plantilla.
 * exact_times se ignora (la expansión en query time es la misma). Filas inválidas
 * (tiempos no parseables, to <= from, headway < 1) se descuentan y cuentan en `invalid`.
 */
export function parseFrequencies(buf) {
  const byTrip = new Map();
  let invalid = 0;
  for (const row of parseGtfsTable(buf)) {
    const from = parseHms(row.start_time);
    const to = parseHms(row.end_time);
    const headway = Number(row.headway_secs);
    if (from === null || to === null || to <= from || !Number.isFinite(headway) || headway < 1) {
      invalid++;
      continue;
    }
    let bands = byTrip.get(row.trip_id);
    if (!bands) {
      bands = [];
      byTrip.set(row.trip_id, bands);
    }
    bands.push({ from, to, headway });
  }
  return { byTrip, invalid };
}

export function normalizeZone(raw) {
  const z = (raw ?? '').trim();
  if (!z) return null;
  const m = /^zona\s+(.+)$/i.exec(z);
  return (m ? m[1] : z).trim().toUpperCase();
}

// route_color/route_text_color GTFS: RRGGBB sin # (se publica en mayúsculas; formato inválido → null)
export function normalizeColor(raw) {
  const c = (raw ?? '').trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(c) ? c : null;
}

// route_url: el GTFS CRTM publica la ficha del sitio antiguo (www.crtm.es/<routeId>.aspx,
// 404 desde la migración del portal a Umbraco 2026); la ficha actual es la misma ruta sin
// extensión. Solo se reescribe ese patrón exacto; cualquier otra URL pasa tal cual.
export function normalizeRouteUrl(raw) {
  const url = /^https?:\/\//i.test(raw ?? '') ? raw.trim() : null;
  if (!url) return null;
  return url.replace(/^(https?:\/\/(?:www\.)?crtm\.es\/[^/?#]+?)\.aspx(?=[?#]|$)/i, '$1');
}

// Código público de parada: los feeds de bus usan stop_code tal cual; M4/M10 namespacelan
// por red porque stop_code colisiona entre redes (par_10_5 → 10_5); cercanías usa stop_id
// con prefijo r_ (stop_id numérico de Renfe colisionaría con los stop_code de bus)
export function publicStopCode(feed, row) {
  if (feed.stopCodePrefix) return `${feed.stopCodePrefix}${(row.stop_id ?? '').trim()}`;
  if (!feed.namespaceStopIds) return row.stop_code;
  const id = row.stop_id ?? '';
  return id.startsWith('par_') ? id.slice(4) : id;
}

// Prefijos de tipo de día que trip_short_name puede llevar delante del label en bus
// (sondeo 2026-08-30: lv/Lv, ls, df, sdf, vsvf, vsdfvf, dyf). En ml/metro el short_name es
// el nombre del corredor completo, sin label → nunca produce dest. Un prefijo nuevo
// desconocido deja el trip sin dest y hace subir counts.dest.sinLabel (alarma de deriva).
export const TRIP_DEST_PREFIXES = new Set(['lv', 'ls', 'df', 'sdf', 'vsvf', 'vsdfvf', 'dyf']);

const TRIP_DEST_MAX_CHARS = 100;

// "[prefijo] <label> <destino> [(variante)]" → destino limpio del widget CRTM.
// Conservador: solo se limpia si el label aparece como token justo tras el prefijo opcional;
// el paréntesis de variante ("por Valdemoro", "Directo"...) se conserva, es lo canónico.
// Cualquier otro caso (sin label, label en otra posición, vacío tras limpiar) → null.
export function cleanTripDest(rawShortName, label) {
  const s = (rawShortName ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const tokens = s.split(' ');
  let i = 0;
  if (tokens.length > 1 && TRIP_DEST_PREFIXES.has(tokens[0].toLowerCase())) i = 1;
  if (i >= tokens.length || tokens[i].toUpperCase() !== String(label ?? '').toUpperCase())
    return null;
  const dest = tokens
    .slice(i + 1)
    .join(' ')
    .trim()
    .slice(0, TRIP_DEST_MAX_CHARS);
  return dest || null;
}

export function compareLabels(a, b) {
  const re = /(\d+)|(\D+)/g;
  const chunksA = String(a).match(re) ?? [];
  const chunksB = String(b).match(re) ?? [];
  const n = Math.min(chunksA.length, chunksB.length);
  for (let i = 0; i < n; i++) {
    const ca = chunksA[i];
    const cb = chunksB[i];
    const digitA = ca[0] >= '0' && ca[0] <= '9';
    const digitB = cb[0] >= '0' && cb[0] <= '9';
    if (digitA && digitB) {
      const diff = Number(ca) - Number(cb);
      if (diff !== 0) return diff;
    } else {
      const cmp = ca.localeCompare(cb, 'es');
      if (cmp !== 0) return cmp;
    }
  }
  return chunksA.length - chunksB.length;
}

// ---------- Cercanías Renfe (NAP): filtrado por núcleo + agrupación por línea ----------

// El GTFS de Renfe publica TODA España y una dirección por route_id (10T0001C1 ida,
// 10T0002C1 vuelta, sin direction_id). Además rellena los campos a ancho fijo con espacios
// y codifica en windows-1252 (iterCsvRows ya hace el fallback de encoding por línea).
// normalizeCercaniasFiles filtra el núcleo (prefijo 10T), reagrupa los route_ids por
// route_short_name en un routeId sintético 10T_<label> y deriva direction_id de las
// terminales reales de los trips (última parada; fallback por primera parada).

export function collapseSpaces(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

// "Principe Pio      -Aeropuerto-T4" → "Principe Pio - Aeropuerto-T4": el guion separador
// va pegado a un lado (padding de ancho fijo) y NO debe tocarse el guion interno
// ("Aeropuerto-T4"). Solo se normaliza cuando hay espacio en algún lado del guion.
export function cleanCercaniasLineName(raw) {
  return collapseSpaces(raw)
    .replace(/\s+[-–]\s*/g, ' - ')
    .replace(/\s*[-–]\s+/g, ' - ')
    .trim();
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableBuffer(header, rows) {
  const lines = [header, ...rows.map((r) => r.map(csvField).join(','))];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * Escaneo único de stop_times: filtra las filas de los trips pedidos y devuelve por trip
 * la primera/última parada (por stop_sequence) y el conjunto de paradas usadas.
 * Las filas conservadas se reemiten tal cual (solo se re-codifican a UTF-8).
 */
export function filterCercaniasStopTimes(buf, wantedTripIds) {
  const kept = [];
  const terms = new Map();
  let rowsTotal = 0;
  let rowsKept = 0;
  if (!buf) return { buf, terms, rowsTotal, rowsKept };
  const rows = iterCsvRows(buf);
  const header = rows.next().value;
  for (const line of rows) {
    if (line === '') continue;
    rowsTotal++;
    const f = parseCsvLine(line);
    if (f.length < 5 || !wantedTripIds.has(f[0].trim())) continue;
    kept.push(line);
    rowsKept++;
    const stopId = f[3].trim();
    const seq = Number.parseInt(f[4], 10);
    const e = terms.get(f[0].trim());
    if (!e) {
      terms.set(f[0].trim(), {
        first: stopId,
        last: stopId,
        minSeq: seq,
        maxSeq: seq,
        stops: new Set([stopId]),
      });
    } else {
      e.stops.add(stopId);
      if (seq < e.minSeq) {
        e.minSeq = seq;
        e.first = stopId;
      }
      if (seq >= e.maxSeq) {
        e.maxSeq = seq;
        e.last = stopId;
      }
    }
  }
  const out = Buffer.from(`${header}\n${kept.join('\n')}\n`, 'utf8');
  return { buf: out, terms, rowsTotal, rowsKept };
}

function modeCounter(counter) {
  let best = null;
  let bestCount = -1;
  for (const [value, count] of counter) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Dirección de cada trip: dir 0 = hacia la terminal con más llegadas de la línea (T0),
 * dir 1 = hacia la segunda (T1). Variantes que acaban fuera de {T0,T1} (refuerzos
 * cortos) toman la dirección por su primera parada: si sale de T0 va hacia el lado T1.
 */
function cercaniasDirectionOf(line, term) {
  const [t0, t1] = line.terminals;
  if (term.last === t0) return 0;
  if (t1 !== undefined && term.last === t1) return 1;
  if (term.first === t0) return 1;
  if (t1 !== undefined && term.first === t1) return 0;
  return 0;
}

export function normalizeCercaniasFiles(files, options = {}) {
  const prefix = options.routeIdPrefix ?? '10T';

  const routeRows = parseGtfsTable(files['routes.txt']).filter(
    (r) => (r.route_id ?? '').trim().startsWith(prefix) && (r.route_short_name ?? '').trim() !== '',
  );
  const labelByRoute = new Map();
  for (const r of routeRows) labelByRoute.set(r.route_id.trim(), r.route_short_name.trim());

  const tripRows = [];
  for (const row of parseGtfsTable(files['trips.txt'])) {
    if (labelByRoute.has((row.route_id ?? '').trim())) tripRows.push(row);
  }

  const {
    buf: stopTimesBuf,
    terms,
    rowsTotal,
    rowsKept,
  } = filterCercaniasStopTimes(files['stop_times.txt'], new Set(tripRows.map((t) => t.trip_id)));
  const usedTrips = tripRows.filter((t) => terms.has(t.trip_id));

  const lines = new Map();
  const routeMaxStops = new Map();
  for (const t of usedTrips) {
    const label = labelByRoute.get(t.route_id.trim());
    let line = lines.get(label);
    if (!line) {
      line = { label, trips: [], nameCandidates: [], colors: new Map(), textColors: new Map() };
      lines.set(label, line);
    }
    line.trips.push(t);
    const stops = terms.get(t.trip_id).stops.size;
    if (stops > (routeMaxStops.get(t.route_id) ?? 0)) routeMaxStops.set(t.route_id, stops);
  }
  for (const r of routeRows) {
    const line = lines.get(labelByRoute.get(r.route_id.trim()));
    if (!line) continue;
    const color = normalizeColor(r.route_color);
    if (color) line.colors.set(color, (line.colors.get(color) ?? 0) + 1);
    const textColor = normalizeColor(r.route_text_color);
    if (textColor) line.textColors.set(textColor, (line.textColors.get(textColor) ?? 0) + 1);
    // nombre de línea = long_name de la variante MÁS LARGA con servicio (el corredor
    // completo; los refuerzos cortos darían nombres parciales); desempates estables
    const name = cleanCercaniasLineName(r.route_long_name);
    const stops = routeMaxStops.get(r.route_id.trim()) ?? 0;
    if (name && stops > 0) {
      line.nameCandidates.push({
        name,
        stops,
        twoPart: name.split(/\s+[-–]\s+/).filter(Boolean).length === 2 ? 1 : 0,
        routeId: r.route_id.trim(),
      });
    }
  }
  for (const line of lines.values()) {
    line.name =
      line.nameCandidates.sort(
        (a, b) =>
          b.stops - a.stops ||
          b.twoPart - a.twoPart ||
          b.name.length - a.name.length ||
          (a.routeId < b.routeId ? -1 : 1),
      )[0]?.name ?? '';
    // terminales T0/T1 por número de llegadas (empate: stop_id menor, determinista)
    const arrivals = new Map();
    for (const t of line.trips) {
      const last = terms.get(t.trip_id).last;
      arrivals.set(last, (arrivals.get(last) ?? 0) + 1);
    }
    line.terminals = [...arrivals.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 2)
      .map(([id]) => id);
  }

  const lineRouteId = (label) => `${prefix}_${label}`;
  const ordered = [...lines.values()].sort((a, b) => compareLabels(a.label, b.label));

  const routesOut = ordered.map((line) => [
    lineRouteId(line.label),
    '',
    line.label,
    line.name,
    '',
    '2',
    '',
    modeCounter(line.colors) ?? '',
    modeCounter(line.textColors) ?? '',
  ]);
  const tripsOut = usedTrips.map((t) => {
    const line = lines.get(labelByRoute.get(t.route_id.trim()));
    return [
      lineRouteId(line.label),
      t.service_id,
      t.trip_id,
      collapseSpaces(t.trip_headsign ?? ''),
      String(cercaniasDirectionOf(line, terms.get(t.trip_id))),
      (t.shape_id ?? '').trim(),
    ];
  });

  const filesOut = {
    ...files,
    'routes.txt': tableBuffer(
      'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color',
      routesOut,
    ),
    'trips.txt': tableBuffer(
      'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id',
      tripsOut,
    ),
    'stop_times.txt': stopTimesBuf,
    ...(options.version
      ? {
          'feed_info.txt': tableBuffer(
            'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version',
            [
              [
                'Renfe Cercanias (NAP)',
                'https://www.renfe.com/es/es/cercanias',
                'es',
                '',
                '',
                options.version,
              ],
            ],
          ),
        }
      : {}),
  };

  const stats = {
    routesRaw: routeRows.length,
    lines: lines.size,
    trips: usedTrips.length,
    tripsWithoutTimes: tripRows.length - usedTrips.length,
    stopTimeRowsTotal: rowsTotal,
    stopTimeRowsKept: rowsKept,
  };
  return { files: filesOut, stats };
}

// ---------- ZIP (solo lectura, sin dependencias) ----------

const EOCD_SIG = 0x06054b50;
const CDE_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export function readZip(buf) {
  const minStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('ZIP: EOCD no encontrado');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDE_SIG) {
      throw new Error(`ZIP: entrada de directorio central inválida (#${i})`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (!name.endsWith('/')) {
      entries.set(name, { name, method, compressedSize, localHeaderOffset });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function zipEntryBuffer(zipBuf, entry) {
  const lho = entry.localHeaderOffset;
  if (lho + 30 > zipBuf.length || zipBuf.readUInt32LE(lho) !== LFH_SIG) {
    throw new Error(`ZIP: cabecera local inválida para ${entry.name}`);
  }
  const nameLen = zipBuf.readUInt16LE(lho + 26);
  const extraLen = zipBuf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + nameLen + extraLen;
  const raw = zipBuf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`ZIP: método no soportado (${entry.method}) para ${entry.name}`);
}

// Desde 2026-11-05 los items de ArcGIS anidan el GTFS en una carpeta (google_transit_M89/,
// google_transit_M9/; ml y metro siguen en la raíz): se prefiere la entrada en raíz y si no
// existe se resuelve por sufijo /<carpeta>/<nombre> único (mismas reglas para los opcionales).
export function extractGtfsFiles(zipBuf) {
  const entries = readZip(zipBuf);
  const need = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
  const optional = [
    'calendar.txt',
    'calendar_dates.txt',
    'feed_info.txt',
    'shapes.txt',
    'frequencies.txt',
  ];
  const resolve = (name) => {
    if (entries.has(name)) return entries.get(name);
    const matches = [...entries.values()].filter((e) => e.name.endsWith('/' + name));
    if (matches.length > 1) {
      throw new Error(
        `GTFS: ${name} aparece en ${matches.length} carpetas del zip (${matches.map((e) => e.name).join(', ')})`,
      );
    }
    return matches[0] ?? null;
  };
  const out = {};
  for (const name of need) {
    if (!resolve(name)) throw new Error(`GTFS: falta ${name} en el zip`);
  }
  for (const name of [...need, ...optional]) {
    const entry = resolve(name);
    out[name] = entry ? zipEntryBuffer(zipBuf, entry) : null;
  }
  return out;
}

// ---------- Parseo GTFS ----------

export function parseStopTimes(buf, onRow) {
  const rows = iterCsvRows(buf);
  rows.next();
  let count = 0;
  let lastDep = null;
  for (const line of rows) {
    if (line === '') continue;
    const f = parseCsvLine(line);
    if (f.length < 5) continue;
    let dep = parseHms((f[2] || f[1]).trim());
    if (dep === null) dep = lastDep ?? 0;
    else lastDep = dep;
    const seq = Number.parseInt(f[4], 10);
    onRow(f[0].trim(), dep, Number.isNaN(seq) ? count : seq, f[3].trim());
    count++;
  }
  return count;
}

function round6(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

function modeOf(counter) {
  let best = null;
  let bestCount = -1;
  for (const [value, count] of counter) {
    if (count > bestCount || (count === bestCount && best === null)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// dest modal por dirección (para el headsign de las direcciones del doc R2, consistente
// con detail/timetable que lo calculan en query time)
function modeDestByDirection(lineDoc) {
  const counters = new Map();
  for (const t of lineDoc.trips ?? []) {
    if (!t.dest) continue;
    let counter = counters.get(t.dir);
    if (!counter) {
      counter = new Map();
      counters.set(t.dir, counter);
    }
    counter.set(t.dest, (counter.get(t.dest) ?? 0) + 1);
  }
  const out = new Map();
  for (const [dir, counter] of counters) out.set(dir, modeOf(counter));
  return out;
}

function sortTripTimes(t) {
  for (let i = 1; i < t.seq.length; i++) {
    if (t.seq[i] < t.seq[i - 1]) {
      const idx = t.seq.map((_, i) => i).sort((a, b) => t.seq[a] - t.seq[b]);
      t.seq = idx.map((i) => t.seq[i]);
      t.dep = idx.map((i) => t.dep[i]);
      t.stop = idx.map((i) => t.stop[i]);
      return;
    }
  }
}

export function buildArtifacts(feeds, munisByStopCode, options = {}) {
  // Modo catálogo: feeds con calendario caducado (gate de frescura) — se escriben sus
  // líneas/paradas/direcciones/geometría pero SIN services/trips (nunca horarios caducados)
  const catalogNetworks = options.catalogNetworks ?? new Set();
  // Redes cuya secuencia de paradas por dirección es la MÁS LARGA y no la modal
  // (cercanías: las variantes cortas son mayoría pero el corredor completo define la línea)
  const longestDirStopsNetworks = new Set(
    feeds.filter((f) => f.directionStops === 'longest').map((f) => f.network),
  );
  const catalogEndByNetwork = {};
  for (const feed of feeds) {
    if (catalogNetworks.has(feed.network))
      catalogEndByNetwork[feed.network] = feedCalendarEnd(feed.files);
  }
  const stopsArr = [];
  const stopIdxById = new Map();
  const stopIdByCode = new Map();
  const stopsDuplicated = { count: 0 };
  const codeCollisions = { count: 0 };
  for (const feed of feeds) {
    const nnMuni = feed.muniStrategy === 'nn';
    for (const row of parseGtfsTable(feed.files['stops.txt'])) {
      if (stopIdxById.has(row.stop_id)) {
        stopsDuplicated.count++;
        continue;
      }
      const code = publicStopCode(feed, row);
      if (stopIdByCode.has(code)) {
        codeCollisions.count++;
        continue;
      }
      const muni = nnMuni
        ? null
        : (munisByStopCode.get(row.stop_code) ??
          munisByStopCode.get(String(row.stop_code).padStart(5, '0')) ??
          null);
      stopIdByCode.set(code, row.stop_id);
      stopIdxById.set(row.stop_id, stopsArr.length);
      stopsArr.push({
        code,
        name: row.stop_name,
        address: row.stop_desc || null,
        lat: round6(row.stop_lat),
        lon: round6(row.stop_lon),
        zone: normalizeZone(row.zone_id),
        muni,
        nnMuni,
        linesSet: new Set(),
      });
    }
  }

  // Municipio de los feeds sin capa Postes (M4/M10): parada de bus con municipio resuelto
  // más cercana (haversine NN, umbral NN_MUNI_MAX_M; sin vecino → null)
  const nnStats = { total: 0, resolved: 0 };
  const muniRefs = stopsArr.filter((s) => !s.nnMuni && s.muni && s.lat !== null && s.lon !== null);
  if (muniRefs.length > 0) {
    for (const s of stopsArr) {
      if (!s.nnMuni) continue;
      nnStats.total++;
      if (s.lat === null || s.lon === null) continue;
      let best = null;
      let bestD = Infinity;
      for (const ref of muniRefs) {
        const d = haversineM(s.lat, s.lon, ref.lat, ref.lon);
        if (d < bestD) {
          bestD = d;
          best = ref;
        }
      }
      if (best && bestD <= NN_MUNI_MAX_M) {
        s.muni = best.muni;
        nnStats.resolved++;
      }
    }
  }

  const routesById = new Map();
  const feedVersions = {};
  for (const feed of feeds) {
    feedVersions[feed.network] = [];
    const routes = parseGtfsTable(feed.files['routes.txt']);
    for (const row of routes) {
      if (routesById.has(row.route_id)) continue;
      routesById.set(row.route_id, {
        routeId: row.route_id,
        label: row.route_short_name,
        name: row.route_long_name,
        url: normalizeRouteUrl(row.route_url),
        network: feed.network,
        municipality: null,
        color: normalizeColor(row.route_color),
        textColor: normalizeColor(row.route_text_color),
      });
    }
    for (const info of parseGtfsTable(feed.files['feed_info.txt'])) {
      if (info.feed_version && !feedVersions[feed.network].includes(info.feed_version)) {
        feedVersions[feed.network].push(info.feed_version);
      }
    }
    feedVersions[feed.network].sort();
  }

  const calendar = new Map();
  for (const feed of feeds) {
    for (const row of parseGtfsTable(feed.files['calendar.txt'])) {
      calendar.set(row.service_id, {
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
          (d) => (row[d] === '1' ? 1 : 0),
        ),
        from: row.start_date || null,
        to: row.end_date || null,
      });
    }
  }
  const calendarDates = new Map();
  for (const feed of feeds) {
    for (const row of parseGtfsTable(feed.files['calendar_dates.txt'])) {
      const type = Number(row.exception_type);
      if (type !== 1 && type !== 2) continue;
      let exc = calendarDates.get(row.service_id);
      if (!exc) {
        exc = new Map();
        calendarDates.set(row.service_id, exc);
      }
      exc.set(row.date, type);
    }
  }

  const tripsById = new Map();
  const routeTrips = new Map();
  const orphan = { stopRefs: 0, routeRefs: 0, serviceRefs: 0 };
  const stopTimeRows = { count: 0 };
  const tripsWithoutTimes = { count: 0 };
  // Frequencies (metro): bandas por trip plantilla; no se materializan (~21k salidas → KV pequeño)
  const freqStats = { trips: 0, bands: 0, departures: 0, orphanRefs: 0, invalidRows: 0 };
  // dest por trip desde trip_short_name (solo redes de bus: en ml/metro es el nombre del
  // corredor completo sin label y el headsign GTFS ya es la terminal — no se cuenta)
  const destStats = { conShortName: 0, conDest: 0, sinLabel: 0 };
  for (const feed of feeds) {
    for (const row of parseGtfsTable(feed.files['trips.txt'])) {
      if (tripsById.has(row.trip_id)) continue;
      const route = routesById.get(row.route_id);
      const serviceKnown = calendar.has(row.service_id) || calendarDates.has(row.service_id);
      if (!route) {
        orphan.routeRefs++;
        continue;
      }
      if (!serviceKnown) {
        orphan.serviceRefs++;
        continue;
      }
      const trip = {
        routeId: row.route_id,
        serviceId: row.service_id,
        headsign: row.trip_headsign || '',
        dest: null,
        dir: Number(row.direction_id) === 1 ? 1 : 0,
        shapeId: row.shape_id || null,
        dep: null,
        stopIdxs: null,
        offs: null,
        freq: null,
        ...(feed.rtTripIds ? { tid: row.trip_id } : {}),
      };
      if (route.network === 'interurban' || route.network === 'urban') {
        const shortName = (row.trip_short_name ?? '').trim();
        if (shortName) {
          destStats.conShortName++;
          const dest = cleanTripDest(shortName, route.label);
          if (dest) {
            trip.dest = dest;
            destStats.conDest++;
          } else {
            destStats.sinLabel++;
          }
        }
      }
      tripsById.set(row.trip_id, trip);
      let list = routeTrips.get(row.route_id);
      if (!list) {
        list = [];
        routeTrips.set(row.route_id, list);
      }
      list.push(row.trip_id);
    }
    const freqFile = feed.files['frequencies.txt'];
    if (freqFile) {
      const { byTrip, invalid } = parseFrequencies(freqFile);
      freqStats.invalidRows += invalid;
      for (const [tripId, bands] of byTrip) {
        const trip = tripsById.get(tripId);
        if (!trip) {
          // fila que referencia un trip inexistente (u orphan de ruta/servicio): observable, no aborta la run
          freqStats.orphanRefs += bands.length;
          continue;
        }
        trip.freq = bands;
        freqStats.trips++;
        freqStats.bands += bands.length;
        for (const b of bands) freqStats.departures += Math.ceil((b.to - b.from) / b.headway);
      }
    }
  }
  for (const feed of feeds) {
    let curId = null;
    let cur = null;
    const flush = () => {
      if (curId === null || !cur) return;
      sortTripTimes(cur);
      const trip = tripsById.get(curId);
      if (trip && cur.seq.length > 0) {
        trip.dep = cur.dep[0];
        trip.stopIdxs = cur.stop;
        trip.offs = cur.dep.map((d) => d - cur.dep[0]);
        // cercanías: dest por trip = nombre de la última parada (estación terminal real,
        // misma prioridad absoluta que el dest del widget en bus); no cuenta en destStats
        if (feed.destFromTripTerminal && trip.stopIdxs.length > 0) {
          const name = stopsArr[trip.stopIdxs[trip.stopIdxs.length - 1]]?.name;
          if (name) trip.dest = name.trim().slice(0, TRIP_DEST_MAX_CHARS);
        }
      }
      if (!trip) tripsWithoutTimes.count++;
    };
    const rowCount = parseStopTimes(feed.files['stop_times.txt'], (tripId, dep, seq, stopId) => {
      if (tripId !== curId) {
        flush();
        curId = tripId;
        cur = { seq: [], dep: [], stop: [] };
      }
      const stopIdx = stopIdxById.get(stopId);
      if (stopIdx === undefined) {
        orphan.stopRefs++;
        return;
      }
      cur.seq.push(seq);
      cur.dep.push(dep);
      cur.stop.push(stopIdx);
    });
    flush();
    stopTimeRows.count += rowCount;
  }

  const routeMuni = new Map();
  for (const [routeId, tripIds] of routeTrips) {
    const route = routesById.get(routeId);
    const muniCounts = new Map();
    let used = 0;
    for (const tripId of tripIds) {
      const trip = tripsById.get(tripId);
      if (!trip.stopIdxs) {
        tripsWithoutTimes.count++;
        continue;
      }
      used++;
      for (const si of trip.stopIdxs) {
        stopsArr[si].linesSet.add(route.label);
        const m = stopsArr[si].muni;
        if (m) muniCounts.set(m, (muniCounts.get(m) ?? 0) + 1);
      }
    }
    if (used === 0) {
      routesById.delete(routeId);
      routeTrips.delete(routeId);
      continue;
    }
    routeMuni.set(routeId, modeOf(muniCounts));
  }

  // Heurística de shapes: para cada línea y dirección, el shape del trip con MÁS PARADAS
  // de esa dirección (la variante más larga suele cubrir todo el recorrido; los recortes
  // bonificados/desvíos tienen menos paradas). Solo trips con shape_id propio.
  const shapeSelection = new Map();
  for (const [routeId, tripIds] of routeTrips) {
    const byDir = new Map();
    for (const tripId of tripIds) {
      const trip = tripsById.get(tripId);
      if (!trip.stopIdxs || !trip.shapeId) continue;
      const best = byDir.get(trip.dir);
      if (!best || trip.stopIdxs.length > best.stopCount) {
        byDir.set(trip.dir, { shapeId: trip.shapeId, stopCount: trip.stopIdxs.length });
      }
    }
    if (byDir.size > 0) shapeSelection.set(routeId, byDir);
  }

  const stops = [];
  let muniResolved = 0;
  for (const s of stopsArr) {
    if (s.linesSet.size === 0) continue;
    if (s.muni) muniResolved++;
    stops.push({
      code: s.code,
      name: s.name,
      address: s.address,
      lat: s.lat,
      lon: s.lon,
      zone: s.zone,
      municipality: s.muni,
      lines: [...s.linesSet].sort(compareLabels),
    });
  }
  stops.sort((a, b) => compareLabels(a.code, b.code));
  const muniCoverage = stops.length > 0 ? muniResolved / stops.length : 0;
  for (const [routeId, muni] of routeMuni) {
    routesById.get(routeId).municipality = muni;
  }

  const lineDocs = new Map();
  // Redes con tid serializado (join con GTFS-RT); rtStats como alarma de deriva en meta
  const rtNetworks = new Set(feeds.filter((f) => f.rtTripIds).map((f) => f.network));
  const rtStats = { tripsWithTid: 0 };
  const buildService = (serviceId) => {
    const cal = calendar.get(serviceId);
    const exc = calendarDates.get(serviceId);
    return {
      id: serviceId,
      days: cal ? cal.days : [0, 0, 0, 0, 0, 0, 0],
      from: cal ? cal.from : null,
      to: cal ? cal.to : null,
      exceptions: exc ? Object.fromEntries(exc) : {},
    };
  };
  for (const [routeId, tripIds] of routeTrips) {
    const route = routesById.get(routeId);
    const catalog = catalogNetworks.has(route.network);
    const dirStats = new Map();
    const svcIds = [];
    const svcIndex = new Map();
    const svcPatterns = new Map();
    const trips = [];
    for (const tripId of tripIds) {
      const trip = tripsById.get(tripId);
      if (!trip.stopIdxs) continue;
      let stats = dirStats.get(trip.dir);
      if (!stats) {
        stats = { headsigns: new Map(), sequences: new Map() };
        dirStats.set(trip.dir, stats);
      }
      if (trip.headsign)
        stats.headsigns.set(trip.headsign, (stats.headsigns.get(trip.headsign) ?? 0) + 1);
      const seqKey = trip.stopIdxs.join('.');
      const seqEntry = stats.sequences.get(seqKey) ?? { count: 0, seq: trip.stopIdxs };
      seqEntry.count++;
      stats.sequences.set(seqKey, seqEntry);
      if (!catalog && !svcIndex.has(trip.serviceId)) {
        const svc = buildService(trip.serviceId);
        const pattern = JSON.stringify([svc.days, svc.from, svc.to, svc.exceptions]);
        let idx = svcPatterns.get(pattern);
        if (idx === undefined) {
          idx = svcIds.length;
          svcIds.push(trip.serviceId);
          svcPatterns.set(pattern, idx);
        }
        svcIndex.set(trip.serviceId, idx);
      }
      if (!catalog) trips.push(trip);
    }
    // Primera salida efectiva: dep en trips con horario exacto, min(from) en trips plantilla
    const firstDep = (t) => (t.freq ? Math.min(...t.freq.map((b) => b.from)) : t.dep);
    if (!catalog)
      trips.sort((a, b) => firstDep(a) - firstDep(b) || a.headsign.localeCompare(b.headsign));
    const directions = [...dirStats.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dir, stats]) => {
        const seqEntries = [...stats.sequences.values()];
        const chosen = longestDirStopsNetworks.has(route.network)
          ? seqEntries.reduce((a, b) =>
              b.seq.length > a.seq.length || (b.seq.length === a.seq.length && b.count > a.count)
                ? b
                : a,
            )
          : modeOf(new Map(seqEntries.map((e) => [e, e.count])));
        return {
          id: dir,
          headsign: modeOf(stats.headsigns) ?? route.name,
          stops: chosen.seq.map((si) => stopsArr[si].code),
        };
      });
    lineDocs.set(routeId, {
      routeId,
      label: route.label,
      name: route.name,
      network: route.network,
      municipality: route.municipality,
      url: route.url,
      ...(route.color ? { color: route.color } : {}),
      ...(route.textColor ? { textColor: route.textColor } : {}),
      directions,
      ...(catalog
        ? {
            noSchedule: {
              calendarEnd: catalogEndByNetwork[route.network] ?? null,
              feedVersions: feedVersions[route.network] ?? [],
            },
          }
        : {
            services: svcIds.map((serviceId) => buildService(serviceId)),
            trips: trips.map((t) => {
              const withTid = rtNetworks.has(route.network) && t.tid;
              if (withTid) rtStats.tripsWithTid++;
              return {
                dir: t.dir,
                svc: svcIndex.get(t.serviceId),
                headsign: t.headsign,
                ...(t.dest ? { dest: t.dest } : {}),
                ...(withTid ? { tid: t.tid } : {}),
                ...(t.freq ? { freq: t.freq } : { dep: t.dep }),
                stops: t.stopIdxs.map((si, i) => `${stopsArr[si].code}@${t.offs[i]}`),
              };
            }),
          }),
    });
  }

  const lines = [...routesById.values()]
    .filter((r) => lineDocs.has(r.routeId))
    .map((r) => ({
      label: r.label,
      routeId: r.routeId,
      name: r.name,
      network: r.network,
      municipality: r.municipality,
      url: r.url,
      ...(r.color ? { color: r.color } : {}),
      ...(r.textColor ? { textColor: r.textColor } : {}),
      ...(catalogNetworks.has(r.network) ? { noSchedule: true } : {}),
    }))
    .sort((a, b) => a.network.localeCompare(b.network) || compareLabels(a.label, b.label));

  const routesCounts = {};
  for (const r of routesById.values()) routesCounts[r.network] = (routesCounts[r.network] ?? 0) + 1;
  const lineDocsCounts = {};
  for (const d of lineDocs.values())
    lineDocsCounts[d.network] = (lineDocsCounts[d.network] ?? 0) + 1;

  const counts = {
    networks: feeds.filter((f) => !catalogNetworks.has(f.network)).map((f) => f.network),
    catalogNetworks: feeds.filter((f) => catalogNetworks.has(f.network)).map((f) => f.network),
    stopsRaw: stopsArr.length,
    stopsKept: stops.length,
    muniResolved,
    muniCoverage,
    nnMuni: nnStats,
    routes: routesCounts,
    lineDocs: lineDocsCounts,
    routesWithoutService: routesById.size - lineDocs.size,
    trips: tripsById.size,
    stopTimeRows: stopTimeRows.count,
    frequencies: freqStats,
    dest: destStats,
    rt: rtStats,
    orphan,
    tripsWithoutTimes: tripsWithoutTimes.count,
    stopsDuplicated: stopsDuplicated.count,
    codeCollisions: codeCollisions.count,
    feedVersions,
  };

  return { stops, lines, lineDocs, shapeSelection, counts };
}

export function validateArtifacts(artifacts) {
  const { counts, stops, lines, lineDocs } = artifacts;
  const errors = [];
  const c = counts;
  if (c.stopsKept < LIMITS.MIN_STOPS) {
    errors.push(`paradas referenciadas ${c.stopsKept} < mínimo ${LIMITS.MIN_STOPS}`);
  }
  // Mínimos solo para las redes activas de la run: un feed en modo catálogo (p. ej. metro
  // stale) no computa para los mínimos ni puede bloquear la validación del resto
  const activeNetworks = new Set(c.networks ?? Object.keys(LIMITS.MIN_ROUTES));
  for (const network of Object.keys(LIMITS.MIN_ROUTES)) {
    if (!activeNetworks.has(network)) continue;
    if ((c.lineDocs[network] ?? 0) < LIMITS.MIN_ROUTES[network]) {
      errors.push(
        `líneas con servicio ${network} ${c.lineDocs[network] ?? 0} < mínimo ${LIMITS.MIN_ROUTES[network]}`,
      );
    }
  }
  if (c.trips < LIMITS.MIN_TRIPS) errors.push(`trips ${c.trips} < mínimo ${LIMITS.MIN_TRIPS}`);
  if (c.stopTimeRows < LIMITS.MIN_STOP_TIME_ROWS) {
    errors.push(`filas stop_times ${c.stopTimeRows} < mínimo ${LIMITS.MIN_STOP_TIME_ROWS}`);
  }
  if (c.orphan.stopRefs > 0) errors.push(`${c.orphan.stopRefs} referencias a paradas inexistentes`);
  if (c.orphan.routeRefs > 0) errors.push(`${c.orphan.routeRefs} trips con ruta inexistente`);
  if (c.orphan.serviceRefs > 0)
    errors.push(`${c.orphan.serviceRefs} trips con servicio desconocido`);
  if (c.codeCollisions > 0)
    errors.push(`${c.codeCollisions} códigos de parada duplicados entre redes`);
  if (c.frequencies.departures > LIMITS.MAX_FREQ_DEPARTURES) {
    errors.push(
      `frequencies: ${c.frequencies.departures} salidas expandibles > máximo ${LIMITS.MAX_FREQ_DEPARTURES}`,
    );
  }
  if (c.muniCoverage < LIMITS.MIN_MUNI_COVERAGE) {
    errors.push(
      `cobertura de municipio ${(c.muniCoverage * 100).toFixed(1)}% < ${LIMITS.MIN_MUNI_COVERAGE * 100}%`,
    );
  }
  if (stops.length === 0) errors.push('caché de paradas vacío');
  if (lines.length === 0) errors.push('caché de líneas vacío');
  if (lineDocs.size === 0) errors.push('sin documentos de línea');
  for (const routeId of lineDocs.keys()) {
    // El routeId viaja del feed a claves KV/R2 de producción: charset y longitud acotados
    // (un id de >512B haría fallar el kvPut de forma no reintentable a mitad de run)
    if (!/^[\w.-]{1,64}$/.test(routeId)) {
      errors.push(`routeId no válido como clave KV/R2: ${JSON.stringify(routeId).slice(0, 60)}`);
      break;
    }
  }
  for (const [value, name] of [
    [JSON.stringify(stops), KV_KEYS.STOPS_ALL],
    [JSON.stringify({ count: lines.length, lines }), KV_KEYS.LINES_ALL],
  ]) {
    if (Buffer.byteLength(value) > LIMITS.MAX_VALUE_BYTES) {
      errors.push(`${name} excede ${(LIMITS.MAX_VALUE_BYTES / 1048576) | 0} MB`);
    }
  }
  for (const [routeId, doc] of lineDocs) {
    const size = Buffer.byteLength(JSON.stringify(doc));
    if (size > LIMITS.MAX_VALUE_BYTES) {
      errors.push(
        `crtm:line:${routeId} excede el tamaño máximo (${(size / 1048576).toFixed(1)} MB)`,
      );
      break;
    }
  }
  return errors;
}

// ---------- Shapes (geometría de recorridos → R2) ----------

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function round5(value) {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * Lee shapes.txt (streaming) conservando solo los shape_id pedidos.
 * Devuelve Map<shapeId, [[lon,lat],...]> ordenado por shape_pt_sequence
 * (con duplicados consecutivos tras el redondeo eliminados).
 */
export function parseShapePoints(buf, neededShapeIds) {
  const collected = new Map();
  if (!buf) return collected;
  const rows = iterCsvRows(buf);
  const header = parseCsvRow(rows.next().value);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const iId = col.shape_id ?? 0;
  const iLat = col.shape_pt_lat ?? 1;
  const iLon = col.shape_pt_lon ?? 2;
  const iSeq = col.shape_pt_sequence ?? 3;
  for (const line of rows) {
    if (line === '') continue;
    const f = parseCsvLine(line);
    if (f.length < 4) continue;
    const shapeId = f[iId].trim();
    if (!neededShapeIds.has(shapeId)) continue;
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let pts = collected.get(shapeId);
    if (!pts) {
      pts = [];
      collected.set(shapeId, pts);
    }
    pts.push([lon, lat, Number.parseInt(f[iSeq], 10) || 0]);
  }
  const out = new Map();
  for (const [shapeId, pts] of collected) {
    pts.sort((a, b) => a[2] - b[2]); // sort estable de V8: conserva el orden de fichero en empates
    const clean = [];
    for (const [lon, lat] of pts) {
      const p = [round5(lon), round5(lat)];
      const prev = clean[clean.length - 1];
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) clean.push(p);
    }
    if (clean.length >= 2) out.set(shapeId, clean);
  }
  return out;
}

/**
 * Corta la polilínea en tramos donde haya un salto > gapM entre puntos
 * consecutivos (huecos del shape original → partes del MultiLineString)
 */
export function splitShapeParts(points, gapM = SHAPES.GAP_SPLIT_M) {
  const parts = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
    if (d > gapM) {
      if (current.length >= 2) parts.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  if (current.length >= 2) parts.push(current);
  return parts;
}

/**
 * Douglas-Peucker iterativo con proyección equirectangular local (metros)
 */
export function simplifyPoints(points, toleranceM) {
  const n = points.length;
  if (n <= 2) return points.slice();
  const mPerDeg = 111319.49;
  const cosLat0 = Math.cos((points[0][1] * Math.PI) / 180);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0] * mPerDeg * cosLat0;
    ys[i] = points[i][1] * mPerDeg;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop();
    if (e <= s + 1) continue;
    const dx = xs[e] - xs[s];
    const dy = ys[e] - ys[s];
    const len2 = dx * dx + dy * dy;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = s + 1; i < e; i++) {
      let dist;
      if (len2 === 0) {
        dist = Math.hypot(xs[i] - xs[s], ys[i] - ys[s]);
      } else {
        const t = ((xs[i] - xs[s]) * dx + (ys[i] - ys[s]) * dy) / len2;
        dist = Math.hypot(xs[i] - (xs[s] + t * dx), ys[i] - (ys[s] + t * dy));
      }
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceM) {
      keep[maxIdx] = 1;
      stack.push([s, maxIdx], [maxIdx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function buildRouteShapeDoc(routeId, lineDoc, dirs, toleranceM) {
  const bounds = [180, 90, -180, -90];
  const directions = [];
  let originalPoints = 0;
  let simplifiedPoints = 0;
  const modeDest = modeDestByDirection(lineDoc);
  for (const dir of [0, 1]) {
    const entry = dirs.get(dir);
    if (!entry) continue;
    originalPoints += entry.pts.length;
    const coords = [];
    let distanceM = 0;
    let count = 0;
    for (const part of splitShapeParts(entry.pts)) {
      const simple = simplifyPoints(part, toleranceM);
      if (simple.length < 2) continue;
      coords.push(simple);
      count += simple.length;
      for (let i = 1; i < simple.length; i++) {
        distanceM += haversineM(simple[i - 1][1], simple[i - 1][0], simple[i][1], simple[i][0]);
      }
      for (const [lon, lat] of simple) {
        if (lon < bounds[0]) bounds[0] = lon;
        if (lat < bounds[1]) bounds[1] = lat;
        if (lon > bounds[2]) bounds[2] = lon;
        if (lat > bounds[3]) bounds[3] = lat;
      }
    }
    if (coords.length === 0) continue;
    simplifiedPoints += count;
    // headsign = dest modal por dirección (nombre canónico del widget) con fallback al GTFS
    const headsign =
      modeDest.get(dir) ?? lineDoc.directions.find((d) => d.id === dir)?.headsign ?? lineDoc.name;
    directions.push({
      id: dir,
      headsign,
      shapeId: entry.shapeId,
      distanceM: Math.round(distanceM),
      pointCount: count,
      geometry: { type: 'MultiLineString', coordinates: coords },
    });
  }
  if (directions.length === 0) return null;
  return {
    doc: {
      routeId,
      label: lineDoc.label,
      name: lineDoc.name,
      network: lineDoc.network,
      municipality: lineDoc.municipality,
      ...(lineDoc.color ? { color: lineDoc.color } : {}),
      ...(lineDoc.textColor ? { textColor: lineDoc.textColor } : {}),
      toleranceM,
      bounds,
      directions,
    },
    originalPoints,
    simplifiedPoints,
  };
}

/**
 * Construye los docs de geometría por línea (uno por routeId con shape disponible).
 * Tolerancia adaptativa: empieza en TOLERANCE_START_M y se duplica hasta que el
 * JSON quepa en maxJsonBytes (tope TOLERANCE_MAX_M).
 */
export function buildShapes(feeds, lineDocs, shapeSelection, options = {}) {
  const maxJsonBytes = options.maxJsonBytes ?? SHAPES.MAX_JSON_BYTES;

  const neededByNetwork = new Map();
  const routesByShape = new Map();
  for (const [routeId, byDir] of shapeSelection) {
    const lineDoc = lineDocs.get(routeId);
    if (!lineDoc) continue;
    let needed = neededByNetwork.get(lineDoc.network);
    if (!needed) {
      needed = new Set();
      neededByNetwork.set(lineDoc.network, needed);
    }
    for (const [dir, entry] of byDir) {
      needed.add(entry.shapeId);
      let list = routesByShape.get(entry.shapeId);
      if (!list) {
        list = [];
        routesByShape.set(entry.shapeId, list);
      }
      list.push({ routeId, dir });
    }
  }

  const shapePoints = new Map();
  for (const feed of feeds) {
    const needed = neededByNetwork.get(feed.network);
    const buf = feed.files['shapes.txt'];
    if (!buf || !needed || needed.size === 0) continue;
    for (const [shapeId, pts] of parseShapePoints(buf, needed)) shapePoints.set(shapeId, pts);
  }

  const dirsByRoute = new Map();
  for (const [shapeId, routes] of routesByShape) {
    const pts = shapePoints.get(shapeId);
    if (!pts) continue;
    for (const { routeId, dir } of routes) {
      let dirs = dirsByRoute.get(routeId);
      if (!dirs) {
        dirs = new Map();
        dirsByRoute.set(routeId, dirs);
      }
      dirs.set(dir, { shapeId, pts });
    }
  }

  const docs = new Map();
  const sizes = [];
  let pointsOriginal = 0;
  let pointsSimplified = 0;
  for (const [routeId, dirs] of dirsByRoute) {
    const lineDoc = lineDocs.get(routeId);
    let toleranceM = SHAPES.TOLERANCE_START_M;
    let result = buildRouteShapeDoc(routeId, lineDoc, dirs, toleranceM);
    if (!result) continue;
    let bytes = Buffer.byteLength(JSON.stringify(result.doc));
    while (bytes > maxJsonBytes && toleranceM < SHAPES.TOLERANCE_MAX_M) {
      toleranceM *= 2;
      result = buildRouteShapeDoc(routeId, lineDoc, dirs, toleranceM);
      if (!result) break;
      bytes = Buffer.byteLength(JSON.stringify(result.doc));
    }
    if (!result) continue;
    pointsOriginal += result.originalPoints;
    pointsSimplified += result.simplifiedPoints;
    sizes.push([routeId, bytes]);
    docs.set(routeId, result.doc);
  }

  sizes.sort((a, b) => b[1] - a[1]);
  const stats = {
    routesWithTrips: lineDocs.size,
    routesWithSelection: shapeSelection.size,
    routes: docs.size,
    pointsOriginal,
    pointsSimplified,
    totalBytes: sizes.reduce((acc, [, b]) => acc + b, 0),
    maxBytes: sizes.length > 0 ? sizes[0][1] : 0,
    maxRouteId: sizes.length > 0 ? sizes[0][0] : null,
    worst: sizes.slice(0, 5).map(([id, b]) => `${id} ${kb(b)}`),
  };
  return { docs, stats };
}

export function validateShapes(feedsHaveShapesFile, shapes, prevShapesCount) {
  const errors = [];
  if (feedsHaveShapesFile && shapes.stats.routes === 0) {
    errors.push('shapes.txt presente en los feeds pero 0 geometrías utilizables');
  }
  // Un shapes.txt degradado/truncado puede dejar pasar el suelo de 0 geometrías y la purga
  // posterior borraría TODA la geometría de producción: suelo relativo a la generación anterior
  if (
    feedsHaveShapesFile &&
    typeof prevShapesCount === 'number' &&
    prevShapesCount >= 50 &&
    shapes.stats.routes < Math.floor(prevShapesCount * 0.8)
  ) {
    errors.push(
      `geometrías ${shapes.stats.routes} < 80% de la generación anterior (${prevShapesCount}): ¿shapes.txt degradado?`,
    );
  }
  for (const [routeId, doc] of shapes.docs) {
    const size = Buffer.byteLength(JSON.stringify(doc));
    if (size > SHAPES.MAX_JSON_BYTES_HARD) {
      errors.push(`shape ${routeId} excede el límite duro (${(size / 1024) | 0} KB)`);
      break;
    }
  }
  return errors;
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchItemMeta(feed) {
  const json = await fetchJson(ARCGIS_ITEM(feed.itemId), 30000);
  return { modified: json.modified ?? null, size: json.size ?? null, name: json.name ?? null };
}

// ---------- NAP (Punto de Acceso Nacional de datos del transporte) ----------
// Cercanías Renfe: dataset 929 con un GTFS-ZIP nacional que se republica a diario. El id
// del fichero cambia en cada publicación: se resuelve vía catálogo y se pide el enlace
// firmado (S3, caduca en 15 min). Autenticación por cabecera ApiKey.

const NAP_API = 'https://nap.transportes.gob.es';

function napApiKey() {
  if (process.env.NAP_API_KEY) return process.env.NAP_API_KEY;
  try {
    const raw = fs.readFileSync('.dev.vars', 'utf8');
    const m = /^NAP_API_KEY=(.+)$/m.exec(raw);
    if (m) return m[1].trim();
  } catch {
    // sin .dev.vars: solo env
  }
  return null;
}

async function napFetchJson(url, apiKey, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { ApiKey: apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`NAP GET ${url} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (json.success === false)
    throw new Error(`NAP ${url}: ${json.message ?? 'respuesta sin éxito'}`);
  return json;
}

// Fichero GTFS-ZIP vigente del dataset: el más reciente de los válidos (si ninguno pasa
// la validación del NAP, el último publicado — observable, mejor que caer la run)
async function fetchNapItemMeta(feed, apiKey) {
  const json = await napFetchJson(`${NAP_API}/api/v2/conjunto-dato/${feed.datasetId}`, apiKey);
  const gtfsZips = (json.data?.ficheros ?? []).filter((f) => f.nombreTipoFichero === 'GTFS-ZIP');
  const pool = gtfsZips.filter((f) => f.esValido);
  const candidates = pool.length > 0 ? pool : gtfsZips;
  if (candidates.length === 0)
    throw new Error(`NAP: el dataset ${feed.datasetId} no publica GTFS-ZIP`);
  const latest = candidates.reduce((a, b) =>
    String(b.fechaActualizacion ?? '') > String(a.fechaActualizacion ?? '') ? b : a,
  );
  // el array ficheros no publica nombre de archivo: la fecha de actualización identifica
  // la publicación (cambia a diario) y alimenta el feed_version sintético del feed_info
  const updated = String(latest.fechaActualizacion ?? '');
  return {
    id: latest.id,
    modified: updated || String(latest.id),
    size: latest.tamanio ?? null,
    name: updated ? updated.slice(0, 10).replace(/-/g, '') : null,
  };
}

async function fetchNapZip(feed, dir, apiKey) {
  const meta = await fetchNapItemMeta(feed, apiKey);
  const json = await napFetchJson(`${NAP_API}/api/v2/fichero/${meta.id}/descarga`, apiKey);
  const url = json.data?.enlaceDescarga;
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    throw new Error(`NAP: enlace de descarga inválido para el fichero ${meta.id}`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`Descarga ${feed.network}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10_000 || buf.readUInt32LE(0) !== LFH_SIG) {
    throw new Error(
      `Descarga ${feed.network}: respuesta no es un zip válido (${buf.length} bytes)`,
    );
  }
  const file = path.join(dir, feed.zipName);
  await fsp.writeFile(file, buf);
  return { file, buf };
}

async function fetchZip(feed, dir) {
  const res = await fetch(ARCGIS_DATA(feed.itemId), { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`Descarga ${feed.network}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10_000 || buf.readUInt32LE(0) !== LFH_SIG) {
    throw new Error(
      `Descarga ${feed.network}: respuesta no es un zip válido (${buf.length} bytes)`,
    );
  }
  const file = path.join(dir, feed.zipName);
  await fsp.writeFile(file, buf);
  return { file, buf };
}

async function loadLocalZip(feed, dir) {
  const candidates = [feed.zipName, ...(feed.altZipNames ?? [])];
  for (const name of candidates) {
    try {
      const buf = await fsp.readFile(path.join(dir, name));
      return { file: path.join(dir, name), buf };
    } catch {
      // probar siguiente nombre
    }
  }
  throw new Error(
    `No se encuentra zip local para ${feed.network} en ${dir} (${candidates.join(', ')})`,
  );
}

async function fetchPosteMunicipalities() {
  const map = new Map();
  for (const feed of FEEDS) {
    if (!feed.posteService) continue; // ml/metro: municipio por NN, sin capa Postes
    let offset = 0;
    for (let page = 0; page < LIMITS.MAX_POSTE_PAGES; page++) {
      const url = `${POSTE_QUERY(feed.posteService)}?where=1%3D1&outFields=CODIGOESTACION%2CCODIGOMUNICIPIO&returnGeometry=false&resultOffset=${offset}&resultRecordCount=${feed.postePage}&f=json`;
      const json = await fetchJson(url, 60000);
      const features = json.features ?? [];
      for (const f of features) {
        const code = f.attributes?.CODIGOESTACION;
        const muni = f.attributes?.CODIGOMUNICIPIO;
        if (code && muni && !map.has(code)) map.set(code, muni);
      }
      if (!json.exceededTransferLimit || features.length === 0) break;
      offset += features.length;
    }
  }
  return map;
}

async function fetchMunicipalityNames() {
  const json = await fetchJson(MUNICIPIOS_URL, 60000);
  const map = new Map();
  for (const row of json.data ?? []) {
    // el dataset CKAN arrastra espacios finales en algunos nombres (p. ej. 'Madrid ')
    const name = String(row.municipio_nombre ?? '').trim();
    if (row.municipio_codigo && name) {
      map.set(row.municipio_codigo, name);
    }
  }
  return map;
}

function readWranglerConfig() {
  const toml = fs.readFileSync('wrangler.toml', 'utf8');
  const accountId = /^account_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const nsMatch =
    /kv_namespaces\s*=\s*\[[\s\S]*?binding\s*=\s*"EMT_CACHE"[\s\S]*?id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!accountId || !nsMatch)
    throw new Error('No se pudo leer account_id o namespace EMT_CACHE de wrangler.toml');
  const r2Match =
    /r2_buckets\s*=\s*\[[\s\S]*?binding\s*=\s*"CRTM_SHAPES"[\s\S]*?bucket_name\s*=\s*"([^"]+)"/m.exec(
      toml,
    );
  return { accountId, namespaceId: nsMatch[1], r2Bucket: r2Match?.[1] ?? null };
}

function kvValueUrl(cfg, key) {
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.namespaceId}/values/${encodeURIComponent(key)}`;
}

async function cfFetch(_cfg, token, url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(init?.timeout ?? 60000),
  });
  const body = await res.text();
  if (!res.ok && res.status !== 404) {
    throw Object.assign(
      new Error(`KV ${init?.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`),
      { status: res.status },
    );
  }
  return { status: res.status, body };
}

// La REST de KV/R2 sufre 5xx transitorios (p. ej. error interno 10001 observado en un PUT
// de R2 el 2026-08-31, ~480 writes/run); los writes del pipeline son idempotentes →
// reintentar con backoff antes de tumbar la run diaria completa
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function withRetries(op, label, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const transient = error instanceof TypeError || RETRYABLE_STATUS.has(error?.status);
      if (attempt >= attempts || !transient) throw error;
      console.warn(`${label}: error transitorio (intento ${attempt}/${attempts}), reintentando...`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}
export { withRetries };

async function kvGet(cfg, token, key) {
  const { status, body } = await cfFetch(cfg, token, kvValueUrl(cfg, key), {});
  if (status === 404) return null;
  return body;
}

async function kvPut(cfg, token, key, value) {
  const bytes = Buffer.byteLength(value);
  if (bytes > LIMITS.MAX_VALUE_BYTES) {
    throw new Error(`${key} excede el límite de tamaño (${(bytes / 1048576).toFixed(1)} MB)`);
  }
  const { body } = await withRetries(
    () => cfFetch(cfg, token, kvValueUrl(cfg, key), { method: 'PUT', body: value }),
    `KV PUT ${key}`,
  );
  const json = JSON.parse(body);
  if (!json.success) throw new Error(`KV PUT ${key} rechazado: ${body.slice(0, 300)}`);
  return bytes;
}

async function kvListLineKeys(cfg, token) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.namespaceId}/keys`;
  const keys = [];
  let cursor = '';
  for (;;) {
    const url = `${base}?prefix=${encodeURIComponent(KV_KEYS.LINE_PREFIX)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body } = await cfFetch(cfg, token, url, {});
    const json = JSON.parse(body);
    if (!json.success) throw new Error(`KV list rechazado: ${body.slice(0, 300)}`);
    for (const k of json.result ?? []) keys.push(k.name);
    cursor = json.result_info?.cursor;
    if (!cursor) break;
  }
  return keys;
}

async function kvDelete(cfg, token, key) {
  const { body } = await withRetries(
    () => cfFetch(cfg, token, kvValueUrl(cfg, key), { method: 'DELETE' }),
    `KV DELETE ${key}`,
  );
  const json = JSON.parse(body);
  if (!json.success) throw new Error(`KV DELETE ${key} rechazado: ${body.slice(0, 300)}`);
}

// ---------- R2 (REST de Cloudflare, mismo token que KV; requiere "Workers R2 Storage: Edit") ----------

function r2ObjectUrl(cfg, key) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.r2Bucket}/objects/${path}`;
}

function r2Hint(status, body) {
  if (status === 401 || status === 403) {
    return ` (HTTP ${status}: ¿tiene el token permiso "Workers R2 Storage: Edit"? Respuesta: ${body.slice(0, 200)})`;
  }
  return ` (HTTP ${status}: ${body.slice(0, 200)})`;
}

async function r2Put(cfg, token, key, value) {
  const body = await withRetries(async () => {
    const res = await fetch(r2ObjectUrl(cfg, key), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: value,
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw Object.assign(new Error(`R2 PUT ${key}${r2Hint(res.status, text)}`), {
        status: res.status,
      });
    }
    return text;
  }, `R2 PUT ${key}`);
  const json = JSON.parse(body);
  if (!json.success) throw new Error(`R2 PUT ${key} rechazado: ${body.slice(0, 300)}`);
  return Buffer.byteLength(value);
}

async function r2ListKeys(cfg, token, prefix) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.r2Bucket}/objects`;
  const keys = [];
  let cursor = '';
  for (;;) {
    const url = `${base}?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`R2 LIST ${prefix}${r2Hint(res.status, body)}`);
    const json = JSON.parse(body);
    if (!json.success) throw new Error(`R2 LIST ${prefix} rechazado: ${body.slice(0, 300)}`);
    const page = json.result ?? [];
    for (const item of page) keys.push(typeof item === 'string' ? item : item.key);
    cursor = json.result_info?.cursor ?? '';
    if (!cursor || page.length === 0) break;
  }
  return keys;
}

async function r2Delete(cfg, token, key) {
  await withRetries(async () => {
    const res = await fetch(r2ObjectUrl(cfg, key), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    if (!res.ok && res.status !== 404) {
      throw Object.assign(new Error(`R2 DELETE ${key}${r2Hint(res.status, text)}`), {
        status: res.status,
      });
    }
    return text;
  }, `R2 DELETE ${key}`);
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------- Main ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    skipDownload: args.includes('--skip-download'),
    skipShapes: args.includes('--skip-shapes'),
    dir: dirIdx !== -1 ? args[dirIdx + 1] : path.join(os.tmpdir(), 'crtm-ingest'),
  };
}

export async function main(argv = process.argv) {
  const opts = parseArgs(argv);
  const started = Date.now();
  console.log(`== CRTM ingest (${opts.dryRun ? 'dry-run' : 'escritura'}) ==`);
  const cfg = readWranglerConfig();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!opts.dryRun && !token) {
    throw new Error(
      'Falta CLOUDFLARE_API_TOKEN (requerido para leer/escribir KV salvo en --dry-run)',
    );
  }

  const itemMetas = {};
  const napKey = napApiKey();
  for (const feed of FEEDS) {
    if (feed.source === 'nap') {
      if (!napKey) {
        if (opts.dryRun && opts.skipDownload) {
          itemMetas[feed.network] = { id: null, modified: null, size: null, name: null };
          console.warn(
            'AVISO: sin NAP_API_KEY; dry-run local sin meta del NAP (short-circuit no verificable).',
          );
          continue;
        }
        throw new Error('Falta NAP_API_KEY (env o .dev.vars) para el feed ' + feed.network);
      }
      itemMetas[feed.network] = await fetchNapItemMeta(feed, napKey);
      console.log(
        `nap ${feed.network}: fichero=${itemMetas[feed.network].id} actualizado=${itemMetas[feed.network].modified} tamaño=${mb(itemMetas[feed.network].size ?? 0)}`,
      );
    } else {
      itemMetas[feed.network] = await fetchItemMeta(feed);
      console.log(
        `item ${feed.network}: modified=${itemMetas[feed.network].modified} size=${mb(itemMetas[feed.network].size ?? 0)}`,
      );
    }
  }

  let prevShapesCount = null;
  if (!opts.dryRun) {
    const metaRaw = await kvGet(cfg, token, KV_KEYS.META);
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      prevShapesCount = typeof meta.shapes?.count === 'number' ? meta.shapes.count : null;
      if (!opts.force) {
        const unchanged = FEEDS.every(
          (f) => meta.versions?.[f.network]?.itemModified === itemMetas[f.network].modified,
        );
        if (unchanged) {
          console.log('Sin cambios en los feeds desde el último refresco; no se escribe nada.');
          return;
        }
      }
    }
  }

  await fsp.mkdir(opts.dir, { recursive: true });
  const zips = {};
  for (const feed of FEEDS) {
    const zip = opts.skipDownload
      ? await loadLocalZip(feed, opts.dir)
      : feed.source === 'nap'
        ? await fetchNapZip(feed, opts.dir, napKey)
        : await fetchZip(feed, opts.dir);
    zips[feed.network] = zip;
    console.log(`zip ${feed.network}: ${mb(zip.buf.length)} (${zip.file})`);
  }

  console.log('Postes (municipios por código de estación) + nombres de municipios...');
  const posteMuni = await fetchPosteMunicipalities();
  const muniNames = await fetchMunicipalityNames();
  const munisByStopCode = new Map();
  for (const [code, muniCode] of posteMuni) {
    const name = muniNames.get(muniCode);
    if (name) munisByStopCode.set(code, name);
  }
  console.log(
    `postes: ${posteMuni.size} códigos; municipios: ${muniNames.size}; joins resueltos: ${munisByStopCode.size}`,
  );

  const feeds = [];
  const staleCalendarEnd = {};
  const todayYmd = madridTodayYmd();
  let cercaniasGrouping = null;
  for (const feedDef of FEEDS) {
    console.log(`Parseando GTFS ${feedDef.network}...`);
    let files = extractGtfsFiles(zips[feedDef.network].buf);
    if (feedDef.destFromTripTerminal) {
      const norm = normalizeCercaniasFiles(files, {
        routeIdPrefix: feedDef.routeIdPrefix,
        version: itemMetas[feedDef.network]?.name,
      });
      files = norm.files;
      cercaniasGrouping = norm.stats;
      console.log(
        `cercanías: ${norm.stats.routesRaw} rutas ${feedDef.routeIdPrefix}* → ${norm.stats.lines} líneas; trips ${norm.stats.trips}` +
          ` (sin horarios: ${norm.stats.tripsWithoutTimes}); stop_times ${norm.stats.stopTimeRowsKept.toLocaleString('es')} de ${norm.stats.stopTimeRowsTotal.toLocaleString('es')} filas`,
      );
    }
    if (feedIsStale(files, todayYmd, feedDef.freshnessMarginDays)) {
      staleCalendarEnd[feedDef.network] = feedCalendarEnd(files);
      console.warn(
        `AVISO: feed ${feedDef.network} con calendario hasta ${staleCalendarEnd[feedDef.network] ?? 'sin fechas'} < ${ymdPlusDays(todayYmd, feedDef.freshnessMarginDays ?? FRESHNESS_MARGIN_DAYS)} → modo catálogo: se escriben líneas/paradas/geometría SIN horarios`,
      );
    }
    feeds.push({ ...feedDef, files });
  }
  const staleNetworks = Object.keys(staleCalendarEnd);
  if (staleNetworks.length > 0) {
    console.warn(
      `Feeds en modo catálogo (sin horarios): ${staleNetworks.join(', ')} (la run continúa)`,
    );
  }

  console.log('Construyendo artefactos (stops/lines/horarios por línea)...');
  const artifacts = buildArtifacts(feeds, munisByStopCode, {
    catalogNetworks: new Set(staleNetworks),
  });
  const c = artifacts.counts;
  if (cercaniasGrouping) c.cercaniasGrouping = cercaniasGrouping;
  const routesSummary = Object.entries(c.routes)
    .map(([net, n]) => `${n} ${net}`)
    .join(' + ');
  console.log(
    `paradas: ${c.stopsKept} referenciadas (de ${c.stopsRaw}); municipio: ${(c.muniCoverage * 100).toFixed(1)}%${c.nnMuni.total > 0 ? ` (NN ml/metro: ${c.nnMuni.resolved}/${c.nnMuni.total})` : ''} | rutas: ${routesSummary} (${c.routesWithoutService} sin servicio) | trips: ${c.trips} | stop_times: ${c.stopTimeRows} | orphans: ${c.orphan.stopRefs}/${c.orphan.routeRefs}/${c.orphan.serviceRefs}`,
  );
  if (c.frequencies.trips > 0 || c.frequencies.bands > 0) {
    console.log(
      `frequencies: ${c.frequencies.trips} trips plantilla, ${c.frequencies.bands} bandas → ${c.frequencies.departures.toLocaleString('es')} salidas expandidas en query time (orphans: ${c.frequencies.orphanRefs}, filas inválidas: ${c.frequencies.invalidRows})`,
    );
  }
  console.log(`versiones feed: ${JSON.stringify(c.feedVersions)}`);

  const sampleIdx = argv.indexOf('--sample');
  if (sampleIdx !== -1 && argv[sampleIdx + 1]) {
    const sample = artifacts.lineDocs.get(argv[sampleIdx + 1]);
    if (!sample) {
      console.error(`--sample: routeId ${argv[sampleIdx + 1]} no existe`);
    } else {
      console.log(
        JSON.stringify(
          sample.trips ? { ...sample, trips: sample.trips.slice(0, 2) } : sample,
          null,
          2,
        ),
      );
    }
  }

  const feedsHaveShapesFile = feeds.some((f) => f.files['shapes.txt']);
  const shapes = opts.skipShapes
    ? { docs: new Map(), stats: { routes: 0, skipped: true } }
    : buildShapes(feeds, artifacts.lineDocs, artifacts.shapeSelection);
  const s = shapes.stats;
  if (opts.skipShapes) {
    console.log('Shapes: omitidos (--skip-shapes).');
  } else if (!feedsHaveShapesFile) {
    console.log(
      'AVISO: los feeds no traen shapes.txt; no se generan geometrías (se conservan las existentes en R2).',
    );
  } else {
    console.log(
      `shapes: ${s.routes}/${s.routesWithTrips} líneas con geometría; puntos ${s.pointsOriginal.toLocaleString('es')}→${s.pointsSimplified.toLocaleString('es')}; total ${mb(s.totalBytes ?? 0)}, máx ${kb(s.maxBytes ?? 0)} (${s.maxRouteId})`,
    );
    if (s.worst?.length > 0) console.log(`peores líneas: ${s.worst.join(' | ')}`);
  }

  const errors = [
    ...validateArtifacts(artifacts),
    ...validateShapes(feedsHaveShapesFile && !opts.skipShapes, shapes, prevShapesCount),
  ];
  if (errors.length > 0) {
    console.error('Validación FALLADA (no se escribe nada):');
    for (const e of errors) console.error(` - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('Validación superada.');

  const stopsValue = JSON.stringify(artifacts.stops);
  const linesValue = JSON.stringify({ count: artifacts.lines.length, lines: artifacts.lines });
  let totalLineBytes = 0;
  let maxLineBytes = 0;
  let maxLineRoute = '';
  const lineValues = [];
  for (const [routeId, doc] of artifacts.lineDocs) {
    const value = JSON.stringify(doc);
    const bytes = Buffer.byteLength(value);
    totalLineBytes += bytes;
    if (bytes > maxLineBytes) {
      maxLineBytes = bytes;
      maxLineRoute = routeId;
    }
    lineValues.push([`${KV_KEYS.LINE_PREFIX}${routeId}`, value]);
  }
  console.log(
    `artefactos: stops:all ${mb(Buffer.byteLength(stopsValue))} | lines:all ${mb(Buffer.byteLength(linesValue))} | ${lineValues.length} lineas, total ${mb(totalLineBytes)}, max ${mb(maxLineBytes)} (${maxLineRoute})`,
  );

  if (opts.dryRun) {
    console.log(
      `== Dry-run completado en ${((Date.now() - started) / 1000).toFixed(1)}s (sin escrituras) ==`,
    );
    return;
  }

  let writes = 0;
  console.log(`Escribiendo KV (namespace ${cfg.namespaceId})...`);
  writes += await kvPut(cfg, token, KV_KEYS.STOPS_ALL, stopsValue);
  writes += await kvPut(cfg, token, KV_KEYS.LINES_ALL, linesValue);
  const chunk = 8;
  for (let i = 0; i < lineValues.length; i += chunk) {
    const part = lineValues.slice(i, i + chunk);
    const sizes = await Promise.all(part.map(([key, value]) => kvPut(cfg, token, key, value)));
    writes += sizes.reduce((a, b) => a + b, 0);
  }
  console.log(
    `Escritos ${2 + lineValues.length} valores (${mb(writes)}). Purgando claves obsoletas...`,
  );

  const existing = await kvListLineKeys(cfg, token);
  const wanted = new Set(lineValues.map(([key]) => key));
  const stale = existing.filter((k) => !wanted.has(k));
  for (const key of stale) await kvDelete(cfg, token, key);
  console.log(`Purgadas ${stale.length} claves obsoletas de crtm:line:*.`);

  let shapesMeta = null;
  if (!opts.skipShapes && feedsHaveShapesFile) {
    if (!cfg.r2Bucket)
      throw new Error('No se pudo leer el bucket R2 (binding CRTM_SHAPES) de wrangler.toml');
    console.log(
      `Escribiendo ${shapes.docs.size} geometrías en R2 (bucket ${cfg.r2Bucket}, prefijo ${SHAPES.OBJECT_PREFIX})...`,
    );
    const shapeEntries = [...shapes.docs.entries()].map(([routeId, doc]) => [
      `${SHAPES.OBJECT_PREFIX}${routeId}.json`,
      JSON.stringify(doc),
    ]);
    let shapeBytes = 0;
    const r2chunk = 8;
    for (let i = 0; i < shapeEntries.length; i += r2chunk) {
      const part = shapeEntries.slice(i, i + r2chunk);
      const sizes = await Promise.all(part.map(([key, value]) => r2Put(cfg, token, key, value)));
      shapeBytes += sizes.reduce((a, b) => a + b, 0);
    }
    const existingShapeKeys = await r2ListKeys(cfg, token, SHAPES.OBJECT_PREFIX);
    const wantedShapeKeys = new Set(shapeEntries.map(([key]) => key));
    const staleShapes = existingShapeKeys.filter(
      (k) => k.startsWith(SHAPES.OBJECT_PREFIX) && !wantedShapeKeys.has(k),
    );
    for (const key of staleShapes) await r2Delete(cfg, token, key);
    console.log(
      `Escritas ${shapeEntries.length} geometrías (${mb(shapeBytes)}); purgadas ${staleShapes.length} obsoletas de R2.`,
    );
    shapesMeta = {
      bucket: cfg.r2Bucket,
      count: shapeEntries.length,
      totalBytes: shapeBytes,
      maxBytes: s.maxBytes ?? 0,
      maxRouteId: s.maxRouteId,
    };
  }

  const meta = {
    versions: Object.fromEntries(
      FEEDS.map((f) => [
        f.network,
        {
          itemModified: itemMetas[f.network].modified,
          zipBytes: zips[f.network].buf.length,
          feedVersions: c.feedVersions[f.network] ?? [],
          // feeds en modo catálogo (calendario caducado): sus líneas/paradas están en los
          // artefactos pero sin horarios; se registran para que el short-circuit por
          // `modified` siga funcionando
          ...(staleCalendarEnd[f.network] !== undefined
            ? {
                catalogOnly: `calendario caducado (${staleCalendarEnd[f.network] ?? 'sin fechas'})`,
              }
            : {}),
        },
      ]),
    ),
    generatedAt: new Date().toISOString(),
    counts: c,
    ...(shapesMeta ? { shapes: shapesMeta } : {}),
  };
  await kvPut(cfg, token, KV_KEYS.META, JSON.stringify(meta));
  console.log(`== CRTM ingest OK en ${((Date.now() - started) / 1000).toFixed(1)}s ==`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`ERROR: ${err?.message ?? err}`);
    process.exit(1);
  });
}
