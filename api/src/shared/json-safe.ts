import type { Response } from 'express';

export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        toJsonSafe(v),
      ]),
    );
  }
  return value;
}

export function sendJson(res: Response, data: unknown): Response {
  return res.json(toJsonSafe(data));
}
