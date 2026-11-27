import type { Env } from '../types';

/**
 * Memoización por isolate de artefactos KV compartida por emt-cache y crtm-cache: la clave
 * del WeakMap es el binding KV (cada isolate memoiza el suyo y los tests con mockKV fresco
 * no comparten estado). El memo LLEVA su clave KV (D-2): getCachedArtifact lee SIEMPRE la
 * clave del memo, así que no existe forma de pedir una clave que no sea la suya. El TTL
 * viaja en el propio memo (cada familia pasa SU constante de config:
 * EMT_CONFIG/CRTM_CONFIG.ARTIFACTS_MEMO_TTL_MS, hoy iguales pero deliberadamente
 * separadas — este módulo no importa ningún config).
 */
export interface MemoEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

export interface ArtifactMemo<T> {
  key: string;
  ttlMs: number;
  entries: WeakMap<object, MemoEntry<T>>;
}

export function createArtifactMemo<T>(key: string, ttlMs: number): ArtifactMemo<T> {
  return { key, ttlMs, entries: new WeakMap<object, MemoEntry<T>>() };
}

/**
 * Lector KV get-or-<fetcher> SIN memo: una lectura de `key` por llamada (la clave la
 * calcula el lector UNA vez, incluidas las compuestas como line:detail:<id>:<fecha>),
 * `parse` sobre el valor crudo (por defecto JSON.parse) y `fetcher` en miss — el lado EMT
 * consulta la API y escribe KV; el lado CRTM lanza CRTMDataUnavailableError porque sus
 * artefactos los escribe el pipeline, nunca el worker. Una lectura KV por petición y el
 * TTL de la clave en KV manda (DATA_TTL/TIMETABLE_TTL/INCIDENTS_TTL).
 */
export function getCachedJSON<T>(
  env: Env,
  key: string,
  fetcher: (env: Env) => Promise<T>,
  parse: (raw: string) => T = (raw) => JSON.parse(raw) as T,
): Promise<T> {
  return env.EMT_CACHE.get(key).then((raw) => (raw !== null ? parse(raw) : fetcher(env)));
}

/**
 * Igual que getCachedJSON, pero sobre la clave DEL MEMO (solo los artefactos multi-MB):
 * la PROMESA se memoiza por binding — single-flight: N peticiones concurrentes al expirar
 * el TTL comparten una sola lectura KV + un solo parse — y un fallo se expulsa del memo
 * (`pending.catch`): reintento inmediato, nunca queda memoizado ttlMs.
 */
export function getCachedArtifact<T>(
  env: Env,
  memo: ArtifactMemo<T>,
  fetcher: (env: Env) => Promise<T>,
  parse?: (raw: string) => T,
): Promise<T> {
  const hit = memo.entries.get(env.EMT_CACHE);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  // la promesa entra en el memo ANTES de resolverse: las concurrentes llegan al hit
  const pending = getCachedJSON(env, memo.key, fetcher, parse);
  memo.entries.set(env.EMT_CACHE, { value: pending, expiresAt: Date.now() + memo.ttlMs });
  pending.catch(() => memo.entries.delete(env.EMT_CACHE)); // un fallo no se memoiza
  return pending;
}
