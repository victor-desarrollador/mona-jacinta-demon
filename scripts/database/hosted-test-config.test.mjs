import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RELEVANT_KEYS, parseHostedTestConfig, toConnectionString } from './hosted-test-config.mjs';

// DB-free: the parser consumes bytes and returns data; nothing here opens a file,
// a socket or a database. All values are synthetic.

const REF = 'abcdefghij0123456789';
const HOST = 'aws-0-us-east-1.pooler.supabase.com';
const MARKER = '3f2b8c1e-5d4a-4b6f-8a7c-1d2e3f4a5b6c';
const PASSWORD = 'Syn7hetic-Passw0rd';
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const url = ({ scheme = 'postgresql', user = `postgres.${REF}`, password = PASSWORD, host = HOST, port = '5432', db = 'postgres', rawUser, rawPassword } = {}) =>
  `${scheme}://${rawUser ?? enc(user)}:${rawPassword ?? enc(password)}@${host}:${port}/${db}`;
const bytes = (lines) => Buffer.from(lines.join('\n'), 'utf8');
const good = (overrides = {}) => bytes([`TEST_DATABASE_URL=${url(overrides)}`, `TEST_DATABASE_MARKER_ID=${overrides.marker ?? MARKER}`]);
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const LEAKS = [PASSWORD, HOST, REF, `postgres.${REF}`];
const noLeak = (value, extra = []) => {
  const text = JSON.stringify(value);
  for (const leak of [...LEAKS, ...extra]) assert.ok(!text.includes(leak), `leaked ${leak}`);
};
const failure = (input) => {
  const r = parseHostedTestConfig(input);
  assert.equal(r.ok, false);
  noLeak(r);
  return r;
};

test('relevant keys are exactly the two reviewed keys', () => {
  assert.deepEqual([...RELEVANT_KEYS], ['TEST_DATABASE_URL', 'TEST_DATABASE_MARKER_ID']);
});

test('a canonical config yields held components, a marker and public evidence', () => {
  const r = parseHostedTestConfig(good());
  assert.equal(r.ok, true);
  const h = r.held;
  assert.equal(h.protocol, 'postgresql:');
  assert.equal(h.host, HOST);
  assert.equal(h.port, 5432);
  assert.equal(h.database, 'postgres');
  assert.equal(h.username, `postgres.${REF}`);
  assert.equal(h.projectRef, REF);
  assert.equal(h.markerId, MARKER);
  assert.equal(h.password, PASSWORD);
  assert.equal(r.evidence.targetClass, 'CONFORMS');
  assert.match(r.evidence.targetDigest, /^[0-9a-f]{64}$/);
  assert.match(r.evidence.markerDigest, /^[0-9a-f]{64}$/);
});

test('digests follow the documented domain-separated serialization (known answer)', () => {
  const r = parseHostedTestConfig(good());
  const identity = JSON.stringify({ host: HOST, port: 5432, database: 'postgres', username: `postgres.${REF}` });
  assert.equal(r.evidence.targetDigest, sha(`mona-d5h-target/v1\n${identity}`));
  assert.equal(r.evidence.markerDigest, sha(`mona-d5h-marker/v1\n${MARKER}`));
});

test('postgres:// and postgresql:// are one target: same digest, same reconstruction', () => {
  const a = parseHostedTestConfig(good({ scheme: 'postgres' }));
  const b = parseHostedTestConfig(good({ scheme: 'postgresql' }));
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.evidence.targetDigest, b.evidence.targetDigest);
  assert.equal(toConnectionString(a.held), toConnectionString(b.held));
  assert.ok(toConnectionString(a.held).startsWith('postgresql://'));
});

test('the password never reaches the target digest, and identity changes change it', () => {
  const a = parseHostedTestConfig(good({ password: 'one-password' }));
  const b = parseHostedTestConfig(good({ password: 'another-password' }));
  assert.equal(a.evidence.targetDigest, b.evidence.targetDigest);
  const otherRef = parseHostedTestConfig(good({ user: 'postgres.zzzzzzzzzz0123456789' }));
  const otherHost = parseHostedTestConfig(good({ host: 'aws-1-eu-west-2.pooler.supabase.com' }));
  assert.notEqual(otherRef.evidence.targetDigest, a.evidence.targetDigest);
  assert.notEqual(otherHost.evidence.targetDigest, a.evidence.targetDigest);
});

test('the marker digest depends only on the marker id', () => {
  const other = '9c1d2e3f-0a1b-4c2d-9e3f-a1b2c3d4e5f6';
  const a = parseHostedTestConfig(good());
  const b = parseHostedTestConfig(good({ marker: other }));
  assert.notEqual(a.evidence.markerDigest, b.evidence.markerDigest);
  assert.equal(a.evidence.targetDigest, b.evidence.targetDigest);
});

