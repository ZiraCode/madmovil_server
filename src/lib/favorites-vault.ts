import { FAVORITES_VAULT_CONFIG } from './config';

// Doc almacenado en KV por vault: opaco para el server salvo la contabilidad de expiración
// (payload/nonce son base64 del ciphertext AES-GCM y su IV; el server jamás los descifra)
export interface VaultDoc {
  payload: string;
  nonce: string;
  alg: string;
  updatedAt: string;
  exp: number;
}

export const VAULT_ALG = 'AES-GCM-256';

// authToken del cliente = base64url SIN padding de 32 bytes (256 bits) → exactamente 43 chars.
// Validar el formato ANTES de tocar KV: token malformado → 401 sin lecturas
const BEARER_RE = /^Bearer ([A-Za-z0-9\-_]{43})$/;

export function parseBearerToken(header: string | undefined): Uint8Array | null {
  if (!header) {
    return null;
  }
  const match = BEARER_RE.exec(header);
  if (!match) {
    return null;
  }
  try {
    const bytes = decodeBase64Url(match[1]);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Clave KV del vault: fav:vault:v1:<hex(sha256(token))>.
 * Sin vaultId público: la clave ES el hash del token → enumeración imposible y sin
 * comparaciones que hacer (quien no tiene el token de 256 bits no puede ni nombrar la clave).
 */
export async function vaultKeyFor(token: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', token);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${FAVORITES_VAULT_CONFIG.CACHE_KEY_PREFIX}${hex}`;
}

/**
 * Valida el formato de los campos opacos (payload/nonce): string base64 no vacío con tope de
 * longitud. No se inspecciona el contenido (cifrado E2E por diseño), solo rechazo de basura.
 */
export function isValidBase64(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

/**
 * Refresca la expiración de un vault leído si le queda menos del umbral (KV no tiene "touch"
 * sin reescribir). No toca updatedAt: refleja la última escritura del cliente, no este refresco.
 */
export async function maybeTouchVault(kv: KVNamespace, key: string, doc: VaultDoc): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (doc.exp - nowSec >= FAVORITES_VAULT_CONFIG.REFRESH_THRESHOLD_SECONDS) {
    return;
  }
  const refreshed: VaultDoc = { ...doc, exp: nowSec + FAVORITES_VAULT_CONFIG.TTL_SECONDS };
  await kv.put(key, JSON.stringify(refreshed), {
    expirationTtl: FAVORITES_VAULT_CONFIG.TTL_SECONDS,
  });
}
