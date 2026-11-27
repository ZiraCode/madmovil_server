/**
 * Utilidades para tests del vault de favoritos: token Bearer válido (base64url de 32 bytes,
 * mismo formato que deriva el cliente con HKDF) y semillas de docs KV.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const VAULT_TEST_TOKEN = new Uint8Array(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256),
);

const VAULT_TEST_TOKEN_B64 = bytesToBase64Url(VAULT_TEST_TOKEN);

export const VAULT_AUTH_HEADER = `Bearer ${VAULT_TEST_TOKEN_B64}`;