test('round trip: parse(toConnectionString(parse(x))) is the same semantic target, even for awkward passwords', () => {
  for (const password of ["p@ss:w/rd?#%'\"`!*()\\ é€", 'a b', 'x;y=z&w', '%41%', "'''", '🙂pw']) {
    const first = parseHostedTestConfig(good({ password }));
    assert.equal(first.ok, true, password);
    assert.equal(first.held.password, password);
    const canonical = toConnectionString(first.held);
    const second = parseHostedTestConfig(bytes([`TEST_DATABASE_URL=${canonical}`, `TEST_DATABASE_MARKER_ID=${MARKER}`]));
    assert.equal(second.ok, true, `re-parse of the canonical string failed for ${password}`);
    assert.deepEqual({ ...second.held, password: second.held.password }, { ...first.held, password: first.held.password });
    assert.equal(second.held.password, password);
    assert.equal(second.evidence.targetDigest, first.evidence.targetDigest);
    assert.equal(toConnectionString(second.held), canonical);
  }
});

test('non-minimal percent-encodings normalise to the same components and string', () => {
  const minimal = parseHostedTestConfig(good({ password: 'aAb/' }));
  const noisy = parseHostedTestConfig(good({ rawPassword: '%61%41b%2f' }));
  const lower = parseHostedTestConfig(good({ rawPassword: 'aAb%2F' }));
  for (const r of [noisy, lower]) {
    assert.equal(r.ok, true);
    assert.equal(r.held.password, 'aAb/');
    assert.equal(toConnectionString(r.held), toConnectionString(minimal.held));
  }
  const encodedUser = parseHostedTestConfig(good({ rawUser: `postgres%2e${REF}` }));
  assert.equal(encodedUser.ok, true);
  assert.equal(encodedUser.held.username, `postgres.${REF}`);
});

test('credentials are decoded exactly once (no double decoding)', () => {
  const r = parseHostedTestConfig(good({ rawPassword: 'a%2541' }));
  assert.equal(r.held.password, 'a%41');
  assert.ok(toConnectionString(r.held).includes('a%2541'));
});

test('malformed percent-encoding and invalid UTF-8 escapes fail closed', () => {
  for (const rawPassword of ['%zz', 'ab%4', 'ab%', '%C3%28', '%E0%A4%A', '%']) {
    const r = failure(good({ rawPassword }));
    assert.equal(r.code, 'CONFIG_TARGET_INVALID', rawPassword);
    assert.equal(r.reason, 'ENCODING', rawPassword);
  }
  assert.equal(failure(good({ rawUser: 'postgres.%zz' })).reason, 'ENCODING');
});

test('control characters after decoding are rejected in password and username', () => {
  for (const rawPassword of ['a%00b', 'a%0Ab', 'a%0Db', 'a%7Fb', 'a%C2%85b']) {
    assert.equal(failure(good({ rawPassword })).reason, 'ENCODING', rawPassword);
  }
  assert.equal(failure(good({ rawUser: `postgres.${REF}%0A` })).code, 'CONFIG_TARGET_INVALID');
});

test('an empty (or empty-after-decoding) password is rejected', () => {
  assert.equal(failure(good({ rawPassword: '' })).reason, 'PASSWORD');
});

test('duplicate relevant keys fail closed, even with identical values or other spellings', () => {
  const u = `TEST_DATABASE_URL=${url()}`;
  const m = `TEST_DATABASE_MARKER_ID=${MARKER}`;
  for (const lines of [[u, u, m], [u, m, m], [u, m, `export ${m}`], [u, m, `${m} `], [u, `TEST_DATABASE_URL: ${url()}`, m], [u, m, `  ${m}`]]) {
    const r = failure(bytes(lines));
    assert.equal(r.code, 'CONFIG_DUPLICATE_KEY', lines.join('|'));
    assert.ok(RELEVANT_KEYS.includes(r.key));
  }
});

test('a relevant assignment hidden inside a quoted multi-line value of another key still counts', () => {
  const lines = [`TEST_DATABASE_URL=${url()}`, `TEST_DATABASE_MARKER_ID=${MARKER}`, 'OTHER="first', `TEST_DATABASE_URL=${url()}`, 'end"'];
  assert.equal(failure(bytes(lines)).code, 'CONFIG_DUPLICATE_KEY');
});

