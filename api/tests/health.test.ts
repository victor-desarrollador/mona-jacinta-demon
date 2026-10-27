import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  it('returns a JSON health response without a database connection', async () => {
    const response = await request(createApp()).get('/health');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
