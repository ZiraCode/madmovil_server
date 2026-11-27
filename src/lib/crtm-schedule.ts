import type { CRTMLineDoc, CRTMService, CRTMTrip } from '../types/crtm-data';
import { madridWallClock, madridInstantFromWall } from './date-utils';
import { nameTokens } from './text-utils';

const DAY_MS = 86_400_000;

export interface CRTMDeparture {
  line: string;
  routeId: string;
  network: string;
  headsign: string;
  dir: number;
  departureISO: string; // ISO 8601
  dayOffset: number; // 0 = hoy (Madrid), 1 = mañana (madrugada que pertenece al servicio de hoy)
  time: string; // HH:MM en hora Madrid
  tripId?: string; // trip_id GTFS original (docs de cercanías con tid): join con el GTFS-RT de Renfe
  stale?: true; // salida servida por el fallback de calendario caducado (patrón teórico obsoleto)
}

function dateKeyToUtcMs(dateKey: string): number {
  return Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(4, 6)) - 1,
    Number(dateKey.slice(6, 8)),
  );
}

export function shiftDateKey(dateKey: string, days: number): string {
  return new Date(dateKeyToUtcMs(dateKey) + days * DAY_MS)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
}

export function dayIndexOf(dateKey: string): number {
  return (new Date(dateKeyToUtcMs(dateKey)).getUTCDay() + 6) % 7; // 0 = lunes
}

function dayDiff(fromKey: string, toKey: string): number {
  return Math.round((dateKeyToUtcMs(toKey) - dateKeyToUtcMs(fromKey)) / DAY_MS);
}

export function formatHM(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * ¿El servicio circula en la fecha GTFS dada?
 * calendar_dates (exceptions) tiene prioridad: 1 añade, 2 retira.
 * Sin fila en calendar.txt (from/to null) el servicio solo existe por excepciones.
 */
export function serviceRunsOn(svc: CRTMService, dateKey: string, dayIndex: number): boolean {
  const exception = svc.exceptions[dateKey];
  if (exception === 1) return true;
  if (exception === 2) return false;
  if (!svc.from || !svc.to) return false;
  if (dateKey < svc.from || dateKey > svc.to) return false;
  return svc.days[dayIndex] === 1;
}

function tripStopOffsetsSecs(trip: CRTMTrip, stopCode: string): number[] {
  const prefix = `${stopCode}@`;
  const offsets: number[] = [];
  const lastIdx = trip.stops.length - 1;
  trip.stops.forEach((entry, idx) => {
    // la última parada del trip es la llegada a cabecera, no una salida (trips de 1 sola parada: degenerados, se mantienen)
    if (lastIdx > 0 && idx === lastIdx) return;
    if (entry.length > prefix.length && entry.startsWith(prefix)) {
      const off = Number(entry.slice(prefix.length));
      if (Number.isFinite(off)) offsets.push(off);
    }
  });
  return offsets;
}

/**
 * Salidas de un trip plantilla (frequencies.txt) en su primera parada:
 * instancias en [from, to) cada headway s (bandas adyacentes no duplican el borde)
 */
export function freqBandInstances(band: { from: number; to: number; headway: number }): number {
  if (!(band.headway > 0) || band.to <= band.from) return 0;
  return Math.ceil((band.to - band.from) / band.headway);
}

/**
 * Segundos de salida en la parada para cada ocurrencia del offset:
 * trip con horario exacto → dep + off; trip plantilla → from + k·headway + off por banda
 */
function tripDeparturesAtOffset(trip: CRTMTrip, off: number): number[] {
  if (trip.freq) {
    const out: number[] = [];
    for (const band of trip.freq) {
      const n = freqBandInstances(band);
      for (let k = 0; k < n; k++) out.push(band.from + k * band.headway + off);
    }
    return out;
  }
  return [(trip.dep ?? 0) + off];
}

/**
 * Fallback de calendario caducado: índices de los servicios de la última generación
 * caducada (to < dateKey) que cubren ese día de la semana. Algunos operadores publican
 * rangos truncados (p. ej. sábados 20260725..20260725 con laborables/domingos a un año);
 * si ningún patrón activo cubre el día, se sirve la última programación conocida.
 * Los servicios que aún no han empezado (from en el futuro) no rellenan huecos.
 */
export function expiredCalendarServices(
  services: CRTMService[],
  dateKey: string,
  dayIndex: number,
): Set<number> {
  const eligible = new Set<number>();
  let latestTo = '';
  for (const svc of services) {
    if (!svc.to || svc.to >= dateKey) continue;
    if (svc.days[dayIndex] !== 1) continue;
    if (svc.to > latestTo) latestTo = svc.to;
  }
  if (!latestTo) return eligible;
  services.forEach((svc, idx) => {
    if (svc.to === latestTo && svc.days[dayIndex] === 1 && svc.exceptions[dateKey] !== 2)
      eligible.add(idx);
  });
  return eligible;
}

/**
 * Destino canónico por dirección: cuando el nombre de la línea es "A - B" (las cabeceras),
 * el destino mostrado es la cabecera a la que llega la dirección en vez del headsign GTFS
 * (que suele ser la calle de la cabecera, p. ej. la 6 de Alcalá "EST. LA GARENA - VIRGEN DEL VAL"
 * usa "FERNANDO FERNÁN GÓMEZ-EST.LA GARENA" y "ÁVILA-MURCIA").
 * Match por tokens compartidos (headsign + nombre de la parada final); si de dos direcciones
 * solo una resuelve, la otra toma la cabecera restante. Sin resolución fiable → se conserva el headsign.
 */
// Stopwords de cabeceras de línea ("A - B"): conjunciones que no aportan al match de tokens.
// Lista propia del dominio de destinos — NO fusionar con los conectores de incidencias
// (nameTokens de text-utils está parametrizada por este motivo)
const DESTINATION_STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'y',
  'a',
  'e',
  'o',
  'u',
]);

