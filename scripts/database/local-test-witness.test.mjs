import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as W from './local-test-witness.mjs';

const H = (c) => c.repeat(64);
const sha = (t) => createHash('sha256').update(t).digest('hex');
const RUN = 'local-test-20261005T120000Z-abcdef12';
const AUTH = 'a'.repeat(32);
const AUTH2 = 'b'.repeat(32);
const PLAN = H('9');
const CANARY_HASH = '$2b$12$CANARY_PASSWORD_HASH_DO_NOT_LEAK0123456789abcdefghijkl';

const preFields = () => ({ markerIdSha256: H('1'), serverVersionNum: '170004', protectedDomainContractSha256: H('2'), fPre: H('3') });
const preText = () => W.buildWitness('PRE', preFields());
const preSha = () => W.preWitnessSha256(preText());

const recordFields = (over = {}) => ({
  authId: AUTH, target: W.TARGET, markerIdSha256: H('1'), backupRun: RUN, dumpSha256: H('5'), manifestSha256: H('4'), fPre: H('3'),
  preWitnessSha256: preSha(), checkpointId: 'cp-20261005T110000Z-' + 'c'.repeat(32), checkpointRecordSha256: H('6'), planDigest: PLAN,
  createdAt: '2026-10-05T12:00:00.000Z', expiresAt: '2026-10-05T13:00:00.000Z', ...over,
});
const recordText = (over) => W.buildAuthorizationRecord(recordFields(over));
const postFields = (over = {}) => ({
  markerIdSha256: H('1'), serverVersionNum: '170004', backupRun: RUN, manifestSha256: H('4'), dumpSha256: H('5'), preWitnessSha256: preSha(),
  fPre: H('3'), fPost: H('7'), authId: AUTH, authorizationRecordSha256: sha(recordText()), planDigest: PLAN, protectedDomainContractSha256: H('2'),
  transformationContractSha256: H('8'), createdAt: '2026-10-05T12:30:00.000Z', ...over,
});
const postText = (over) => W.buildWitness('POST', postFields(over));
const ctxOf = (over = {}) => ({
  run: RUN, manifestSha256: H('4'), dumpSha256: H('5'), preWitnessSha256: preSha(), fPre: H('3'), markerIdSha256: H('1'), serverVersionNum: '170004',
  domainSha256: H('2'), acceptedTransformationContracts: [H('8')], consumedAuthIds: [AUTH], authRecords: { [AUTH]: recordText() }, ...over,
});
// an attacker/model that can rewrite a witness AND recompute its self-hash
const reseal = (obj) => { const o = { ...obj }; o.witnessSha256 = W.postSelfHash(o); return JSON.stringify(o) + '\n'; };
const mutate = (over) => reseal({ ...JSON.parse(postText()), ...over });

