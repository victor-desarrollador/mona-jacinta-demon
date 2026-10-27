// Zona operativa canónica de Mona Jacinta. Un único lugar de verdad para toda
// la lógica de día operativo, cortes diarios y filtros por fecha.
// Nunca depende de TZ del servidor, TZ de Railway ni zona del navegador.
export const OPERATING_TIME_ZONE = 'America/Argentina/Tucuman';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Formatea componentes (year/month/day/hour/minute/second) de un instante en
// la zona operativa, sin depender de la zona del proceso.
function tzParts(instant: Date): {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// Devuelve el nombre del dia de la semana en la zona operativa:
// 0 = domingo, 1 = lunes, ..., 6 = sabado.
function weekdayInTz(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATING_TIME_ZONE,
    weekday: 'long',
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === 'weekday')!.value.toLowerCase();
  const map: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return map[name]!;
}

// Limites [startInclusive, endExclusive) del dia operativo de Tucuman que
// contiene al `instant`. No usa fin 23:59:59.999: el intervalo es medio
// abierto y el borde es exacto.
// Como `instant` ya es un instante absoluto, restarle los milisegundos
// transcurridos desde la medianoche de su propio dia (en la zona operativa)
// lleva exactamente a la medianoche operativa, sin conocer el offset absoluto.
export function operatingDayBounds(instant: Date): {
  start: Date;
  end: Date;
} {
  const { hour, minute, second } = tzParts(instant);
  const localMs = (hour * 3600 + minute * 60 + second) * 1000;
  const start = new Date(instant.getTime() - localMs);
  const end = new Date(start.getTime() + MS_PER_DAY);
  return { start, end };
}

// Devuelve los limites UTC del dia de negocio "YYYY-MM-DD" en la zona de
// Tucuman. Rechaza formatos o fechas calendario invalidas.
export function parseOperatingDate(value: string): {
  start: Date;
  end: Date;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new Error(`Fecha de negocio invalida: ${value}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  // Validacion de calendario real (zonas del proceso son irrelevantes para
  // detectar dias inexistentes: 2026-10-32 -> 1 de noviembre, etc.).
  const check = new Date(year, month - 1, day);
  if (
    check.getFullYear() !== year ||
    check.getMonth() !== month - 1 ||
    check.getDate() !== day
  ) {
    throw new Error(`Fecha de negocio invalida: ${value}`);
  }

  // Medianaoche operativa del dia solicitado, sin hardcodear el offset.
  // Tomamos el mediodia UTC como referencia (evita bordes de DST), leemos su
  // hora local en Tucuman y restamos para llegar a medianoche operativa.
  const ref = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const { hour, minute, second } = tzParts(ref);
  const localMs = (hour * 3600 + minute * 60 + second) * 1000;
  const start = new Date(ref.getTime() - localMs);
  const end = new Date(start.getTime() + MS_PER_DAY);
  return { start, end };
}

// Inicio de la semana operativa (lunes a sabado). Un domingo pertenece al
// ciclo que comienza el lunes siguiente. Determinista y sin dependencia de
// TZ del proceso. Futuro EmployeeSettlement reusa esta primitiva.
export function operatingWeekStart(instant: Date): Date {
  const startOfDay = operatingDayBounds(instant).start;
  const wd = weekdayInTz(startOfDay);
  if (wd === 0) {
    // domingo -> lunes siguiente
    return new Date(startOfDay.getTime() + MS_PER_DAY);
  }
  // lunes(1)..sabado(6): inicio = startOfDay menos (wd-1) dias
  return new Date(startOfDay.getTime() - (wd - 1) * MS_PER_DAY);
}