export function resolveDirectionDestinations(
  doc: CRTMLineDoc,
  stopNameOf: (code: string) => string | null | undefined,
): Record<number, string> {
  const parts = doc.name
    .split(/\s+[-–]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 2) return {};
  const [candA, candB] = parts;
  const tokensA = nameTokens(candA, DESTINATION_STOPWORDS);
  const tokensB = nameTokens(candB, DESTINATION_STOPWORDS);
  if (tokensA.length === 0 || tokensB.length === 0) return {};

  const resolved: Record<number, string> = {};
  for (const direction of doc.directions) {
    const terminal =
      direction.stops.length > 0 ? stopNameOf(direction.stops[direction.stops.length - 1]) : null;
    const tokens = new Set(
      nameTokens(`${direction.headsign} ${terminal ?? ''}`, DESTINATION_STOPWORDS),
    );
    const scoreA = tokensA.filter((t) => tokens.has(t)).length;
    const scoreB = tokensB.filter((t) => tokens.has(t)).length;
    if (scoreA >= 2 && scoreA > scoreB) resolved[direction.id] = candA;
    else if (scoreB >= 2 && scoreB > scoreA) resolved[direction.id] = candB;
  }

  const dirIds = doc.directions.map((d) => d.id);
  const resolvedIds = Object.keys(resolved).map(Number);
  if (
    resolvedIds.length === 2 &&
    resolvedIds.length === dirIds.length &&
    resolved[dirIds[0]] === resolved[dirIds[1]]
  ) {
    return {}; // ambas direcciones matchean la misma cabecera: datos ambiguos, no tocar
  }
  if (dirIds.length === 2 && resolvedIds.length === 1) {
    const other = dirIds.find((id) => !(id in resolved));
    if (other !== undefined)
      resolved[other] =
        resolved[dirIds.find((id) => id in resolved) as number] === candA ? candB : candA;
  }
  return resolved;
}

/**
 * Dest modal por dirección a partir de los dest por trip (trip_short_name del feed):
 * headsign de dirección para detail/timetable cuando el doc ya trae dest (refresco
 * 2026-08-30). Sin dest en ningún trip → {} (se usa la heurística de cabeceras).
 */
export function modeDestByDirection(doc: CRTMLineDoc): Record<number, string> {
  const counters = new Map<number, Map<string, number>>();
  for (const trip of doc.trips ?? []) {
    if (!trip.dest) continue;
    let counter = counters.get(trip.dir);
    if (!counter) {
      counter = new Map();
      counters.set(trip.dir, counter);
    }
    counter.set(trip.dest, (counter.get(trip.dest) ?? 0) + 1);
  }
  const out: Record<number, string> = {};
  for (const [dir, counter] of counters) {
    let best: string | null = null;
    let bestCount = -1;
    for (const [dest, count] of counter) {
      if (count > bestCount) {
        best = dest;
        bestCount = count;
      }
    }
    if (best !== null) out[dir] = best;
  }
  return out;
}

