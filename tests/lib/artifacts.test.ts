import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadArtifactFamilies } from '../../src/lib/artifacts';
import { CRTM_CONFIG, EMT_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV } from '../helpers/mock-kv';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadArtifactFamilies', () => {
  it('sanas: degraded vacío y crtmLines DESENVUELTO (CRTMLineSummary[], sin { count, lines })', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify([{ lineId: '1', label: '1', nameA: 'A', nameB: 'B' }]),
    );
    kv.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([{ stopId: '62', name: 'SOL', lines: ['1'] }]),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 1,
        lines: [{ routeId: '4__1___', label: '1', name: 'M1', network: 'metro' }],
      }),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([{ code: '4_12', name: 'SOL', lines: ['1'] }]),
    );

    const families = await loadArtifactFamilies(mockEnv(kv), 'Test');

    expect(families.degraded).toEqual([]);
    expect(families.emtLines).toHaveLength(1);
    expect(families.emtStops).toHaveLength(1);
    expect(families.crtmLines).toEqual([
      { routeId: '4__1___', label: '1', name: 'M1', network: 'metro' },
    ]);
    expect(families.crtmStops).toHaveLength(1);
  });

  it('degradación POR CARGADOR: lines:all EMT caído con stops:all sano → emtLines null, emtStops servido, degraded [emt]', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([{ stopId: '62', name: 'SOL', lines: ['1'] }]),
    );
    kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify({ count: 0, lines: [] }));
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify([]));

    const families = await loadArtifactFamilies(mockEnv(kv), 'Test');

    expect(families.emtLines).toBeNull();
    expect(families.emtStops).toHaveLength(1);
    expect(families.degraded).toEqual(['emt']);
  });

  it('CRTM sin cargar (pipeline pendiente): crtmLines/crtmStops null con EMT sano', async () => {
    const kv = mockKV();
    kv.set(EMT_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify([]));
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify([]));

    const families = await loadArtifactFamilies(mockEnv(kv), 'Test');

    expect(families.crtmLines).toBeNull();
    expect(families.crtmStops).toBeNull();
    expect(families.emtLines).toEqual([]);
    expect(families.degraded).toEqual(['crtm']);
  });

  it('ambas familias caídas: degraded [emt, crtm] (la política del 503 es de cada ruta)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));

    const families = await loadArtifactFamilies(mockEnv(mockKV()), 'Test');

    expect(families.emtLines).toBeNull();
    expect(families.emtStops).toBeNull();
    expect(families.crtmLines).toBeNull();
    expect(families.crtmStops).toBeNull();
    expect(families.degraded).toEqual(['emt', 'crtm']);
  });
});
