import type { Stop } from '../types/emt-data';
import type { CRTMStop } from '../types/crtm-data';
import { normalizeText } from './text-utils';

/**
 * Índice de búsqueda de paradas: los campos de texto ya normalizados junto a la parada
 * original. /search (la web lo consulta en cada pulsación del buscador) y los dos
 * /stops/search filtran sobre estos campos; normalizar por parada y campo en cada
 * petición costaba ~28 ms de CPU con ~13k paradas × 3 campos.
 *
 * El código (stopId/code) viaja SIN normalizar dentro de `stop`: se compara raw a
 * propósito porque los ceros a la izquierda importan.
 */
export interface IndexedEmtStop {
  stop: Stop;
  name: string;
}

export interface IndexedCrtmStop {
  stop: CRTMStop;
  name: string;
  address: string;
  municipality: string;
}

// El índice cuelga del propio array memoizado del artefacto (WeakMap por identidad): vive
// exactamente lo que viva el valor del memo de emt-cache/crtm-cache (getCachedJSON con memo,
// TTL ARTIFACTS_MEMO_TTL_MS) y no puede desincronizarse de él — una recarga del artefacto es
// un array nuevo (JSON.parse) y con él se reconstruye el índice. Sin env ni TTL propio.
const emtIndexMemo = new WeakMap<Stop[], IndexedEmtStop[]>();
const crtmIndexMemo = new WeakMap<CRTMStop[], IndexedCrtmStop[]>();

/**
 * Índice normalizado de stops:all EMT (solo name: el artefacto no lleva dirección ni municipio)
 */
export function emtStopIndex(stops: Stop[]): IndexedEmtStop[] {
  let index = emtIndexMemo.get(stops);
  if (index) return index;
  index = stops.map((stop) => ({ stop, name: normalizeText(stop.name) }));
  emtIndexMemo.set(stops, index);
  return index;
}

/**
 * Índice normalizado de crtm:stops:all (name + address + municipality; null → cadena vacía)
 */
export function crtmStopIndex(stops: CRTMStop[]): IndexedCrtmStop[] {
  let index = crtmIndexMemo.get(stops);
  if (index) return index;
  index = stops.map((stop) => ({
    stop,
    name: normalizeText(stop.name),
    address: stop.address ? normalizeText(stop.address) : '',
    municipality: stop.municipality ? normalizeText(stop.municipality) : '',
  }));
  crtmIndexMemo.set(stops, index);
  return index;
}
