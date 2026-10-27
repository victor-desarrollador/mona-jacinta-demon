import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { validate } from '../src/middleware/validation.js';
import { AppError } from '../src/shared/errors.js';
import { sendJson } from '../src/shared/json-safe.js';

describe('input validation and safe errors', () => {
  it.each(['body', 'query', 'params'] as const)(
    'uses parsed %s data (including Express 5 query)',
    async (target) => {
      const app = express();
      app.use(express.json());
      app.post(
        '/validate/:value',
        validate(z.object({ value: z.coerce.number().int() }), target),
        (req, res) => {
          sendJson(res, req[target]);
        },
      );
      app.use(errorHandler);
      const response = await request(app)
        .post('/validate/7?value=7')
        .send({ value: '7', extra: 'ignored' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ value: 7 });
    },
  );

  it('redacts unknown internal errors and Prisma metadata', async () => {
    const marker = 'synthetic-sensitive-internal-data';
    const cases = [
      [new Error(marker), 500, 'INTERNAL_ERROR'],
      [
        new Prisma.PrismaClientKnownRequestError(marker, {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { target: marker },
        }),
        409,
        'DATABASE_CONFLICT',
      ],
    ] as const;
    for (const [error, status, code] of cases) {
      const app = express();
      app.get('/', () => {
        throw error;
      });
      app.use(errorHandler);
      const response = await request(app).get('/');
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.text.includes(marker)).toBe(false);
      expect(response.body.error.stack).toBeUndefined();
    }
  });

  it('returns sanitized Zod issue codes without custom error messages or input', async () => {
    const marker = 'synthetic-sensitive-invalid-input';
    const app = express();
    app.use(express.json());
    app.post(
      '/',
      validate(z.object({ value: z.string().refine(() => false, marker) })),
      (_req, res) => res.end(),
    );
    app.use(errorHandler);
    const response = await request(app).post('/').send({ value: marker });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { path: ['value'], code: 'custom' },
    ]);
    expect(response.text.includes(marker)).toBe(false);
  });

  it('normalizes explicitly public AppError details through the JSON helper', async () => {
    const app = express();
    app.get('/', () => {
      throw new AppError(400, 'TEST_ERROR', 'Mensaje público.', {
        amount: 16500000n,
      });
    });
    app.use(errorHandler);
    const response = await request(app).get('/');
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual({ amount: '16500000' });
  });

  it('handles malformed JSON without echoing request data', async () => {
    const response = await request(createApp())
      .post('/')
      .set('Content-Type', 'application/json')
      .send('{"sensitive-test-value":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
    expect(response.text.includes('sensitive-test-value')).toBe(false);
  });

  it('adds security headers, limits CORS to the allowlist, and returns JSON 404', async () => {
    const app = createApp();
    const allowed = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['x-powered-by']).toBeUndefined();
    const denied = await request(app)
      .get('/health')
      .set('Origin', 'https://untrusted.invalid');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const missing = await request(app).get('/missing');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});
