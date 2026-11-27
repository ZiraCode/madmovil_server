import { describe, expect, it, vi } from 'vitest';
import {
  getCRTMStops,
  getCRTMLinesAll,
  getCRTMStopLineDocs,
  CRTMDataUnavailableError,
} from '../../src/lib/crtm-cache';
import { CRTM_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV } from '../helpers/mock-kv';
import type { CRTMLineDoc, CRTMStop } from '../../src/types/crtm-data';

describe('memoización por isolate de artefactos CRTM (WeakMap por binding KV)', () => {
  it('getCRTMStops no relee KV dentro del TTL', async () => {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([{ code: '08497', name: 'SANTA MARIA', lines: ['513'] }]),
    );
    const env = mockEnv(kv);

    const first = await getCRTMStops(env);
    kv.delete(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL);
    const second = await getCRTMStops(env);

    expect(second).toEqual(first);
    expect(second[0].code).toBe('08497');
  });

  it('envs con KV distinto no comparten memo', async () => {
    const kvA = mockKV();
    kvA.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([{ code: 'a', name: 'A', lines: [] }]),
    );
    const kvB = mockKV();
    kvB.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([{ code: 'b', name: 'B', lines: [] }]),
    );

    expect((await getCRTMStops(mockEnv(kvA)))[0].name).toBe('A');
    expect((await getCRTMStops(mockEnv(kvB)))[0].name).toBe('B');
  });

  it('getCRTMLinesAll memoiza igual y sigue fallando si el artefacto falta', async () => {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({ count: 1, lines: [{ routeId: '8__1___', label: '1' }] }),
    );
    const env = mockEnv(kv);

    const first = await getCRTMLinesAll(env);
    kv.delete(CRTM_CONFIG.CACHE_KEYS.LINES_ALL);
    expect(await getCRTMLinesAll(env)).toEqual(first);

    await expect(getCRTMLinesAll(mockEnv(mockKV()))).rejects.toThrow('Datos CRTM no disponibles');
  });

  it('single-flight: llamadas concurrentes con el memo frío comparten UNA sola lectura KV', async () => {
    const kv = mockKV();
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify([{ code: 'a', name: 'A', lines: [] }]));
    const env = mockEnv(kv);

    const all = await Promise.all([getCRTMStops(env), getCRTMStops(env), getCRTMStops(env)]);

    expect(kv.getCalls.filter((key) => key === CRTM_CONFIG.CACHE_KEYS.STOPS_ALL)).toHaveLength(1);
    expect(all[0]).toEqual(all[2]);
  });

  it('un fallo no queda memoizado: la siguiente llamada reintenta la lectura', async () => {
    const kv = mockKV();
    const env = mockEnv(kv);
    await expect(getCRTMStops(env)).rejects.toThrow('Datos CRTM no disponibles');

    // sin la expulsión del fallo, el rechazo estaría memoizado 5 min y esto volvería a fallar
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify([{ code: 'a', name: 'A', lines: [] }]));
    await expect(getCRTMStops(env)).resolves.toHaveLength(1);
  });

  it('la url de ficha .aspx del portal antiguo CRTM se sirve sin extensión (artefactos previos al fix del pipeline)', async () => {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 2,
        lines: [
          { routeId: '9__6__005_', label: '6', url: 'https://www.crtm.es/9__6__005_.aspx' },
          { routeId: '8__1___', label: '1', url: 'https://crtm.es/a' },
        ],
      }),
    );

    const all = await getCRTMLinesAll(mockEnv(kv));
    expect(all.lines[0].url).toBe('https://www.crtm.es/9__6__005_');
    expect(all.lines[1].url).toBe('https://crtm.es/a');
  });
});

describe('valor vacío en una clave CRTM (D-1): 503 CRTMDataUnavailableError, no 500 de JSON corrupto', () => {
  it('getCRTMStops con crtm:stops:all como cadena vacía rechaza con CRTMDataUnavailableError', async () => {
    const kv = mockKV();
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, '');
    const env = mockEnv(kv);

    await expect(getCRTMStops(env)).rejects.toBeInstanceOf(CRTMDataUnavailableError);
  });

  it('getCRTMLinesAll con crtm:lines:all como cadena vacía rechaza con CRTMDataUnavailableError', async () => {
    const kv = mockKV();
    kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, '');
    const env = mockEnv(kv);

    await expect(getCRTMLinesAll(env)).rejects.toBeInstanceOf(CRTMDataUnavailableError);
  });
});