// Clave de comparación de nombres de destino: tokens únicos ordenados (insensible a
// acentos/mayúsculas/puntuación; "FERNANDO FERNÁN GÓMEZ-EST.LA GARENA" y su variante con
// espacios dan la misma clave)
function destinationKey(text: string): string {
  return [...new Set(nameTokens(text, DESTINATION_STOPWORDS))].sort().join(' ');
}

export interface WidgetDirDestinations {
  canonical: string | null; // mode(dest) > cabecera del nombre "A - B"; null = sin resolución fiable
  // Claves aceptadas del dest del SAE (headsign GTFS, parada terminal del sentido, canónico):
  // solo si el dest del widget ES la terminal del sentido se reescribe — una variante corta
  // real (dest = parada intermedia) o un dir mal mapeado nunca se tocan
  matchKeys: string[];
}

export interface WidgetDestinations {
  byDir: Record<number, WidgetDirDestinations>;
}

/**
 * Destino canónico por dirección para el tablón RT del widget: el SAE manda como dest la
 * ÚLTIMA parada física del sentido ("ÁVILA-MURCIA" en la 6 de Alcalá "EST. LA GARENA -
 * VIRGEN DEL VAL"), mientras que la UI debe mostrar el destino oficial — la misma cadena
 * mode(dest) > cabecera que detail/timetable. Sin resolución (circulares, cabeceras de un
 * solo token) → canonical null y la UI conserva el dest del widget.
 */
export function widgetDestinations(
  doc: CRTMLineDoc,
  stopNameOf: (code: string) => string | null | undefined,
): WidgetDestinations {
  const halves = resolveDirectionDestinations(doc, stopNameOf);
  const mode = modeDestByDirection(doc);
  const byDir: Record<number, WidgetDirDestinations> = {};
  for (const direction of doc.directions) {
    const canonical = mode[direction.id] ?? halves[direction.id] ?? null;
    const terminal =
      direction.stops.length > 0 ? stopNameOf(direction.stops[direction.stops.length - 1]) : null;
    const keys = [
      destinationKey(direction.headsign),
      terminal ? destinationKey(terminal) : '',
      canonical ? destinationKey(canonical) : '',
    ].filter((key) => key !== '');
    byDir[direction.id] = { canonical, matchKeys: [...new Set(keys)] };
  }
  return { byDir };
}

/**
 * Destino a mostrar de un item del widget: el canónico de su (routeId, dir) si el dest del
 * SAE casa con la terminal del sentido (o llega a null). Si no hay canónico, o el dest es
 * de una variante corta real, devuelve null → la UI conserva el dest del widget.
 */
export function resolveWidgetDest(
  dests: WidgetDestinations | null | undefined,
  dir: number | null,
  dest: string | null,
): string | null {
  if (!dests || dir === null) return null;
  const entry = dests.byDir[dir];
  if (!entry?.canonical) return null;
  if (!dest) return entry.canonical;
  return entry.matchKeys.includes(destinationKey(dest)) ? entry.canonical : null;
}

/**
 * Destino mostrado de un trip: dest por trip (trip_short_name limpio, prioridad absoluta
 * — cubre variantes ocultas con headsign = el de su dirección pero otro destino) >
 * canónica de cabecera si el trip es "normal" (headsign = el de su dirección) >
 * headsign propio del trip variante > headsign de la dirección > nombre de línea
 */
function tripHeadsign(
  doc: CRTMLineDoc,
  trip: CRTMTrip,
  destinations: Record<number, string>,
): string {
  const dirHeadsign = doc.directions.find((d) => d.id === trip.dir)?.headsign;
  const canonical = destinations[trip.dir];
  if (trip.dest) return trip.dest;
  if (canonical && (!trip.headsign || trip.headsign === dirHeadsign)) return canonical;
  return trip.headsign || dirHeadsign || doc.name;
}

/**
 * Modo de recogida de salidas: ventana desde "ahora" (schedule/arrivals) o tablón de un
 * día completo (schedule ?date=). Unión discriminada: el núcleo filtra por día (comparación
 * de strings) ANTES de calcular el instante con madridInstantFromWall.
 */
type DepartureMode =
  | { kind: 'window'; todayKey: string; now: number; cutoff: number }
  | { kind: 'date'; dateKey: string };

/**
 * Días de servicio a examinar por modo: ventana = ayer/hoy/mañana (las madrugadas ≥24:00
 * del servicio de ayer caen en hoy); fecha = el día consultado y su anterior.
 */
function serviceDaysFor(mode: DepartureMode): string[] {
  return mode.kind === 'window'
    ? [shiftDateKey(mode.todayKey, -1), mode.todayKey, shiftDateKey(mode.todayKey, 1)]
    : [shiftDateKey(mode.dateKey, -1), mode.dateKey];
}

