import { describe, expect, it } from 'vitest';
import { requiresDatabaseTls } from '../../src/config/prisma-tls.js';

describe('Prisma database TLS classification', () => {
  it.each([
    'postgresql://user:password@127.0.0.1:5432/database',
    'postgres://user:password@localhost:5432/database',
    'postgresql://user:password@[::1]:5432/database',
  ])('uses plain transport only for an unambiguous loopback URL: %s', (url) => {
    expect(requiresDatabaseTls(url)).toBe(false);
  });

  it.each([
    'postgresql://user:password@aws-0-example.pooler.supabase.com:6543/postgres',
    'postgresql://user:password@localhost.example.com:5432/database',
    'postgresql://user:password@127.0.0.2:5432/database',
    'postgresql://user:password@[::2]:5432/database',
    'postgresql://user:password@127.0.0.1:5432/database?host=remote.example.com',
    'postgresql://user:password@localhost:5432/database#remote',
    'https://user:password@localhost:5432/database',
    'not-a-database-url',
  ])('keeps verified TLS for remote, ambiguous or malformed input: %s', (url) => {
    expect(requiresDatabaseTls(url)).toBe(true);
  });
});
