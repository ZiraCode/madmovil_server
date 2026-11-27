import { describe, expect, it } from 'vitest';
import { normalizeText, asArray, nameTokens } from '../../src/lib/text-utils';

describe('normalizeText', () => {
  it('pasa texto simple a minúsculas', () => {
    expect(normalizeText('Sol')).toBe('sol');
  });

  it('elimina acentos', () => {
    expect(normalizeText('Plaza de Españá')).toBe('plaza de espana');
  });

  it('normaliza mayúsculas acentuadas', () => {
    expect(normalizeText('GRAN VÍA')).toBe('gran via');
  });

  it('elimina caracteres especiales conservando letras, números y espacios', () => {
    expect(normalizeText('C/ Alcalá, 23-B')).toBe('c alcala 23b');
  });

  it('elimina espacios al inicio y final', () => {
    expect(normalizeText('  sol  ')).toBe('sol');
  });

  it('devuelve cadena vacía para solo símbolos', () => {
    expect(normalizeText('!?-')).toBe('');
  });
});

describe('asArray (quirk SOAP→JSON del CRTM)', () => {
  it('array pasa tal cual; colección de 1 llega como objeto suelto; vacía como {}', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray({})).toEqual([{}]);
  });

  it('null y primitivos → []', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray('x')).toEqual([]);
  });
});

describe('nameTokens (stopwords parametrizadas por dominio)', () => {
  const STOPWORDS = new Set(['de', 'la']);

  it('minúsculas sin acentos, separadores SUSTITUIDOS por espacio (EST.LA no se fusiona)', () => {
    expect(nameTokens('EST. LA GARENA', STOPWORDS)).toEqual(['est', 'garena']);
  });

  it('filtra stopwords y tokens de 1 carácter', () => {
    expect(nameTokens('Puerto de Navacerrada', STOPWORDS)).toEqual(['puerto', 'navacerrada']);
    expect(nameTokens('AV. de Herrería x', STOPWORDS)).toEqual(['av', 'herreria']);
  });
});