// ---- parsing ----
test('AC-001 a PRE witness with an extra key is refused on write and on read', () => {
  assert.throws(() => W.buildWitness('PRE', { ...preFields(), extra: 'x' }));
  assert.equal(W.parseWitness('PRE', JSON.stringify({ ...JSON.parse(preText()), extra: 'x' }) + '\n').ok, false);
});
test('AC-002 a PRE witness missing one key is refused', () => {
  const o = JSON.parse(preText()); delete o.fPre;
  assert.equal(W.parseWitness('PRE', JSON.stringify(o) + '\n').ok, false);
  const { fPre, ...rest } = preFields(); void fPre;
  assert.throws(() => W.buildWitness('PRE', rest));
});
test('AC-003 a POST witness with keys in another order is refused as non-canonical', () => {
  const o = JSON.parse(postText()); const re = Object.fromEntries(Object.entries(o).reverse());
  const r = W.parseWitness('POST', JSON.stringify(re) + '\n');
  assert.equal(r.ok, false);
});
test('AC-004 a POST witness with a duplicated key is refused as non-canonical', () => {
  const t = postText().replace('{', `{"format":"x",`);
  assert.deepEqual(W.parseWitness('POST', t), { ok: false, reason: 'NOT_CANONICAL' });
});
test('AC-005 BOM, CRLF, pretty printing or a missing trailing newline are refused', () => {
  const t = postText();
  for (const bad of ['﻿' + t, t.replace(/\n$/, '\r\n'), JSON.stringify(JSON.parse(t), null, 2) + '\n', t.replace(/\n$/, '')]) {
    assert.equal(W.parseWitness('POST', bad).ok, false);
  }
});
test('AC-006 fPost in uppercase, 63 or 65 hex is refused', () => {
  for (const v of ['A'.repeat(64), '7'.repeat(63), '7'.repeat(65)]) {
    assert.equal(W.parseWitness('POST', mutate({ fPost: v })).ok, false, v.length + v[0]);
    assert.throws(() => postText({ fPost: v }));
  }
});
test('AC-007 streamFormat as the string "3" or as 3.0 is refused', () => {
  assert.equal(W.parseWitness('POST', mutate({ streamFormat: '3' })).ok, false);
  const t = postText().replace('"streamFormat":3,', '"streamFormat":3.0,');
  assert.notEqual(t, postText());
  assert.equal(W.parseWitness('POST', t).ok, false);
});
test('AC-008 createdAt without milliseconds or with an offset is refused', () => {
  for (const v of ['2026-10-05T12:30:00Z', '2026-10-05T12:30:00.000+00:00', '2026-10-05 12:30:00.000Z']) {
    assert.equal(W.parseWitness('POST', mutate({ createdAt: v })).ok, false, v);
    assert.throws(() => postText({ createdAt: v }));
  }
});
test('AC-009 a state other than PRECOMMIT_EXPECTED_POST is refused', () => {
  assert.deepEqual(W.parseWitness('POST', mutate({ state: 'COMMITTED' })), { ok: false, reason: 'VALUE:state' });
  assert.ok(!/committed|succeeded|acknowledged|applied|completed/i.test(postText()));
});
test('AC-010 another target or a non-17xxxx server version is refused', () => {
  assert.equal(W.parseWitness('POST', mutate({ target: 'other@127.0.0.1:5432/other' })).ok, false);
  assert.equal(W.parseWitness('POST', mutate({ serverVersionNum: '160004' })).ok, false);
  assert.throws(() => postText({ serverVersionNum: '160004' }));
});
test('AC-011 fPost equal to fPre is refused on write and on read', () => {
  assert.throws(() => postText({ fPost: H('3') }));
  assert.deepEqual(W.parseWitness('POST', mutate({ fPost: H('3') })), { ok: false, reason: 'POST_EQ_PRE' });
});
test('AC-012 protected-looking values in any slot are refused by the slot pattern', () => {
  for (const slot of ['planDigest', 'authId', 'backupRun', 'manifestSha256', 'createdAt']) {
    for (const v of [CANARY_HASH, 'canary@example.invalid', '{"a":1}']) {
      assert.equal(W.parseWitness('POST', mutate({ [slot]: v })).ok, false, slot);
      assert.throws(() => postText({ [slot]: v }), undefined, slot);
    }
  }
});
test('AC-013 __proto__ key and non-object JSON values are refused', () => {
  for (const t of ['{"__proto__":{}}\n', '[]\n', 'null\n', '7\n', '"x"\n', 'not json\n']) assert.equal(W.parseWitness('POST', t).ok, false, t);
});
test('AC-014 a key spelled with a unicode escape is refused (non-canonical bytes)', () => {
  const t = postText().replace('"format"', '"\\u0066ormat"');
  assert.notEqual(t, postText());
  assert.deepEqual(W.parseWitness('POST', t), { ok: false, reason: 'NOT_CANONICAL' });
});
test('AC-015 an edited planDigest with the old self-hash is refused', () => {
  const o = JSON.parse(postText()); o.planDigest = H('a');
  assert.deepEqual(W.parseWitness('POST', JSON.stringify(o) + '\n'), { ok: false, reason: 'SELF_HASH' });
});
test('AC-016 a self-hash computed under the PRE label is refused', () => {
  const o = JSON.parse(postText()); const { witnessSha256, ...body } = o; void witnessSha256;
  const wrong = createHash('sha256').update(W.frameStr(`${W.SCHEME}/WITNESS/PRE/SELF`)).update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
  assert.notEqual(wrong, o.witnessSha256);
  assert.deepEqual(W.parseWitness('POST', JSON.stringify({ ...body, witnessSha256: wrong }) + '\n'), { ok: false, reason: 'SELF_HASH' });
});
test('AC-017 a same-user attacker who recomputes the self-hash is accepted by the parser (documented tamper-evidence limit)', () => {
  assert.equal(W.parseWitness('POST', mutate({ fPost: H('e') })).ok, true);
});
test('AC-018 PRE and POST witnesses round-trip canonically', () => {
  const pre = W.parseWitness('PRE', preText());
  assert.equal(pre.ok, true);
  assert.deepEqual(Object.keys(pre.obj), ['format', 'digestScheme', 'streamFormat', 'target', 'markerIdSha256', 'serverVersionNum', 'protectedDomainContractSha256', 'fPre']);
  const post = W.parseWitness('POST', postText());
  assert.equal(post.ok, true);
  assert.equal(Object.keys(post.obj).length, 20);
  assert.equal(post.obj.state, W.POST_STATE);
  assert.ok(postText().endsWith('\n') && postText().indexOf('\n') === postText().length - 1);
  assert.equal(W.preWitnessSha256(preText()), createHash('sha256').update(W.frameStr(`${W.SCHEME}/WITNESS/PRE/SHA`)).update(Buffer.from(preText(), 'utf8')).digest('hex'));
});

