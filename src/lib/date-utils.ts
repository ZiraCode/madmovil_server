const MADRID_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function madridParts(date: Date): { year: string; month: string; day: string } {
  const [year, month, day] = MADRID_DATE_FORMAT.format(date).split('-');
  return { year, month, day };
}

/**
 * Fecha en formato YYYYMMDD (para la API EMT) en hora de Madrid
 * El worker corre en UTC; sin timezone, entre las 00:00-02:00 Madrid devolvería el día anterior
 */
export function formatDateYYYYMMDD(date: Date): string {
  const { year, month, day } = madridParts(date);
  return `${year}${month}${day}`;
}

/**
 * Fecha en formato ISO YYYY-MM-DD (claves de calendario) en hora de Madrid
 */
export function formatDateISO(date: Date): string {
  const { year, month, day } = madridParts(date);
  return `${year}-${month}-${day}`;
}

const MADRID_OFFSET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  timeZoneName: 'longOffset',
});

// El offset de Madrid solo cambia dos veces al año y las transiciones caen en punto UTC
// (01:00), así que el offset es constante dentro de cada hora UTC: memo acotado por bucket
// horario (la alternativa, un Intl.format por conversión, son ~2,6 us y se llama una vez
// por salida candidata del schedule)
const OFFSET_MEMO = new Map<number, number>();
const OFFSET_MEMO_MAX = 256;

/**
 * Offset de Madrid (minutos) vigente en el instante dado (+120 en verano, +60 en invierno)
 */
function madridOffsetMinutes(instant: number): number {
  const bucket = instant - (instant % 3_600_000);
  const memo = OFFSET_MEMO.get(bucket);
  if (memo !== undefined) return memo;
  const formatted = MADRID_OFFSET_FORMAT.format(new Date(instant));
  const match = formatted.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const offset = sign * (Number(match[2]) * 60 + Number(match[3]));
  if (OFFSET_MEMO.size >= OFFSET_MEMO_MAX) OFFSET_MEMO.clear();
  OFFSET_MEMO.set(bucket, offset);
  return offset;
}

/**
 * Hora de pared (como si fuera UTC) → instante UTC real, con DST correcto en los dos domingos
 * de cambio: el offset medido sobre el propio guess cae al otro lado de la transición para las
 * horas de pared cercanas a ella (Madrid conmuta a las 01:00 UTC), así que se reevalúa sobre el
 * resultado y, si discrepa, se aplica el del instante real. Horas de pared inexistentes
 * (02:00-02:59 de primavera) se mapean hacia delante, como las librerías de fechas.
 */
function wallToInstant(asUTCGuess: number): number {
  const first = madridOffsetMinutes(asUTCGuess);
  const candidate = asUTCGuess - first * 60_000;
  const second = madridOffsetMinutes(candidate);
  return second === first ? candidate : asUTCGuess - second * 60_000;
}

/**
 * Parsea fechas locales de la EMT en formato dd/MM/yyyy H:mm:ss (ej: "19/08/2026 6:30:00")
 * interpretándolas en hora de Madrid y devolviendo el instante UTC correspondiente
 * Devuelve null si el string no matchea el formato esperado
 */
export function parseMadridDateTime(input: string | null | undefined): Date | null {
  if (!input) {
    return null;
  }
  const match = input.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year, hours, minutes, seconds] = match;
  const asUTCGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
  return new Date(wallToInstant(asUTCGuess));
}

/**
 * Comprueba si una fecha YYYYMMDD cae dentro de [hoy+minOffsetDays, hoy+maxOffsetDays]
 * comparando días naturales en hora de pared de Madrid
 */
export function dateWithinWindow(
  dateYYYYMMDD: string,
  minOffsetDays: number,
  maxOffsetDays: number,
  now: Date = new Date(),
): boolean {
  const y = Number(dateYYYYMMDD.slice(0, 4));
  const mo = Number(dateYYYYMMDD.slice(4, 6));
  const d = Number(dateYYYYMMDD.slice(6, 8));
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(mo) ||
    !Number.isInteger(d) ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31
  ) {
    return false;
  }
  const today = madridWallClock(now.getTime());
  const todayUtcMs = Date.UTC(
    Number(today.dateKey.slice(0, 4)),
    Number(today.dateKey.slice(4, 6)) - 1,
    Number(today.dateKey.slice(6, 8)),
  );
  const targetUtcMs = Date.UTC(y, mo - 1, d);
  // round-trip: Date.UTC rueda las fechas inexistentes (20260231 → 2026-03-03)
  const roundTrip = new Date(targetUtcMs);
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() + 1 !== mo ||
    roundTrip.getUTCDate() !== d
  ) {
    return false;
  }
  const dayDiff = Math.round((targetUtcMs - todayUtcMs) / 86_400_000);
  return dayDiff >= minOffsetDays && dayDiff <= maxOffsetDays;
}

/**
 * 'YYYYMMDD' → 'DD/MM/YYYY' para mensajes legibles (dateKey GTFS, calendarEnd de noSchedule)
 */
export function formatYmd(ymd: string): string {
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export interface MadridWallClock {
  dateKey: string; // YYYYMMDD
  dateISO: string; // YYYY-MM-DD
  dayIndex: number; // 0 = lunes ... 6 = domingo (orden GTFS)
  secsOfDay: number;
}

/**
 * Reloj local de Madrid (fecha, día de la semana y segundos del día) para un instante dado
 */
export function madridWallClock(instant: number): MadridWallClock {
  const offset = madridOffsetMinutes(instant);
  const wall = new Date(instant + offset * 60_000);
  const y = wall.getUTCFullYear();
  const mo = wall.getUTCMonth() + 1;
  const d = wall.getUTCDate();
  return {
    dateKey: `${y}${pad2(mo)}${pad2(d)}`,
    dateISO: `${y}-${pad2(mo)}-${pad2(d)}`,
    dayIndex: (wall.getUTCDay() + 6) % 7,
    secsOfDay: wall.getUTCHours() * 3600 + wall.getUTCMinutes() * 60 + wall.getUTCSeconds(),
  };
}

/**
 * Instante UTC correspondiente a una hora de pared de Madrid (fecha YYYYMMDD + segundos del día)
 * Inverso de madridWallClock; mismo tratamiento DST que parseMadridDateTime
 */
export function madridInstantFromWall(dateKey: string, secsOfDay: number): number {
  const y = Number(dateKey.slice(0, 4));
  const mo = Number(dateKey.slice(4, 6)) - 1;
  const d = Number(dateKey.slice(6, 8));
  const h = Math.floor(secsOfDay / 3600);
  const min = Math.floor((secsOfDay % 3600) / 60);
  const s = secsOfDay % 60;
  const asUTCGuess = Date.UTC(y, mo, d, h, min, s);
  return wallToInstant(asUTCGuess);
}