// S2 (auditoría de CPU 2026-11-24): memo por isolate de los docs de línea (crtm:line:<routeId>).
// mockEnv() fresco por test porque el memo es de módulo y se clava por binding KV
describe('memo por isolate de docs de línea (S2: TTL corto + techo de bytes FIFO)', () => {
  function lineDoc(routeId: string, label: string, name = `Línea ${label}`): CRTMLineDoc {
    return {
      routeId,
      label,
      name,
      network: 'interurban',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'A', stops: ['09568'] }],
      services: [
        {
          id: 'LAB',
          days: [1, 1, 1, 1, 1, 1, 1],
          from: '20260101',
          to: '20270101',
          exceptions: {},
        },
      ],
      trips: [{ dir: 0, svc: 0, headsign: 'A', dep: 3600, stops: ['09568@0'] }],
    };
  }

  function stopOf(lines: string[]): CRTMStop {
    return {
      code: '09568',
      name: 'Parada de prueba',
      address: null,
      lat: null,
      lon: null,
      zone: null,
      municipality: null,
      lines,
    };
  }

  // raw null = doc ausente en KV (la línea está en lines:all pero su doc no existe)
  function envLineDocs(entries: Array<{ routeId: string; label: string; raw: string | null }>) {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: entries.length,
        lines: entries.map((e) => ({
          label: e.label,
          routeId: e.routeId,
          name: `Línea ${e.label}`,
          network: 'interurban',
          municipality: 'Madrid',
          url: null,
        })),
      }),
    );
    for (const e of entries) {
      if (e.raw !== null) kv.set(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${e.routeId}`, e.raw);
    }
    return { env: mockEnv(kv), kv };
  }

  const key = (routeId: string) => `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${routeId}`;

  it('single-flight: 3 lecturas concurrentes del mismo routeId → UNA sola lectura KV', async () => {
    const doc = lineDoc('8__421___', '421');
    const { env, kv } = envLineDocs([
      { routeId: '8__421___', label: '421', raw: JSON.stringify(doc) },
    ]);
    const stop = stopOf(['421']);

    const [first, second, third] = await Promise.all([
      getCRTMStopLineDocs(env, stop),
      getCRTMStopLineDocs(env, stop),
      getCRTMStopLineDocs(env, stop),
    ]);

    expect(kv.getCalls.filter((k) => k === key('8__421___'))).toHaveLength(1);
    // misma instancia: el doc parseado se comparte entre las concurrentes (y con las siguientes)
    expect(second[0]).toBe(first[0]);
    expect(third[0]).toBe(first[0]);
  });

  it('TTL: dentro de la ventana no relee y al caducar relee', async () => {
    const doc = lineDoc('8__421___', '421');
    const { env, kv } = envLineDocs([
      { routeId: '8__421___', label: '421', raw: JSON.stringify(doc) },
    ]);
    const stop = stopOf(['421']);

    await getCRTMStopLineDocs(env, stop);
    await getCRTMStopLineDocs(env, stop);
    expect(kv.getCalls.filter((k) => k === key('8__421___'))).toHaveLength(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + CRTM_CONFIG.LINE_DOCS_MEMO_TTL_MS + 1);
      await getCRTMStopLineDocs(env, stop);
      expect(kv.getCalls.filter((k) => k === key('8__421___'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un fallo (valor vacío → CRTMDataUnavailableError) no queda memoizado: reintenta la lectura', async () => {
    const { env, kv } = envLineDocs([{ routeId: '8__421___', label: '421', raw: '' }]);
    const stop = stopOf(['421']);

    await expect(getCRTMStopLineDocs(env, stop)).rejects.toBeInstanceOf(CRTMDataUnavailableError);

    // sin la expulsión del fallo, el rechazo estaría memoizado 60 s y esto volvería a fallar
    kv.set(key('8__421___'), JSON.stringify(lineDoc('8__421___', '421')));
    await expect(getCRTMStopLineDocs(env, stop)).resolves.toHaveLength(1);
  });

  it('techo de bytes desaloja FIFO: el doc más antiguo se relee, el resto sigue caliente', async () => {
    // 3 docs de ~4,5 MB: dos caben (9 MB < techo de 12 MB), el tercero desaloja al primero
    // (tamaño del 10T_C5 real: 3,25 MB; el techo está calibrado para el set completo de un hub)
    const pad = 'X'.repeat(4_500_000);
    const entries = ['A', 'B', 'C'].map((label) => ({
      routeId: `8__${label}_____`,
      label,
      raw: JSON.stringify(lineDoc(`8__${label}_____`, label, `${label} ${pad}`)),
    }));
    const { env, kv } = envLineDocs(entries);
    const stop = stopOf(['A', 'B', 'C']);

    await getCRTMStopLineDocs(env, stop);
    await getCRTMStopLineDocs(env, stop);

    // 2ª llamada: A (desalojada por FIFO al insertar C) relee; B y C salieron del memo
    expect(kv.getCalls.filter((k) => k === key('8__A_____'))).toHaveLength(2);
    expect(kv.getCalls.filter((k) => k === key('8__B_____'))).toHaveLength(1);
    expect(kv.getCalls.filter((k) => k === key('8__C_____'))).toHaveLength(1);
  });

  it('techo de entradas desaloja FIFO con docs pequeños (el techo de bytes no aplica)', async () => {
    const total = CRTM_CONFIG.LINE_DOCS_MEMO_MAX_ENTRIES + 3;
    const entries = Array.from({ length: total }, (_, i) => ({
      routeId: `r${i}`,
      label: `L${i}`,
      raw: JSON.stringify(lineDoc(`r${i}`, `L${i}`)),
    }));
    const { env, kv } = envLineDocs(entries);
    const stop = stopOf(entries.map((e) => e.label));

    await getCRTMStopLineDocs(env, stop);
    await getCRTMStopLineDocs(env, stop);

    expect(kv.getCalls.filter((k) => k === key('r0'))).toHaveLength(2); // desalojada por el techo
    expect(kv.getCalls.filter((k) => k === key(`r${total - 1}`))).toHaveLength(1); // la última sigue
  });

  it('docs de rutas distintas no se pisan: cada routeId sirve SU doc del memo', async () => {
    const { env, kv } = envLineDocs([
      { routeId: '8__A_____', label: 'A', raw: JSON.stringify(lineDoc('8__A_____', 'A', 'Doc A')) },
      { routeId: '8__B_____', label: 'B', raw: JSON.stringify(lineDoc('8__B_____', 'B', 'Doc B')) },
    ]);

    const docsA = await getCRTMStopLineDocs(env, stopOf(['A']));
    const docsB = await getCRTMStopLineDocs(env, stopOf(['B']));
    expect(docsA[0].name).toBe('Doc A');
    expect(docsB[0].name).toBe('Doc B');

    // sobrescribir A en KV no contamina a B (ni a A hasta caducar su TTL: mismo doc compartido)
    kv.set(key('8__A_____'), JSON.stringify(lineDoc('8__A_____', 'A', 'Doc A mutado')));
    expect((await getCRTMStopLineDocs(env, stopOf(['B'])))[0].name).toBe('Doc B');
    expect((await getCRTMStopLineDocs(env, stopOf(['A'])))[0].name).toBe('Doc A');
  });

  it('un null de doc ausente queda memoizado: no relee KV hasta caducar el TTL', async () => {
    const { env, kv } = envLineDocs([{ routeId: '8__A_____', label: 'A', raw: null }]);
    const stop = stopOf(['A']);

    await expect(getCRTMStopLineDocs(env, stop)).resolves.toHaveLength(0);
    kv.set(key('8__A_____'), JSON.stringify(lineDoc('8__A_____', 'A')));
    await expect(getCRTMStopLineDocs(env, stop)).resolves.toHaveLength(0);

    expect(kv.getCalls.filter((k) => k === key('8__A_____'))).toHaveLength(1);
  });
});
