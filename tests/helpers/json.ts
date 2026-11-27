/**
 * Body JSON de una respuesta de tests, tipado como any a propósito: el valor de
 * typecheck:tests son los fixtures y los tipos de producción, no repetir un cast
 * `as Record<string, any>` en cada lectura (res.json() del runtime devuelve unknown)
 */
export async function jsonBody(res: Response): Promise<any> {
  return await res.json();
}
