import type { Line } from '../types/emt-data';
import type { CRTMLineSummary, CRTMNetwork, CRTMStop } from '../types/crtm-data';
import type { IndexedCrtmStop, IndexedEmtStop } from './search-index';
import { normalizeText } from './text-utils';

/**
 * Búsqueda unificada del buscador general de la web: líneas y paradas de TODAS las redes
 * (EMT + CRTM interurbano/urbano/ml/metro/cercanías) mezcladas con ranking común:
 *
 * Líneas: label exacto > prefijo de label > substring de nombre
 * Paradas: código exacto > nombre exacto > prefijo de nombre > nombre > dirección > municipio
 *
 * Query puramente numérica: en paradas solo matchea como número de vía completo
 * (frontera de dígitos, mismo criterio que /crtm/stops/search desde 2026-08-29) para
 * que "62" no devuelva "Ctra del Escorial 16200"; en labels de línea sí hay prefijo
 * ("6" sugiere 6, 60, 61...).
 *
 * Las paradas se reciben ya normalizadas (índices de search-index.ts, memoizados junto
 * al artefacto): normalizeText por parada y campo en cada request costaba ~28 ms de CPU
 * con ~13k paradas.
 */

export type SearchNetwork = 'emt' | CRTMNetwork;

export type LineMatchTier = 'label-exact' | 'label-prefix' | 'name';
export type StopMatchTier =
  | 'code-exact'
  | 'name-exact'
  | 'name-prefix'
  | 'name'
  | 'address'
  | 'municipality';

// Resultado de línea: source/network permiten a la UI pintar chips distinguibles
// (los labels están duplicados entre redes: '1' existe como bus EMT, urbana, interurbana y metro)
export interface SearchLineResult {
  type: 'line';
  source: 'emt' | 'crtm';
  network: SearchNetwork;
  label: string;
  id: string; // EMT: lineId interno; CRTM: routeId
  name: string; // EMT: "nameA - nameB"; CRTM: nombre de línea
  color?: string; // RRGGBB sin # (ausente en bus CRTM; EMT publica el suyo)
  textColor?: string;
  noSchedule?: true; // red en modo catálogo (feed stale, sin horarios oficiales)
  match: LineMatchTier;
}

export interface SearchStopResult {
  type: 'stop';
  source: 'emt' | 'crtm'; // enruta la selección: /stops/* vs /crtm/stops/*
  id: string; // EMT: stopId; CRTM: code (incluye 10_x, 4_x, r_*)
  name: string;
  municipality: string | null;
  lines: string[];
  // Red(es) del resultado para el badge de la UI: EMT siempre ['emt']. CRTM: los códigos
  // namespacelados identifican la red (r_* cercanías, 10_* ml, 4_* metro); el bus CRTM
  // (código numérico) se resuelve por las redes de sus labels filtradas a interurban/urban
  // — así el label duplicado '1' (metro/urbana/interurbana) no contamina: la estación de
  // metro Sol nunca aparece como bus, y una parada de bus nunca aparece como metro
  networks: SearchNetwork[];
  match: StopMatchTier;
}

export interface UnifiedSearchArgs {
  query: string;
  emtLines: Line[];
  crtmLines: CRTMLineSummary[];
  emtStops: IndexedEmtStop[];
  crtmStops: IndexedCrtmStop[];
  limitLines: number;
  limitStops: number;
}

export interface UnifiedSearchResult {
  lines: { count: number; returned: number; results: SearchLineResult[] };
  stops: { count: number; returned: number; results: SearchStopResult[] };
}

const LINE_TIER: Record<LineMatchTier, number> = { 'label-exact': 0, 'label-prefix': 1, name: 2 };
const STOP_TIER: Record<StopMatchTier, number> = {
  'code-exact': 0,
  'name-exact': 1,
  'name-prefix': 2,
  name: 3,
  address: 4,
  municipality: 5,
};

// Orden natural de labels: '2' < '10' < 'N13' < 'C10'
export const labelCollator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

// Red de un código de parada CRTM namespacelado (r_/10_/4_); null = bus (código numérico),
// cuya red se resuelve por las líneas que lo sirven
export function crtmCodeNetwork(code: string): CRTMNetwork | null {
  if (code.startsWith('r_')) return 'cercanias';
  if (code.startsWith('10_')) return 'ml';
  if (code.startsWith('4_')) return 'metro';
  return null;
}

// Redes por label de CRTM (un label puede vivir en varias redes: '1' urbana + interurbana + metro)
export function buildNetworksByLabel(crtmLines: CRTMLineSummary[]): Map<string, CRTMNetwork[]> {
  const map = new Map<string, CRTMNetwork[]>();
  for (const line of crtmLines) {
    const networks = map.get(line.label);
    if (networks) {
      if (!networks.includes(line.network)) networks.push(line.network);
    } else {
      map.set(line.label, [line.network]);
    }
  }
  return map;
}

// Red(es) de una parada CRTM: código namespacelado → red directa; bus (numérico) → redes
// de sus labels restringidas a interurban/urban
export function crtmStopNetworks(
  stop: CRTMStop,
  networksByLabel: Map<string, CRTMNetwork[]>,
): CRTMNetwork[] {
  const fixed = crtmCodeNetwork(stop.code);
  if (fixed) return [fixed];
  const bus = new Set<CRTMNetwork>();
  for (const label of stop.lines) {
    for (const network of networksByLabel.get(label) ?? []) {
      if (network === 'interurban' || network === 'urban') bus.add(network);
    }
  }
  return [...bus];
}