test('a missing relevant key fails closed and there is no fallback to any other variable', () => {
  const noUrl = bytes([`DATABASE_URL=${url()}`, `LOCAL_TEST_DATABASE_URL=${url()}`, `MONA_AUTOMATED_TEST_TARGET=${url()}`, `TEST_DATABASE_MARKER_ID=${MARKER}`]);
  const a = failure(noUrl);
  assert.equal(a.code, 'CONFIG_KEY_MISSING');
  assert.equal(a.key, 'TEST_DATABASE_URL');
  const b = failure(bytes([`TEST_DATABASE_URL=${url()}`, `LOCAL_TEST_DATABASE_MARKER_ID=${MARKER}`]));
  assert.equal(b.code, 'CONFIG_KEY_MISSING');
  assert.equal(b.key, 'TEST_DATABASE_MARKER_ID');
  assert.equal(failure(bytes([])).code, 'CONFIG_KEY_MISSING');
});

test('only column-0 KEY=value is accepted; every ambiguous relevant form is refused', () => {
  const u = url();
  const m = `TEST_DATABASE_MARKER_ID=${MARKER}`;
  const bad = [
    `export TEST_DATABASE_URL=${u}`,
    `TEST_DATABASE_URL: ${u}`,
    ` TEST_DATABASE_URL=${u}`,
    `\tTEST_DATABASE_URL=${u}`,
    `TEST_DATABASE_URL="${u}"`,
    `TEST_DATABASE_URL='${u}'`,
    `TEST_DATABASE_URL=\`${u}\``,
    `TEST_DATABASE_URL=${u} # comment`,
    `TEST_DATABASE_URL=${u}#frag`,
    `TEST_DATABASE_URL=${u}\\`,
    `TEST_DATABASE_URL =${u}`,
    `TEST_DATABASE_URL= ${u}`,
    `TEST_DATABASE_URL=${u} `,
    'TEST_DATABASE_URL',
    'TEST_DATABASE_URL=',
  ];
  for (const line of bad) {
    const r = failure(bytes([line, m]));
    assert.equal(r.code, line === 'TEST_DATABASE_URL=' ? 'CONFIG_UNSUPPORTED_SYNTAX' : 'CONFIG_UNSUPPORTED_SYNTAX', line);
  }
  for (const line of [`export ${m}`, `${m} `, ` ${m}`, `TEST_DATABASE_MARKER_ID="${MARKER}"`, `TEST_DATABASE_MARKER_ID: ${MARKER}`]) {
    assert.equal(failure(bytes([`TEST_DATABASE_URL=${u}`, line])).code, 'CONFIG_UNSUPPORTED_SYNTAX', line);
  }
});

test('unrelated lines, comments and look-alike keys never become inputs', () => {
  const lines = [
    '# TEST_DATABASE_URL=postgresql://nobody:x@h:1/db',
    '   # TEST_DATABASE_MARKER_ID=bogus',
    '',
    'DATABASE_URL=not-even-a-url',
    'TEST_DATABASE_URL_OLD=whatever',
    'TEST_DATABASE_MARKER_ID_OLD=whatever',
    'export UNRELATED="quoted value"',
    `TEST_DATABASE_URL=${url()}`,
    `TEST_DATABASE_MARKER_ID=${MARKER}`,
  ];
  const r = parseHostedTestConfig(bytes(lines));
  assert.equal(r.ok, true);
  assert.equal(r.held.host, HOST);
});

test('byte hygiene: invalid UTF-8, NUL, BOM and lone CR are refused; CRLF equals LF; strings are not bytes', () => {
  const text = `TEST_DATABASE_URL=${url()}\nTEST_DATABASE_MARKER_ID=${MARKER}\n`;
  assert.equal(failure(Buffer.concat([Buffer.from('# '), Buffer.from([0xff, 0xfe]), Buffer.from(`\n${text}`)])).code, 'CONFIG_INVALID_UTF8');
  assert.equal(failure(Buffer.from(`# a\u0000b\n${text}`)).code, 'CONFIG_NUL');
  assert.equal(failure(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])).code, 'CONFIG_BOM');
  assert.equal(failure(Buffer.from(`# a\rb\n${text}`)).code, 'CONFIG_LONE_CR');
  const lf = parseHostedTestConfig(Buffer.from(text));
  const crlf = parseHostedTestConfig(Buffer.from(text.replace(/\n/g, '\r\n')));
  assert.equal(crlf.ok, true);
  assert.deepEqual(crlf.evidence, lf.evidence);
  assert.equal(failure(text).code, 'CONFIG_NOT_BYTES');
  assert.equal(failure(undefined).code, 'CONFIG_NOT_BYTES');
  assert.equal(parseHostedTestConfig(new Uint8Array(Buffer.from(text))).ok, true);
});

