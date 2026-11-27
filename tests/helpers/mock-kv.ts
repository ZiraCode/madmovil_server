import type {
  KVNamespace,
  KVNamespacePutOptions,
  RateLimit,
  R2Bucket,
} from '@cloudflare/workers-types';
import type { Env } from '../../src/types';

export class MockKV {
  private store = new Map<string, string>();
  readonly putCalls: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];
  readonly getCalls: string[] = [];

  get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return Promise.resolve(this.store.has(key) ? this.store.get(key)! : null);
  }

  put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.putCalls.push({ key, value, options });
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

export class MockR2 {
  private store = new Map<string, string>();

  get(key: string): Promise<{ key: string; size: number; text: () => Promise<string> } | null> {
    const value = this.store.get(key);
    if (value === undefined) return Promise.resolve(null);
    return Promise.resolve({ key, size: value.length, text: () => Promise.resolve(value) });
  }

  put(key: string, value: string): Promise<null> {
    this.store.set(key, value);
    return Promise.resolve(null);
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }
}

export function mockRateLimiter(limit = Infinity): RateLimit & { calls: string[] } {
  const calls: string[] = [];
  const countsByKey = new Map<string, number>();
  return {
    calls,
    limit: async ({ key }: { key: string }) => {
      calls.push(key);
      const count = (countsByKey.get(key) ?? 0) + 1;
      countsByKey.set(key, count);
      return { success: count <= limit };
    },
  } as RateLimit & { calls: string[] };
}

export function mockKV(): KVNamespace & MockKV {
  return new MockKV() as unknown as KVNamespace & MockKV;
}

export function mockR2(): R2Bucket & MockR2 {
  return new MockR2() as unknown as R2Bucket & MockR2;
}

/** Env de test: los secrets/bindings opcionales por caso (VAULT_CREATE_LIMITER,
 *  TURNSTILE_SECRET_KEY, SSR_INTERNAL_KEY) empiezan AUSENTES y cada test que los necesite
 *  los inyecta — sin cast: si Env gana un binding OBLIGATORIO, typecheck:tests lo detecta */
export function mockEnv(
  kv: KVNamespace = mockKV(),
  rateLimiter: RateLimit = mockRateLimiter(),
  r2: R2Bucket = mockR2(),
): Env {
  return {
    EMT_CACHE: kv,
    CRTM_SHAPES: r2,
    RATE_LIMITER: rateLimiter,
    EMT_CLIENT_ID: 'test-client-id',
    EMT_PASS_KEY: 'test-pass-key',
    ADMIN_SECRET: 'test-admin-secret',
  };
}
