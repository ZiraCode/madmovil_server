import type { Env } from '../types';
import type {
  CRTMStop,
  CRTMLineDoc,
  CRTMLinesAll,
  CRTMMeta,
  CRTMLineRouteDoc,
} from '../types/crtm-data';
import { widgetDestinations, type WidgetDestinations } from './crtm-schedule';
import { CRTM_CONFIG } from './config';
import { getCachedArtifact, createArtifactMemo } from './kv-cache';

export class CRTMDataUnavailableError extends Error {
  constructor() {
    super('Datos CRTM no disponibles (carga inicial del pipeline pendiente o incompleta)');
    this.name = 'CRTMDataUnavailableError';
  }
}

export class CRTMStopNotFoundError extends Error {
  constructor(stopCode: string) {
    super(`No existe la parada CRTM ${stopCode}`);
    this.name = 'CRTMStopNotFoundError';
  }
}

export class CRTMLineNotFoundError extends Error {
  constructor(id: string) {
    super(`No existe la línea CRTM ${id}`);
    this.name = 'CRTMLineNotFoundError';
  }
}

export class CRTMNoGeometryError extends Error {
  constructor(id: string) {
    super(
      `La línea CRTM ${id} existe pero no tiene geometría disponible (su feed no publica shapes)`,
    );
    this.name = 'CRTMNoGeometryError';
  }
}

// Los artefactos CRTM los escribe el pipeline de ingesta (TTL 0, refresco explícito), nunca
// el worker: clave ausente en KV = datos no disponibles. Modelado como fetcher que lanza para
// getCachedJSON (kv-cache.ts)
function dataUnavailable(): never {
  throw new CRTMDataUnavailableError();
}

// Un valor vacío en KV es "datos no disponibles" (503), no un JSON corrupto (500): el
// getRequired que getCachedJSON sustituyó decidía el miss con falsy y el genérico lo
// decide con raw !== null
function parseOrUnavailable<T>(raw: string): T {
  if (!raw) dataUnavailable();
  return JSON.parse(raw) as T;
}

// stops:all (1,61 MB) y lines:all se cachean por isolate con el TTL de artefactos (el
// artefacto solo cambia con el pipeline diario); single-flight con expulsión del fallo,
// ver kv-cache.ts
const stopsMemo = createArtifactMemo<CRTMStop[]>(
  CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
  CRTM_CONFIG.ARTIFACTS_MEMO_TTL_MS,
);
const linesAllMemo = createArtifactMemo<CRTMLinesAll>(
  CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
  CRTM_CONFIG.ARTIFACTS_MEMO_TTL_MS,
);