test('the target class is enforced component by component', () => {
  const cases = {
    'uppercase host': { host: HOST.toUpperCase() },
    'direct database host': { host: `db.${REF}.supabase.co` },
    'pooler look-alike suffix': { host: 'x.pooler.supabase.com.evil.example' },
    'bare pooler suffix': { host: 'pooler.supabase.com' },
    'empty label': { host: 'aws-0..pooler.supabase.com' },
    'transaction-pooler port': { port: '6543' },
    'leading-zero port': { port: '05432' },
    'other database': { db: 'postgres2' },
    'path suffix': { db: 'postgres/' },
    'no project ref': { user: 'postgres' },
    'short ref': { user: 'postgres.abcdefghij012345678' },
    'long ref': { user: 'postgres.abcdefghij01234567890' },
    'uppercase ref': { user: 'postgres.ABCDEFGHIJ0123456789' },
    'other role prefix': { user: `admin.${REF}` },
    'scheme': { scheme: 'mysql' },
    'scheme look-alike': { scheme: 'postgresqls' },
  };
  for (const [name, o] of Object.entries(cases)) {
    const r = failure(good(o));
    assert.equal(r.code, 'CONFIG_TARGET_INVALID', name);
    assert.ok(typeof r.reason === 'string' && /^[A-Z_]+$/.test(r.reason), name);
  }
  const noPort = bytes([`TEST_DATABASE_URL=postgresql://${enc(`postgres.${REF}`)}:${PASSWORD}@${HOST}/postgres`, `TEST_DATABASE_MARKER_ID=${MARKER}`]);
  assert.equal(failure(noPort).code, 'CONFIG_TARGET_INVALID');
  const query = bytes([`TEST_DATABASE_URL=${url()}?sslmode=disable`, `TEST_DATABASE_MARKER_ID=${MARKER}`]);
  assert.equal(failure(query).code, 'CONFIG_TARGET_INVALID');
  const rawAt = bytes([`TEST_DATABASE_URL=postgresql://${enc(`postgres.${REF}`)}:pa@ss@${HOST}:5432/postgres`, `TEST_DATABASE_MARKER_ID=${MARKER}`]);
  assert.equal(failure(rawAt).code, 'CONFIG_TARGET_INVALID');
  const bracket = bytes([`TEST_DATABASE_URL=postgresql://${enc(`postgres.${REF}`)}:${PASSWORD}@[::1]:5432/postgres`, `TEST_DATABASE_MARKER_ID=${MARKER}`]);
  assert.equal(failure(bracket).code, 'CONFIG_TARGET_INVALID');
  const noUserinfo = bytes([`TEST_DATABASE_URL=postgresql://${HOST}:5432/postgres`, `TEST_DATABASE_MARKER_ID=${MARKER}`]);
  assert.equal(failure(noUserinfo).code, 'CONFIG_TARGET_INVALID');
});

test('the marker id must be a canonical lowercase version-4 UUID', () => {
  for (const marker of [MARKER.toUpperCase(), '3f2b8c1e-5d4a-1b6f-8a7c-1d2e3f4a5b6c', '3f2b8c1e-5d4a-4b6f-0a7c-1d2e3f4a5b6c', MARKER.replace(/-/g, ''), `${MARKER}0`, 'not-a-uuid']) {
    assert.equal(failure(good({ marker })).code, 'CONFIG_MARKER_INVALID', marker);
  }
});

test('secrets never appear in any result; the password is not enumerable on the held target', () => {
  const r = parseHostedTestConfig(good());
  noLeak(r.evidence);
  const serialised = JSON.stringify(r.held);
  assert.ok(!serialised.includes(PASSWORD));
  assert.ok(!Object.keys(r.held).includes('password'));
  assert.equal(Object.isFrozen(r.held), true);
  assert.equal(Object.isFrozen(r.evidence), true);
  for (const input of [good({ rawPassword: '%zz' }), good({ port: '6543' }), bytes([`TEST_DATABASE_URL=${url()} # x`, `TEST_DATABASE_MARKER_ID=${MARKER}`])]) {
    noLeak(failure(input));
  }
});

test('toConnectionString emits one canonical spelling and refuses a non-held object', () => {
  const r = parseHostedTestConfig(good());
  assert.equal(toConnectionString(r.held), `postgresql://${enc(`postgres.${REF}`)}:${enc(PASSWORD)}@${HOST}:5432/postgres`);
  assert.throws(() => toConnectionString({ host: HOST }), /held/i);
  assert.throws(() => toConnectionString(null), /held/i);
});
