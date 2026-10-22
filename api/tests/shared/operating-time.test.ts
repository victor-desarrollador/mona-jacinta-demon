import { describe, it, expect } from 'vitest';
import {
  OPERATING_TIME_ZONE,
  operatingDayBounds,
  parseOperatingDate,
  operatingWeekStart,
} from '../../src/shared/operating-time.ts';

describe('operating-time (canonical zone America/Argentina/Tucuman)', () => {
  it('expone la zona canónica como constante única', () => {
    expect(OPERATING_TIME_ZONE).toBe('America/Argentina/Tucuman');
  });

  describe('operatingDayBounds(instant)', () => {
    it('un instante 23:30 argentina pertenece todavía al día argentino aunque UTC ya es el día siguiente', () => {
      // Argentina 2026-10-21 23:30 = UTC 2026-10-22 02:30 (Tucuman = UTC-3, sin DST vigente).
      const instant = new Date(Date.UTC(2026, 9, 22, 2, 30, 0));
      const { start, end } = operatingDayBounds(instant);

      // start debe ser 2026-10-21 00:00 Argentina = 2026-10-21 03:00 UTC.
      expect(start.getTime()).toBe(Date.UTC(2026, 9, 21, 3, 0, 0));
      // end es start + 1 día (2026-10-22 00:00 Argentina = 2026-10-22 03:00 UTC).
      expect(end.getTime()).toBe(Date.UTC(2026, 9, 22, 3, 0, 0));
      // Semántica [startInclusive, endExclusive): el instante cae dentro.
      expect(instant.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(instant.getTime()).toBeLessThan(end.getTime());
    });

    it('un instante 00:30 argentina pertenece al nuevo día operativo aunque el servidor cambie', () => {
      // Argentina 2026-10-22 00:30 = UTC 2026-10-22 03:30.
      const instant = new Date(Date.UTC(2026, 9, 22, 3, 30, 0));
      const { start, end } = operatingDayBounds(instant);

      expect(start.getTime()).toBe(Date.UTC(2026, 9, 22, 3, 0, 0));
      expect(end.getTime()).toBe(Date.UTC(2026, 9, 23, 3, 0, 0));
      expect(instant.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(instant.getTime()).toBeLessThan(end.getTime());
    });

    it('un instante exactamente a medianoche argentina pertenece al día que comienza', () => {
      const instant = new Date(Date.UTC(2026, 9, 22, 3, 0, 0)); // 2026-10-22 00:00 ARG
      const { start } = operatingDayBounds(instant);
      expect(start.getTime()).toBe(Date.UTC(2026, 9, 22, 3, 0, 0));
    });

    it('usa semántica [startInclusive, endExclusive) sin fin 23:59:59.999', () => {
      const instant = new Date(Date.UTC(2026, 9, 21, 3, 0, 0)); // 2026-10-21 00:00 ARG
      const { start, end } = operatingDayBounds(instant);
      expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
      // Un instante a mediodia del dia operativo pertenece al mismo dia.
      const noon = new Date(start.getTime() + 12 * 3600 * 1000);
      const { start: s2, end: e2 } = operatingDayBounds(noon);
      expect(s2.getTime()).toBe(start.getTime());
      expect(e2.getTime()).toBe(end.getTime());
      // El limite exclusivo `end` pertenece al dia siguiente.
      const { start: s3 } = operatingDayBounds(end);
      expect(s3.getTime()).toBe(end.getTime());
    });
  });

  describe('parseOperatingDate("YYYY-MM-DD")', () => {
    it('devuelve límites correctos en UTC para un día de negocio de Tucuman', () => {
      const { start, end } = parseOperatingDate('2026-10-21');
      expect(start.getTime()).toBe(Date.UTC(2026, 9, 21, 3, 0, 0));
      expect(end.getTime()).toBe(Date.UTC(2026, 9, 22, 3, 0, 0));
    });

    it('rechaza fechas inválidas', () => {
      expect(() => parseOperatingDate('2026-13-01')).toThrow();
      expect(() => parseOperatingDate('2026-10-32')).toThrow();
      expect(() => parseOperatingDate('no-una-fecha')).toThrow();
      expect(() => parseOperatingDate('2026-10-1')).toThrow();
      expect(() => parseOperatingDate('')).toThrow();
    });

    it('no depende de TZ del proceso', () => {
      const { start } = parseOperatingDate('2026-10-21');
      expect(start.getTime()).toBe(Date.UTC(2026, 9, 21, 3, 0, 0));
    });
  });

  describe('ciclo semanal (lunes a sábado, domingo -> lunes siguiente)', () => {
    it('lunes es el inicio de su propia semana operativa', () => {
      // 2026-10-19 es lunes.
      const instant = new Date(Date.UTC(2026, 9, 19, 10, 0, 0));
      expect(operatingWeekStart(instant).getTime()).toBe(
        Date.UTC(2026, 9, 19, 3, 0, 0),
      );
    });

    it('sabado 23:59 sigue perteneciendo a la semana que inicio el lunes', () => {
      // 2026-10-24 es sabado.
      const instant = new Date(Date.UTC(2026, 9, 24, 3, 59, 0)); // 23:59 ARG del 24
      expect(operatingWeekStart(instant).getTime()).toBe(
        Date.UTC(2026, 9, 19, 3, 0, 0),
      );
    });

    it('domingo 00:00 pertenece al ciclo que comienza el lunes siguiente', () => {
      // 2026-10-25 es domingo. Lunes siguiente = 2026-10-26.
      const instant = new Date(Date.UTC(2026, 9, 25, 3, 0, 0)); // 00:00 ARG del 25
      expect(operatingWeekStart(instant).getTime()).toBe(
        Date.UTC(2026, 9, 26, 3, 0, 0),
      );
    });

    it('domingo tarde mapeada a lunes siguiente', () => {
      // 2026-10-25 domingo 15:00 ARG = 2026-10-25 18:00 UTC.
      const instant = new Date(Date.UTC(2026, 9, 25, 18, 0, 0));
      expect(operatingWeekStart(instant).getTime()).toBe(
        Date.UTC(2026, 9, 26, 3, 0, 0),
      );
    });
  });
});
