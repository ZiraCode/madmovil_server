import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRTM_CONFIG } from '../../src/lib/config';
import {
  __resetRealtimeCache,
  getMadridRealtime,
  isRealtimeFresh,
  parsePlatformLabel,
} from '../../src/lib/crtm-rt';
import { CRTM_TEST_NOW, crtmRenfeRealtimeFixture } from '../fixtures/crtm';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rtFetchMock(
  nowMs = CRTM_TEST_NOW,
  opts: { stale?: boolean; vpFails?: boolean; tuFails?: boolean } = {},
) {
  const { tripUpdates, vehiclePositions } = crtmRenfeRealtimeFixture(nowMs, opts);
  return vi.fn().mockImplementation((url: string | URL) => {
    const u = String(url);
    if (u === CRTM_CONFIG.RT.TRIP_UPDATES_URL) {
      if (opts.tuFails) return Promise.reject(new TypeError('tu down'));
      return Promise.resolve(jsonResponse(tripUpdates));
    }
    if (u === CRTM_CONFIG.RT.VEHICLE_POSITIONS_URL) {
      if (opts.vpFails) return Promise.reject(new TypeError('vp down'));
      return Promise.resolve(jsonResponse(vehiclePositions));
    }
    return Promise.reject(new Error(`URL inesperada: ${u}`));
  });
}

beforeEach(() => {
  __resetRealtimeCache();
  vi.setSystemTime(new Date(CRTM_TEST_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parsePlatformLabel', () => {
  it('extrae el andén del label de VP', () => {
    expect(parsePlatformLabel('C5-19789-PLATF.(1)')).toBe('1');
    expect(parsePlatformLabel('C4a-20319-PLATF.(8AM)')).toBe('8AM');
    expect(parsePlatformLabel('C3-99002-PLATF.(0)')).toBe('0');
    expect(parsePlatformLabel('C5-19789')).toBeNull();
    expect(parsePlatformLabel(null)).toBeNull();
    expect(parsePlatformLabel(undefined)).toBeNull();
  });
});

describe('getMadridRealtime', () => {
  it('filtra Madrid (1041L/SPECIAL_10_), une TU+VP y mapea los campos', async () => {
    const fetchMock = rtFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const rt = await getMadridRealtime();

    expect(rt).not.toBeNull();
    // 6 entidades TU de Madrid (5 board/SPECIAL + 1041L19789C5) + 0 solo-VP nuevas
    expect(rt!.byTripId.size).toBe(6);
    expect(rt!.byTripId.has('3041L23574C1')).toBe(false);

    const exact = rt!.byTripId.get('1041L19791C5')!;
    expect(exact).toMatchObject({
      tripId: '1041L19791C5',
      scheduleRelationship: 'SCHEDULED',
      delaySec: 120,
      nextStopId: '18000',
      nextStopArrivalSec: Math.floor(CRTM_TEST_NOW / 1000) + 660,
      accessible: true,
      platform: '9',
      status: 'INCOMING_AT',
      vehicleId: '19791',
      position: { latitude: 40.4008, longitude: -3.6826 },
    });

    const canceled = rt!.byTripId.get('1041L19795C5')!;
    expect(canceled.scheduleRelationship).toBe('CANCELED');
    expect(canceled.platform).toBe('10');

    const added = rt!.byTripId.get('SPECIAL_10_99001C5')!;
    expect(added.scheduleRelationship).toBe('ADDED');
    expect(added.nextStopId).toBe('18000');

    // accesible solo tri-estado: UNKNOWN → null
    expect(rt!.byTripId.get('1041L19792C5')!.accessible).toBe(false);

    expect(rt!.feedTimestampMs).toBe(CRTM_TEST_NOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caché por isolate: dentro del TTL no re-fetch', async () => {
    const fetchMock = rtFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await getMadridRealtime();
    await getMadridRealtime();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('el filtro Madrid acepta cualquier día de la ventana móvil (1046S sábado, 1070M...)', async () => {
    const { tripUpdates, vehiclePositions } = crtmRenfeRealtimeFixture();
    tripUpdates.entity.push({
      tripUpdate: {
        trip: { tripId: '1046S30001C8', scheduleRelationship: 'SCHEDULED' },
        delay: 30,
      },
      // entidad mínima a propósito (sin stopTimeUpdate ni vehicle): así viajan los trips
    } as (typeof tripUpdates.entity)[number]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string | URL) =>
          jsonResponse(
            String(url) === CRTM_CONFIG.RT.TRIP_UPDATES_URL ? tripUpdates : vehiclePositions,
          ),
        ),
    );

    const rt = await getMadridRealtime();

    expect(rt!.byTripId.has('1046S30001C8')).toBe(true);
    expect(rt!.byTripId.has('3041L23574C1')).toBe(false); // Sevilla fuera
  });

  it('VP caído no degrada el tablón (sin andén/posición)', async () => {
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW, { vpFails: true }));

    const rt = await getMadridRealtime();

    expect(rt).not.toBeNull();
    expect(rt!.byTripId.get('1041L19791C5')!.platform).toBeNull();
    expect(rt!.byTripId.get('1041L19791C5')!.delaySec).toBe(120);
  });

  it('TU caído sin caché → null (el llamador sirve tablón teórico)', async () => {
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW, { tuFails: true }));

    const rt = await getMadridRealtime();

    expect(rt).toBeNull();
  });

  it('caché negativa: un fallo se recuerda CACHE_TTL_MS y no repite fetch', async () => {
    const fetchMock = rtFetchMock(CRTM_TEST_NOW, { tuFails: true });
    vi.stubGlobal('fetch', fetchMock);

    expect(await getMadridRealtime()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // TU + VP (allSettled: VP no bloquea)

    expect(await getMadridRealtime()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // null inmediato, sin pagar el timeout

    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.RT.CACHE_TTL_MS + 1000));
    expect(await getMadridRealtime()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // caducada la negativa: reintenta
  });

  it('la marca de fallo se limpia con un fetch OK posterior', async () => {
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW, { tuFails: true }));
    expect(await getMadridRealtime()).toBeNull();

    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.RT.CACHE_TTL_MS + 1000));
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW + CRTM_CONFIG.RT.CACHE_TTL_MS + 1000));
    expect(await getMadridRealtime()).not.toBeNull();
  });

  it('TU caído con caché fresca → stale-serve de la última instantánea', async () => {
    vi.stubGlobal('fetch', rtFetchMock());
    const first = await getMadridRealtime();
    expect(first).not.toBeNull();

    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW, { tuFails: true }));
    // avanza menos que STALE_MAX_AGE_MS (caché caducada por TTL pero servible)
    vi.setSystemTime(new Date(CRTM_TEST_NOW + 60_000));
    const served = await getMadridRealtime();

    expect(served).not.toBeNull();
    expect(served!.byTripId.size).toBe(6);
  });

  it('delay del arrival de la próxima parada rellena delaySec si falta el global', async () => {
    const { tripUpdates, vehiclePositions } = crtmRenfeRealtimeFixture();
    delete (tripUpdates.entity[0].tripUpdate as { delay?: number }).delay;
    tripUpdates.entity[0].tripUpdate!.stopTimeUpdate![0].arrival!.delay = 300;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string | URL) =>
          jsonResponse(
            String(url) === CRTM_CONFIG.RT.TRIP_UPDATES_URL ? tripUpdates : vehiclePositions,
          ),
        ),
    );

    const rt = await getMadridRealtime();

    expect(rt!.byTripId.get('1041L19791C5')!.delaySec).toBe(300);
  });
});

