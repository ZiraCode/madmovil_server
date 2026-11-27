import { describe, expect, it } from 'vitest';
import { unifiedSearch } from '../../src/lib/search';
import { emtStopIndex, crtmStopIndex } from '../../src/lib/search-index';
import type { CRTMLineSummary } from '../../src/types/crtm-data';
import {
  crtmLinesSearchFixture,
  crtmStopsSearchFixture,
  emtLinesSearchFixture,
  emtStopsSearchFixture,
} from '../fixtures/search';

const baseArgs = {
  emtLines: emtLinesSearchFixture(),
  crtmLines: crtmLinesSearchFixture(),
  emtStops: emtStopIndex(emtStopsSearchFixture()),
  crtmStops: crtmStopIndex(crtmStopsSearchFixture()),
  limitLines: 5,
  limitStops: 8,
};

describe('unifiedSearch · líneas', () => {
  it("'C10' resuelve la línea de Cercanías por label exacto (con id routeId, color y match)", () => {
    const { lines, stops } = unifiedSearch({ ...baseArgs, query: 'C10' });

    expect(lines.count).toBe(1);
    expect(lines.results[0]).toMatchObject({
      type: 'line',
      source: 'crtm',
      network: 'cercanias',
      label: 'C10',
      id: '10T_C10',
      color: 'C4D600',
      match: 'label-exact',
    });
    expect(stops.count).toBe(0);
  });

  it("'1' devuelve las líneas duplicadas entre redes con EMT primero y match label-exact", () => {
    const { lines } = unifiedSearch({ ...baseArgs, query: '1' });

    const exact = lines.results.filter((l) => l.match === 'label-exact');
    expect(exact.map((l) => `${l.source}:${l.network}`)).toEqual([
      'emt:emt',
      'crtm:urban',
      'crtm:metro',
    ]);
    // el 10 de EMT matchea por prefijo y queda tras todos los exactos
    expect(lines.results[3]).toMatchObject({ label: '10', source: 'emt', match: 'label-prefix' });
  });

  it('prefijos de label ordenan numéricamente (A2 < A10)', () => {
    const { lines } = unifiedSearch({
      ...baseArgs,
      query: 'A',
      emtLines: [
        { lineId: '902', label: 'A10', nameA: 'X', nameB: 'Y' },
        { lineId: '901', label: 'A2', nameA: 'X', nameB: 'Y' },
      ],
      crtmLines: [],
    });

    expect(lines.results.map((l) => l.label)).toEqual(['A2', 'A10']);
    expect(lines.results.every((l) => l.match === 'label-prefix')).toBe(true);
  });

  it('match por nombre de línea (nameA/nameB en EMT, name en CRTM) queda en el último tier', () => {
    const emt = unifiedSearch({ ...baseArgs, query: 'benavente' });
    const crtm = unifiedSearch({ ...baseArgs, query: 'valdecarros' });

    expect(emt.lines.results[0]).toMatchObject({ label: '51', source: 'emt', match: 'name' });
    expect(crtm.lines.results[0]).toMatchObject({ label: '1', network: 'metro', match: 'name' });
  });

  it('la línea de red en catálogo arrastra noSchedule y el color/textColor pasa intactos', () => {
    const { lines } = unifiedSearch({ ...baseArgs, query: 'R' });

    expect(lines.results[0]).toMatchObject({
      label: 'R',
      network: 'metro',
      noSchedule: true,
      color: 'A0A0A0',
      textColor: 'FFFFFF',
    });
  });

  it('límite propio para líneas: count conserva el total y returned lo recortado', () => {
    const { lines } = unifiedSearch({ ...baseArgs, query: '1', limitLines: 2 });

    // 3 labels exactos + el 10 por prefijo + la ML1 por nombre ("ML1 Las Tablas...")
    expect(lines.count).toBe(5);
    expect(lines.returned).toBe(2);
    expect(lines.results).toHaveLength(2);
  });
});

