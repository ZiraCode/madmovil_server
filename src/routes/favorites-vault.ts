import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { FAVORITES_VAULT_CONFIG as VAULT_CFG } from '../lib/config';
import {
  VAULT_ALG,
  parseBearerToken,
  vaultKeyFor,
  isValidBase64,
  maybeTouchVault,
} from '../lib/favorites-vault';
import type { VaultDoc } from '../lib/favorites-vault';
import { verifyTurnstileToken, TurnstileServiceUnavailableError } from '../lib/turnstile';

// Vault de favoritos: copia de sincronización anónima cifrada E2E (el server solo ve un blob opaco).
// Autorización por posesión: Bearer <authToken> (base64url de 32 bytes derivado del código secreto
// del usuario); la clave KV es su SHA-256 → sin vaultId, sin enumeración, sin comparaciones.
// POST (creación) exige Turnstile; PUT solo actualiza si ya existe (404 si no) para que nadie
// cree vaults saltándose el reto.
const favoritesVaultRoutes = new Hono<{ Bindings: Env }>();

function authError(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      status: 'error',
      message: 'Cabecera Authorization inválida: se espera un token Bearer válido',
      timestamp: new Date().toISOString(),
    },
    401,
  );
}

type BodyResult = { ok: true; body: unknown } | { ok: false; status: 413 | 400; message: string };

async function readBody(c: Context<{ Bindings: Env }>): Promise<BodyResult> {
  const text = await c.req.text();
  if (text.length > VAULT_CFG.MAX_BODY_CHARS) {
    return {
      ok: false,
      status: 413,
      message: `El cuerpo supera el tamaño máximo de ${VAULT_CFG.MAX_BODY_CHARS} caracteres`,
    };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }
}

interface VaultBody {
  payload?: unknown;
  nonce?: unknown;
  turnstileToken?: unknown;
}

function validateVaultFields(body: VaultBody): { payload: string; nonce: string } | null {
  if (
    !isValidBase64(body.payload, VAULT_CFG.MAX_PAYLOAD_B64_CHARS) ||
    !isValidBase64(body.nonce, VAULT_CFG.MAX_NONCE_B64_CHARS)
  ) {
    return null;
  }
  return { payload: body.payload, nonce: body.nonce };
}

