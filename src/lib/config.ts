export const EMT_CONFIG = {
  BASE_URL: 'https://openapi.emtmadrid.es',
  ENDPOINTS: {
    LOGIN: '/v1/mobilitylabs/user/login/',
    STOPS_LIST: '/v1/transport/busemtmad/stops/list/',
    LINES_INFO: '/v2/transport/busemtmad/lines/info/',
    LINE_DETAIL: '/v2/transport/busemtmad/lines/',
    STOP_DETAIL: '/v1/transport/busemtmad/stops/',
    CALENDAR: '/v1/transport/busemtmad/calendar/',
    STOP_ARRIVES: '/v2/transport/busemtmad/stops/',
    LINE_ROUTE: '/v1/transport/busemtmad/lines/',
    LINE_INCIDENTS: '/v1/transport/busemtmad/lines/incidents/',
  },
  CACHE_KEYS: {
    ACCESS_TOKEN: 'emt:access_token',
    STOPS_ALL: 'stops:all',
    LINES_ALL: 'lines:all',
    LINE_DETAIL: 'line:detail:',
    STOP_DETAIL: 'stop:detail:',
    CALENDAR: 'calendar:',
    LINE_TIMETABLE: 'timetable:',
    LINE_ROUTE: 'line:route:',
    INCIDENTS_ALL: 'incidents:all',
  },
  TOKEN_TTL: 24 * 60 * 60, // 24 hours in seconds
  DATA_TTL: 7 * 24 * 60 * 60, // 7 days in seconds
  CALENDAR_TTL: 30 * 24 * 60 * 60, // 30 days in seconds
  TIMETABLE_TTL: 7 * 24 * 60 * 60, // 7 days in seconds
  INCIDENTS_TTL: 30 * 60, // 30 minutes en seconds (feed vivo: avisos que caducan; ~48 escrituras KV/día)
  ARTIFACTS_MEMO_TTL_MS: 30 * 60 * 1000, // memoización por isolate de stops:all/lines:all (multi-MB). 5→30 min (auditoría CPU 2026-11-24): el cold-load (KV get + JSON.parse multi-MB + índices) era el mayor coste de CPU por request con el tráfico repartido en muchos isolates, y los artefactos solo cambian con el pipeline diario; coste aceptado: datos ≤30 min tras un /admin/refresh-cache
  ARRIVALS_CACHE_TTL: 30, // 30 seconds (en memoria, protege de ráfagas sin gastar escrituras KV; 2026-08-26: 15→30s, halve de llamadas por polling)
  ARRIVALS_CACHE_MAX_ENTRIES: 64, // techo de la micro-caché de arrivals (patrón pruneStopTimesCache del widget): una entrada por stopId:line crecería sin límite en un isolate de vida larga
  ARRIVALS_FETCH_TIMEOUT_MS: 10_000, // el endpoint de arrives de la EMT sufre degradaciones de minutos (2026-08-26: 20-60s/500): corta antes de colgar la petición
  ARRIVALS_STALE_MAX_AGE_MS: 3 * 60_000, // si la EMT falla tras caducar el TTL, sirve la última estimación hasta 3 min antigua
} as const;