// ---- binding ----
test('AC-019 bindPost refuses another run, manifest, dump, PRE witness or fPre (each separately)', () => {
  const t = postText();
  for (const [key, reason] of [['run', 'RUN'], ['manifestSha256', 'MANIFEST'], ['dumpSha256', 'DUMP'], ['preWitnessSha256', 'PRE_WITNESS'], ['fPre', 'F_PRE']]) {
    const other = key === 'run' ? 'local-test-20261005T130000Z-00000000' : H('f');
    assert.deepEqual(W.bindPost(t, ctxOf({ [key]: other }), AUTH), { ok: false, reason }, key);
  }
});
test('AC-020 bindPost refuses another marker, server version or domain contract', () => {
  const t = postText();
  assert.deepEqual(W.bindPost(t, ctxOf({ markerIdSha256: H('f') }), AUTH), { ok: false, reason: 'TARGET' });
  assert.deepEqual(W.bindPost(t, ctxOf({ serverVersionNum: '170005' }), AUTH), { ok: false, reason: 'SERVER' });
  assert.deepEqual(W.bindPost(t, ctxOf({ domainSha256: H('f') }), AUTH), { ok: false, reason: 'DOMAIN' });
});
test('AC-021 bindPost refuses a transformation contract outside the accepted set', () => {
  assert.deepEqual(W.bindPost(postText(), ctxOf({ acceptedTransformationContracts: [H('d')] }), AUTH), { ok: false, reason: 'TRANSFORMATION_CONTRACT' });
  assert.deepEqual(W.bindPost(postText(), ctxOf({ acceptedTransformationContracts: [] }), AUTH), { ok: false, reason: 'TRANSFORMATION_CONTRACT' });
});
test('AC-022 bindPost refuses an authId with no consumed marker', () => {
  assert.deepEqual(W.bindPost(postText(), ctxOf({ consumedAuthIds: [] }), AUTH), { ok: false, reason: 'NO_CONSUMED_AUTHORIZATION' });
});
test('AC-023 bindPost refuses an authorizationRecordSha256 that differs from the actual record', () => {
  assert.deepEqual(W.bindPost(postText({ authorizationRecordSha256: H('f') }), ctxOf(), AUTH), { ok: false, reason: 'AUTH_RECORD' });
  assert.deepEqual(W.bindPost(postText(), ctxOf({ authRecords: {} }), AUTH), { ok: false, reason: 'AUTH_RECORD' });
});
const withRecord = (over) => {
  const text = recordText(over);
  return { witness: postText({ authorizationRecordSha256: sha(text) }), ctx: ctxOf({ authRecords: { [AUTH]: text } }) };
};
test('AC-024 LOW-5: a record whose file sha matches but whose manifestSha256 disagrees is refused', () => {
  const { witness, ctx } = withRecord({ manifestSha256: H('f') });
  assert.deepEqual(W.bindPost(witness, ctx, AUTH), { ok: false, reason: 'AUTH_RECORD_CONTENT' });
});
test('AC-025 LOW-5: record fPre or preWitnessSha256 disagreeing is refused', () => {
  for (const over of [{ fPre: H('f') }, { preWitnessSha256: H('f') }]) {
    const { witness, ctx } = withRecord(over);
    assert.deepEqual(W.bindPost(witness, ctx, AUTH), { ok: false, reason: 'AUTH_RECORD_CONTENT' }, Object.keys(over)[0]);
  }
});
test('AC-026 LOW-5: record planDigest disagreeing is refused', () => {
  const { witness, ctx } = withRecord({ planDigest: H('f') });
  assert.deepEqual(W.bindPost(witness, ctx, AUTH), { ok: false, reason: 'AUTH_RECORD_CONTENT' });
});
test('AC-027 LOW-5: record backupRun, dumpSha256 or markerIdSha256 disagreeing is refused', () => {
  for (const over of [{ backupRun: 'local-test-20261005T130000Z-00000000' }, { dumpSha256: H('f') }, { markerIdSha256: H('f') }]) {
    const { witness, ctx } = withRecord(over);
    assert.deepEqual(W.bindPost(witness, ctx, AUTH), { ok: false, reason: 'AUTH_RECORD_CONTENT' }, Object.keys(over)[0]);
  }
});
test('AC-028 LOW-5: unreadable, non-canonical, extra-key or mis-self-hashed records never bind by hash alone', () => {
  const good = JSON.parse(recordText());
  const variants = ['garbage', JSON.stringify(good, null, 2) + '\n', JSON.stringify({ ...good, streamSha256: H('0') }) + '\n', JSON.stringify({ ...good, planDigest: H('f') }) + '\n'];
  for (const text of variants) {
    const witness = postText({ authorizationRecordSha256: sha(text) });
    assert.deepEqual(W.bindPost(witness, ctxOf({ authRecords: { [AUTH]: text } }), AUTH), { ok: false, reason: 'AUTH_RECORD_INVALID' }, text.slice(0, 12));
  }
  assert.equal(W.parseAuthorizationRecord(recordText()).ok, true);
  assert.ok(!('streamSha256' in JSON.parse(recordText())));
});
test('AC-029 a witness whose every field agrees with the evidence and the record binds', () => {
  const r = W.bindPost(postText(), ctxOf(), AUTH);
  assert.equal(r.ok, true);
  assert.equal(r.obj.authId, AUTH);
});

// ---- filename / content (LOW-1) ----
test('AC-030 LOW-1: a witness filed under another authId than its content names is refused', () => {
  assert.deepEqual(W.bindPost(postText(), ctxOf({ consumedAuthIds: [AUTH, AUTH2], authRecords: { [AUTH]: recordText() } }), AUTH2), { ok: false, reason: 'FILENAME_AUTHID' });
});

const witnessOutcome = (witnesses, current, over = {}) => W.classifyOutcome({ pre: { valid: true, fPre: H('3') }, ctx: ctxOf(over), witnesses, current });
test('AC-031 LOW-1: a copy under a second authId name is refused while the original still classifies POST', () => {
  const r = witnessOutcome([{ authId: AUTH, text: postText() }, { authId: AUTH2, text: postText() }], { pre: H('0'), post: H('7') }, { consumedAuthIds: [AUTH, AUTH2] });
  assert.deepEqual([r.state, r.authId], ['POST_SEED_EXACT', AUTH]);
});

// ---- file hygiene ----
const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'mj-witness-'));
const put = (dir, name, data, mode = 0o600) => { const p = path.join(dir, name); fsSync.writeFileSync(p, data, { mode }); fsSync.chmodSync(p, mode); return p; };

