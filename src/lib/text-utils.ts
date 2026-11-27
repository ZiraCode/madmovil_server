/**
 * Normaliza texto para búsquedas insensibles a mayúsculas, acentos y caracteres especiales
 * @param text Texto a normalizar
 * @returns Texto normalizado en minúsculas sin acentos ni caracteres especiales
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD') // Descompone caracteres acentuados
    .replace(/[\u0300-\u036f]/g, '') // Elimina marcas de acentos
    .replace(/[^a-z0-9\s]/g, '') // Elimina caracteres especiales, mantiene letras, números y espacios
    .trim();
}

/** Colección del backend SOAP→JSON del CRTM → array: 1 elemento llega como objeto suelto y la vacía como {} */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return [value];
  return [];
}

/**
 * Tokens de nombre propio: minúsculas sin acentos, separadores ('.', '-', '('...) SUSTITUIDOS
 * por espacio (normalizeText los borra y fusionaría "EST.LA" → "estla"). Stopwords
 * parametrizadas por dominio: NO fusionar las listas — los conectores de nombres de estación
 * (incidencias) y las conjunciones de cabeceras (destinos) son conjuntos distintos a propósito
 */
export function nameTokens(text: string, stopwords: ReadonlySet<string>): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !stopwords.has(t));
}
