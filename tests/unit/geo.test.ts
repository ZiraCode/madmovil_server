import { describe, expect, it } from 'vitest';
import { haversineDistanceM } from '../../src/lib/geo';

describe('haversineDistanceM', () => {
  it('devuelve 0 para el mismo punto', () => {
    expect(haversineDistanceM(40.4172, -3.7038, 40.4172, -3.7038)).toBe(0);
  });

  it('calcula la distancia Sol - Plaza de España (~1.2 km)', () => {
    const d = haversineDistanceM(40.4172, -3.7038, 40.423, -3.7103);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(900);
  });

  it('es simétrica', () => {
    const ab = haversineDistanceM(40.4172, -3.7038, 40.423, -3.7103);
    const ba = haversineDistanceM(40.423, -3.7103, 40.4172, -3.7038);
    expect(ab).toBeCloseTo(ba, 9);
  });

  it('longitud del ecuador: 1 grado de lon ~ 111.2 km', () => {
    const d = haversineDistanceM(0, 0, 0, 1);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112500);
  });

  it('1 grado de lat ~ 111.2 km en cualquier longitud', () => {
    const d = haversineDistanceM(40, -3, 41, -3);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112500);
  });
});