test('AC-032 dotfiles, temp names, uppercase hex, suffixes and non-32-hex names are never candidates', async () => {
  const dir = tmpDir();
  for (const n of [`.${AUTH}.post.json.tmp`, `${AUTH.toUpperCase()}.post.json`, `${AUTH}.post.json.bak`, `${'a'.repeat(31)}.post.json`, 'notes.txt']) put(dir, n, postText());
  put(dir, `${AUTH}.post.json`, postText());
  const listed = await W.listWitnessFiles(dir, W.realWitnessFs);
  assert.deepEqual(listed.map((e) => e.authId), [AUTH]);
});
test('AC-033 a symlink, hard link, 0644 file, directory, empty or oversize file is refused', async () => {
  const dir = tmpDir(); const out = tmpDir();
  const N = (c) => `${c.repeat(32)}.post.json`;
  fsSync.symlinkSync(put(out, 'real', postText()), path.join(dir, N('1')));
  fsSync.linkSync(put(out, 'real2', postText()), path.join(dir, N('2')));
  put(dir, N('3'), postText(), 0o644);
  fsSync.mkdirSync(path.join(dir, N('4')));
  put(dir, N('5'), '');
  put(dir, N('6'), 'x'.repeat(4097));
  put(dir, N('7'), postText());
  const listed = await W.listWitnessFiles(dir, W.realWitnessFs);
  const byId = Object.fromEntries(listed.map((e) => [e.authId, e]));
  for (const c of '123456') assert.equal(byId[c.repeat(32)].ok, false, c);
  assert.equal(byId['7'.repeat(32)].ok, true);
});
test('AC-034 a witness owned by another uid is refused', async () => {
  const lst = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, mode: 0o100600, uid: 4242, size: 10 };
  const fake = { readdir: async () => [`${AUTH}.post.json`], lstat: async () => lst, readFile: async () => Buffer.from('x'), getuid: () => 1000 };
  const [e] = await W.listWitnessFiles('/w', fake);
  assert.deepEqual([e.ok, e.reason], [false, 'OWNER']);
});
test('AC-035 an invalid sibling is reported and never prevents a valid witness from being found', async () => {
  const dir = tmpDir();
  put(dir, `${AUTH}.post.json`, postText());
  put(dir, `${AUTH2}.post.json`, 'garbage');
  const listed = await W.listWitnessFiles(dir, W.realWitnessFs);
  assert.deepEqual(listed.map((e) => [e.authId, e.ok]).sort(), [[AUTH, true], [AUTH2, true]].sort()); // hygiene ok for both; content judged by classify
  const r = witnessOutcome(listed.map((e) => ({ authId: e.authId, text: e.text })), { pre: H('0'), post: H('7') }, { consumedAuthIds: [AUTH, AUTH2] });
  assert.deepEqual([r.state, r.authId, r.inventory], ['POST_SEED_EXACT', AUTH, { valid: 1, invalid: 1 }]);
});

