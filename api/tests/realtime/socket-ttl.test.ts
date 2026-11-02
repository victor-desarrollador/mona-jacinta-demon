// USER-MGMT-01 U4 — ONE access-token lifetime: the signer, the HTTP verifier and the Socket.IO handshake all read ACCESS_TOKEN_SECONDS
// (env.JWT_ACCESS_TTL_SECONDS). The env is mocked to 120 s here, so a hardcoded 900 anywhere would accept a token the others refuse.
import { createServer } from 'node:http';
import { SignJWT, decodeJwt } from 'jose';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return { ...actual, env: { ...actual.env, JWT_ACCESS_TTL_SECONDS: 120 } };
});

const { env } = await import('../../src/config/env.js');
const { ACCESS_TOKEN_SECONDS, signAccessToken, verifyAccessToken } = await import('../../src/modules/auth/tokens.js');
const { createRequireAuth } = await import('../../src/middleware/auth.js');
const { createRealtime } = await import('../../src/realtime/socket.js');

const database = {
  user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, isActive: true, mustChangePassword: false, credentialsChangedAt: null, branchRoles: [], roleScopes: [] })) },
  location: { findMany: vi.fn(async () => []) },
};
const server = createServer();
const realtime = createRealtime(server, database as never);
const clients: ClientSocket[] = [];
let port: number;

// a token issued `ageSeconds` ago whose own `exp` is still far in the future: only maxTokenAge can refuse it
async function aged(ageSeconds: number) {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('u1').setIssuedAt(iat).setExpirationTime(iat + 3600).sign(new TextEncoder().encode(env.JWT_SECRET));
}
async function socketAccepts(token: string): Promise<boolean> {
  const c = connect(`http://127.0.0.1:${port}`, { auth: { token }, autoConnect: false, reconnection: false });
  clients.push(c);
  return new Promise((resolve) => { c.once('connect', () => resolve(true)); c.once('connect_error', () => resolve(false)); c.connect(); });
}
async function httpAccepts(token: string): Promise<boolean> {
  let outcome: unknown = 'pending';
  await createRequireAuth(database as never)({ headers: { authorization: `Bearer ${token}` } } as never, {} as never, ((e?: unknown) => { outcome = e; }) as never);
  return outcome === undefined;
}
const signerAccepts = (token: string) => verifyAccessToken(token).then(() => true, () => false);

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); port = (server.address() as { port: number }).port; resolve(); });
  });
});
afterAll(async () => {
  for (const c of clients) c.close();
  await new Promise<void>((resolve) => realtime.io.close(() => resolve()));
  server.close();
});

describe('one canonical token lifetime (TTL-*)', () => {
  it('TTL-01 the configured lifetime is the one the signer uses (exp - iat) and the module exports', async () => {
    expect(ACCESS_TOKEN_SECONDS).toBe(120);
    const claims = decodeJwt(await signAccessToken('u1'));
    expect((claims.exp as number) - (claims.iat as number)).toBe(120);
  });

  it('TTL-02 a token 60 s old is accepted by the signer\'s verifier, the HTTP verifier AND the socket handshake', async () => {
    const token = await aged(60);
    expect([await signerAccepts(token), await httpAccepts(token), await socketAccepts(token)]).toEqual([true, true, true]);
  });

  it('TTL-03 a token 300 s old (older than the configured 120 s, younger than a hardcoded 900 s) is refused by ALL THREE', async () => {
    const token = await aged(300);
    expect([await signerAccepts(token), await httpAccepts(token), await socketAccepts(token)]).toEqual([false, false, false]);
  });
});