// Artefactos CRTM en KV: los escribe scripts/crtm-ingest.mjs (TTL 0, refresco explícito del pipeline)
export const CRTM_CONFIG = {
  CACHE_KEYS: {
    STOPS_ALL: 'crtm:stops:all',
    LINES_ALL: 'crtm:lines:all',
    LINE_PREFIX: 'crtm:line:',
    META: 'crtm:meta',
  },
  SHAPES_OBJECT_PREFIX: 'line/', // claves R2 del bucket CRTM_SHAPES: line/<routeId>.json
  SEARCH_DEFAULT_LIMIT: 30,
  SEARCH_MAX_LIMIT: 100,
  SCHEDULE_WINDOW_DEFAULT_MIN: 120, // minutos (próximas salidas teóricas)
  SCHEDULE_WINDOW_MIN: 5,
  SCHEDULE_WINDOW_MAX: 360,
  SCHEDULE_MAX_RESULTS: 100,
  SCHEDULE_DATE_MAX_OFFSET_DAYS: 14, // horizonte del modo fecha (date=): [hoy, hoy+14] en hora de pared de Madrid
  SCHEDULE_DAY_MAX_RESULTS: 1000, // techo del tablón de día completo (intercambiadores con 30+ líneas)
  ARTIFACTS_MEMO_TTL_MS: 30 * 60 * 1000, // memoización por isolate de stops/lines (multi-MB) y del widgetDestMemo (destinos por routeId); los artefactos solo cambian con el pipeline diario (5→30 min por la auditoría CPU del 2026-11-24: el cold-load por isolate era el mayor coste por request)
  // S2 (auditoría CPU 2026-11-24, sesión 6): memo por isolate de los docs de línea
  // (crtm:line:<routeId>) — los schedule/arrivals de estaciones r_* y las fichas grandes
  // parsean docs multi-MB en CADA petición (10T_C5 = 3,25 MB; un hub de cercanías carga los
  // 12 docs = 11,35 MB medidos; 24-125 ms de CPU por schedule r_*). A diferencia de los 4
  // artefactos (TTL 30 min) aquí hay 482 docs: TTL corto para rotar memoria en isolates de
  // tráfico disperso y techo de bytes FIFO (expiradas primero, luego la más antigua) con el
  // que el set COMPLETO de un hub cabe sin crecer sin límite; el techo de entradas cubre los
  // docs pequeños y los null de routeIds sin doc
  LINE_DOCS_MEMO_TTL_MS: 60 * 1000,
  LINE_DOCS_MEMO_MAX_BYTES: 12 * 1024 * 1024,
  LINE_DOCS_MEMO_MAX_ENTRIES: 128,
  // Tiempo real Cercanías (GTFS-RT oficial de Renfe, CC BY 4.0, data.renfe.com):
  // feeds NACIONALES (~200 KB juntos, refresco ~20 s) que se filtran a Madrid por tripId
  RT: {
    TRIP_UPDATES_URL: 'https://gtfsrt.renfe.com/trip_updates.json',
    VEHICLE_POSITIONS_URL: 'https://gtfsrt.renfe.com/vehicle_positions.json',
    USER_AGENT: 'madmovil-api/1.0 (https://madmovil.es)',
    CACHE_TTL_MS: 25 * 1000, // 2 fetches por isolate como máximo cada 25 s, independiente del nº de estaciones (el feed se refresca cada ~20 s)
    FETCH_TIMEOUT_MS: 8_000,
    // Frescura por NUESTRO fetch (fiable): TripUpdates obtenido hace <3 min → el snapshot sirve
    STALE_MAX_AGE_MS: 3 * 60_000,
    // El header.timestamp de Renfe avanza a ritmo IRREGULAR (pausas de minutos son normales en
    // GTFS-RT; medido: 42 s congelado con el feed respondiendo 200): usarlo como reloj estricto
    // hacía bascular el tablón entero a "Programado" cada poco (bandazos 2026-09-01). Queda como
    // límite holgado: header más antiguo que esto = fuente congelada de verdad → degradado
    FEED_HEADER_MAX_AGE_MS: 10 * 60_000,
    // Madrid = núcleo 10: tripId = '10' + día de la ventana móvil (41..70) + letra de día
    // de semana (L/M/X/J/V/S/D) + trenId + línea (1041L19789C5 = lunes; 1046S... = sábado)
    // + refuerzos SPECIAL_10_*. Verificado contra TU/VP/panel/estático 2026-08-31: los
    // núcleos son siempre 2 dígitos, no hay colisión con ^10\d{2}[A-Z]
    MADRID_TRIP_ID: /^10\d{2}[A-Z]/,
    MADRID_SPECIAL_TRIP_ID: /^SPECIAL_10_/,
  },
  ARRIVALS_WINDOW_DEFAULT_MIN: 60, // próximas salidas con overlay de tiempo real
  ARRIVALS_WINDOW_MIN: 10,
  ARRIVALS_WINDOW_MAX: 180,
  // Tiempo real bus/ML/metro (API no documentada del widget oficial del CRTM,
  // www.crtm.es/widgets/): GetStopsTimes.php sin key con los parámetros exactos del widget.
  // Decisión 2026-10-09 tras el silencio del CRTM al email: misma vía que el resto de apps.
  // Sin contrato → degradación a tablón teórico obligatoria ante cualquier fallo
  WIDGET: {
    BASE_URL: 'https://www.crtm.es/widgets/api/',
    GET_STOP_TIMES: 'GetStopsTimes.php',
    GET_STOP: 'GetStops.php',
    STOP_TIMES_PARAMS: 'type=1&orderBy=2&stopTimesByIti=3',
    USER_AGENT: 'madmovil-api/1.0 (https://madmovil.es)',
    CACHE_TTL_MS: 25 * 1000, // 1 fetch por parada e isolate como máximo cada 25 s (consideración con el servicio)
    CACHE_MAX_ENTRIES: 64, // techo del caché por isolate (purga de expiradas/más antiguas)
    FETCH_TIMEOUT_MS: 8_000,
    STALE_MAX_AGE_MS: 3 * 60_000, // si el widget falla tras caducar el TTL, sirve la última instantánea hasta 3 min
    ACTUAL_DATE_MAX_AGE_MS: 10 * 60_000, // actualDate congelada más de 10 min = fuente congelada (límite holgado, igual que Renfe)
    // Resolución del modo de bus (el codStop del widget no se deriva de la red de la línea:
    // la 20789 es línea 9__* pero vive como 8_20789) → GetStops.php con 8_/9_ y caché del mapeo
    STOP_CODE_CACHE_PREFIX: 'crtm:widget:stop:',
    STOP_CODE_TTL: 30 * 24 * 60 * 60, // el modo de un poste no cambia (segundos KV)
    STOP_CODE_NONE_TTL: 24 * 60 * 60, // no encontrado: reintento al día (deriva temporal entre feeds)
    RESOLVE_MEMO_TTL_MS: 5 * 60 * 1000, // memoización por isolate del mapeo (evita leer KV en cada arrivals)
  },
  // Incidencias de cercanías (GetIncidentsAffectations.php?mode=5 del mismo widget oficial):
  // afectaciones que el operador carga en el SAE (verificado en vivo 2026-10-11: obras C9
  // Cercedilla–Cotos con servicio sustitutivo). Los avisos del CMS de crtm.es son un canal
  // DISTINTO sin feed estructurado y bus/metro/ML viajan vacíos hoy → solo cercanías
  INCIDENTS: {
    GET_INCIDENTS: 'GetIncidentsAffectations.php',
    CERCANIAS_MODE: '5', // mode del widget para cercanías (el parámetro se llama mode, no codMode)
    CACHE_KEY: 'crtm:incidents:cercanias',
    TTL: 30 * 60, // segundos KV, mismo criterio que las incidencias EMT (feed vivo, ~48 escrituras/día)
    FETCH_TIMEOUT_MS: 8_000,
  },
} as const;

