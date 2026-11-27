import { describe, expect, it } from 'vitest';
import {
  formatDateYYYYMMDD,
  formatDateISO,
  parseMadridDateTime,
  madridWallClock,
  madridInstantFromWall,
  dateWithinWindow,
} from '../../src/lib/date-utils';

// Los Date se construyen en UTC (misma referencia que el worker) para poder
// probar la conversión a hora de Madrid de forma determinista

describe('formatDateYYYYMMDD (hora Madrid)', () => {
  it('mediodía UTC: misma fecha en Madrid', () => {
    expect(formatDateYYYYMMDD(new Date('2026-08-15T12:00:00Z'))).toBe('20260815');
  });

  it('23:30 UTC = 01:30 Madrid del día siguiente (verano CEST): devuelve el día siguiente', () => {
    expect(formatDateYYYYMMDD(new Date('2026-08-15T23:30:00Z'))).toBe('20260816');
  });

  it('22:30 UTC en invierno (CET, UTC+1) = 23:30 Madrid: mismo día', () => {
    expect(formatDateYYYYMMDD(new Date('2026-01-15T22:30:00Z'))).toBe('20260115');
  });

  it('23:30 UTC en invierno (CET) = 00:30 Madrid del día siguiente', () => {
    expect(formatDateYYYYMMDD(new Date('2026-01-15T23:30:00Z'))).toBe('20260116');
  });

  it('fin de año en Madrid ya avanzado mientras UTC sigue en el año anterior', () => {
    expect(formatDateYYYYMMDD(new Date('2026-12-31T23:30:00Z'))).toBe('20270101');
  });
});

describe('formatDateISO (hora Madrid)', () => {
  it('mediodía UTC: misma fecha en Madrid', () => {
    expect(formatDateISO(new Date('2026-03-01T12:00:00Z'))).toBe('2026-03-01');
  });

  it('cambio de mes a medianoche Madrid', () => {
    expect(formatDateISO(new Date('2026-08-31T23:30:00Z'))).toBe('2026-09-01');
  });
});

describe('parseMadridDateTime (fechas EMT dd/MM/yyyy H:mm:ss en hora Madrid)', () => {
  it('verano (CEST, UTC+2): hora con un dígito', () => {
    expect(parseMadridDateTime('19/08/2026 6:30:00')?.toISOString()).toBe(
      '2026-08-19T04:30:00.000Z',
    );
  });

  it('invierno (CET, UTC+1)', () => {
    expect(parseMadridDateTime('15/01/2026 8:00:00')?.toISOString()).toBe(
      '2026-01-15T07:00:00.000Z',
    );
  });

  it('medianoche Madrid en verano = 22:00 UTC del día anterior', () => {
    expect(parseMadridDateTime('19/08/2026 0:00:00')?.toISOString()).toBe(
      '2026-08-18T22:00:00.000Z',
    );
  });

  it('devuelve null con formatos inválidos o vacíos', () => {
    expect(parseMadridDateTime(null)).toBeNull();
    expect(parseMadridDateTime(undefined)).toBeNull();
    expect(parseMadridDateTime('')).toBeNull();
    expect(parseMadridDateTime('texto libre')).toBeNull();
    expect(parseMadridDateTime('19/8/2026 6:30:00')).toBeNull();
    expect(parseMadridDateTime('2026-08-19T06:30:00')).toBeNull();
  });
});