/**
 * Núcleo compartido de computeStopDepartures (modo ventana) y computeStopDayDepartures
 * (modo fecha): docs → días de servicio (con fallback de calendario caducado) → trips
 * de la parada → salidas por offset. Cada modo aplica sus invariantes (ventana
 * [now, cutoff) con dayOffset respecto a hoy; fecha exacta con dayOffset 0).
 */
function collectStopDepartures(
  docs: CRTMLineDoc[],
  stopCode: string,
  maxResults: number,
  mode: DepartureMode,
  stopNameOf?: (code: string) => string | null | undefined,
): CRTMDeparture[] {
  const out: CRTMDeparture[] = [];
  const serviceDays = serviceDaysFor(mode);

  for (const doc of docs) {
    const destinations = stopNameOf ? resolveDirectionDestinations(doc, stopNameOf) : {};
    const docServices = doc.services ?? [];
    const tripsAtStop = (doc.trips ?? [])
      .map((trip) => ({ trip, offsets: tripStopOffsetsSecs(trip, stopCode) }))
      .filter((entry) => entry.offsets.length > 0);
    if (tripsAtStop.length === 0) continue;

    for (const serviceDay of serviceDays) {
      const dayIndex = dayIndexOf(serviceDay);
      const hasActiveService = docServices.some((svc) => serviceRunsOn(svc, serviceDay, dayIndex));
      const fallbackIdxs = hasActiveService
        ? null
        : expiredCalendarServices(docServices, serviceDay, dayIndex);
      if (!hasActiveService && fallbackIdxs!.size === 0) continue;

      for (const { trip, offsets } of tripsAtStop) {
        const svc = docServices[trip.svc];
        if (!svc) continue;
        const runs = hasActiveService
          ? serviceRunsOn(svc, serviceDay, dayIndex)
          : fallbackIdxs!.has(trip.svc);
        if (!runs) continue;
        const headsign = tripHeadsign(doc, trip, destinations);

        for (const off of offsets) {
          for (const depAtStop of tripDeparturesAtOffset(trip, off)) {
            const shift = depAtStop >= DAY_MS / 1000 ? 1 : 0; // ≥24:00 = madrugada del día siguiente
            const effDay = shiftDateKey(serviceDay, shift);
            // filtro barato por día (strings) ANTES del instante: en modo ventana las salidas
            // de ayer sin madrugada ≥24:00 se descartan sin tocar madridInstantFromWall
            if (mode.kind === 'date') {
              if (effDay !== mode.dateKey) continue;
            } else if (effDay < mode.todayKey) {
              continue;
            }
            const effSecs = depAtStop - shift * 86400;
            const instant = madridInstantFromWall(effDay, effSecs);
            if (mode.kind === 'window' && (instant < mode.now || instant >= mode.cutoff)) continue;
            out.push({
              line: doc.label,
              routeId: doc.routeId,
              network: doc.network,
              headsign,
              dir: trip.dir,
              departureISO: new Date(instant).toISOString(),
              dayOffset: mode.kind === 'window' ? dayDiff(mode.todayKey, effDay) : 0,
              time: formatHM(effSecs),
              ...(trip.tid ? { tripId: trip.tid } : {}),
              ...(hasActiveService ? {} : { stale: true as const }),
            });
          }
        }
      }
    }
  }

  out.sort(
    (a, b) =>
      Date.parse(a.departureISO) - Date.parse(b.departureISO) || a.line.localeCompare(b.line),
  );
  return out.slice(0, maxResults);
}

/**
 * Salidas teóricas de una parada a partir de los docs de las líneas que la sirven
 * Se examinan los días de servicio ayer/hoy/mañana para cubrir las madrugadas (horas ≥24:00 GTFS)
 * Si un día de servicio no lo cubre ningún patrón activo de un doc, se aplica el fallback
 * de calendario caducado (última generación conocida de ese día de la semana, marca stale)
 * @param docs Docs de línea (crtm:line:*) de los labels de la parada
 * @param stopCode Código de parada CRTM
 * @param now Epoch ms
 * @param windowSecs Ventana hacia adelante en segundos
 * @param maxResults Límite de resultados (ordenados por salida)
 * @param stopNameOf Resolvedor de nombre de parada (código → nombre); activa el destino canónico por cabecera
 */