// Patrones de validación de los identificadores CRTM compartidos por las rutas (antes eran
// regexes duplicadas en cada handler). STOP_CODE ({1,16}, antes {1,10} en /crtm/* y {1,16}
// en /connections) cubre bus numérico, ml 10_*, metro 4_* y cercanías r_*: un código de
// formato válido pero inexistente valida después contra stops:all → 404 (más correcto que
// un 400 por longitud).
export const CRTM_PATTERNS = {
  STOP_CODE: /^[A-Za-z0-9_]{1,16}$/,
  LINE_ID: /^[\w -]{1,20}$/, // label o routeId (C10, 8__421___)
  ROUTE_ID: /^[\w-]{1,24}$/, // routeId exacto (8__421___, 10T_C5)
} as const;

// Búsqueda unificada (GET /search): líneas + paradas de todas las redes en una sola consulta
export const EMT_SEARCH_CONFIG = {
  DEFAULT_LIMIT: 30,
  MAX_LIMIT: 100,
};

export const NEARBY_CONFIG = {
  DEFAULT_RADIUS_M: 300,
  MAX_RADIUS_M: 2000,
};

export const SEARCH_CONFIG = {
  MAX_QUERY_CHARS: 60,
  LINES_DEFAULT_LIMIT: 5,
  LINES_MAX_LIMIT: 20,
  STOPS_DEFAULT_LIMIT: 8,
  STOPS_MAX_LIMIT: 50,
} as const;

// Conexiones/transbordos entre paradas (GET /connections/:source/:stopId): líneas de otras
// paradas en un radio a pie (los intercambiadores son N paradas con códigos distintos).
// Cap 500 m: en Atocha-style todo queda <500 m; más radio añade ruido de paradas no relacionadas
export const CONNECTIONS_CONFIG = {
  RADIUS_DEFAULT_M: 300,
  RADIUS_MAX_M: 500,
} as const;

// Vault de favoritos (copia de sincronización anónima cifrada E2E en el cliente)
// La clave KV se deriva del token del portador: fav:vault:v1:<hex(sha256(authToken))>
export const FAVORITES_VAULT_CONFIG = {
  CACHE_KEY_PREFIX: 'fav:vault:v1:',
  TTL_SECONDS: 180 * 24 * 60 * 60, // caduca a los 180 días sin uso (escrituras POST/PUT la reescriben)
  REFRESH_THRESHOLD_SECONDS: 90 * 24 * 60 * 60, // GET/PUT refrescan la expiración si queda menos de esto
  MAX_BODY_CHARS: 16 * 1024, // límite del body JSON completo (payload cifrado en b64 + turnstileToken en POST)
  MAX_PAYLOAD_B64_CHARS: 12 * 1024, // payload base64 del ciphertext (≈9 KB de claro: de sobra para >100 favoritos)
  MAX_NONCE_B64_CHARS: 64, // base64 del IV (AES-GCM 96 bits = 16 chars b64; margen para clientes generosos)
  MAX_TURNSTILE_TOKEN_CHARS: 2048, // tokens de Turnstile ~2000 chars
} as const;
