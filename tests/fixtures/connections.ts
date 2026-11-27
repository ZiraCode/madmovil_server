import type { Line, Stop } from '../../src/types/emt-data';
import type { CRTMLineSummary, CRTMStop } from '../../src/types/crtm-data';

/**
 * Fixtures de /connections: escenario tipo intercambiador (Moncloa) donde la "misma" estación
 * son N paradas con códigos distintos (EMT + interurbanos + metro + ML + cercanías).
 *
 * Distancias fabricadas con offsets puros de latitud sobre la misma longitud (1e-4 deg ≈ 11,1 m;
 * el haversine sobre un meridiano es exacto), para que los tests afirmen distancias redondas:
 * 0.00027→30 m, 0.00045→50 m, 0.00072→80 m, 0.0008→89 m, 0.0009→100 m, 0.0018→200 m,
 * 0.00315→350 m, 0.00432→480 m, 0.005→556 m (fuera incluso del radio máx 500).
 *
 * Casos deliberados: label '3' en EMT y metro (misma etiqueta, redes distintas: nunca se
 * deduplica entre redes), label '573' en dos paradas (dedup dentro de interurban), label '6'
 * en dos entradas de metro (4_202/4_203, dedup dentro de metro), label '99' de metro SIN
 * entrada en lines:all (ref con id null), label '1' urbano+metro en lines:all servido por una
 * parada de bus (solo cuenta como urban).
 */

const BASE_LAT = 40.4385;
const BASE_LON = -3.7415;

export function emtStopsConnectionsFixture(): Stop[] {
  return [
    {
      stopId: '602',
      name: 'Moncloa',
      coordinates: { latitude: BASE_LAT, longitude: BASE_LON },
      lines: ['3', '44', '133'],
    },
    {
      stopId: '603',
      name: 'Moncloa II',
      coordinates: { latitude: BASE_LAT + 0.00027, longitude: BASE_LON },
      lines: ['44', '160', '161'],
    },
    {
      stopId: '666',
      name: 'Marqués de Urquijo - Centro',
      coordinates: { latitude: BASE_LAT + 0.00315, longitude: BASE_LON },
      lines: ['2', '10'],
    },
  ];
}

export function emtLinesConnectionsFixture(): Line[] {
  return [
    {
      lineId: '003',
      label: '3',
      nameA: 'San Amaro',
      nameB: 'Plaza de España',
      group: 'EMT',
      color: 'D2232A',
    },
    {
      lineId: '044',
      label: '44',
      nameA: 'Callao',
      nameB: 'Moscatelares',
      group: 'EMT',
      color: '00A0E2',
    },
    {
      lineId: '133',
      label: '133',
      nameA: 'Callao',
      nameB: 'Mirasierra',
      group: 'EMT',
      color: '53418F',
    },
    {
      lineId: '160',
      label: '160',
      nameA: 'Moncloa',
      nameB: 'Aravaca',
      group: 'EMT',
      color: '53418F',
    },
    {
      lineId: '161',
      label: '161',
      nameA: 'Moncloa',
      nameB: 'Aravaca Sur',
      group: 'EMT',
      color: '53418F',
    },
    {
      lineId: '002',
      label: '2',
      nameA: 'Reina Victoria',
      nameB: 'Argüelles',
      group: 'EMT',
      color: '53418F',
    },
    {
      lineId: '010',
      label: '10',
      nameA: 'Cibeles',
      nameB: 'Lucero',
      group: 'EMT',
      color: '53418F',
    },
  ];
}

export function crtmStopsConnectionsFixture(): CRTMStop[] {
  return [
    {
      code: '06002',
      name: 'INTERCAMBIADOR MONCLOA',
      address: null,
      lat: BASE_LAT + 0.00045,
      lon: BASE_LON,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['571', '573'],
    },
    {
      code: '4_202',
      name: 'MONCLOA',
      address: null,
      lat: BASE_LAT + 0.00072,
      lon: BASE_LON,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['3', '6'],
    },
    {
      code: '4_203',
      name: 'MONCLOA',
      address: null,
      lat: BASE_LAT + 0.0008,
      lon: BASE_LON,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['6', '99'],
    },
    {
      code: '08888',
      name: 'Calle Mayor - Moncloa',
      address: 'Calle Mayor 1',
      lat: BASE_LAT + 0.0009,
      lon: BASE_LON,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['1', '573'],
    },
    {
      code: '10_7',
      name: 'MONCLOA',
      address: null,
      lat: BASE_LAT + 0.0018,
      lon: BASE_LON,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['ML2'],
    },
    {
      code: 'r_18000',
      name: 'Príncipe Pío Cercanías',
      address: null,
      lat: BASE_LAT + 0.00432,
      lon: BASE_LON,
      zone: null,
      municipality: 'Madrid',
      lines: ['C5', 'C10'],
    },
    {
      code: '06999',
      name: 'Carretera Lejana',
      address: null,
      lat: BASE_LAT + 0.005,
      lon: BASE_LON,
      zone: 'B1',
      municipality: 'Las Rozas',
      lines: ['592'],
    },
  ];
}

export function crtmLinesConnectionsFixture(): CRTMLineSummary[] {
  return [
    {
      label: '571',
      routeId: '8__571___',
      name: 'Moncloa - Boadilla del Monte',
      network: 'interurban',
      municipality: 'Boadilla del Monte',
      url: null,
    },
    {
      label: '573',
      routeId: '8__573___',
      name: 'Moncloa - Pozuelo de Alarcón',
      network: 'interurban',
      municipality: 'Pozuelo de Alarcón',
      url: null,
    },
    {
      label: '592',
      routeId: '8__592___',
      name: 'Moncloa - Las Rozas',
      network: 'interurban',
      municipality: 'Las Rozas',
      url: null,
    },
    {
      label: '1',
      routeId: '9__1__013_',
      name: 'Urbano Centro',
      network: 'urban',
      municipality: 'Madrid',
      url: null,
    },
    {
      label: '1',
      routeId: '4__1_____',
      name: 'Metro L1 Pinar de Chamartín - Valdecarros',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      color: '58ABE8',
      textColor: 'FFFFFF',
    },
    {
      label: '3',
      routeId: '4__3_____',
      name: 'Metro L3 Moncloa - Villaverde Alto',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      color: '8EBF42',
      textColor: 'FFFFFF',
    },
    {
      label: '6',
      routeId: '4__6_____',
      name: 'Metro L6 Circular',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      color: 'A0A0A0',
      textColor: 'FFFFFF',
    },
    {
      label: 'ML2',
      routeId: '10__ML2___',
      name: 'ML2 Colonia Jardín - Estación de Aravaca',
      network: 'ml',
      municipality: 'Pozuelo de Alarcón',
      url: null,
      color: 'A60084',
    },
    {
      label: 'C5',
      routeId: '10T_C5',
      name: 'Móstoles-El Soto - Humanes',
      network: 'cercanias',
      municipality: 'Móstoles',
      url: null,
      color: 'FECB00',
      textColor: '000000',
    },
    {
      label: 'C10',
      routeId: '10T_C10',
      name: 'Madrid-Chamartín - Villalba',
      network: 'cercanias',
      municipality: 'Madrid',
      url: null,
      color: 'C4D600',
      textColor: '000000',
    },
  ];
}