export function computeStopDepartures(
  docs: CRTMLineDoc[],
  stopCode: string,
  now: number,
  windowSecs: number,
  maxResults: number,
  stopNameOf?: (code: string) => string | null | undefined,
): CRTMDeparture[] {
  const todayKey = madridWallClock(now).dateKey;
  return collectStopDepartures(
    docs,
    stopCode,
    maxResults,
    {
      kind: 'window',
      todayKey,
      now,
      cutoff: now + windowSecs * 1000,
    },
    stopNameOf,
  );
}

/**
 * Tablón teórico de un día COMPLETO (modo fecha, ?date=): todas las salidas cuya hora
 * efectiva de reloj cae dentro del día consultado — trips del día de servicio de esa
 * fecha + madrugadas ≥24:00 del servicio del día anterior. Sin filtro de "ahora":
 * para hoy incluye también las ya pasadas (la UI las atenúa).
 * Mismo fallback de calendario caducado y misma cadena de destinos que el modo ventana.
 * @param dateKey Día consultado en formato YYYYMMDD (hora de pared de Madrid)
 */
export function computeStopDayDepartures(
  docs: CRTMLineDoc[],
  stopCode: string,
  dateKey: string,
  maxResults: number,
  stopNameOf?: (code: string) => string | null | undefined,
): CRTMDeparture[] {
  return collectStopDepartures(docs, stopCode, maxResults, { kind: 'date', dateKey }, stopNameOf);
}

export interface CRTMServiceSummary {
  serviceIndex: number;
  id: string;
  days: number[];
  from: string | null;
  to: string | null;
  exceptions: Record<string, 1 | 2>;
  first: string | null; // HH:MM (GTFS: puede ser ≥24:00)
  last: string | null;
  trips: number;
}

export interface CRTMDirectionTimetable {
  id: number;
  headsign: string;
  first: string | null;
  last: string | null;
  trips: number;
  services: CRTMServiceSummary[];
}

/**
 * Resumen de horarios teóricos de un doc de línea: primer/último servicio y nº de expediciones
 * por dirección, desglosado por patrón de servicio (días de la semana + excepciones)
 * Los trips plantilla (frequencies.txt) aportan su expansión: primero/último instancia y nº de instancias
 */
export function buildLineTimetable(doc: CRTMLineDoc): CRTMDirectionTimetable[] {
  return [...doc.directions]
    .sort((a, b) => a.id - b.id)
    .map((direction) => {
      const byService = new Map<number, { first: number; last: number; count: number }>();
      let first = Number.POSITIVE_INFINITY;
      let last = -1;
      let total = 0;
      for (const trip of doc.trips ?? []) {
        if (trip.dir !== direction.id) continue;
        let spanFirst: number;
        let spanLast: number;
        let spanCount: number;
        if (trip.freq) {
          spanFirst = Number.POSITIVE_INFINITY;
          spanLast = -1;
          spanCount = 0;
          for (const band of trip.freq) {
            const n = freqBandInstances(band);
            if (n === 0) continue;
            spanFirst = Math.min(spanFirst, band.from);
            spanLast = Math.max(spanLast, band.from + (n - 1) * band.headway);
            spanCount += n;
          }
          if (spanCount === 0) continue;
        } else {
          const dep = trip.dep ?? 0;
          spanFirst = dep;
          spanLast = dep;
          spanCount = 1;
        }
        let stats = byService.get(trip.svc);
        if (!stats) {
          stats = { first: spanFirst, last: spanLast, count: 0 };
          byService.set(trip.svc, stats);
        }
        if (spanFirst < stats.first) stats.first = spanFirst;
        if (spanLast > stats.last) stats.last = spanLast;
        stats.count += spanCount;
        if (spanFirst < first) first = spanFirst;
        if (spanLast > last) last = spanLast;
        total += spanCount;
      }
      const services: CRTMServiceSummary[] = [...byService.entries()]
        .sort((a, b) => a[1].first - b[1].first)
        .map(([idx, stats]) => {
          const svc = (doc.services ?? [])[idx];
          return {
            serviceIndex: idx,
            id: svc?.id ?? `svc-${idx}`,
            days: svc?.days ?? [],
            from: svc?.from ?? null,
            to: svc?.to ?? null,
            exceptions: svc?.exceptions ?? {},
            first: formatHM(stats.first),
            last: formatHM(stats.last),
            trips: stats.count,
          };
        });
      return {
        id: direction.id,
        headsign: direction.headsign,
        first: total > 0 ? formatHM(first) : null,
        last: total > 0 ? formatHM(last) : null,
        trips: total,
        services,
      };
    });
}
