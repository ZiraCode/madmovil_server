import { describe, expect, it } from 'vitest';
import {
  stopNameIndex,
  stopIndex,
  noScheduleSummary,
  noScheduleMessage,
} from '../../src/lib/crtm-stops';
import type { CRTMLineDoc, CRTMNetwork, CRTMStop } from '../../src/types/crtm-data';

const stops: CRTMStop[] = [
  {
    code: '09568',
    name: 'Legazpi',
    address: null,
    lat: 1,
    lon: 1,
    zone: 'A',
    municipality: 'Madrid',
    lines: ['421'],
  },
  {
    code: '4_12',
    name: 'SOL',
    address: null,
    lat: 1,
    lon: 1,
    zone: null,
    municipality: 'Madrid',
    lines: ['1'],
  },
];

function doc(partial: Partial<CRTMLineDoc> = {}): CRTMLineDoc {
  return {
    routeId: '8__421___',
    label: '421',
    name: 'Legazpi - Pinto',
    network: 'interurban',
    municipality: null,
    url: null,
    directions: [{ id: 0, headsign: 'PINTO', stops: ['09568'] }],
    ...partial,
  };
}

function catalogDoc(
  label: string,
  network: CRTMNetwork,
  stops: string[],
  calendarEnd: string | null,
  feedVersions: string[],
): CRTMLineDoc {
  return doc({
    routeId: `x_${label}`,
    label,
    network,
    directions: [{ id: 0, headsign: 'X', stops }],
    noSchedule: { calendarEnd, feedVersions },
  });
}

describe('índices de paradas CRTM (memoizados por identidad del array del artefacto)', () => {
  it('stopNameIndex mapea code → nombre; stopIndex, code → parada completa', () => {
    expect(stopNameIndex(stops).get('09568')).toBe('Legazpi');
    expect(stopNameIndex(stops).get('4_12')).toBe('SOL');
    expect(stopIndex(stops).get('4_12')).toMatchObject({ code: '4_12', name: 'SOL' });
    expect(stopIndex(stops).get('09568')).toBe(stops[0]);
  });

  it('el mismo array reutiliza el índice; un array nuevo (recarga del artefacto) lo reconstruye', () => {
    expect(stopNameIndex(stops)).toBe(stopNameIndex(stops));
    expect(stopIndex(stops)).toBe(stopIndex(stops));

    const reloaded = [...stops]; // JSON.parse de una recarga = array nuevo
    expect(stopNameIndex(reloaded)).not.toBe(stopNameIndex(stops));
    expect(stopIndex(reloaded)).not.toBe(stopIndex(stops));
    expect([...stopNameIndex(reloaded).entries()]).toEqual([...stopNameIndex(stops).entries()]);
  });
});

describe('noScheduleSummary (noScheduleData compartido por schedule y arrivals)', () => {
  it('agrega las redes en catálogo que sirven la parada: networks dedup, calendarEnd máximo, feedVersions dedup', () => {
    const docs = [
      catalogDoc('1', 'metro', ['4_12'], '20260527', ['v1']),
      catalogDoc('2', 'metro', ['4_12'], '20260401', ['v1', 'v2']),
      catalogDoc('3', 'interurban', ['09568'], null, []), // no sirve 4_12: fuera
    ];

    expect(noScheduleSummary(docs, '4_12')).toEqual({
      networks: ['metro'],
      calendarEnd: '20260527',
      feedVersions: ['v1', 'v2'],
    });
  });

  it('respeta ?line= (C-21): el aviso no contamina con líneas ajenas al filtro', () => {
    const docs = [
      catalogDoc('1', 'metro', ['4_12'], '20260527', ['v1']),
      catalogDoc('61', 'interurban', ['4_12'], null, []),
    ];

    expect(noScheduleSummary(docs, '4_12', '61')).toEqual({
      networks: ['interurban'],
      calendarEnd: null,
      feedVersions: [],
    });
    expect(noScheduleSummary(docs, '4_12', '999')).toBeNull();
  });

  it('null cuando ninguna línea de la parada está en catálogo', () => {
    expect(noScheduleSummary([doc()], '09568')).toBeNull();
    expect(
      noScheduleSummary([doc({ noSchedule: { calendarEnd: null, feedVersions: [] } })], '00000'),
    ).toBeNull();
  });

  it('noScheduleMessage formatea calendarEnd DD/MM/YYYY solo si existe', () => {
    expect(
      noScheduleMessage({ networks: ['metro'], calendarEnd: '20260527', feedVersions: [] }),
    ).toBe(
      'Sin horarios disponibles: el feed GTFS de esta red está caducado (calendario publicado hasta 27/05/2026)',
    );
    expect(noScheduleMessage({ networks: ['metro'], calendarEnd: null, feedVersions: [] })).toBe(
      'Sin horarios disponibles: el feed GTFS de esta red está caducado',
    );
  });
});