describe('unifiedSearch · paradas', () => {
  it("'sol': nombre exacto de la estación de metro (4_12) antes que el match parcial de EMT", () => {
    const { stops } = unifiedSearch({ ...baseArgs, query: 'sol' });

    expect(stops.results[0]).toMatchObject({
      source: 'crtm',
      id: '4_12',
      name: 'Sol',
      match: 'name-exact',
      networks: ['metro'],
    });
    expect(stops.results[1]).toMatchObject({
      source: 'emt',
      id: '5001',
      match: 'name-prefix',
      networks: ['emt'],
    });
  });

  it('networks de parada por namespace de código y por labels (bus), sin contaminación cruzada', () => {
    const lines: CRTMLineSummary[] = [
      ...crtmLinesSearchFixture(),
      {
        label: '421',
        routeId: '8__421___',
        name: 'Moncloa - Boadilla del Monte',
        network: 'interurban',
        municipality: 'Boadilla del Monte',
        url: null,
      },
      {
        label: '421',
        routeId: '9__421___',
        name: 'Circular Alcorcón',
        network: 'urban',
        municipality: 'Alcorcón',
        url: null,
      },
    ];
    const stops = crtmStopIndex([
      ...crtmStopsSearchFixture(),
      {
        code: '09568',
        name: 'Pº Extremadura - Av. Portugal',
        address: 'Av. de Portugal 12',
        lat: 1,
        lon: 1,
        zone: 'A',
        municipality: 'Madrid',
        lines: ['421'],
      },
    ]);
    const find = (query: string, id: string) =>
      unifiedSearch({ ...baseArgs, query, crtmLines: lines, crtmStops: stops }).stops.results.find(
        (s) => s.id === id,
      );

    // estaciones: red por prefijo del código, aunque su label colisione con bus
    expect(find('sol', '4_12')?.networks).toEqual(['metro']);
    expect(find('atocha', 'r_18000')?.networks).toEqual(['cercanias']);
    // bus numérico: redes de sus labels (el '1' de Alcorcón es urban; el metro queda fuera)
    expect(find('alcorcon', '08712')?.networks).toEqual(['urban']);
    // label duplicado interurban+urban sirviendo una parada de bus: ambas, sin inventar
    expect(find('extremadura', '09568')?.networks).toEqual(['interurban', 'urban']);
  });

  it("'62': código exacto primero, número de vía con frontera de dígitos después, 16200 fuera", () => {
    const { stops } = unifiedSearch({ ...baseArgs, query: '62' });

    expect(stops.results.map((s) => `${s.id}:${s.match}`)).toEqual([
      '62:code-exact',
      '06165:address',
    ]);
    expect(stops.results.every((s) => s.id !== '06159')).toBe(true);
  });

  it('query numérica sin prefijo de nombre: la parada "620..." no matchea con 62', () => {
    const { stops } = unifiedSearch({
      ...baseArgs,
      query: '62',
      crtmStops: crtmStopIndex([
        ...crtmStopsSearchFixture(),
        {
          code: '00620',
          name: 'AV. AMERICA 620',
          address: null,
          lat: 1,
          lon: 1,
          zone: 'A',
          municipality: 'Madrid',
          lines: [],
        },
      ]),
    });

    expect(stops.results.some((s) => s.id === '00620')).toBe(false);
  });

  it('match por municipio en el último tier, tras nombre y dirección', () => {
    const { stops } = unifiedSearch({ ...baseArgs, query: 'alcorcon' });

    expect(stops.results.map((s) => `${s.id}:${s.match}`)).toEqual([
      '08713:name',
      '08712:municipality',
    ]);
  });

  it('municipality: null y networks: [emt] en paradas EMT (el artefacto no lleva municipio); lines pasa para los chips', () => {
    const { stops } = unifiedSearch({ ...baseArgs, query: 'gran via' });

    expect(stops.results[0]).toMatchObject({
      source: 'emt',
      id: '456',
      municipality: null,
      networks: ['emt'],
      lines: ['5'],
    });
  });

  it('límites propios por grupo: el de líneas no recorta paradas y viceversa', () => {
    const manyMadrid = unifiedSearch({
      ...baseArgs,
      query: 'madrid',
      limitLines: 1,
      limitStops: 2,
    });

    expect(manyMadrid.lines.returned).toBe(1);
    expect(manyMadrid.stops.returned).toBe(2);
    expect(manyMadrid.stops.count).toBeGreaterThan(2);
  });
});

describe('unifiedSearch · mezcla líneas + paradas', () => {
  it("'alcorcon' devuelve a la vez la línea urbana (match por nombre) y sus paradas", () => {
    const { lines, stops } = unifiedSearch({ ...baseArgs, query: 'alcorcon' });

    expect(lines.results[0]).toMatchObject({ label: '1', network: 'urban', match: 'name' });
    expect(stops.count).toBe(2);
  });

  it('query vacía tras normalizar no matchea nada', () => {
    const result = unifiedSearch({ ...baseArgs, query: '   ' });

    expect(result).toEqual({
      lines: { count: 0, returned: 0, results: [] },
      stops: { count: 0, returned: 0, results: [] },
    });
  });
});
