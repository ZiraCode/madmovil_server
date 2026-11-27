import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRTM_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV } from '../helpers/mock-kv';
import {
  parseCercaniasIncidents,
  resolveIncidentStopCode,
  getCercaniasIncidents,
  __resetIncidentsInflight,
  CRTMIncidentsUnavailableError,
} from '../../src/lib/crtm-incidents';
import { crtmCercaniasIncidentsFixture } from '../fixtures/crtm';
import type { CRTMStop } from '../../src/types/crtm-data';

afterEach(() => {
  __resetIncidentsInflight();
  vi.unstubAllGlobals();
});

describe('parseCercaniasIncidents', () => {
  it('colección de 1 (objeto suelto): la afectación real de las obras C9', () => {
    const incidents = parseCercaniasIncidents(crtmCercaniasIncidentsFixture());

    expect(incidents).not.toBeNull();
    expect(incidents).toHaveLength(1);
    expect(incidents![0]).toMatchObject({ label: 'C9', type: 'AFF' });
    expect(incidents![0].description).toContain('C-9');
    expect(incidents![0].affectedStops.map((s) => s.name)).toEqual([
      'CERCEDILLA',
      'PUERTO NAVACERRADA',
      'COTOS',
    ]);
  });

  it('array de varias; codLine ajeno o ausente → label null; item sin description se descarta', () => {
    const incidents = parseCercaniasIncidents({
      incidentsAffectations: {
        IncidentAffectation: [
          { codLine: '5__C9___', description: 'a' },
          { codLine: '5__C2c__', description: 'b', stopsAffectated: {} },
          { codLine: '8__224___', description: 'c' },
          { codLine: '5__C10___' },
        ],
      },
    });

    expect(incidents!.map((i) => i.label)).toEqual(['C9', 'C2c', null]);
  });

  it('paradas afectadas sin nombre se filtran y colección vacía de paradas → []', () => {
    const incidents = parseCercaniasIncidents({
      incidentsAffectations: {
        IncidentAffectation: {
          codLine: '5__C9___',
          description: 'a',
          stopsAffectated: { ShortStop: [{ codStop: '5_16' }, { name: 'COTOS' }] },
        },
      },
    });

    expect(incidents![0].affectedStops).toEqual([{ name: 'COTOS' }]);
  });

  it('{} del widget (sin avisos) → [] distinguible del error', () => {
    expect(parseCercaniasIncidents({ incidentsAffectations: {} })).toEqual([]);
  });

  it('respuesta de error o inválida → null', () => {
    expect(parseCercaniasIncidents({ error: 'service_unavailable', message: 'x' })).toBeNull();
    expect(parseCercaniasIncidents('nope')).toBeNull();
    expect(parseCercaniasIncidents(null)).toBeNull();
  });
});

describe('resolveIncidentStopCode', () => {
  const stops: CRTMStop[] = [
    {
      code: 'r_18132',
      name: 'Cercedilla',
      address: null,
      lat: 1,
      lon: 1,
      zone: null,
      municipality: 'Cercedilla',
      lines: ['C9'],
    },
    {
      code: 'r_18133',
      name: 'Puerto de Navacerrada',
      address: null,
      lat: 1,
      lon: 1,
      zone: null,
      municipality: 'Navacerrada',
      lines: ['C9'],
    },
    {
      code: 'r_18134',
      name: 'Cotos',
      address: null,
      lat: 1,
      lon: 1,
      zone: null,
      municipality: 'Rascafría',
      lines: ['C9'],
    },
    {
      code: 'r_18000',
      name: 'Madrid-Atocha Cercanías',
      address: null,
      lat: 1,
      lon: 1,
      zone: null,
      municipality: 'Madrid',
      lines: ['C5'],
    },
    {
      code: 'r_17002',
      name: 'Madrid-Chamartín',
      address: null,
      lat: 1,
      lon: 1,
      zone: null,
      municipality: 'Madrid',
      lines: ['C10'],
    },
  ];

  it('igualdad normalizada (CERCEDILLA → Cercedilla)', () => {
    expect(resolveIncidentStopCode('CERCEDILLA', stops)).toBe('r_18132');
  });

  it('tokens del widget contenidos en el nombre GTFS (PUERTO NAVACERRADA → Puerto de Navacerrada)', () => {
    expect(resolveIncidentStopCode('PUERTO NAVACERRADA', stops)).toBe('r_18133');
  });

  it('varias contenedoras: gana la de menos tokens sobrantes (MADRID ATOCHA → Atocha Cercanías)', () => {
    expect(resolveIncidentStopCode('MADRID ATOCHA', stops)).toBe('r_18000');
  });

  it('un solo token sin igualdad exacta es ambiguo → null', () => {
    expect(resolveIncidentStopCode('MADRID', stops)).toBeNull();
  });

  it('sin coincidencia → null', () => {
    expect(resolveIncidentStopCode('EL ESCORIAL', stops)).toBeNull();
  });
});

describe('getCercaniasIncidents', () => {
  it('miss → fetch + put con TTL; hit posterior sin refetch', async () => {
    const kv = mockKV();
    const env = mockEnv(kv);
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(crtmCercaniasIncidentsFixture()), { status: 200 }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = await getCercaniasIncidents(env);
    expect(first).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.putCalls).toHaveLength(1);
    expect(kv.putCalls[0]).toMatchObject({
      key: CRTM_CONFIG.INCIDENTS.CACHE_KEY,
      options: { expirationTtl: CRTM_CONFIG.INCIDENTS.TTL },
    });

    const second = await getCercaniasIncidents(env);
    expect(second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('URL del widget con mode=5 y UA propio', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(crtmCercaniasIncidentsFixture({ empty: true })), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getCercaniasIncidents(mockEnv());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${CRTM_CONFIG.WIDGET.BASE_URL}${CRTM_CONFIG.INCIDENTS.GET_INCIDENTS}?mode=${CRTM_CONFIG.INCIDENTS.CERCANIAS_MODE}`,
    );
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(
      CRTM_CONFIG.WIDGET.USER_AGENT,
    );
  });

  it('widget caído sin caché → CRTMIncidentsUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    await expect(getCercaniasIncidents(mockEnv())).rejects.toBeInstanceOf(
      CRTMIncidentsUnavailableError,
    );
  });

  it('HTTP 500 o body de error → CRTMIncidentsUnavailableError sin cachear', async () => {
    const kv500 = mockKV();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 }))),
    );
    await expect(getCercaniasIncidents(mockEnv(kv500))).rejects.toBeInstanceOf(
      CRTMIncidentsUnavailableError,
    );
    expect(kv500.putCalls).toHaveLength(0);

    __resetIncidentsInflight();
    const kvError = mockKV();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'service_unavailable', message: 'x' }), {
            status: 200,
          }),
        ),
      ),
    );
    await expect(getCercaniasIncidents(mockEnv(kvError))).rejects.toBeInstanceOf(
      CRTMIncidentsUnavailableError,
    );
    expect(kvError.putCalls).toHaveLength(0);
  });
});
