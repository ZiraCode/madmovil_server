import type { Env } from '../types';
import type { Stop, Line } from '../types/emt-data';
import type { CRTMStop, CRTMLineSummary } from '../types/crtm-data';
import { getCachedLines, getCachedStops } from './emt-cache';
import { getCRTMLinesAll, getCRTMStops } from './crtm-cache';

export type ArtifactFamily = 'emt' | 'crtm';

/**
 * null = familia NO disponible, sea porque su cargador rechazó o porque resolvió a null;
 * `degraded` solo refleja que un cargador RECHAZÓ — no deriva disponibilidad por sí solo
 * (/connections decide su 503 con originStops === null, no con degraded)
 */
export interface ArtifactFamilies {
  emtLines: Line[] | null;
  emtStops: Stop[] | null;
  crtmLines: CRTMLineSummary[] | null;
  crtmStops: CRTMStop[] | null;
  degraded: ArtifactFamily[];
}

function settleError(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'rejected' ? result.reason : null;
}

/**
 * Carga las 4 familias de artefactos (lines:all/stops:all EMT + crtm:lines:all/crtm:stops:all)
 * en paralelo e independientes, con null POR CARGADOR: una familia caída no anula la otra —
 * /search con lines:all EMT caído pero stops:all sano sigue sirviendo las paradas EMT con
 * degraded ['emt']. `degraded` se empuja si CUALQUIERA de los dos cargadores de la familia
 * falla; loguea la primera razón disponible de cada familia con el contexto de la ruta.
 *
 * crtmLines llega DESENVUELTO (CRTMLineSummary[], sin el envoltorio { count, lines }).
 * Cada ruta decide su política con el resultado: /search y /catalog miran degraded.length === 2,
 * /connections solo el stops:all de la familia del :source; el 503 y su texto son de la ruta.
 * crtm:meta NO se carga aquí (getCRTMMeta no está memoizado y /search es el endpoint más
 * llamado): lo pide aparte quien lo necesite (hoy solo /catalog).
 */
export async function loadArtifactFamilies(env: Env, context: string): Promise<ArtifactFamilies> {
  const [emtLines, emtStops, crtmLines, crtmStops] = await Promise.allSettled([
    getCachedLines(env),
    getCachedStops(env),
    getCRTMLinesAll(env),
    getCRTMStops(env),
  ]);

  const degraded: ArtifactFamily[] = [];
  if (emtLines.status === 'rejected' || emtStops.status === 'rejected') {
    console.error(`${context} sin datos EMT:`, settleError(emtLines) ?? settleError(emtStops));
    degraded.push('emt');
  }
  if (crtmLines.status === 'rejected' || crtmStops.status === 'rejected') {
    console.error(`${context} sin datos CRTM:`, settleError(crtmLines) ?? settleError(crtmStops));
    degraded.push('crtm');
  }

  return {
    emtLines: emtLines.status === 'fulfilled' ? emtLines.value : null,
    emtStops: emtStops.status === 'fulfilled' ? emtStops.value : null,
    crtmLines: crtmLines.status === 'fulfilled' ? crtmLines.value.lines : null,
    crtmStops: crtmStops.status === 'fulfilled' ? crtmStops.value : null,
    degraded,
  };
}