// Cuerpo compartido de POST y PUT: lee el JSON, valida payload/nonce y devuelve los campos
// listos para guardar (o la Response de error tal cual)
async function readVaultFields(
  c: Context<{ Bindings: Env }>,
): Promise<{ fields: { payload: string; nonce: string }; raw: VaultBody } | Response> {
  const result = await readBody(c);
  if (!result.ok) {
    return c.json(
      {
        status: 'error',
        message: result.message,
        timestamp: new Date().toISOString(),
      },
      result.status,
    );
  }
  if (result.body === null || typeof result.body !== 'object') {
    return c.json(
      {
        status: 'error',
        message: 'Invalid JSON body',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }
  const raw = result.body as VaultBody;
  const fields = validateVaultFields(raw);
  if (!fields) {
    return c.json(
      {
        status: 'error',
        message: 'payload y nonce deben ser strings base64 no vacíos dentro de los límites',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }
  return { fields, raw };
}

function buildVaultDoc(payload: string, nonce: string): VaultDoc {
  const now = new Date();
  return {
    payload,
    nonce,
    alg: VAULT_ALG,
    updatedAt: now.toISOString(),
    exp: Math.floor(now.getTime() / 1000) + VAULT_CFG.TTL_SECONDS,
  };
}

// POST /api/favorites/vault — crear el vault (requiere Turnstile)
favoritesVaultRoutes.post('/vault', async (c) => {
  const token = parseBearerToken(c.req.header('Authorization'));
  if (!token) {
    return authError(c);
  }

  const parsed = await readVaultFields(c);
  if (parsed instanceof Response) {
    return parsed;
  }

  const { fields, raw } = parsed;
  const turnstileToken = raw.turnstileToken;
  if (
    typeof turnstileToken !== 'string' ||
    turnstileToken.length === 0 ||
    turnstileToken.length > VAULT_CFG.MAX_TURNSTILE_TOKEN_CHARS
  ) {
    return c.json(
      {
        status: 'error',
        message: 'turnstileToken requerido (string)',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  const secret = c.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return c.json(
      {
        status: 'error',
        message: 'Verificación anti-bot no configurada; inténtalo más tarde',
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }

  let verified: boolean;
  try {
    verified = await verifyTurnstileToken(secret, turnstileToken, c.req.header('cf-connecting-ip'));
  } catch (error) {
    if (error instanceof TurnstileServiceUnavailableError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }
    throw error;
  }
  if (!verified) {
    return c.json(
      {
        status: 'error',
        message: 'Verificación anti-bot fallida; recarga la página e inténtalo de nuevo',
        timestamp: new Date().toISOString(),
      },
      403,
    );
  }

  const key = await vaultKeyFor(token);
  if ((await c.env.EMT_CACHE.get(key)) !== null) {
    return c.json(
      {
        status: 'error',
        message: 'Ya existe una copia de sincronización para este código',
        timestamp: new Date().toISOString(),
      },
      409,
    );
  }

  const doc = buildVaultDoc(fields.payload, fields.nonce);
  await c.env.EMT_CACHE.put(key, JSON.stringify(doc), { expirationTtl: VAULT_CFG.TTL_SECONDS });

  return c.json(
    {
      status: 'success',
      message: 'Vault created successfully',
      data: { updatedAt: doc.updatedAt },
      timestamp: new Date().toISOString(),
    },
    201,
  );
});

// GET /api/favorites/vault — leer el vault (refresca la expiración si le queda <90 días)
favoritesVaultRoutes.get('/vault', async (c) => {
  const token = parseBearerToken(c.req.header('Authorization'));
  if (!token) {
    return authError(c);
  }

  const key = await vaultKeyFor(token);
  const raw = await c.env.EMT_CACHE.get(key);
  if (raw === null) {
    return c.json(
      {
        status: 'error',
        message: 'No existe ninguna copia de sincronización para este código',
        timestamp: new Date().toISOString(),
      },
      404,
    );
  }

  let doc: VaultDoc;
  try {
    doc = JSON.parse(raw) as VaultDoc;
  } catch (error) {
    console.error('Corrupt vault doc:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al leer la copia de sincronización',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }

  try {
    await maybeTouchVault(c.env.EMT_CACHE, key, doc);
  } catch (error) {
    console.error('Vault touch failed:', error);
  }

  return c.json({
    status: 'success',
    message: 'Vault retrieved successfully',
    data: { payload: doc.payload, nonce: doc.nonce, updatedAt: doc.updatedAt },
    timestamp: new Date().toISOString(),
  });
});

// PUT /api/favorites/vault — actualizar SOLO si existe (404 si no: nunca upsert, el bypass
// de Turnstile quedaría abierto si PUT pudiera crear)
favoritesVaultRoutes.put('/vault', async (c) => {
  const token = parseBearerToken(c.req.header('Authorization'));
  if (!token) {
    return authError(c);
  }

  const parsed = await readVaultFields(c);
  if (parsed instanceof Response) {
    return parsed;
  }

  const { fields } = parsed;

  const key = await vaultKeyFor(token);
  if ((await c.env.EMT_CACHE.get(key)) === null) {
    return c.json(
      {
        status: 'error',
        message: 'No existe ninguna copia de sincronización para este código',
        timestamp: new Date().toISOString(),
      },
      404,
    );
  }

  const doc = buildVaultDoc(fields.payload, fields.nonce);
  await c.env.EMT_CACHE.put(key, JSON.stringify(doc), { expirationTtl: VAULT_CFG.TTL_SECONDS });

  return c.json({
    status: 'success',
    message: 'Vault updated successfully',
    data: { updatedAt: doc.updatedAt },
    timestamp: new Date().toISOString(),
  });
});

// DELETE /api/favorites/vault — borrar el vault
favoritesVaultRoutes.delete('/vault', async (c) => {
  const token = parseBearerToken(c.req.header('Authorization'));
  if (!token) {
    return authError(c);
  }

  const key = await vaultKeyFor(token);
  if ((await c.env.EMT_CACHE.get(key)) === null) {
    return c.json(
      {
        status: 'error',
        message: 'No existe ninguna copia de sincronización para este código',
        timestamp: new Date().toISOString(),
      },
      404,
    );
  }

  await c.env.EMT_CACHE.delete(key);

  return c.json({
    status: 'success',
    message: 'Vault deleted successfully',
    data: { deleted: true },
    timestamp: new Date().toISOString(),
  });
});

export default favoritesVaultRoutes;
