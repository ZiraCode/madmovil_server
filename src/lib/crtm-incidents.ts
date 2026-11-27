import type { Env } from '../types';
import type { CRTMStop } from '../types/crtm-data';
import { CRTM_CONFIG } from './config';
import { normalizeText, asArray, nameTokens } from './text-utils';

// Incidencias de cercanías del widget oficial del CRTM (GetIncidentsAffectations.php?mode=5,
// sin key: mismo API no documentado que el tablón de llegadas). El feed trae las afectaciones
// que el operador carga en el SAE (verificado en vivo 2026-10-11: obras C9 Cercedilla–Cotos
// con paradas afectadas); los avisos de la web crtm.es (CMS Umbraco) son un canal DISTINTO
// sin feed estructurado, y bus/metro/ML viajan vacíos ({}).
//
// Se consulta SIEMPRE a nivel de red (mode=5, sin codLine) y se filtra local por label: el
// codLine del widget para cercanías es 5__C9___ y NO es nuestro routeId (10T_C9) — mismo
// patrón all+filtro que las incidencias EMT. Quirks SOAP→JSON conocidos: colección de 1
// elemento como objeto suelto, vacía como {}, HTTP 200 siempre y {"error": ...} = fallo.

export class CRTMIncidentsUnavailableError extends Error {
  constructor() {
    super('Incidencias de cercanías no disponibles (widget del CRTM no accesible)');
    this.name = 'CRTMIncidentsUnavailableError';
  }
}

export interface CercaniasIncident {
  label: string | null; // label de la línea (5__C9___ → C9); null = codLine no reconocido
  type: string | null; // tipo de afectación del feed (p. ej. 'AFF')
  description: string;
  affectedStops: { name: string }[]; // nombres del widget (sus códigos 5_* no son los nuestros r_*)
}

interface RawIncidentAffectation {
  codLine?: unknown;
  type?: unknown;
  description?: unknown;
  stopsAffectated?: { ShortStop?: unknown };
}

// 5__C9___ → 'C9' (el label de nuestros artefactos); formatos no reconocidos → null
function labelFromCodLine(codLine: string): string | null {
  const match = /^5__(.+?)_*$/i.exec(codLine);
  return match !== null ? match[1] : null;
}

/** Respuesta cruda del widget → incidents; null = respuesta de error del servicio */
export function parseCercaniasIncidents(raw: unknown): CercaniasIncident[] | null {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (body.error) return null;
  const collection = body.incidentsAffectations;
  if (collection === null || typeof collection !== 'object') return [];
  return asArray((collection as Record<string, unknown>).IncidentAffectation)
    .map((item) => item as RawIncidentAffectation)
    .filter((item) => typeof item.description === 'string' && item.description.length > 0)
    .map((item) => ({
      label: typeof item.codLine === 'string' ? labelFromCodLine(item.codLine) : null,
      type: typeof item.type === 'string' ? item.type : null,
      description: item.description as string,
      affectedStops: asArray(item.stopsAffectated?.ShortStop)
        .map((stop) => stop as { name?: unknown })
        .filter((stop) => typeof stop.name === 'string' && stop.name.length > 0)
        .map((stop) => ({ name: stop.name as string })),
    }));
}

// Conectores ignorados al tokenizar nombres de estación: el widget no los trae y el GTFS sí
// ("PUERTO NAVACERRADA" debe casar con "Puerto de Navacerrada") — lista propia, NO fusionar
// con las de destinos (nameTokens de text-utils está parametrizada por este motivo)
const STOP_NAME_CONNECTORS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'a', 'en']);

/**
 * Código r_* de una estación afectada a partir del nombre del widget, contra las estaciones
 * de cercanías de stops:all (los códigos 5_* del widget no tienen correspondencia publicada).
 * Igualdad normalizada > coincidencia de tokens (≥2) ganando la estación con menos tokens
 * sobrantes; sin resolución → null (la UI muestra el nombre tal cual)
 */
export function resolveIncidentStopCode(name: string, cercaniasStops: CRTMStop[]): string | null {
  const target = normalizeText(name);
  const exact = cercaniasStops.find((s) => normalizeText(s.name) === target);
  if (exact) return exact.code;

  const targetTokens = nameTokens(name, STOP_NAME_CONNECTORS);
  if (targetTokens.length < 2) return null;
  let best: { code: string; extraTokens: number } | null = null;
  for (const stop of cercaniasStops) {
    const tokens = new Set(nameTokens(stop.name, STOP_NAME_CONNECTORS));
    if (!targetTokens.every((token) => tokens.has(token))) continue;
    const extraTokens = tokens.size - targetTokens.length;
    if (best === null || extraTokens < best.extraTokens) best = { code: stop.code, extraTokens };
  }
  return best !== null ? best.code : null;
}

async function readCachedIncidents(env: Env): Promise<CercaniasIncident[] | null> {
  const cached = await env.EMT_CACHE.get(CRTM_CONFIG.INCIDENTS.CACHE_KEY);
  if (cached === null) return null;
  try {
    return JSON.parse(cached) as CercaniasIncident[];
  } catch {
    return null; // valor corrupto: se re-consulta
  }
}

async function fetchAndCacheIncidents(env: Env): Promise<CercaniasIncident[]> {
  let raw: unknown;
  try {
    const url = `${CRTM_CONFIG.WIDGET.BASE_URL}${CRTM_CONFIG.INCIDENTS.GET_INCIDENTS}?mode=${CRTM_CONFIG.INCIDENTS.CERCANIAS_MODE}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': CRTM_CONFIG.WIDGET.USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(CRTM_CONFIG.INCIDENTS.FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (error) {
    console.warn(
      `Widget CRTM incidencias no disponible: ${error instanceof Error ? error.message : error}`,
    );
    throw new CRTMIncidentsUnavailableError();
  }

  const incidents = parseCercaniasIncidents(raw);
  if (incidents === null) {
    console.warn('Widget CRTM incidencias: respuesta con error');
    throw new CRTMIncidentsUnavailableError();
  }

  try {
    await env.EMT_CACHE.put(CRTM_CONFIG.INCIDENTS.CACHE_KEY, JSON.stringify(incidents), {
      expirationTtl: CRTM_CONFIG.INCIDENTS.TTL,
    });
  } catch (error) {
    console.warn(
      `Widget CRTM incidencias: no se pudo cachear: ${error instanceof Error ? error.message : error}`,
    );
  }
  return incidents;
}

let inflight: Promise<CercaniasIncident[]> | null = null;

/**
 * Incidencias de cercanías del widget, cacheadas en KV (TTL 30 min) + single-flight del fetch
 * @throws CRTMIncidentsUnavailableError widget caído sin caché válida
 */
export async function getCercaniasIncidents(env: Env): Promise<CercaniasIncident[]> {
  const cached = await readCachedIncidents(env);
  if (cached !== null) return cached;
  if (inflight === null) {
    inflight = fetchAndCacheIncidents(env).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// Limpieza para tests
export function __resetIncidentsInflight(): void {
  inflight = null;
}
