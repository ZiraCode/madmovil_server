const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 10_000;

export class TurnstileServiceUnavailableError extends Error {
  constructor() {
    super('No se pudo verificar el reto anti-bot; inténtalo de nuevo en unos instantes');
    this.name = 'TurnstileServiceUnavailableError';
  }
}

interface SiteverifyResponse {
  success?: boolean;
}

/**
 * Verifica server-side un token de Turnstile contra siteverify.
 * Fail-closed: cualquier fallo de red/parseo lanza TurnstileServiceUnavailableError (→ 503);
 * un token inválido simplemente devuelve false (→ 403).
 */
export async function verifyTurnstileToken(
  secret: string,
  token: string,
  remoteIp?: string,
): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) {
    form.set('remoteip', remoteIp);
  }

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error('Turnstile siteverify request failed:', error);
    throw new TurnstileServiceUnavailableError();
  }

  if (!response.ok) {
    console.error(`Turnstile siteverify responded ${response.status}`);
    throw new TurnstileServiceUnavailableError();
  }

  let data: SiteverifyResponse;
  try {
    data = (await response.json()) as SiteverifyResponse;
  } catch (error) {
    console.error('Turnstile siteverify invalid JSON:', error);
    throw new TurnstileServiceUnavailableError();
  }

  return data.success === true;
}
