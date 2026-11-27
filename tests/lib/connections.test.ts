import { describe, expect, it } from 'vitest';
import { findStopConnections } from '../../src/lib/connections';
import {
  crtmLinesConnectionsFixture,
  crtmStopsConnectionsFixture,
  emtLinesConnectionsFixture,
  emtStopsConnectionsFixture,
} from '../fixtures/connections';

function baseArgs(overrides: Partial<Parameters<typeof findStopConnections>[0]> = {}) {
  return {
    source: 'emt' as const,
    stopId: '602',
    radiusM: 300,
    emtStops: emtStopsConnectionsFixture(),
    emtLines: emtLinesConnectionsFixture(),
    crtmStops: crtmStopsConnectionsFixture(),
    crtmLines: crtmLinesConnectionsFixture(),
    ...overrides,
  };
}

describe('findStopConnections', () => {
  it('intercambiador EMT: grupos por red ordenados por distancia, líneas propias fuera, colisión de label entre redes conservada', () => {
    const result = findStopConnections(baseArgs())!;

    expect(result.origin).toEqual({
      source: 'emt',
      stopId: '602',
      name: 'Moncloa',
      networks: ['emt'],
    });
    expect(result.radiusM).toBe(300);
    // paradas cercanas ordenadas por distancia, la propia 602 excluida
    expect(result.stops.map((s) => [s.id, s.distanceM])).toEqual([
      ['603', 30],
      ['06002', 50],
      ['4_202', 80],
      ['4_203', 89],
      ['08888', 100],
      ['10_7', 200],
    ]);

    expect(result.groups.map((g) => [g.network, g.distanceM])).toEqual([
      ['emt', 30],
      ['interurban', 50],
      ['metro', 80],
      ['urban', 100],
      ['ml', 200],
    ]);
    expect(result.transferCount).toBe(9);

    const emt = result.groups[0];
    // la 44 ya está en la 602: no es transbordo
    expect(emt.lines.map((l) => l.label)).toEqual(['160', '161']);
    expect(emt.lines[0]).toMatchObject({
      source: 'emt',
      network: 'emt',
      label: '160',
      id: '160',
      name: 'Moncloa - Aravaca',
    });

    const metro = result.groups[2];
    // label '3' existe en EMT (propia) y metro: son redes distintas, el de metro ES transbordo;
    // '6' llega por 4_202 y 4_203 sin duplicar; '99' no está en lines:all → id null pero chip válido
    expect(metro.lines.map((l) => l.label)).toEqual(['3', '6', '99']);
    expect(metro.lines[0]).toMatchObject({ id: '4__3_____', color: '8EBF42', textColor: 'FFFFFF' });
    expect(metro.lines[2]).toMatchObject({ id: null, name: null });

    // '573' la sirven 06002 (50 m) y 08888 (100 m): una sola vez, distancia mínima
    expect(result.groups[1].lines.map((l) => l.label)).toEqual(['571', '573']);
    expect(result.groups[1].distanceM).toBe(50);
  });

  it('radius=500 añade las lejanas (cercanías a 480 m, EMT a 350 m) con orden natural de labels', () => {
    const result = findStopConnections(baseArgs({ radiusM: 500 }))!;

    expect(result.stops.map((s) => s.id)).toEqual([
      '603',
      '06002',
      '4_202',
      '4_203',
      '08888',
      '10_7',
      '666',
      'r_18000',
    ]);
    expect(result.groups.map((g) => [g.network, g.distanceM])).toEqual([
      ['emt', 30],
      ['interurban', 50],
      ['metro', 80],
      ['urban', 100],
      ['ml', 200],
      ['cercanias', 480],
    ]);
    expect(result.groups[0].lines.map((l) => l.label)).toEqual(['2', '10', '160', '161']);
    expect(result.groups[5].lines.map((l) => l.label)).toEqual(['C5', 'C10']);
    expect(result.transferCount).toBe(13);
  });

  it('origen CRTM (metro): sus líneas dedup dentro de SU red, la 3 de EMT conservada, distancia mínima por red', () => {
    const result = findStopConnections(baseArgs({ source: 'crtm', stopId: '4_202' }))!;

    expect(result.origin).toEqual({
      source: 'crtm',
      stopId: '4_202',
      name: 'MONCLOA',
      networks: ['metro'],
    });
    expect(result.stops.map((s) => [s.id, s.distanceM])).toEqual([
      ['4_203', 9],
      ['08888', 20],
      ['06002', 30],
      ['603', 50],
      ['602', 80],
      ['10_7', 120],
      ['666', 270],
    ]);

    // metro solo aporta la 99 (3 y 6 son propias); interurban baja a 20 m por la 573 de 08888
    expect(result.groups.map((g) => [g.network, g.distanceM])).toEqual([
      ['metro', 9],
      ['interurban', 20],
      ['urban', 20],
      ['emt', 50],
      ['ml', 120],
    ]);
    // la 666 (270 m) entra en el radio: la 2 y la 10 de EMT también son transbordo
    expect(result.groups[3].lines.map((l) => l.label)).toEqual([
      '2',
      '3',
      '10',
      '44',
      '133',
      '160',
      '161',
    ]);
    expect(result.transferCount).toBe(12);
  });

  it('label duplicado urbano+metro servido por parada de bus: solo cuenta como urban (sin contaminar metro)', () => {
    const result = findStopConnections(baseArgs())!;

    const metro = result.groups.find((g) => g.network === 'metro')!;
    expect(metro.lines.map((l) => l.label)).toEqual(['3', '6', '99']);

    const urban = result.groups.find((g) => g.network === 'urban')!;
    expect(urban.lines.map((l) => l.label)).toEqual(['1']);
    expect(urban.lines[0]).toMatchObject({ id: '9__1__013_', network: 'urban' });
  });

  it('sin crtm:lines:all el bus CRTM no aporta redes, pero metro/ML siguen (refs con id null)', () => {
    const result = findStopConnections(baseArgs({ crtmLines: null }))!;

    expect(result.groups.map((g) => g.network)).toEqual(['emt', 'metro', 'ml']);
    const metro = result.groups[1];
    expect(metro.lines.map((l) => l.label)).toEqual(['3', '6', '99']);
    expect(metro.lines.every((l) => l.id === null)).toBe(true);
    // paradas de bus CRTM sin redes resolubles (networks vacío), las namespaceladas intactas
    const intercambiador = result.stops.find((s) => s.id === '06002')!;
    expect(intercambiador.networks).toEqual([]);
    expect(result.stops.find((s) => s.id === '4_202')!.networks).toEqual(['metro']);
  });

  it('radio pequeño sin paradas cercanas: resultado vacío distinguible', () => {
    const result = findStopConnections(baseArgs({ radiusM: 20 }))!;

    expect(result.stops).toEqual([]);
    expect(result.groups).toEqual([]);
    expect(result.transferCount).toBe(0);
  });

  it('origen desconocido → null (404 en la ruta)', () => {
    expect(findStopConnections(baseArgs({ stopId: '9999' }))).toBeNull();
    expect(findStopConnections(baseArgs({ source: 'crtm', stopId: 'r_99999' }))).toBeNull();
  });
});