describe('isRealtimeFresh', () => {
  it('fresco con header actual y degradado con header congelado', async () => {
    vi.stubGlobal('fetch', rtFetchMock());
    const fresh = await getMadridRealtime();
    expect(isRealtimeFresh(fresh!)).toBe(true);

    __resetRealtimeCache();
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW, { stale: true }));
    const stale = await getMadridRealtime();
    expect(stale).not.toBeNull();
    expect(isRealtimeFresh(stale!)).toBe(false);
  });

  it('header congelado varios minutos con fetch OK → FRESCO (anti-bandazo: el timestamp de Renfe avanza a ritmo irregular)', async () => {
    // header 2 min por detrás del reloj, fetch respondiendo ahora (200 con snapshot repetido)
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW - 2 * 60_000));

    const rt = await getMadridRealtime();

    expect(rt).not.toBeNull();
    expect(isRealtimeFresh(rt!)).toBe(true);
  });

  it('fetch caducado (>STALE_MAX_AGE_MS) → degradado aunque el header fuera reciente', async () => {
    vi.stubGlobal('fetch', rtFetchMock());
    const rt = await getMadridRealtime();

    // 4 min después (caché caducada y fuera de la gracia de stale-serve)
    vi.setSystemTime(new Date(CRTM_TEST_NOW + 4 * 60_000));
    expect(isRealtimeFresh(rt!)).toBe(false);
  });

  it('header ausente con fetch OK → fresco (los datos sirven aunque el feed no publique timestamp)', async () => {
    const { tripUpdates, vehiclePositions } = crtmRenfeRealtimeFixture();
    delete (tripUpdates.header as { timestamp?: string }).timestamp;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string | URL) =>
          jsonResponse(
            String(url) === CRTM_CONFIG.RT.TRIP_UPDATES_URL ? tripUpdates : vehiclePositions,
          ),
        ),
    );

    const rt = await getMadridRealtime();

    expect(rt).not.toBeNull();
    expect(rt!.feedTimestampMs).toBeNull();
    expect(isRealtimeFresh(rt!)).toBe(true);
  });
});