// ---- durability ----
function fakeFs({ fail = {}, preexisting = [], hang = null } = {}) {
  const files = new Map(); const log = []; let n = 0;
  for (const p of preexisting) files.set(p, { data: Buffer.from('foreign'), nlink: 1, mode: 0o100600, uid: 1000, dir: false });
  const step = async (name, fn) => {
    log.push(name);
    if (hang === name) await new Promise(() => {});
    const f = fail[name];
    if (f === 'zero') return 0;
    if (f) throw Object.assign(new Error('boom'), { code: 'EIO', syscall: name });
    return fn();
  };
  const rec = (p) => { const r = files.get(p); if (!r) throw Object.assign(new Error('nf'), { code: 'ENOENT', syscall: 'open' }); return r; };
  return {
    files, log, getuid: () => 1000,
    openExcl: (p) => step('open', () => { if (files.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST', syscall: 'open' }); files.set(p, { data: Buffer.alloc(0), nlink: 1, mode: 0o100600, uid: 1000, dir: false }); return { p, id: ++n }; }),
    write: (h, buf) => step('write', () => { const r = rec(h.p); const take = fail.short ? Math.min(3, buf.length) : buf.length; r.data = Buffer.concat([r.data, buf.subarray(0, take)]); return take; }),
    fsync: (h) => step('fsync', () => { rec(h.p); }),
    close: () => step('close', () => {}),
    readFile: (p) => step(p.includes('.tmp') ? 'readTmp' : 'readFinal', () => { const r = rec(p); return fail.tamper && p.includes('.tmp') ? Buffer.from('tampered') : (fail.tamperFinal && !p.includes('.tmp') ? Buffer.from('tampered') : r.data); }),
    link: (a, b) => step('link', () => { if (files.has(b)) throw Object.assign(new Error('exists'), { code: 'EEXIST', syscall: 'link' }); const r = rec(a); r.nlink += 1; files.set(b, r); }),
    unlink: (p) => step('unlink', () => { const r = rec(p); r.nlink -= 1; files.delete(p); }),
    lstat: (p) => step('lstat', () => { const r = rec(p); return { isFile: () => !r.dir, isDirectory: () => r.dir, isSymbolicLink: () => false, nlink: r.nlink, mode: r.mode, uid: r.uid, size: r.data.length }; }),
    fsyncDir: (p) => step('fsyncDir', () => { void p; }),
    mkdir: (p, mode) => step('mkdir', () => { files.set(p, { data: Buffer.alloc(0), nlink: 2, mode: 0o40000 | mode, uid: 1000, dir: true }); }),
  };
}
const persist = (fs, over = {}) => W.persistWitnessDurably({ dir: '/w/run', authId: AUTH, text: postText(), fs, ...over });

test('AC-036 a failing temp open is not durable and yields no receipt', async () => {
  const r = await persist(fakeFs({ fail: { open: true } }));
  assert.deepEqual(r, { durable: false, step: 'open' });
});
test('AC-037 an existing temp leftover is not durable and is never deleted', async () => {
  const fs = fakeFs({ preexisting: [`/w/run/.${AUTH}.post.json.tmp`] });
  const r = await persist(fs);
  assert.deepEqual(r, { durable: false, step: 'open' });
  assert.ok(fs.files.has(`/w/run/.${AUTH}.post.json.tmp`));
  assert.ok(!fs.log.includes('unlink'));
});
test('AC-038 short writes are continued until every byte is written', async () => {
  const fs = fakeFs({ fail: { short: true } });
  const r = await persist(fs);
  assert.equal(r.durable, true);
  assert.equal(fs.files.get(`/w/run/${AUTH}.post.json`).data.toString(), postText());
});
test('AC-039 a zero-byte or throwing write is not durable', async () => {
  assert.deepEqual(await persist(fakeFs({ fail: { write: 'zero' } })), { durable: false, step: 'write' });
  assert.deepEqual(await persist(fakeFs({ fail: { write: true } })), { durable: false, step: 'write' });
});
test('AC-040 a failing file fsync is not durable', async () => { assert.deepEqual(await persist(fakeFs({ fail: { fsync: true } })), { durable: false, step: 'fsync' }); });
test('AC-041 a failing close is not durable', async () => { assert.deepEqual(await persist(fakeFs({ fail: { close: true } })), { durable: false, step: 'close' }); });
test('AC-042 a temp read-back mismatch is not durable', async () => { assert.deepEqual(await persist(fakeFs({ fail: { tamper: true } })), { durable: false, step: 'readback' }); });
test('AC-043 an existing final name is never overwritten and the result is not durable', async () => {
  const fs = fakeFs({ preexisting: [`/w/run/${AUTH}.post.json`] });
  assert.deepEqual(await persist(fs), { durable: false, step: 'link' });
  assert.equal(fs.files.get(`/w/run/${AUTH}.post.json`).data.toString(), 'foreign');
});
test('AC-044 a failing directory fsync is not durable', async () => { assert.deepEqual(await persist(fakeFs({ fail: { fsyncDir: true } })), { durable: false, step: 'dirfsync' }); });
test('AC-045 a final read-back mismatch or a hygiene failure is not durable', async () => {
  assert.deepEqual(await persist(fakeFs({ fail: { tamperFinal: true } })), { durable: false, step: 'final-readback' });
});
test('AC-046 a failing temp unlink after link (nlink 2) is not durable', async () => {
  const fs = fakeFs({ fail: { unlink: true } });
  assert.deepEqual(await persist(fs), { durable: false, step: 'unlink' });
});
test('AC-047 LOW-2: the witnesses root is fsynced after the run directory is created; a failing fsync refuses', async () => {
  const fs = fakeFs();
  const ok = await W.ensureWitnessDir({ root: '/w', run: RUN, fs });
  assert.equal(ok.ok, true);
  const mk = fs.log.indexOf('mkdir'); const fsy = fs.log.lastIndexOf('fsyncDir');
  assert.ok(mk >= 0 && fsy > mk, fs.log.join());
  const bad = await W.ensureWitnessDir({ root: '/w', run: RUN, fs: fakeFs({ fail: { fsyncDir: true } }) });
  assert.equal(bad.ok, false);
});
test('AC-049 a hung filesystem step exceeds the deadline and is not durable', async () => {
  let fire; const timers = { setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} };
  const pending = persist(fakeFs({ hang: 'fsync' }), { timers, deadlineMs: 5000 });
  await new Promise((r) => setImmediate(r));
  fire();
  assert.deepEqual(await pending, { durable: false, step: 'deadline' });
});
test('AC-050 an I/O step completing after the deadline cannot make the result durable', async () => {
  let fire; const timers = { setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} };
  const fs = fakeFs(); let release; const gate = new Promise((r) => { release = r; });
  const slowWrite = fs.write; fs.write = async (h, b) => { await gate; return slowWrite(h, b); };
  const pending = persist(fs, { timers, deadlineMs: 5000 });
  await new Promise((r) => setImmediate(r));
  fire();
  const result = await pending;
  release();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(result, { durable: false, step: 'deadline' });
  assert.ok(!fs.log.includes('link'), 'no link after the deadline: ' + fs.log.join());
});
test('AC-051 umask 0 cannot widen the witness file or directory mode', async () => {
  const root = tmpDir(); const old = process.umask(0);
  try {
    const d = await W.ensureWitnessDir({ root, run: RUN, fs: W.realWitnessFs });
    assert.equal(d.ok, true);
    const dir = path.join(root, RUN);
    assert.equal(fsSync.lstatSync(dir).mode & 0o777, 0o700);
    const r = await W.persistWitnessDurably({ dir, authId: AUTH, text: postText(), fs: W.realWitnessFs });
    assert.equal(r.durable, true);
    assert.equal(fsSync.lstatSync(path.join(dir, `${AUTH}.post.json`)).mode & 0o777, 0o600);
    assert.equal(fsSync.lstatSync(path.join(dir, `${AUTH}.post.json`)).nlink, 1);
    assert.deepEqual(fsSync.readdirSync(dir), [`${AUTH}.post.json`]);
  } finally { process.umask(old); }
});
test('AC-052 the durable receipt is produced only after the last step', async () => {
  const fs = fakeFs(); const r = await persist(fs);
  assert.equal(r.durable, true);
  assert.deepEqual(fs.log.filter((s) => s !== 'lstat' && s !== 'readFinal'), ['open', 'write', 'fsync', 'close', 'readTmp', 'link', 'unlink', 'fsyncDir']);
  assert.ok(fs.log.indexOf('readFinal') > fs.log.indexOf('fsyncDir'));
});
test('AC-053 a witness directory that is a symlink, foreign or group/other accessible is refused', async () => {
  const root = tmpDir();
  const dir = path.join(root, RUN); fsSync.mkdirSync(dir, { mode: 0o755 }); fsSync.chmodSync(dir, 0o755);
  assert.equal((await W.ensureWitnessDir({ root, run: RUN, fs: W.realWitnessFs })).ok, false);
  const root2 = tmpDir(); const target = tmpDir(); fsSync.symlinkSync(target, path.join(root2, RUN));
  assert.equal((await W.ensureWitnessDir({ root: root2, run: RUN, fs: W.realWitnessFs })).ok, false);
  const fs = fakeFs(); fs.getuid = () => 4242; fs.files.set(`/w/${RUN}`, { data: Buffer.alloc(0), nlink: 2, mode: 0o40700, uid: 1000, dir: true });
  assert.equal((await W.ensureWitnessDir({ root: '/w', run: RUN, fs })).ok, false);
});

// ---- outcome verifier ----
const POSTCUR = { pre: H('0'), post: H('7') };
test('AC-064 a current PRE digest equal to fPre is PRE_SEED_EXACT even if a valid POST witness exists', () => {
  const r = witnessOutcome([{ authId: AUTH, text: postText() }], { pre: H('3'), post: H('7') });
  assert.deepEqual([r.state, r.authId], ['PRE_SEED_EXACT', undefined]);
});
test('AC-065 a current POST digest equal to exactly one valid witness is POST_SEED_EXACT naming its authId', () => {
  const r = witnessOutcome([{ authId: AUTH, text: postText() }], POSTCUR);
  assert.deepEqual([r.state, r.authId], ['POST_SEED_EXACT', AUTH]);
});
test('AC-066 a digest matching neither is PARTIAL_OR_UNKNOWN / NO_MATCH', () => {
  const r = witnessOutcome([{ authId: AUTH, text: postText() }], { pre: H('0'), post: H('c') });
  assert.deepEqual([r.state, r.reason], ['PARTIAL_OR_UNKNOWN', 'NO_MATCH']);
});
test('AC-067 invalid PRE evidence is PARTIAL_OR_UNKNOWN / PRE_EVIDENCE_INVALID without consulting witnesses', () => {
  let touched = false; const witnesses = new Proxy([], { get(t, k) { touched = true; return Reflect.get(t, k); } });
  const r = W.classifyOutcome({ pre: { valid: false }, ctx: ctxOf(), witnesses, current: POSTCUR });
  assert.deepEqual([r.state, r.reason], ['PARTIAL_OR_UNKNOWN', 'PRE_EVIDENCE_INVALID']);
  assert.equal(touched, false);
  assert.equal(W.classifyOutcome({ pre: null, ctx: ctxOf(), witnesses: [], current: POSTCUR }).reason, 'PRE_EVIDENCE_INVALID');
});
test('AC-068 a witness present with the state still PRE (crash before COMMIT) is PRE_SEED_EXACT', () => {
  assert.equal(witnessOutcome([{ authId: AUTH, text: postText() }], { pre: H('3'), post: H('1') }).state, 'PRE_SEED_EXACT');
});
test('AC-069 a tampered witness with a POST-shaped state is PARTIAL (witness ignored)', () => {
  const o = JSON.parse(postText()); o.fPost = H('c');
  const r = witnessOutcome([{ authId: AUTH, text: JSON.stringify(o) + '\n' }], { pre: H('0'), post: H('c') });
  assert.deepEqual([r.state, r.reason, r.inventory], ['PARTIAL_OR_UNKNOWN', 'NO_MATCH', { valid: 0, invalid: 1 }]);
});
test('AC-070 the outcome alphabet is exactly three states over a fuzz of combinations', () => {
  const states = new Set();
  const witnessSets = [[], [{ authId: AUTH, text: postText() }], [{ authId: AUTH, text: 'junk' }], [{ authId: AUTH, text: postText() }, { authId: AUTH2, text: postText() }]];
  for (const pre of [null, { valid: true, fPre: H('3') }, { valid: false }]) for (const ws of witnessSets) for (const cur of [{ pre: H('3'), post: H('7') }, POSTCUR, { pre: H('a'), post: H('b') }]) {
    states.add(W.classifyOutcome({ pre, ctx: ctxOf({ consumedAuthIds: [AUTH, AUTH2] }), witnesses: ws, current: cur }).state);
  }
  assert.deepEqual([...states].sort(), ['PARTIAL_OR_UNKNOWN', 'POST_SEED_EXACT', 'PRE_SEED_EXACT']);
});
test('AC-071 nextAction never offers seed, resume-execute or restore for PARTIAL_OR_UNKNOWN', () => {
  assert.equal(W.nextAction({ state: 'PARTIAL_OR_UNKNOWN' }, true), 'STOP_OWNER_RESTORE_FROM_BACKUP');
  assert.equal(W.nextAction({ state: 'PARTIAL_OR_UNKNOWN' }, false), 'STOP_OWNER_RESTORE_FROM_BACKUP');
  assert.equal(W.nextAction({ state: 'POST_SEED_EXACT' }, true), 'RECORD_COMPLETION_ONLY');
  assert.equal(W.nextAction({ state: 'PRE_SEED_EXACT' }, true), 'FRESH_AUTHORIZATION_REQUIRED');
  for (const s of ['PRE_SEED_EXACT', 'POST_SEED_EXACT', 'PARTIAL_OR_UNKNOWN']) for (const c of [true, false]) assert.ok(!/SEED$|^EXECUTE|^RESTORE/.test(W.nextAction({ state: s }, c)));
});
test('AC-076 a rolled-back first attempt plus a committed second attempt classifies POST via the second', () => {
  const second = postText({ authId: AUTH2, fPost: H('c'), authorizationRecordSha256: sha(recordText({ authId: AUTH2 })) });
  const r = witnessOutcome([{ authId: AUTH, text: postText() }, { authId: AUTH2, text: second }], { pre: H('0'), post: H('c') },
    { consumedAuthIds: [AUTH, AUTH2], authRecords: { [AUTH]: recordText(), [AUTH2]: recordText({ authId: AUTH2 }) } });
  assert.deepEqual([r.state, r.authId], ['POST_SEED_EXACT', AUTH2]);
});
test('AC-077 two valid witnesses with the same fPost matching the state are ambiguous', () => {
  const dup = postText({ authId: AUTH2, authorizationRecordSha256: sha(recordText({ authId: AUTH2 })) });
  const r = witnessOutcome([{ authId: AUTH, text: postText() }, { authId: AUTH2, text: dup }], POSTCUR,
    { consumedAuthIds: [AUTH, AUTH2], authRecords: { [AUTH]: recordText(), [AUTH2]: recordText({ authId: AUTH2 }) } });
  assert.deepEqual([r.state, r.reason], ['PARTIAL_OR_UNKNOWN', 'AMBIGUOUS_WITNESSES']);
});
test('AC-078 two valid witnesses of which only one matches classify POST with that authId', () => {
  const other = postText({ authId: AUTH2, fPost: H('c'), authorizationRecordSha256: sha(recordText({ authId: AUTH2 })) });
  const r = witnessOutcome([{ authId: AUTH, text: postText() }, { authId: AUTH2, text: other }], POSTCUR,
    { consumedAuthIds: [AUTH, AUTH2], authRecords: { [AUTH]: recordText(), [AUTH2]: recordText({ authId: AUTH2 }) } });
  assert.deepEqual([r.state, r.authId], ['POST_SEED_EXACT', AUTH]);
});
test('AC-079 the witness inventory reports counts only (no paths, no content)', () => {
  const r = witnessOutcome([{ authId: AUTH, text: postText() }, { authId: AUTH2, text: 'junk' }], POSTCUR);
  assert.deepEqual(r.inventory, { valid: 1, invalid: 1 });
  assert.ok(!JSON.stringify(r).includes(AUTH2));
});


// ---- OWNER authorization store (AC-080..085): write, read with hygiene/expiry/consumed checks, single-use consumption ----
const homeDir = () => { const h = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mj-auth-home-')); fsSync.chmodSync(h, 0o700); return h; };
const NOW = new Date('2026-10-05T12:30:00.000Z');
const consumedFields = (over = {}) => ({ authId: AUTH, planDigest: PLAN, fPre: H('3'), backupRun: RUN, at: '2026-10-05T12:31:00.000Z', ...over });

test('AC-081 the store is created owner-only; a written record reads back byte-identical, 0600, and binds the reviewed fields', async () => {
  const home = homeDir();
  const store = await W.ensureAuthorizationStore({ home, fs: W.realWitnessFs });
  assert.equal(store.ok, true);
  assert.equal(fsSync.lstatSync(store.dir).mode & 0o777, 0o700);
  const text = recordText();
  assert.deepEqual(await W.writeAuthorizationRecord({ dir: store.dir, authId: AUTH, text, fs: W.realWitnessFs }), { durable: true, authId: AUTH, witnessSha256: sha(Buffer.from(text)) });
  assert.equal(fsSync.lstatSync(path.join(store.dir, `${AUTH}.json`)).mode & 0o777, 0o600);
  const read = await W.readAuthorizationRecord({ dir: store.dir, authId: AUTH, fs: W.realWitnessFs, now: NOW });
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.text, text);
  assert.equal(read.record.authId, AUTH);
  assert.deepEqual(Object.keys(read.record), W.AUTH_SPEC.map(([k]) => k));
  assert.ok(!('streamSha256' in read.record));
});
test('AC-080 an authorization store that is a symlink, group/other accessible or foreign is refused', async () => {
  const home = homeDir();
  const real = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mj-auth-real-'));
  fsSync.mkdirSync(path.join(home, '.local', 'state', 'mona-jacinta'), { recursive: true, mode: 0o700 });
  fsSync.symlinkSync(real, path.join(home, '.local', 'state', 'mona-jacinta', 'local-test-authorizations'));
  assert.equal((await W.ensureAuthorizationStore({ home, fs: W.realWitnessFs })).ok, false);
  const home2 = homeDir();
  const dir2 = path.join(home2, '.local', 'state', 'mona-jacinta', 'local-test-authorizations');
  fsSync.mkdirSync(dir2, { recursive: true, mode: 0o755 }); fsSync.chmodSync(dir2, 0o755);
  assert.equal((await W.ensureAuthorizationStore({ home: home2, fs: W.realWitnessFs })).ok, false);
});
test('AC-082 expired, not-yet-created, foreign-mode, symlinked, non-canonical and misnamed records are refused', async () => {
  const home = homeDir(); const { dir } = await W.ensureAuthorizationStore({ home, fs: W.realWitnessFs });
  const read = (authId = AUTH, now = NOW) => W.readAuthorizationRecord({ dir, authId, fs: W.realWitnessFs, now });
  assert.equal((await read()).reason, 'MISSING');
  await W.writeAuthorizationRecord({ dir, authId: AUTH, text: recordText(), fs: W.realWitnessFs });
  assert.equal((await read()).ok, true);
  assert.equal((await read(AUTH, new Date('2026-10-05T13:00:01.000Z'))).reason, 'EXPIRED'); // beyond expiresAt
  assert.equal((await read(AUTH, new Date('2026-10-05T11:59:59.000Z'))).reason, 'NOT_YET_VALID');
  fsSync.chmodSync(path.join(dir, `${AUTH}.json`), 0o644);
  assert.equal((await read()).reason, 'MODE');
  fsSync.chmodSync(path.join(dir, `${AUTH}.json`), 0o600);
  // non-canonical bytes
  fsSync.writeFileSync(path.join(dir, `${AUTH2}.json`), JSON.stringify(JSON.parse(recordText({ authId: AUTH2 })), null, 2) + '\n', { mode: 0o600 });
  assert.equal((await read(AUTH2)).reason, 'INVALID');
  // file named for another authId than its content (LOW-1 class)
  fsSync.writeFileSync(path.join(dir, `${'c'.repeat(32)}.json`), recordText(), { mode: 0o600 });
  assert.equal((await read('c'.repeat(32))).reason, 'FILENAME_AUTHID');
  // a symlink
  const target = path.join(dir, 'real.json'); fsSync.writeFileSync(target, recordText({ authId: 'd'.repeat(32) }), { mode: 0o600 });
  fsSync.symlinkSync(target, path.join(dir, `${'d'.repeat(32)}.json`));
  assert.equal((await read('d'.repeat(32))).reason, 'NOT_REGULAR');
  assert.equal((await read('not-an-id')).reason, 'BAD_ID');
});
test('AC-085 single use: the consumed marker is created O_EXCL; any existing form (file, symlink, directory) counts as consumed and refuses a second consumption', async () => {
  const home = homeDir(); const { dir } = await W.ensureAuthorizationStore({ home, fs: W.realWitnessFs });
  await W.writeAuthorizationRecord({ dir, authId: AUTH, text: recordText(), fs: W.realWitnessFs });
  const marker = W.buildConsumedMarker(consumedFields());
  assert.deepEqual(await W.consumeAuthorizationMarker({ dir, authId: AUTH, text: marker, fs: W.realWitnessFs }), { durable: true, authId: AUTH, witnessSha256: sha(Buffer.from(marker)) });
  assert.equal(fsSync.lstatSync(path.join(dir, `${AUTH}.consumed.json`)).mode & 0o777, 0o600);
  assert.equal((await W.readAuthorizationRecord({ dir, authId: AUTH, fs: W.realWitnessFs, now: NOW })).reason, 'CONSUMED');
  assert.equal((await W.consumeAuthorizationMarker({ dir, authId: AUTH, text: marker, fs: W.realWitnessFs })).durable, false);
  for (const make of [(p) => fsSync.symlinkSync('/nonexistent', p), (p) => fsSync.mkdirSync(p), (p) => fsSync.writeFileSync(p, 'x')]) {
    const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
    await W.writeAuthorizationRecord({ dir, authId: id, text: recordText({ authId: id }), fs: W.realWitnessFs });
    make(path.join(dir, `${id}.consumed.json`));
    assert.equal((await W.readAuthorizationRecord({ dir, authId: id, fs: W.realWitnessFs, now: NOW })).reason, 'CONSUMED');
    assert.equal((await W.consumeAuthorizationMarker({ dir, authId: id, text: W.buildConsumedMarker(consumedFields({ authId: id })), fs: W.realWitnessFs })).durable, false);
  }
});
test('AC-085b the consumed marker is canonical, digest-only and pattern-checked; unknown keys or protected-looking values are refused', () => {
  const text = W.buildConsumedMarker(consumedFields());
  assert.deepEqual(Object.keys(JSON.parse(text)), ['format', 'authId', 'planDigest', 'fPre', 'backupRun', 'at']);
  assert.ok(text.endsWith('\n'));
  assert.throws(() => W.buildConsumedMarker({ ...consumedFields(), extra: 'x' }));
  assert.throws(() => W.buildConsumedMarker(consumedFields({ planDigest: CANARY_HASH })));
  assert.throws(() => W.buildConsumedMarker(consumedFields({ at: 'yesterday' })));
});

test('AC-019b backupRun is exactly the manifest run name (local-test-<stamp>-<suffix>); an unprefixed or malformed run is refused in witnesses and authorization records', () => {
  assert.equal(W.parseWitness('POST', postText()).obj.backupRun, 'local-test-20261005T120000Z-abcdef12');
  for (const bad of ['20261005T120000Z-abcdef12', 'local-test-20261005T120000Z-ABCDEF12', 'local-test-2026-abcdef12', 'local-test-20261005T120000Z-abcdef1', '']) {
    assert.throws(() => postText({ backupRun: bad }), undefined, bad);
    assert.throws(() => recordText({ backupRun: bad }), undefined, bad);
  }
});
