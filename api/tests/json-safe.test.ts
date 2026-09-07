import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sendJson, toJsonSafe } from '../src/shared/json-safe.js';

describe('toJsonSafe', () => {
  it('represents root money bigint as a decimal string', () => {
    expect(toJsonSafe(16500000n)).toBe('16500000');
    expect(toJsonSafe(9007199254740993n)).toBe('9007199254740993');
  });

  it('normalizes nested objects and arrays without mutating the input', () => {
    const input = {
      total: 16500000n,
      items: [{ amount: 10000000n }, [6500000n]],
    };
    expect(toJsonSafe(input)).toEqual({
      total: '16500000',
      items: [{ amount: '10000000' }, ['6500000']],
    });
    expect(input.total).toBe(16500000n);
    expect(toJsonSafe([1n, -2n, 0n])).toEqual(['1', '-2', '0']);
  });

  it.each([null, undefined, 'text', 123, true, false])(
    'preserves primitive %s',
    (value) => {
      expect(toJsonSafe(value)).toBe(value);
    },
  );

  it('preserves Date until the actual JSON boundary', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(toJsonSafe(date)).toBe(date);
    const normalized = toJsonSafe({
      date,
      nested: [{ amount: 16500000n, date }],
    });
    expect(normalized).toEqual({
      date,
      nested: [{ amount: '16500000', date }],
    });
    expect(JSON.parse(JSON.stringify(normalized))).toEqual({
      date: date.toISOString(),
      nested: [{ amount: '16500000', date: date.toISOString() }],
    });
  });
});

describe('sendJson', () => {
  it('serializes bigint and Date through an Express route in the test harness', async () => {
    const app = express();
    app.get('/test-only', (_req, res) => {
      sendJson(res, {
        total: 16500000n,
        items: [6500000n],
        at: new Date('2026-01-01'),
      });
    });
    const response = await request(app).get('/test-only');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      total: '16500000',
      items: ['6500000'],
      at: '2026-01-01T00:00:00.000Z',
    });
  });
});