// El GTFS CRTM publica route_url del portal antiguo (www.crtm.es/<routeId>.aspx, 404 desde la
// migración a Umbraco); la ficha actual es la misma ruta sin extensión. El pipeline normaliza
// en origen desde 2026-08-29; esto cubre los artefactos KV escritos antes (patrón exacto)
function normalizeLineUrl(url: string | null): string | null {
  if (!url) return url;
  return url.replace(/^(https?:\/\/(?:www\.)?crtm\.es\/[^/?#]+?)\.aspx(?=[?#]|$)/i, '$1');
}

/**
 * Paradas CRTM del caché (crtm:stops:all, escrito por el pipeline de ingesta)
 */
export function getCRTMStops(env: Env): Promise<CRTMStop[]> {
  return getCachedArtifact<CRTMStop[]>(env, stopsMemo, dataUnavailable, parseOrUnavailable);
}

/**
 * Listado de líneas CRTM (crtm:lines:all) para chips y para resolver label/routeId → doc
 */
export function getCRTMLinesAll(env: Env): Promise<CRTMLinesAll> {
  return getCachedArtifact(env, linesAllMemo, dataUnavailable, (raw) => {
    const all = parseOrUnavailable<CRTMLinesAll>(raw);
    for (const line of all.lines) line.url = normalizeLineUrl(line.url);
    return all;
  });
}

/**
 * Meta del pipeline (crtm:meta); null si todavía no hay carga inicial
 */
export async function getCRTMMeta(env: Env): Promise<CRTMMeta | null> {
  const raw = await env.EMT_CACHE.get(CRTM_CONFIG.CACHE_KEYS.META);
  return raw ? (JSON.parse(raw) as CRTMMeta) : null;
}

// S2 (auditoría de CPU 2026-11-24, sesión 6 de AUDIT.md): memo por isolate de los docs de
// línea. Los schedule/arrivals de estaciones r_* y las fichas grandes parsean docs multi-MB
// en CADA petición (crtm:line:10T_C5 = 3,25 MB; un hub de cercanías carga los 12 docs,
// 11,35 MB medidos en KV remoto), sin memo: 24-125 ms de CPU por schedule r_*. A diferencia
// de los artefactos (4 claves memoizadas con ARTIFACTS_MEMO_TTL_MS) aquí hay 482 docs, así
// que el memo lleva TTL corto y techo de bytes FIFO: rotación de memoria en isolates de
// tráfico disperso sin crecer sin límite. Single-flight (C-12): la PROMESA se memoiza por
// routeId — N peticiones concurrentes comparten una sola lectura KV + un solo parse — y el
// fallo se expulsa (pending.catch): un CRTMDataUnavailableError nunca queda memoizado; un
// null de doc ausente sí (routeId del widget fuera de los artefactos → no se relee KV hasta
// caducar el TTL)
interface LineDocMemoEntry {
  value: Promise<CRTMLineDoc | null>;
  expiresAt: number;
  bytes: number; // longitud del valor crudo de KV: proxy del coste en memoria del doc parseado
}

interface LineDocMemoStore {
  entries: Map<string, LineDocMemoEntry>;
  totalBytes: number;
}

const lineDocMemo = new WeakMap<object, LineDocMemoStore>();

function lineDocMemoStore(env: Env): LineDocMemoStore {
  let store = lineDocMemo.get(env.EMT_CACHE);
  if (!store) {
    store = { entries: new Map(), totalBytes: 0 };
    lineDocMemo.set(env.EMT_CACHE, store);
  }
  return store;
}

function evictLineDoc(store: LineDocMemoStore, routeId: string): void {
  const entry = store.entries.get(routeId);
  if (entry) {
    store.entries.delete(routeId);
    store.totalBytes -= entry.bytes;
  }
}

// purga del techo (patrón pruneFifo de crtm-widget / C-18): expiradas primero, luego FIFO
// por la más antigua hasta bajar de los techos de bytes y de entradas
function pruneLineDocMemo(store: LineDocMemoStore): void {
  const now = Date.now();
  for (const [routeId, entry] of store.entries) {
    if (entry.expiresAt <= now) evictLineDoc(store, routeId);
  }
  while (
    store.totalBytes > CRTM_CONFIG.LINE_DOCS_MEMO_MAX_BYTES ||
    store.entries.size > CRTM_CONFIG.LINE_DOCS_MEMO_MAX_ENTRIES
  ) {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [routeId, entry] of store.entries) {
      if (entry.expiresAt < oldest) {
        oldest = entry.expiresAt;
        oldestId = routeId;
      }
    }
    if (oldestId === null) break; // mapa vacío: los techos ya no pueden incumplirse
    evictLineDoc(store, oldestId);
  }
}

// La entrada se crea y la lectura KV arranca ANTES de tocar el mapa: las concurrentes del
// mismo routeId llegan al hit de la promesa (una sola lectura + un solo parse)
function newLineDocEntry(env: Env, routeId: string, store: LineDocMemoStore): LineDocMemoEntry {
  const entry: LineDocMemoEntry = {
    value: Promise.resolve(null),
    expiresAt: Date.now() + CRTM_CONFIG.LINE_DOCS_MEMO_TTL_MS,
    bytes: 0,
  };
  entry.value = env.EMT_CACHE.get(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${routeId}`).then((raw) => {
    if (raw === null) return null; // doc ausente: null memoizable
    const doc = parseOrUnavailable<CRTMLineDoc>(raw);
    // contabilidad de bytes solo si la entrada sigue viva en el mapa: una purga pudo
    // desalojarla mientras esta lectura estaba en vuelo
    if (store.entries.get(routeId) === entry) {
      entry.bytes = raw.length;
      store.totalBytes += raw.length;
      pruneLineDocMemo(store);
    }
    return doc;
  });
  // un fallo (valor vacío en KV → CRTMDataUnavailableError) se expulsa: reintento ya
  entry.value.catch(() => {
    if (store.entries.get(routeId) === entry) store.entries.delete(routeId);
  });
  return entry;
}

function getLineDoc(env: Env, routeId: string): Promise<CRTMLineDoc | null> {
  const store = lineDocMemoStore(env);
  const hit = store.entries.get(routeId);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  const entry = newLineDocEntry(env, routeId, store);
  // sustituye una expirada que aún ocupe la clave (su promesa en vuelo ya no es de nadie:
  // la contabilidad de ambas se protege por identidad de entrada)
  evictLineDoc(store, routeId);
  store.entries.set(routeId, entry);
  return entry.value;
}

/**
 * Docs de línea por routeId, alineados con la entrada (null = doc ausente en KV):
 * getCRTMWidgetDestinations lo usa para saber QUÉ routeId no resolvió y no releerlo.
 * Sirve del memo por isolate (arriba): las concurrentes del mismo routeId comparten
 * lectura + parse
 */
async function getLineDocsOrNull(env: Env, routeIds: string[]): Promise<(CRTMLineDoc | null)[]> {
  return Promise.all(routeIds.map((routeId) => getLineDoc(env, routeId)));
}

/** Docs de línea por routeId, solo los presentes en KV */
function getLineDocsByRouteIds(env: Env, routeIds: string[]): Promise<CRTMLineDoc[]> {
  return getLineDocsOrNull(env, routeIds).then((docs) =>
    docs.filter((doc): doc is CRTMLineDoc => doc !== null),
  );
}

/**
 * Docs de línea que sirven una parada: labels de la parada → todos los routeIds con ese label
 * Los labels están duplicados entre redes (p. ej. '1' interurbana y urbana): se cargan todos
 * los docs y computeStopDepartures filtra por presencia real del código de parada en los trips
 */
export async function getCRTMStopLineDocs(env: Env, stop: CRTMStop): Promise<CRTMLineDoc[]> {
  const all = await getCRTMLinesAll(env);
  const labels = new Set(stop.lines);
  const routeIds = all.lines.filter((l) => labels.has(l.label)).map((l) => l.routeId);
  return getLineDocsByRouteIds(env, routeIds);
}

// entrada del memo de destinos del widget: Map perezoso por routeId (no promesa — se
// rellena por clave a demanda), TTL de artefactos
interface WidgetDestMemoEntry {
  value: Map<string, WidgetDestinations | null>;
  expiresAt: number;
}

const widgetDestMemo = new WeakMap<object, WidgetDestMemoEntry>();

/**
 * Destino canónico por (routeId, dir) para el tablón RT del widget (mode(dest) > cabecera,
 * ver widgetDestinations). Memo por isolate con el TTL de artefactos: los docs de línea son
 * multi-KB y el board se polea cada 30 s. Entrada null = doc ausente en KV (routeId del SAE
 * fuera de los artefactos) → la UI conserva el dest del widget sin releer KV.
 */
export async function getCRTMWidgetDestinations(
  env: Env,
  routeIds: string[],
  stopNameOf: (code: string) => string | null | undefined,
): Promise<Map<string, WidgetDestinations | null>> {
  let cached = widgetDestMemo.get(env.EMT_CACHE);
  if (!cached || cached.expiresAt <= Date.now()) {
    cached = { value: new Map(), expiresAt: Date.now() + CRTM_CONFIG.ARTIFACTS_MEMO_TTL_MS };
    widgetDestMemo.set(env.EMT_CACHE, cached);
  }
  const map = cached.value;
  const missing = routeIds.filter((id) => !map.has(id));
  if (missing.length > 0) {
    const docs = await getLineDocsOrNull(env, missing);
    missing.forEach((id, i) => {
      const doc = docs[i];
      map.set(id, doc !== null ? widgetDestinations(doc, stopNameOf) : null);
    });
  }
  return map;
}

/**
 * Resuelve un identificador de línea (routeId exacto o label) a sus docs de KV
 * Un label puede corresponder a varias líneas (redes distintas) → devuelve array
 * @throws CRTMLineNotFoundError si no hay coincidencias en lines:all
 */
export async function resolveCRTMLineDocs(env: Env, id: string): Promise<CRTMLineDoc[]> {
  const all = await getCRTMLinesAll(env);
  const matches = all.lines.filter((l) => l.routeId === id || l.label === id);
  if (matches.length === 0) {
    throw new CRTMLineNotFoundError(id);
  }
  const docs = await getLineDocsByRouteIds(
    env,
    matches.map((m) => m.routeId),
  );
  if (docs.length === 0) {
    throw new CRTMDataUnavailableError();
  }
  for (const doc of docs) doc.url = normalizeLineUrl(doc.url);
  return docs;
}

/**
 * Geometría de recorrido de una línea CRTM (R2, línea por línea; el worker nunca toca shapes GTFS crudos)
 * 404 con dos criterios distintos: CRTMLineNotFoundError (routeId inexistente en lines:all)
 * vs CRTMNoGeometryError (línea válida sin objeto en R2 — feed sin shapes)
 * @throws CRTMLineNotFoundError / CRTMNoGeometryError / CRTMDataUnavailableError
 */
export async function getCRTMLineRoute(env: Env, routeId: string): Promise<CRTMLineRouteDoc> {
  const all = await getCRTMLinesAll(env);
  if (!all.lines.some((l) => l.routeId === routeId)) {
    throw new CRTMLineNotFoundError(routeId);
  }
  if (!env.CRTM_SHAPES) {
    throw new CRTMDataUnavailableError();
  }
  let body: string;
  try {
    const object = await env.CRTM_SHAPES.get(`${CRTM_CONFIG.SHAPES_OBJECT_PREFIX}${routeId}.json`);
    if (object === null) {
      throw new CRTMNoGeometryError(routeId);
    }
    body = await object.text();
  } catch (error) {
    if (error instanceof CRTMNoGeometryError) throw error;
    console.error('CRTM shapes R2 read error:', error);
    throw new CRTMDataUnavailableError();
  }
  return JSON.parse(body) as CRTMLineRouteDoc;
}
