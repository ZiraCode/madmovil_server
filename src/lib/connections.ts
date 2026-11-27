import type { Line, Stop } from '../types/emt-data';
import type { CRTMLineSummary, CRTMNetwork, CRTMStop } from '../types/crtm-data';
import { haversineDistanceM } from './geo';
import {
  buildNetworksByLabel,
  crtmCodeNetwork,
  crtmStopNetworks,
  labelCollator,
  type SearchNetwork,
} from './search';

/**
 * Conexiones/transbordos de una parada: líneas de OTRAS paradas físicas en un radio a pie.
 * Los intercambiadores son N paradas con códigos distintos (EMT 602 + CRTM 06002 + metro
 * 4_202 + cercanías r_*), y las líneas conectadas viven en registros separados de los
 * artefactos. Servido al 100% desde caché (mismo patrón que /search y /nearby): haversine
 * sobre stops:all EMT+CRTM, dedup por red+label (el label '3' de EMT y el de metro son
 * líneas distintas, nunca se deduplican entre redes) y agrupación por red con la distancia
 * de la parada más cercana de esa red.
 *
 * Las líneas de la PROPIA parada no son transbordo (la ficha ya las muestra): se deduplican
 * con clave red|label. El bus CRTM (código numérico) no identifica red por sí solo: cada
 * label se resuelve contra crtm:lines:all restringido a interurban/urban (mismo criterio
 * que /search); sin ese artefacto esas líneas no aportan transbordos (familia degraded en
 * la ruta), pero metro/ML/cercanías siguen funcionando (red por prefijo de código).
 */

export type ConnectionSource = 'emt' | 'crtm';

// Línea de transbordo: misma forma que los resultados de línea de /search (chips reutilizables)
export interface ConnectionLineRef {
  source: ConnectionSource;
  network: SearchNetwork;
  label: string;
  id: string | null; // lineId EMT / routeId CRTM; null si lines:all no la resuelve (el chip se pinta igual)
  name: string | null;
  color?: string;
  textColor?: string;
  noSchedule?: true;
}

// Grupo de transbordo por red, con la distancia a la parada más cercana de esa red
export interface ConnectionGroup {
  network: SearchNetwork;
  distanceM: number;
  lines: ConnectionLineRef[];
}

// Parada cercana que aporta conexiones (desglose físico; lines = labels crudos del artefacto)
export interface NearbyStop {
  source: ConnectionSource;
  id: string;
  name: string;
  municipality: string | null;
  distanceM: number;
  networks: SearchNetwork[];
  lines: string[];
}

export interface StopConnectionsArgs {
  source: ConnectionSource;
  stopId: string;
  radiusM: number;
  emtStops: Stop[] | null; // null = familia EMT no disponible (degradada)
  emtLines: Line[] | null;
  crtmStops: CRTMStop[] | null;
  crtmLines: CRTMLineSummary[] | null;
}

export interface StopConnectionsResult {
  origin: { source: ConnectionSource; stopId: string; name: string; networks: SearchNetwork[] };
  radiusM: number;
  stops: NearbyStop[];
  transferCount: number;
  groups: ConnectionGroup[];
}

const lineKey = (network: SearchNetwork, label: string): string => `${network}|${label}`;

function emtLineIndex(lines: Line[]): Map<string, Line> {
  const map = new Map<string, Line>();
  for (const line of lines) {
    if (!map.has(line.label)) map.set(line.label, line);
  }
  return map;
}

function crtmLineIndex(lines: CRTMLineSummary[]): Map<string, CRTMLineSummary> {
  const map = new Map<string, CRTMLineSummary>();
  for (const line of lines) {
    const key = lineKey(line.network, line.label);
    if (!map.has(key)) map.set(key, line);
  }
  return map;
}

function emtLineRef(label: string, line: Line | null): ConnectionLineRef {
  return {
    source: 'emt',
    network: 'emt',
    label,
    id: line ? line.lineId : null,
    name: line ? `${line.nameA} - ${line.nameB}` : null,
    ...(line?.color ? { color: line.color } : {}),
  };
}

function crtmLineRef(
  label: string,
  network: CRTMNetwork,
  summary: CRTMLineSummary | null,
): ConnectionLineRef {
  return {
    source: 'crtm',
    network,
    label,
    id: summary ? summary.routeId : null,
    name: summary ? summary.name : null,
    ...(summary?.color ? { color: summary.color } : {}),
    ...(summary?.textColor ? { textColor: summary.textColor } : {}),
    ...(summary?.noSchedule ? { noSchedule: true } : {}),
  };
}

