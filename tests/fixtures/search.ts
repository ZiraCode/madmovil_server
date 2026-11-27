import type { Line, Stop } from '../../src/types/emt-data';
import type { CRTMLineSummary, CRTMStop } from '../../src/types/crtm-data';

/**
 * Fixtures del buscador unificado (/search): forma exacta de los artefactos de caché
 * (stops:all y lines:all de EMT; crtm:stops:all y crtm:lines:all de CRTM), con los casos
 * que ejercitan el ranking: labels duplicados entre redes, red en catálogo (noSchedule),
 * query numérica con frontera de dígitos y matches por municipio.
 */

export function emtStopsSearchFixture(): Stop[] {
  return [
    {
      stopId: '62',
      name: 'Marqués de Urquijo - Ventura Rodríguez',
      coordinates: { latitude: 40.4299, longitude: -3.7136 },
      lines: ['2', '46'],
    },
    {
      stopId: '456',
      name: 'Gran Vía - Montera',
      coordinates: { latitude: 40.4201, longitude: -3.7099 },
      lines: ['5'],
    },
    {
      stopId: '5001',
      name: 'Sol - Sevilla',
      coordinates: { latitude: 40.4168, longitude: -3.7038 },
      lines: ['N16'],
    },
  ];
}

export function emtLinesSearchFixture(): Line[] {
  return [
    {
      lineId: '001',
      label: '1',
      nameA: 'Prosperidad',
      nameB: 'Princesa',
      group: 'EMT',
      color: '53418F',
    },
    {
      lineId: '051',
      label: '51',
      nameA: 'Plaza Jacinto Benavente',
      nameB: 'Prosperidad',
      group: 'EMT',
      color: '53418F',
    },
    {
      lineId: '010',
      label: '10',
      nameA: 'Plaza de Cibeles',
      nameB: 'San Ignacio de Loyola',
      group: 'EMT',
      color: '53418F',
    },
  ];
}

export function crtmStopsSearchFixture(): CRTMStop[] {
  return [
    {
      code: '4_12',
      name: 'Sol',
      address: null,
      lat: 40.4168,
      lon: -3.7038,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['1', '2', '3'],
    },
    {
      code: '10_1',
      name: 'Las Tablas',
      address: 'Avenida de Asturias 2',
      lat: 40.4889,
      lon: -3.6619,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['ML1'],
    },
    {
      code: '08712',
      name: 'Av. Europa - C. Mayor',
      address: 'Calle Mayor 5',
      lat: 40.3452,
      lon: -3.8257,
      zone: 'B1',
      municipality: 'Alcorcón',
      lines: ['1'],
    },
    {
      code: '08713',
      name: 'Estación de Alcorcón',
      address: null,
      lat: 40.3455,
      lon: -3.824,
      zone: 'B1',
      municipality: 'Alcorcón',
      lines: ['1'],
    },
    {
      code: '06165',
      name: 'EST. LA GARENA',
      address: 'Calle de Alcalá 62',
      lat: 40.4722,
      lon: -3.365,
      zone: 'B1',
      municipality: 'Alcalá de Henares',
      lines: ['6'],
    },
    {
      code: '06159',
      name: 'CTRA. M505 - URB. LOS GAMOS',
      address: 'Ctra del Escorial 16200',
      lat: 40.5702,
      lon: -3.9888,
      zone: 'B3',
      municipality: 'Galapagar',
      lines: ['661'],
    },
    {
      code: 'r_18000',
      name: 'Madrid-Atocha Cercanías',
      address: null,
      lat: 40.4055,
      lon: -3.6886,
      zone: null,
      municipality: 'Madrid',
      lines: ['C5', 'C10'],
    },
  ];
}

export function crtmLinesSearchFixture(): CRTMLineSummary[] {
  return [
    {
      label: '1',
      routeId: '9__1__013_',
      name: 'Urbano Alcorcón',
      network: 'urban',
      municipality: 'Alcorcón',
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
      label: 'R',
      routeId: '4__R_____',
      name: 'Metro R Ópera - Príncipe Pío',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      color: 'A0A0A0',
      textColor: 'FFFFFF',
      noSchedule: true,
    },
    {
      label: 'ML1',
      routeId: '10__ML1___',
      name: 'ML1 Las Tablas - Pinar de Chamartín',
      network: 'ml',
      municipality: 'Madrid',
      url: null,
      color: '3A7DDA',
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
