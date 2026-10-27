import { createHash } from 'node:crypto';

// D5H canonical hosted TEST configuration: the one parser every D5H hosted-TEST
// entrypoint must consume. Pure: it takes raw config BYTES and returns data. It
// never reads a file, never opens a socket and never touches the environment, so
// the caller owns reading and nothing here can reach a database.
//
// Deliberately NOT dotenv / util.parseEnv: those accept `export`, `key: value`,
// quotes, inline comments and "last assignment wins". For the two security-sensitive
// keys below exactly one narrow spelling is accepted — `KEY=value` at column 0 —
// and every other spelling of those keys (or a second assignment) fails closed.
// Failure results carry fixed codes only; no input text is ever echoed.

export const URL_KEY = 'TEST_DATABASE_URL';
export const MARKER_KEY = 'TEST_DATABASE_MARKER_ID';
export const RELEVANT_KEYS = Object.freeze([URL_KEY, MARKER_KEY]);

const TARGET_DOMAIN = 'mona-d5h-target/v1\n';
const MARKER_DOMAIN = 'mona-d5h-marker/v1\n';
const POOLER_SUFFIX = ['pooler', 'supabase', 'com'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USERNAME = /^postgres\.([a-z0-9]{20})$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Any line that mentions a relevant key as its first token, in ANY spelling
// (export prefix, leading whitespace, `:` or ` =` separators), is an assignment
// attempt and is counted. A longer key such as TEST_DATABASE_URL_OLD is not.
const RELEVANT_LINE = /^\s*(?:export\s+)?(TEST_DATABASE_URL|TEST_DATABASE_MARKER_ID)(?![A-Za-z0-9_.-])/;
const STRICT_LINE = /^(TEST_DATABASE_URL|TEST_DATABASE_MARKER_ID)=(.+)$/;
// Printable ASCII only, and none of: whitespace, quotes, backtick, `#`, backslash.
const RAW_VALUE = /^[\x21\x24-\x26\x28-\x5b\x5d-\x5f\x61-\x7e]+$/;
const URL_SHAPE = /^(postgres|postgresql):\/\/([^:@/?#]+):([^@/?#]*)@([^:@/?#[\]]+):(\d+)\/([^?#]*)$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const fail = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// encodeURIComponent leaves !'()* unescaped; the quote would not survive the raw
// grammar above, so every reserved sub-delimiter is escaped. One spelling only.
const encodeComponent = (text) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Decodes exactly once. Any malformed escape, invalid UTF-8 or control character
// after decoding is refused; the decoded text is never decoded again.
function decodeOnce(encoded) {
  if (/%(?![0-9A-Fa-f]{2})/.test(encoded)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return CONTROL.test(decoded) ? null : decoded;
}

function validHost(host) {
  const labels = host.split('.');
  return (
    labels.length >= 4 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    POOLER_SUFFIX.every((suffix, i) => labels[labels.length - POOLER_SUFFIX.length + i] === suffix)
  );
}

function parseTargetValue(raw) {
  const invalid = (reason) => fail('CONFIG_TARGET_INVALID', { reason });
  if (!/^postgres(?:ql)?:\/\//.test(raw)) return invalid('SCHEME');
  const m = URL_SHAPE.exec(raw);
  if (!m) return invalid(raw.includes('?') ? 'QUERY' : 'SHAPE');
  const [, , rawUser, rawPassword, host, port, database] = m;
  if (!validHost(host)) return invalid('HOST');
  if (port !== '5432') return invalid('PORT');
  if (database !== 'postgres') return invalid('DATABASE');
  const username = decodeOnce(rawUser);
  const password = decodeOnce(rawPassword);
  if (username === null || password === null) return invalid('ENCODING');
  const ref = USERNAME.exec(username);
  if (!ref) return invalid('USERNAME');
  if (password.length === 0) return invalid('PASSWORD');
  return { host, username, password, projectRef: ref[1] };
}

const HELD = new WeakSet();

// The returned `held` object is the private, in-memory target. The password is
// readable (for the one connection built from it) but not enumerable, so a
// JSON/inspect of the object cannot carry it into logs. `evidence` is the only
// part intended for output and contains digests and a class label, nothing else.
export function parseHostedTestConfig(input) {
  if (!(input instanceof Uint8Array)) return fail('CONFIG_NOT_BYTES');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return fail('CONFIG_INVALID_UTF8');
  }
  if (text.charCodeAt(0) === 0xfeff) return fail('CONFIG_BOM');
  if (text.includes('\u0000')) return fail('CONFIG_NUL');
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return fail('CONFIG_LONE_CR');

  const lines = normalized.split('\n');
  const attempts = new Map(RELEVANT_KEYS.map((key) => [key, []]));
  for (const line of lines) {
    const hit = RELEVANT_LINE.exec(line);
    if (hit) attempts.get(hit[1]).push(line);
  }
  for (const key of RELEVANT_KEYS) {
    if (attempts.get(key).length > 1) return fail('CONFIG_DUPLICATE_KEY', { key });
  }
  for (const key of RELEVANT_KEYS) {
    if (attempts.get(key).length === 0) return fail('CONFIG_KEY_MISSING', { key });
  }
  const values = {};
  for (const key of RELEVANT_KEYS) {
    const strict = STRICT_LINE.exec(attempts.get(key)[0]);
    if (!strict || strict[1] !== key || !RAW_VALUE.test(strict[2])) return fail('CONFIG_UNSUPPORTED_SYNTAX', { key });
    values[key] = strict[2];
  }

  const target = parseTargetValue(values[URL_KEY]);
  if (target.ok === false) return target;
  const markerId = values[MARKER_KEY];
  if (!UUID_V4.test(markerId)) return fail('CONFIG_MARKER_INVALID', { key: MARKER_KEY });

  const held = {
    protocol: 'postgresql:',
    host: target.host,
    port: 5432,
    database: 'postgres',
    username: target.username,
    projectRef: target.projectRef,
    markerId,
  };
  Object.defineProperty(held, 'password', { value: target.password, enumerable: false });
  Object.freeze(held);
  HELD.add(held);
  const identity = JSON.stringify({ host: held.host, port: held.port, database: held.database, username: held.username });
  const evidence = Object.freeze({
    targetClass: 'CONFORMS',
    targetDigest: sha256(`${TARGET_DOMAIN}${identity}`),
    markerDigest: sha256(`${MARKER_DOMAIN}${markerId}`),
  });
  return Object.freeze({ ok: true, held, evidence });
}

// The one deterministic spelling of the held target, with the one canonical
// scheme. Used only where a string is unavoidable (a child process environment);
// everything else should connect with the discrete fields.
export function toConnectionString(held) {
  if (!HELD.has(held)) throw new Error('toConnectionString requires a held target from parseHostedTestConfig');
  return `postgresql://${encodeComponent(held.username)}:${encodeComponent(held.password)}@${held.host}:${held.port}/${held.database}`;
}