export function findStopConnections(args: StopConnectionsArgs): StopConnectionsResult | null {
  const networksByLabel = args.crtmLines ? buildNetworksByLabel(args.crtmLines) : null;
  const crtmLinesByKey = args.crtmLines ? crtmLineIndex(args.crtmLines) : null;
  const emtLinesByLabel = args.emtLines ? emtLineIndex(args.emtLines) : null;
  const emptyNetworks: Map<string, CRTMNetwork[]> = new Map();

  let originName: string;
  let originNetworks: SearchNetwork[];
  let originKeys: Set<string>;
  let originLat: number | null = 0;
  let originLon: number | null = 0;

  if (args.source === 'emt') {
    const stop = args.emtStops?.find((s) => s.stopId === args.stopId);
    if (!stop) return null;
    originName = stop.name;
    originNetworks = ['emt'];
    originKeys = new Set(stop.lines.map((label) => lineKey('emt', label)));
    originLat = stop.coordinates.latitude;
    originLon = stop.coordinates.longitude;
  } else {
    const stop = args.crtmStops?.find((s) => s.code === args.stopId);
    if (!stop) return null;
    const fixedNetwork = crtmCodeNetwork(stop.code);
    originName = stop.name;
    originNetworks = crtmStopNetworks(stop, networksByLabel ?? emptyNetworks);
    if (fixedNetwork) {
      originKeys = new Set(stop.lines.map((label) => lineKey(fixedNetwork, label)));
    } else {
      originKeys = new Set<string>();
      for (const label of stop.lines) {
        for (const network of networksByLabel?.get(label) ?? []) {
          if (network === 'interurban' || network === 'urban')
            originKeys.add(lineKey(network, label));
        }
      }
    }
    originLat = stop.lat;
    originLon = stop.lon;
  }

  const stops: NearbyStop[] = [];
  const seen = new Set(originKeys);
  const groupLines = new Map<SearchNetwork, ConnectionLineRef[]>();
  const networkMinDistance = new Map<SearchNetwork, number>();

  const touchNetwork = (network: SearchNetwork, distanceM: number): void => {
    const current = networkMinDistance.get(network);
    if (current === undefined || distanceM < current) networkMinDistance.set(network, distanceM);
  };

  const addLine = (network: SearchNetwork, label: string, ref: ConnectionLineRef): void => {
    const key = lineKey(network, label);
    if (seen.has(key)) return;
    seen.add(key);
    let lines = groupLines.get(network);
    if (!lines) {
      lines = [];
      groupLines.set(network, lines);
    }
    lines.push(ref);
  };

  if (originLat !== null && originLon !== null) {
    if (args.emtStops) {
      for (const stop of args.emtStops) {
        if (args.source === 'emt' && stop.stopId === args.stopId) continue;
        const distanceM = Math.round(
          haversineDistanceM(
            originLat,
            originLon,
            stop.coordinates.latitude,
            stop.coordinates.longitude,
          ),
        );
        if (distanceM > args.radiusM) continue;
        touchNetwork('emt', distanceM);
        stops.push({
          source: 'emt',
          id: stop.stopId,
          name: stop.name,
          municipality: null,
          distanceM,
          networks: ['emt'],
          lines: stop.lines,
        });
        for (const label of stop.lines) {
          addLine('emt', label, emtLineRef(label, emtLinesByLabel?.get(label) ?? null));
        }
      }
    }

    if (args.crtmStops) {
      for (const stop of args.crtmStops) {
        if (args.source === 'crtm' && stop.code === args.stopId) continue;
        if (stop.lat === null || stop.lon === null) continue;
        const distanceM = Math.round(haversineDistanceM(originLat, originLon, stop.lat, stop.lon));
        if (distanceM > args.radiusM) continue;
        const fixedNetwork = crtmCodeNetwork(stop.code);
        const stopNetworks = crtmStopNetworks(stop, networksByLabel ?? emptyNetworks);
        for (const network of stopNetworks) touchNetwork(network, distanceM);
        stops.push({
          source: 'crtm',
          id: stop.code,
          name: stop.name,
          municipality: stop.municipality,
          distanceM,
          networks: stopNetworks,
          lines: stop.lines,
        });
        for (const label of stop.lines) {
          if (fixedNetwork) {
            const summary = crtmLinesByKey?.get(lineKey(fixedNetwork, label)) ?? null;
            addLine(fixedNetwork, label, crtmLineRef(label, fixedNetwork, summary));
          } else {
            for (const network of networksByLabel?.get(label) ?? []) {
              if (network !== 'interurban' && network !== 'urban') continue;
              const summary = crtmLinesByKey?.get(lineKey(network, label)) ?? null;
              addLine(network, label, crtmLineRef(label, network, summary));
            }
          }
        }
      }
    }
  }

  stops.sort(
    (a, b) =>
      a.distanceM - b.distanceM || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
  );

  const groups: ConnectionGroup[] = [];
  for (const [network, lines] of groupLines) {
    lines.sort((a, b) => labelCollator.compare(a.label, b.label));
    groups.push({ network, distanceM: networkMinDistance.get(network)!, lines });
  }
  groups.sort((a, b) => a.distanceM - b.distanceM || a.network.localeCompare(b.network));

  return {
    origin: {
      source: args.source,
      stopId: args.stopId,
      name: originName,
      networks: originNetworks,
    },
    radiusM: args.radiusM,
    stops,
    transferCount: groups.reduce((count, group) => count + group.lines.length, 0),
    groups,
  };
}
