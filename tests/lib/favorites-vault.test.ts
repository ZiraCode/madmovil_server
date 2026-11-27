import { describe, expect, it } from 'vitest';
import { FAVORITES_VAULT_CONFIG } from '../../src/lib/config';
import {
  VAULT_ALG,
  parseBearerToken,
  vaultKeyFor,
  isValidBase64,
  maybeTouchVault,
} from '../../src/lib/favorites-vault';
import type { VaultDoc } from '../../src/lib/favorites-vault';
import { mockKV } from '../helpers/mock-kv';
import { bytesToBase64Url, VAULT_TEST_TOKEN } from '../helpers/vault';

const TOKEN_B64 = bytesToBase64Url(VAULT_TEST_TOKEN);

describe('parseBearerToken', () => {
  it('acepta un Bearer base64url de 32 bytes y devuelve los bytes exactos', () => {
    const parsed = parseBearerToken(`Bearer ${TOKEN_B64}`);

    expect(parsed).toBeInstanceOf(Uint8Array);
    expect(parsed!.length).toBe(32);
    expect(Array.from(parsed!)).toEqual(Array.from(VAULT_TEST_TOKEN));
  });

  it('rechaza header ausente, esquema incorrecto, longitud errónea o charset inválido', () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken(TOKEN_B64)).toBeNull();
    expect(parseBearerToken(`Basic ${TOKEN_B64}`)).toBeNull();
    expect(parseBearerToken(`Bearer ${TOKEN_B64.slice(0, 42)}`)).toBeNull();
    expect(parseBearerToken(`Bearer ${TOKEN_B64}x`)).toBeNull();
    expect(parseBearerToken('Bearer ¿¡invalid-charset!?')).toBeNull();
  });
});

describe('vaultKeyFor', () => {
  it('deriva fav:vault:v1:<sha-256 hex de 64> de forma determinista', async () => {
    const key = await vaultKeyFor(VAULT_TEST_TOKEN);

    expect(key).toMatch(/^fav:vault:v1:[0-9a-f]{64}$/);
    expect(await vaultKeyFor(VAULT_TEST_TOKEN)).toBe(key);
  });

  it('tokens distintos derivan claves distintas', async () => {
    const other = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 13 + 1) % 256));

    expect(await vaultKeyFor(other)).not.toBe(await vaultKeyFor(VAULT_TEST_TOKEN));
  });
});

describe('isValidBase64', () => {
  it('acepta base64 no vacío dentro del tope', () => {
    expect(isValidBase64('QUJDRA==', 100)).toBe(true);
    expect(isValidBase64('QUJD', 100)).toBe(true);
  });

  it('rechaza vacío, demasiado largo, charset no base64 y no-strings', () => {
    expect(isValidBase64('', 100)).toBe(false);
    expect(isValidBase64('A'.repeat(101), 100)).toBe(false);
    expect(isValidBase64('¿hola?', 100)).toBe(false);
    expect(isValidBase64(42, 100)).toBe(false);
    expect(isValidBase64(null, 100)).toBe(false);
    expect(isValidBase64(undefined, 100)).toBe(false);
  });
});

describe('maybeTouchVault', () => {
  const key = 'fav:vault:v1:test';
  const baseDoc: VaultDoc = {
    payload: 'cGF5bG9hZA==',
    nonce: 'bG9jYQ==',
    alg: VAULT_ALG,
    updatedAt: '2026-08-01T10:00:00Z',
    exp: 0,
  };

  it('no reescribe si queda más del umbral de refresco', async () => {
    const kv = mockKV();
    const doc = {
      ...baseDoc,
      exp: Math.floor(Date.now() / 1000) + FAVORITES_VAULT_CONFIG.TTL_SECONDS,
    };

    await maybeTouchVault(kv, key, doc);

    expect(kv.putCalls.length).toBe(0);
  });

  it('refresca exp y TTL de KV si queda menos del umbral, sin tocar updatedAt', async () => {
    const kv = mockKV();
    const doc = { ...baseDoc, exp: Math.floor(Date.now() / 1000) + 1000 };

    await maybeTouchVault(kv, key, doc);

    expect(kv.putCalls.length).toBe(1);
    expect(kv.putCalls[0].options?.expirationTtl).toBe(FAVORITES_VAULT_CONFIG.TTL_SECONDS);
    const rewritten = JSON.parse(kv.putCalls[0].value) as VaultDoc;
    expect(rewritten.updatedAt).toBe(doc.updatedAt);
    expect(rewritten.payload).toBe(doc.payload);
    expect(rewritten.exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + FAVORITES_VAULT_CONFIG.TTL_SECONDS - 60,
    );
  });
});