function matchEmtLine(line: Line, q: string): LineMatchTier | null {
  const nLabel = normalizeText(line.label);
  if (nLabel === q) return 'label-exact';
  if (nLabel.startsWith(q)) return 'label-prefix';
  if (normalizeText(line.nameA).includes(q) || normalizeText(line.nameB).includes(q)) return 'name';
  return null;
}

function matchCrtmLine(line: CRTMLineSummary, q: string): LineMatchTier | null {
  const nLabel = normalizeText(line.label);
  if (nLabel === q) return 'label-exact';
  if (nLabel.startsWith(q)) return 'label-prefix';
  if (normalizeText(line.name).includes(q)) return 'name';
  return null;
}

function matchEmtStop(
  entry: IndexedEmtStop,
  rawQuery: string,
  q: string,
  numeric: boolean,
  boundary: RegExp | null,
): StopMatchTier | null {
  // código por comparación raw: los stopId son dígitos limpios y el cero a la izquierda importa
  if (entry.stop.stopId === rawQuery) return 'code-exact';
  const nName = entry.name;
  if (nName === q) return 'name-exact';
  if (!numeric) {
    if (nName.startsWith(q)) return 'name-prefix';
    if (nName.includes(q)) return 'name';
  } else if (boundary!.test(nName)) {
    // numérica: sin prefijo (el nombre "620 ..." no es la parada 62), solo frontera de dígitos
    return 'name';
  }
  return null;
}

function matchCrtmStop(
  entry: IndexedCrtmStop,
  rawQuery: string,
  q: string,
  numeric: boolean,
  boundary: RegExp | null,
): StopMatchTier | null {
  if (entry.stop.code === rawQuery) return 'code-exact';
  const nName = entry.name;
  if (nName === q) return 'name-exact';
  if (!numeric) {
    if (nName.startsWith(q)) return 'name-prefix';
    if (nName.includes(q)) return 'name';
    if (entry.address?.includes(q)) return 'address';
    if (entry.municipality?.includes(q)) return 'municipality';
  } else {
    if (boundary!.test(nName)) return 'name';
    if (entry.address && boundary!.test(entry.address)) return 'address';
    if (entry.municipality && boundary!.test(entry.municipality)) return 'municipality';
  }
  return null;
}

export function unifiedSearch(args: UnifiedSearchArgs): UnifiedSearchResult {
  const rawQuery = args.query.trim();
  const q = normalizeText(rawQuery);

  if (!q) {
    return {
      lines: { count: 0, returned: 0, results: [] },
      stops: { count: 0, returned: 0, results: [] },
    };
  }

  const numeric = /^\d+$/.test(q);
  const boundary = numeric ? new RegExp(`(?:^|\\D)${q}(?:\\D|$)`) : null;

  const lineMatches: Array<{ tier: number; result: SearchLineResult }> = [];
  for (const line of args.emtLines) {
    const match = matchEmtLine(line, q);
    if (match) {
      lineMatches.push({
        tier: LINE_TIER[match],
        result: {
          type: 'line',
          source: 'emt',
          network: 'emt',
          label: line.label,
          id: line.lineId,
          name: `${line.nameA} - ${line.nameB}`,
          ...(line.color ? { color: line.color } : {}),
          match,
        },
      });
    }
  }
  for (const line of args.crtmLines) {
    const match = matchCrtmLine(line, q);
    if (match) {
      lineMatches.push({
        tier: LINE_TIER[match],
        result: {
          type: 'line',
          source: 'crtm',
          network: line.network,
          label: line.label,
          id: line.routeId,
          name: line.name,
          ...(line.color ? { color: line.color } : {}),
          ...(line.textColor ? { textColor: line.textColor } : {}),
          ...(line.noSchedule ? { noSchedule: true } : {}),
          match,
        },
      });
    }
  }

  const stopMatches: Array<{ tier: number; result: SearchStopResult }> = [];
  const networksByLabel = buildNetworksByLabel(args.crtmLines);
  for (const entry of args.emtStops) {
    const match = matchEmtStop(entry, rawQuery, q, numeric, boundary);
    if (match) {
      stopMatches.push({
        tier: STOP_TIER[match],
        result: {
          type: 'stop',
          source: 'emt',
          id: entry.stop.stopId,
          name: entry.stop.name,
          municipality: null,
          lines: entry.stop.lines,
          networks: ['emt'],
          match,
        },
      });
    }
  }
  for (const entry of args.crtmStops) {
    const match = matchCrtmStop(entry, rawQuery, q, numeric, boundary);
    if (match) {
      const stop = entry.stop;
      stopMatches.push({
        tier: STOP_TIER[match],
        result: {
          type: 'stop',
          source: 'crtm',
          id: stop.code,
          name: stop.name,
          municipality: stop.municipality,
          lines: stop.lines,
          networks: crtmStopNetworks(stop, networksByLabel),
          match,
        },
      });
    }
  }

  // sort estable: dentro del mismo tier, líneas por label (orden natural) y paradas por
  // longitud de nombre (más corto = match más concreto); EMT precede a CRTM por orden de inserción
  lineMatches.sort(
    (a, b) => a.tier - b.tier || labelCollator.compare(a.result.label, b.result.label),
  );
  stopMatches.sort((a, b) => a.tier - b.tier || a.result.name.length - b.result.name.length);

  const lines = lineMatches.map((m) => m.result);
  const stops = stopMatches.map((m) => m.result);

  return {
    lines: {
      count: lines.length,
      returned: Math.min(lines.length, args.limitLines),
      results: lines.slice(0, args.limitLines),
    },
    stops: {
      count: stops.length,
      returned: Math.min(stops.length, args.limitStops),
      results: stops.slice(0, args.limitStops),
    },
  };
}
