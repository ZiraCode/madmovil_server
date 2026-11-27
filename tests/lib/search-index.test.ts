import { describe, expect, it } from 'vitest';
import { emtStopIndex, crtmStopIndex } from '../../src/lib/search-index';
import { normalizeText } from '../../src/lib/text-utils';
import { crtmStopsSearchFixture, emtStopsSearchFixture } from '../fixtures/search';

describe('índice normalizado de paradas (memoizado por identidad del array del artefacto)', () => {
  it('name/address/municipality quedan normalizados y null → cadena vacía', () => {
    const emt = emtStopIndex(emtStopsSearchFixture());
    expect(emt[0].name).toBe(normalizeText(emt[0].stop.name));

    const crtm = crtmStopIndex(crtmStopsSearchFixture());
    expect(crtm.find((e) => e.stop.code === '08712')).toMatchObject({
      name: normalizeText('Av. Europa - C. Mayor'),
      address: normalizeText('Calle Mayor 5'),
      municipality: 'alcorcon',
    });
    // address null (estación) → '' para poder testear/boundary sin nullish
    expect(crtm.find((e) => e.stop.code === '4_12')).toMatchObject({
      name: 'sol',
      address: '',
      municipality: 'madrid',
    });
  });

  it('el mismo array reutiliza el índice; un array nuevo (recarga del artefacto) lo reconstruye', () => {
    const stops = crtmStopsSearchFixture();
    expect(crtmStopIndex(stops)).toBe(crtmStopIndex(stops));

    const emtStops = emtStopsSearchFixture();
    expect(emtStopIndex(emtStops)).toBe(emtStopIndex(emtStops));

    const reloaded = crtmStopsSearchFixture(); // JSON.parse de una recarga = array nuevo
    const first = crtmStopIndex(stops);
    const second = crtmStopIndex(reloaded);
    expect(second).not.toBe(first);
    expect(second.map((e) => e.stop.code)).toEqual(first.map((e) => e.stop.code));
  });

  it('el código viaja SIN normalizar dentro de stop (los ceros a la izquierda importan)', () => {
    const crtm = crtmStopIndex([
      {
        code: '06165',
        name: 'EST. LA GARENA',
        address: null,
        lat: 1,
        lon: 1,
        zone: 'A',
        municipality: 'Alcalá de Henares',
        lines: ['6'],
      },
    ]);
    expect(crtm[0].stop.code).toBe('06165');
    expect(crtm[0].name).toBe('est la garena');

    const emt = emtStopIndex([
      {
        stopId: '062',
        name: 'Marqués de Urquijo - Ventura Rodríguez',
        coordinates: { latitude: 1, longitude: 1 },
        lines: ['2'],
      },
    ]);
    expect(emt[0].stop.stopId).toBe('062');
  });
});