describe('madridWallClock / madridInstantFromWall (GTFS CRTM)', () => {
  it('verano (CEST): 22:30 UTC del jueves = viernes 00:30 Madrid', () => {
    const wc = madridWallClock(Date.parse('2026-08-20T22:30:00Z'));

    expect(wc).toEqual({
      dateKey: '20260821',
      dateISO: '2026-08-21',
      dayIndex: 4, // viernes (0 = lunes)
      secsOfDay: 30 * 60,
    });
  });

  it('invierno (CET): 23:30 UTC del jueves = viernes 00:30 Madrid', () => {
    const wc = madridWallClock(Date.parse('2026-01-15T23:30:00Z'));

    expect(wc.dateKey).toBe('20260116');
    expect(wc.dayIndex).toBe(4); // viernes
    expect(wc.secsOfDay).toBe(30 * 60);
  });

  it('mediodía UTC: mismo día y día de la semana correcto (lunes y domingo)', () => {
    expect(madridWallClock(Date.parse('2026-08-17T12:00:00Z'))).toMatchObject({
      dateKey: '20260817',
      dayIndex: 0,
    });
    expect(madridWallClock(Date.parse('2026-08-23T12:00:00Z'))).toMatchObject({
      dateKey: '20260823',
      dayIndex: 6,
    });
  });

  it('madridInstantFromWall es el inverso de madridWallClock (verano e invierno)', () => {
    const summerInstant = Date.parse('2026-08-19T22:30:00Z'); // 2026-08-20 00:30 Madrid (CEST)
    expect(madridInstantFromWall('20260820', 30 * 60)).toBe(summerInstant);
    expect(madridWallClock(summerInstant)).toMatchObject({
      dateKey: '20260820',
      secsOfDay: 30 * 60,
    });

    const winterInstant = Date.parse('2026-01-15T23:30:00Z'); // 2026-01-16 00:30 Madrid (CET)
    expect(madridInstantFromWall('20260116', 30 * 60)).toBe(winterInstant);
    expect(madridWallClock(winterInstant)).toMatchObject({
      dateKey: '20260116',
      secsOfDay: 30 * 60,
    });
  });

  it('madridInstantFromWall maneja segundos de día arbitrarios (10:15:30)', () => {
    expect(madridInstantFromWall('20260820', 10 * 3600 + 15 * 60 + 30)).toBe(
      Date.parse('2026-08-20T08:15:30Z'),
    );
  });
});

describe('dateWithinWindow (validación de date en /lines/detail)', () => {
  const now = new Date('2026-08-25T12:00:00Z'); // 2026-08-25 en hora Madrid

  it('acepta hoy y los bordes de la ventana', () => {
    expect(dateWithinWindow('20260825', -7, 30, now)).toBe(true);
    expect(dateWithinWindow('20260818', -7, 30, now)).toBe(true);
    expect(dateWithinWindow('20260924', -7, 30, now)).toBe(true);
  });

  it('rechaza fuera de ventana (pasado y futuro lejanos)', () => {
    expect(dateWithinWindow('20260817', -7, 30, now)).toBe(false);
    expect(dateWithinWindow('20260925', -7, 30, now)).toBe(false);
    expect(dateWithinWindow('20200101', -7, 30, now)).toBe(false);
    expect(dateWithinWindow('20991231', -7, 30, now)).toBe(false);
  });

  it('rechaza fechas imposibles o no numéricas', () => {
    expect(dateWithinWindow('20261301', -7, 30, now)).toBe(false);
    expect(dateWithinWindow('20260832', -7, 30, now)).toBe(false);
    expect(dateWithinWindow('abcdefgh', -7, 30, now)).toBe(false);
  });

  it('rechaza fechas que ruedan (2026 no bisiesto: 20260229/20260231)', () => {
    const feb = new Date('2026-02-25T12:00:00Z');
    expect(dateWithinWindow('20260229', -7, 30, feb)).toBe(false);
    expect(dateWithinWindow('20260230', -7, 30, feb)).toBe(false);
    expect(dateWithinWindow('20260231', -7, 30, feb)).toBe(false);
    expect(dateWithinWindow('20260228', -7, 30, feb)).toBe(true);
  });
});

describe('madridInstantFromWall en cambios de hora (DST)', () => {
  it('primavera 2027-03-28: la salida GTFS 01:00 no colapsa con 00:00', () => {
    const t0000 = madridInstantFromWall('20270328', 0);
    const t0100 = madridInstantFromWall('20270328', 3600);
    expect(t0100 - t0000).toBe(3_600_000);
    expect(madridWallClock(t0100).secsOfDay).toBe(3600);
  });

  it('otoño 2026-10-25: 01:00 queda a dos horas reales del 02:00 repetido', () => {
    const t0100 = madridInstantFromWall('20261025', 3600);
    const t0200 = madridInstantFromWall('20261025', 7200);
    expect(t0200 - t0100).toBe(7_200_000);
    expect(madridWallClock(t0100).secsOfDay).toBe(3600);
    expect(madridWallClock(t0200).secsOfDay).toBe(7200);
  });

  it('días normales: una hora de pared = una hora real', () => {
    const summer = madridInstantFromWall('20260820', 3600) - madridInstantFromWall('20260820', 0);
    const winter = madridInstantFromWall('20261220', 3600) - madridInstantFromWall('20261220', 0);
    expect(summer).toBe(3_600_000);
    expect(winter).toBe(3_600_000);
  });
});
