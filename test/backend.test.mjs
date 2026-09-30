import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../api/pisteborssi.js';
import { loadConfig } from '../lib/config.js';
import { canonical, hashPassword, hashTemporaryPassword, sha256, verifyPassword } from '../lib/crypto.js';
import { FAMILY, initialState, balance, assertCapacity } from '../lib/ledger.js';
import { SupabaseStore } from '../lib/store.js';
import { bootstrap } from '../scripts/bootstrap.mjs';
import { MockSupabase } from './mock-supabase.mjs';

const env = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_only_not_a_real_credential',
  APP_ORIGIN: 'https://pisteborssi.example',
  RATE_LIMIT_SECRET: randomBytes(32).toString('hex')
};
const passwords = Object.fromEntries(FAMILY.map(p => [p.id, randomBytes(24).toString('base64url')]));
const wrongPassword = randomBytes(24).toString('base64url');
const initialAccounts = await Promise.all(FAMILY.map(async p =>
  ({ personId: p.id, username: p.id, credential: await hashPassword(passwords[p.id], false) })));
const key = () => randomUUID();
function fixture({ state = initialState(), accounts = initialAccounts } = {}) {
  const db = new MockSupabase(state, accounts);
  const store = new SupabaseStore(loadConfig(env), db.fetch.bind(db));
  return { db, store, handler: createHandler({ env, store }) };
}
async function request(f, op, { method = 'POST', body = {}, session, headers = {}, idempotencyKey = key(), handler = f.handler } = {}) {
  const output = { headers: {} };
  const res = {
    statusCode: 0,
    setHeader(name, value) { output.headers[name.toLowerCase()] = value; },
    end(value) { output.status = this.statusCode; output.body = JSON.parse(value); }
  };
  await handler({
    method, url: `/api/pisteborssi?op=${op}`,
    headers: {
      origin: env.APP_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      ...headers
    },
    body, socket: { remoteAddress: '192.0.2.4' }
  }, res);
  return output;
}
async function login(f, id) {
  const result = await request(f, 'login', { body: { username: id, password: passwords[id] } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { cookie: result.headers['set-cookie'].split(';')[0], csrfToken: result.body.csrfToken, result };
}
async function addPoints(f, session, childId, count) {
  for (let n = 0; n < count / 2; n++) {
    const result = await request(f, 'points', { session, body: { childId, points: 2, topic: 'walk', reason: '' } });
    assert.equal(result.status, 200);
  }
}

test('independent sessions and server instances share authoritative sanitized state', async () => {
  const f = fixture();
  const parent = await login(f, 'ilkka'), child = await login(f, 'elli');
  assert.notEqual(parent.cookie, child.cookie);
  await addPoints(f, child, 'elli', 2);
  const another = createHandler({ env, store: new SupabaseStore(loadConfig(env), f.db.fetch.bind(f.db)) });
  const read = await request(f, 'state', { method: 'GET', session: parent, handler: another });
  assert.equal(read.status, 200);
  assert.equal(balance(read.body.state, 'elli'), 2);
  assert.equal(read.body.state.people.length, 5);
  assert.equal(read.body.state.version, 4);
  for (const p of read.body.state.people) assert.equal(p.credential, undefined);
  assert.ok(!/scrypt|"salt"|"hash"|"email"/.test(JSON.stringify(read.body)));
  assert.equal(read.headers['cache-control'], 'no-store, private, max-age=0');
  assert.match(parent.result.headers['set-cookie'], /HttpOnly; Secure; SameSite=Lax/);
  assert.match(parent.result.headers['set-cookie'], /__Host-pisteborssi=.*Path=\//);
  assert.ok(f.db.calls.every(call => call.headers.apikey.startsWith('sb_secret_') && !call.headers.Authorization));
  assert.equal(f.db.sessions.size, 2);
  const raw = parent.cookie.split('=')[1];
  assert.ok(f.db.sessions.has(sha256(raw)));
  assert.ok(!JSON.stringify([...f.db.sessions.values()]).includes(raw));
  assert.ok([...f.db.idempotency.values()].every(record => record.result.body.state === undefined));
});

test('Other always needs a reason and preserves the original 300 character limit', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  for (const body of [
    { childId: 'elli', points: 1, topic: 'other', reason: '' },
    { childId: 'elli', points: 2, topic: 'other', reason: ' ' },
    { childId: 'elli', points: 1, topic: 'walk', reason: 'Unexpected comment' },
    { childId: 'elli', points: -1, topic: 'other', reason: 'x'.repeat(301) }
  ]) assert.equal((await request(f, 'points', { session: parent, body })).status, 400);
  assert.equal(f.db.state.entries.length, 0);
});

test('concurrent CAS commits preserve every write and reread roles', async () => {
  const f = fixture();
  const parent = await login(f, 'ilkka');
  const results = await Promise.all(Array.from({ length: 5 }, () => request(f, 'points', {
    session: parent, body: { childId: 'elli', points: 2, topic: 'walk' }
  })));
  assert.ok(results.every(r => r.status === 200), JSON.stringify(results));
  assert.equal(f.db.state.entries.length, 5);
  assert.equal(balance(f.db.state, 'elli'), 10);
  assert.ok(f.db.casConflicts > 0);
  f.db.beforeCommit = db => {
    db.state.people.find(p => p.id === 'ilkka').role = 'child';
    db.revision++;
  };
  const reward = await request(f, 'reward', { session: parent, body: { childId: 'elli' } });
  assert.equal(reward.status, 403);
  assert.equal(balance(f.db.state, 'elli'), 10);
});

test('rewards are atomic/idempotent, consume exactly ten, and reject insufficient funds', async () => {
  const f = fixture();
  const parent = await login(f, 'ilkka');
  assert.equal((await request(f, 'reward', { session: parent, body: { childId: 'elli' } })).status, 409);
  await addPoints(f, parent, 'elli', 10);
  const sameKey = key();
  const [one, two] = await Promise.all([1, 2].map(() => request(f, 'reward', { session: parent, body: { childId: 'elli' }, idempotencyKey: sameKey })));
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, two.body);
  assert.equal(balance(f.db.state, 'elli'), 0);
  const rewards = f.db.state.entries.filter(e => e.kind === 'reward');
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].points, -10);
  assert.equal(rewards[0].amount, 5);
  assert.equal((await request(f, 'reward', { session: parent, body: { childId: 'aava' }, idempotencyKey: sameKey })).status, 409);
  assert.equal((await request(f, 'reward', { session: parent, body: { childId: 'elli' } })).status, 409);
});

test('simultaneous different reward keys cannot overspend the current balance', async () => {
  const f = fixture();
  const parent = await login(f, 'ilkka');
  await addPoints(f, parent, 'elli', 10);
  const results = await Promise.all([1, 2].map(() => request(f, 'reward', { session: parent, body: { childId: 'elli' } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(balance(f.db.state, 'elli'), 0);
});

test('concurrent reuse of one key with different payloads commits only one and returns409', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  const sameKey = key();
  const results = await Promise.all(['elli', 'aava'].map(childId =>
    request(f, 'points', { session: parent, idempotencyKey: sameKey, body: { childId, points: 2, topic: 'walk' } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.db.state.entries.length, 1);
});

test('a committed mutation with a lost database response recovers through durable idempotency', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  let lost = false;
  const handler = createHandler({
    env,
    fetchImpl: async (url, options) => {
      const response = await f.db.fetch(url, options);
      if (url.endsWith('/pb_commit') && !lost) { lost = true; throw new Error('Response lost after committed transaction'); }
      return response;
    }
  });
  const sameKey = key();
  const options = { session: parent, idempotencyKey: sameKey, body: { childId: 'elli', points: 2, topic: 'walk' }, handler };
  assert.equal((await request(f, 'points', options)).status, 503);
  assert.equal(f.db.state.entries.length, 1);
  const retry = await request(f, 'points', options);
  assert.equal(retry.status, 200);
  assert.equal(f.db.state.entries.length, 1);
  assert.equal(balance(retry.body.state, 'elli'), 2);
});

test('login retries return the same opaque session and cannot resurrect it after logout', async () => {
  const f = fixture();
  const sameKey = key(), options = { idempotencyKey: sameKey, body: { username: 'elli', password: passwords.elli } };
  const one = await request(f, 'login', options), two = await request(f, 'login', options);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, two.body);
  assert.equal(one.headers['set-cookie'].split(';')[0], two.headers['set-cookie'].split(';')[0]);
  assert.equal(f.db.sessions.size, 1);
  await request(f, 'logout', { session: { cookie: one.headers['set-cookie'].split(';')[0], csrfToken: one.body.csrfToken } });
  assert.equal((await request(f, 'login', options)).status, 401);
  assert.equal(f.db.sessions.size, 0);
});

test('authentication, exact origin, same-origin reads, CSRF, active roles and forced password changes', async () => {
  const f = fixture();
  assert.equal((await request(f, 'state', { method: 'GET' })).status, 401);
  assert.equal((await request(f, 'points', { body: { childId: 'elli', points: 1, topic: 'walk' } })).status, 401);
  const child = await login(f, 'elli');
  const body = { childId: 'elli', points: 1, topic: 'walk' };
  assert.equal((await request(f, 'points', { session: child, body, headers: { origin: undefined } })).status, 403);
  assert.equal((await request(f, 'points', { session: child, body, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(f, 'state', { method: 'GET', session: child, headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await request(f, 'points', { session: child, body, headers: { 'x-csrf-token': undefined } })).status, 403);
  assert.equal((await request(f, 'points', { session: child, body: { ...body, childId: 'aava' } })).status, 403);
  assert.equal((await request(f, 'reward', { session: child, body: { childId: 'elli' } })).status, 403);
  assert.equal((await request(f, 'backup', { method: 'GET', session: child })).status, 403);
  for (const op of ['edit','delete','person','archive','credentials','import-preview','import-commit']) {
    assert.equal((await request(f, op, { session: child })).status, 403, op);
  }
  f.db.accounts.find(a => a.personId === 'elli').credential.mustChange = true;
  assert.equal((await request(f, 'points', { session: child, body })).body.error.code, 'password_change_required');
  f.db.state.people.find(p => p.id === 'elli').archived = true;
  assert.equal((await request(f, 'state', { method: 'GET', session: child })).status, 401);
});

test('point validation and parent edit/delete preserve original identifiers, times and histories', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  for (const invalid of [
    { points: 3, topic: 'walk' }, { points: 0, topic: 'walk' },
    { points: 1, topic: 'unknown' }, { points: -1, topic: 'walk', reason: 'x' },
    { points: -2, topic: 'other', reason: ' ' }
  ]) assert.equal((await request(f, 'points', { session: parent, body: { childId: 'elli', ...invalid } })).status, 400);
  const created = await request(f, 'points', { session: parent, body: { childId: 'elli', points: -1, topic: 'other', reason: 'Selite' } });
  const original = structuredClone(created.body.state.entries[0]);
  const edited = await request(f, 'edit', { session: parent, body: { id: original.id, points: 2, topic: 'trash', reason: '' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.state.entries[0].id, original.id);
  assert.equal(edited.body.state.entries[0].createdAt, original.createdAt);
  assert.deepEqual(edited.body.state.entries[0].revisions[0], {
    at: edited.body.state.entries[0].revisions[0].at, by: 'ilkka', points: -1, topic: 'other', reason: 'Selite'
  });
  const deleted = await request(f, 'delete', { session: parent, body: { id: original.id } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.state.entries[0].deletedBy, 'ilkka');
  assert.equal(balance(f.db.state, 'elli'), 0);
  assert.equal(deleted.body.state.entries[0].revisions.length, 1);
});

test('ledger capacity bounds protect deployment response sizes without silently truncating history', () => {
  const state = initialState();
  state.entries = Array.from({ length: 4000 }, (_, n) => ({
    id: `entry-${n}`, kind: 'points', childId: 'elli', actorId: 'hanna',
    createdAt: '2026-01-01T00:00:00.000Z', points: 2, topic: 'other', reason: 'x'.repeat(500)
  }));
  assert.throws(() => assertCapacity(state), error => error.status === 409 && error.code === 'ledger_full');
  assert.equal(state.entries.length, 4000);
});

test('last active login-capable parent is preserved even if an accountless parent exists', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  f.db.state.people.push({ id: 'no-login-parent', name: 'Vanhempi', role: 'parent', archived: false });
  const archived = await request(f, 'archive', { session: parent, body: { id: 'hanna' } });
  assert.equal(archived.status, 200);
  const last = await request(f, 'archive', { session: parent, body: { id: 'ilkka' } });
  assert.equal(last.status, 409);
  assert.equal(last.body.error.code, 'last_parent');
  assert.equal(f.db.state.people.find(p => p.id === 'ilkka').archived, false);
});

test('competing self-archives cannot remove both parents, and self-archive clears its cookie', async () => {
  const f = fixture(), one = await login(f, 'ilkka'), two = await login(f, 'hanna');
  const results = await Promise.all([
    request(f, 'archive', { session: one, body: { id: 'ilkka' } }),
    request(f, 'archive', { session: two, body: { id: 'hanna' } })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.db.state.people.filter(p => p.role === 'parent' && !p.archived).length, 1);
  const success = results.find(r => r.status === 200);
  assert.equal(success.body.user, null);
  assert.match(success.headers['set-cookie'], /Max-Age=0/);
});

test('parent creates a public person and independent private login atomically', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  const password = randomBytes(24).toString('base64url');
  const created = await request(f, 'person', { session: parent, body: { name: 'Uusi lapsi', username: ' UUSI.LAPSI ', role: 'child', password } });
  assert.equal(created.status, 200);
  const person = created.body.state.people.find(p => p.id === created.body.personId);
  assert.equal(person.name, 'Uusi lapsi');
  assert.equal(person.username, 'uusi.lapsi');
  assert.equal(person.credential, undefined);
  assert.ok(!JSON.stringify(created.body).includes(password));
  const loggedIn = await request(f, 'login', { body: { username: 'uusi.lapsi', password } });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.user.id, person.id);
  assert.equal(loggedIn.body.user.mustChange, true);
  assert.equal((await request(f, 'person', { session: parent, body: { name: 'Toinen', username: 'uusi.lapsi', role: 'child', password } })).status, 409);
});

// Every test secret is generated in memory; never use the requested deployment password.
const temporaryPassword = () => randomBytes(3).toString('hex').slice(0, 4) + String.fromCharCode(0xf6);
const sessionFrom = result => ({ cookie: result.headers['set-cookie'].split(';')[0], csrfToken: result.body.csrfToken });

test('server automatically initializes exactly five fixed accounts with unique salts and temporary five-character passwords', async () => {
  const f = fixture({ state: null, accounts: [] }), temporary = temporaryPassword();
  assert.equal(temporary.length, 5);
  f.handler = createHandler({ env: { ...env, INITIAL_USER_PASSWORD: temporary }, store: f.store });
  const first = await request(f, 'session', { method: 'GET' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { user: null, csrfToken: null, ready: true });
  assert.deepEqual(f.db.state, initialState());
  assert.deepEqual(f.db.accounts.map(a => [a.personId, a.username]), FAMILY.map(p => [p.id, p.id]));
  assert.equal(new Set(f.db.accounts.map(a => a.credential.salt)).size, 5);
  assert.equal(new Set(f.db.accounts.map(a => a.credential.hash)).size, 5);
  assert.ok(f.db.accounts.every(a => a.credential.mustChange === true));
  assert.ok(!JSON.stringify(f.db.calls).includes(temporary));
  const responses = [first];
  for (const person of FAMILY) {
    const account = f.db.accounts.find(a => a.personId === person.id);
    assert.ok(await verifyPassword(temporary, account.credential));
    const result = await request(f, 'login', { body: { username: ` ${person.id.toUpperCase()} `, password: temporary } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.user, { id: person.id, name: person.name, role: person.role, mustChange: true });
    responses.push(result);
    const wrong = await request(f, 'login', { body: { username: person.id, password: wrongPassword } });
    assert.equal(wrong.status, 401);
  }
  assert.ok(responses.every(result => !JSON.stringify(result.body).includes(temporary) &&
    !/"credential"|"salt"|"hash"|"INITIAL_USER_PASSWORD"/.test(JSON.stringify(result.body))));
  assert.equal(f.db.calls.filter(c => c.name === 'pb_initialize').length, 1);
});

test('first login can initialize but caller-supplied users and passwords cannot override the server family/secret', async () => {
  const f = fixture({ state: null, accounts: [] }), temporary = temporaryPassword();
  f.handler = createHandler({ env: { ...env, INITIAL_USER_PASSWORD: temporary }, store: f.store });
  const result = await request(f, 'login', { body: { username: 'ILKKA', password: temporary,
    people: [{ id: 'attacker', role: 'parent' }], accounts: [], initialPassword: wrongPassword } });
  assert.equal(result.status, 200);
  assert.deepEqual(f.db.state.people, initialState().people);
  assert.equal(f.db.accounts.length, 5);
  const before = f.db.fingerprint();
  assert.equal((await request(f, 'initialize', { body: { people: [], password: wrongPassword } })).status, 404);
  assert.equal(f.db.fingerprint(), before);
});

test('temporary password forces parent/child writes off until a new personal password of at least twelve characters', async () => {
  const f = fixture({ state: null, accounts: [] }), temporary = temporaryPassword();
  f.handler = createHandler({ env: { ...env, INITIAL_USER_PASSWORD: temporary }, store: f.store });
  const loggedIn = await request(f, 'login', { body: { username: 'ilkka', password: temporary } });
  const parent = sessionFrom(loggedIn);
  const before = f.db.fingerprint();
  for (const op of ['points', 'reward', 'edit', 'delete', 'person', 'archive', 'credentials', 'import-preview', 'import-commit']) {
    const blocked = await request(f, op, { session: parent });
    assert.equal(blocked.status, 403, op);
    assert.equal(blocked.body.error.code, 'password_change_required', op);
  }
  assert.equal(f.db.fingerprint(), before);
  const short = randomBytes(8).toString('hex').slice(0, 11);
  const rejected = await request(f, 'password', { session: parent, body: { currentPassword: temporary, newPassword: short } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'invalid_password');
  assert.equal(f.db.accounts.find(a => a.personId === 'ilkka').credential.mustChange, true);
  const next = randomBytes(6).toString('hex');
  assert.equal(next.length, 12);
  const changed = await request(f, 'password', { session: parent, body: { currentPassword: temporary, newPassword: next } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.mustChange, false);
  await addPoints(f, sessionFrom(changed), 'elli', 2);
  assert.equal((await request(f, 'login', { body: { username: 'ilkka', password: temporary } })).status, 401);
  const childLogin = await request(f, 'login', { body: { username: 'elli', password: temporary } });
  const childSession = sessionFrom(childLogin);
  const blockedChild = await request(f, 'points', { session: childSession, body: { childId: 'elli', points: 1, topic: 'walk' } });
  assert.equal(blockedChild.body.error.code, 'password_change_required');
  assert.equal((await request(f, 'logout', { session: childSession })).status, 200);
  await assert.rejects(hashPassword(temporary, false), error => error.code === 'invalid_password');
  assert.equal((await hashTemporaryPassword(temporary)).mustChange, true);
});

test('concurrent cold starts across independent Vercel handlers initialize once without duplicates or replacement', async () => {
  const f = fixture({ state: null, accounts: [] }), temporary = temporaryPassword();
  const initEnv = { ...env, INITIAL_USER_PASSWORD: temporary };
  const handlers = Array.from({ length: 3 }, () => createHandler({ env: initEnv,
    store: new SupabaseStore(loadConfig(initEnv), f.db.fetch.bind(f.db)) }));
  const results = await Promise.all(handlers.map(handler => request(f, 'session', { method: 'GET', handler })));
  assert.ok(results.every(r => r.status === 200 && r.body.ready));
  assert.equal(f.db.accounts.length, 5);
  assert.deepEqual(f.db.state, initialState());
  assert.equal(f.db.revision, 0);
  // All raced from an empty snapshot; only one pb_initialize transaction wins.
  assert.equal(f.db.calls.filter(c => c.name === 'pb_initialize').length, 3);
  const before = f.db.fingerprint();
  await Promise.all(handlers.map(handler => request(f, 'session', { method: 'GET', handler })));
  assert.equal(f.db.fingerprint(), before);
  assert.equal(f.db.calls.filter(c => c.name === 'pb_initialize').length, 3);
});

test('redeploy/new or removed initialization secret never resets existing accounts, credentials, points or payments', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  await addPoints(f, parent, 'elli', 10);
  assert.equal((await request(f, 'reward', { session: parent, body: { childId: 'elli' } })).status, 200);
  const before = f.db.fingerprint();
  for (const value of [undefined, '', ' ', temporaryPassword()]) {
    const nextEnv = { ...env };
    if (value !== undefined) nextEnv.INITIAL_USER_PASSWORD = value;
    const handler = createHandler({ env: nextEnv, store: new SupabaseStore(loadConfig(nextEnv), f.db.fetch.bind(f.db)) });
    const session = await request(f, 'session', { method: 'GET', session: parent, handler });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.id, 'ilkka');
    assert.equal(session.body.state.entries.filter(e => e.kind === 'reward').length, 1);
    assert.equal(f.db.fingerprint(), before);
  }
  assert.equal(f.db.calls.some(c => c.name === 'pb_initialize'), false);
  assert.ok(await verifyPassword(passwords.ilkka, f.db.accounts.find(a => a.personId === 'ilkka').credential));
});

test('fresh database setup secret errors are actionable, safe, and never cause partial initialization', async () => {
  for (const value of [undefined, '', ' ', randomBytes(2).toString('hex'), 'x'.repeat(257)]) {
    const f = fixture({ state: null, accounts: [] });
    const handler = createHandler({ env: { ...env, INITIAL_USER_PASSWORD: value }, store: f.store });
    const error = await request(f, 'session', { method: 'GET', handler });
    assert.equal(error.status, 503);
    assert.equal(error.body.error.code, 'initialization_required');
    assert.match(error.body.error.message, /INITIAL_USER_PASSWORD.*Redeploy/);
    assert.equal(f.db.state, null);
    assert.deepEqual(f.db.accounts, []);
    assert.equal(f.db.calls.some(c => c.name === 'pb_initialize'), false);
  }
  const f = fixture({ state: null, accounts: [] });
  const handler = createHandler({ env: { ...env, INITIAL_USER_PASSWORD: temporaryPassword() }, store: f.store });
  assert.equal((await request(f, 'session', { method: 'GET', headers: { origin: 'https://evil.example' }, handler })).status, 403);
  assert.equal((await request(f, 'session', { method: 'POST', handler })).status, 405);
  assert.equal((await request(f, 'unknown', { method: 'GET', handler })).status, 404);
  assert.equal((await request(f, 'login', { body: '{"bad"', handler })).status, 400);
  assert.equal(f.db.calls.length, 0);
});

test('a lost initialization response can retry without resetting the committed database', async () => {
  const f = fixture({ state: null, accounts: [] }), temporary = temporaryPassword();
  let lost = false;
  const handler = createHandler({ env: { ...env, INITIAL_USER_PASSWORD: temporary },
    fetchImpl: async (url, options) => {
      const result = await f.db.fetch(url, options);
      if (url.endsWith('/pb_initialize') && !lost) { lost = true; throw new Error('Simulated lost setup response'); }
      return result;
    } });
  assert.equal((await request(f, 'session', { method: 'GET', handler })).status, 503);
  const before = f.db.fingerprint();
  assert.equal((await request(f, 'session', { method: 'GET', handler })).status, 200);
  assert.equal(f.db.fingerprint(), before);
  assert.equal(f.db.calls.filter(c => c.name === 'pb_initialize').length, 1);
  const removed = createHandler({ env, store: f.store });
  const result = await request(f, 'login', { body: { username: 'hanna', password: temporary }, handler: removed });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.mustChange, true);
});

test('both Ilkka and Hanna create child and parent accounts with unique usernames and idempotent parent creation', async () => {
  const f = fixture();
  for (const id of ['ilkka', 'hanna']) {
    const parent = await login(f, id);
    for (const role of ['child', 'parent']) {
      const password = temporaryPassword(), username = `${id}.${role}`;
      const body = { name: `Uusi ${role}`, username: ` ${username.toUpperCase()} `, role, password };
      const sameKey = key(), options = { session: parent, body, idempotencyKey: sameKey };
      const results = await Promise.all([request(f, 'person', options), request(f, 'person', options)]);
      assert.ok(results.every(r => r.status === 200));
      assert.equal(results[0].body.personId, results[1].body.personId);
      assert.equal(f.db.accounts.filter(a => a.username === username).length, 1);
      const person = f.db.state.people.find(p => p.id === results[0].body.personId);
      assert.equal(person.role, role);
      const loggedIn = await request(f, 'login', { body: { username, password } });
      assert.equal(loggedIn.status, 200);
      assert.equal(loggedIn.body.user.mustChange, true);
      const duplicate = await request(f, 'person', { session: parent, body });
      assert.equal(duplicate.body.error.code, 'username_taken');
      assert.equal((await request(f, 'person', { ...options, body: { ...body, name: 'Different' } })).body.error.code, 'idempotency_conflict');
    }
  }
  const before = f.db.fingerprint(), password = temporaryPassword();
  const body = { name: 'Ei sallittu', username: 'not.allowed', role: 'parent', password };
  assert.equal((await request(f, 'person', { body })).status, 401);
  const child = await login(f, 'elli'), revision = f.db.revision;
  assert.equal((await request(f, 'person', { session: child, body })).status, 403);
  assert.equal(f.db.revision, revision);
  assert.equal(f.db.accounts.length, 9);
  assert.equal(f.db.state.people.length, 9);
  assert.equal(JSON.parse(before).accounts.length, 9);
});

test('password change uses current password, rotates session/CSRF, revokes all old sessions and clears mustChange', async () => {
  const f = fixture();
  const one = await login(f, 'elli'), two = await login(f, 'elli');
  const before = structuredClone(f.db.accounts.find(a => a.personId === 'elli').credential);
  f.db.accounts.find(a => a.personId === 'elli').credential.mustChange = true;
  const next = randomBytes(24).toString('base64url');
  assert.equal((await request(f, 'password', { session: one, body: { currentPassword: 'wrong', newPassword: next } })).status, 401);
  const changeKey = key();
  const changed = await request(f, 'password', { session: one, idempotencyKey: changeKey, body: { currentPassword: passwords.elli, newPassword: next } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.mustChange, false);
  assert.notEqual(changed.body.csrfToken, one.csrfToken);
  assert.equal((await request(f, 'state', { method: 'GET', session: two })).status, 401);
  assert.equal((await request(f, 'state', { method: 'GET', session: one })).status, 401);
  const fresh = { cookie: changed.headers['set-cookie'].split(';')[0], csrfToken: changed.body.csrfToken };
  assert.equal((await request(f, 'state', { method: 'GET', session: fresh })).status, 200);
  const after = f.db.accounts.find(a => a.personId === 'elli').credential;
  assert.notEqual(before.salt, after.salt);
  assert.ok(await verifyPassword(next, after));
  assert.ok(!await verifyPassword(passwords.elli, after));
  assert.ok(!JSON.stringify(changed.body).includes(next));
  const lostResponseRetry = await request(f, 'password', { session: one, idempotencyKey: changeKey, body: { currentPassword: passwords.elli, newPassword: next } });
  assert.equal(lostResponseRetry.status, 200);
  assert.deepEqual(lostResponseRetry.body, changed.body);
  assert.equal(lostResponseRetry.headers['set-cookie'].split(';')[0], changed.headers['set-cookie'].split(';')[0]);
  assert.equal((await request(f, 'password', { session: one, idempotencyKey: changeKey,
    headers: { 'x-csrf-token': 'wrong' }, body: { currentPassword: passwords.elli, newPassword: next } })).status, 401);
});

test('persisted login throttles apply across handlers and errors do not reveal account existence', async () => {
  const f = fixture();
  const wrong = await request(f, 'login', { body: { username: 'elli', password: wrongPassword } });
  const absent = await request(f, 'login', { body: { username: 'missing', password: wrongPassword } });
  assert.deepEqual(wrong.body, absent.body);
  assert.equal(wrong.status, 401);
  for (let i = 0; i < 7; i++) await request(f, 'login', { body: { username: 'elli', password: wrongPassword } });
  const another = createHandler({ env, store: new SupabaseStore(loadConfig(env), f.db.fetch.bind(f.db)) });
  const blocked = await request(f, 'login', { body: { username: 'elli', password: passwords.elli }, handler: another });
  assert.equal(blocked.status, 429);
  assert.ok(f.db.calls.filter(c => c.name === 'pb_rate').every(c => c.args.p_buckets.every(b => /^[a-f0-9]{64}$/.test(b.key))));
});

function legacyBackup(version = 3) {
  const state = initialState();
  state.version = version;
  state.people.push({ id: 'imported-child', name: 'Tuotu lapsi', role: 'child', archived: false });
  for (const p of state.people) Object.assign(p, { username: p.id, email: 'ignored@example.invalid', credential: { untrusted: randomBytes(8).toString('hex') } });
  state.entries.push({
    id: 'legacy-entry', kind: 'points', childId: 'imported-child', actorId: 'ilkka',
    createdAt: '2024-03-01T10:20:30.000Z', points: 2, topic: 'walk', reason: '',
    revisions: [{ at: '2024-03-01T10:21:00.000Z', by: 'hanna', points: 1, topic: 'walk', reason: '' }]
  });
  return state;
}

test('version 1/2/3 imports preview+confirm, dedupe and never import credentials or reset accounts', async () => {
  for (const version of [1, 2, 3]) {
    const f = fixture(), parent = await login(f, 'ilkka');
    const before = canonical(f.db.accounts);
    const backup = legacyBackup(version);
    const preview = await request(f, 'import-preview', { session: parent, body: { backup } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.summary.newPeople, 1);
    assert.equal(preview.body.summary.newEntries, 1);
    assert.equal(f.db.state.entries.length, 0);
    assert.ok(!JSON.stringify([...f.db.previews.values()]).includes('credential'));
    const commitKey = key();
    const committed = await request(f, 'import-commit', { session: parent, idempotencyKey: commitKey, body: { previewId: preview.body.previewId } });
    assert.equal(committed.status, 200);
    assert.equal(canonical(f.db.accounts), before);
    assert.equal(f.db.accounts.some(a => a.personId === 'imported-child'), false);
    assert.equal(committed.body.state.entries[0].id, 'legacy-entry');
    assert.equal(committed.body.state.entries[0].createdAt, backup.entries[0].createdAt);
    assert.deepEqual(committed.body.state.entries[0].revisions, backup.entries[0].revisions);
    const retry = await request(f, 'import-commit', { session: parent, idempotencyKey: commitKey, body: { previewId: preview.body.previewId } });
    assert.deepEqual(retry.body, committed.body);
    const duplicate = await request(f, 'import-preview', { session: parent, body: { backup } });
    assert.equal(duplicate.body.summary.newEntries, 0);
    assert.equal(duplicate.body.summary.duplicates, 7);
    const exported = await request(f, 'backup', { method: 'GET', session: parent });
    assert.equal(exported.body.backup.version, 4);
    assert.ok(!/credential|email|scrypt/.test(JSON.stringify(exported.body)));
    assert.equal((await request(f, 'credentials', { session: parent, body: { id: 'ilkka', username: 'another', password: randomBytes(20).toString('hex') } })).status, 409);
  }
});

test('import conflicts block commits, actor binding and CAS remerge detect newly introduced conflicts', async () => {
  const f = fixture(), parent = await login(f, 'ilkka'), other = await login(f, 'hanna');
  const conflict = legacyBackup();
  conflict.people.find(p => p.id === 'elli').name = 'Ristiriitainen nimi';
  const preview = await request(f, 'import-preview', { session: parent, body: { backup: conflict } });
  assert.equal(preview.body.canCommit, false);
  assert.deepEqual(preview.body.summary.conflicts, [{ kind: 'person', id: 'elli' }]);
  const revision = f.db.revision;
  const rejected = await request(f, 'import-commit', { session: parent, body: { previewId: preview.body.previewId } });
  assert.equal(rejected.status, 409);
  assert.equal(f.db.revision, revision);
  const clean = await request(f, 'import-preview', { session: parent, body: { backup: legacyBackup() } });
  assert.equal((await request(f, 'import-commit', { session: other, body: { previewId: clean.body.previewId } })).status, 409);
  f.db.beforeCommit = db => {
    db.state.people.push({ id: 'imported-child', name: 'Eri henkilö', role: 'child', archived: false });
    db.revision++;
  };
  const race = await request(f, 'import-commit', { session: parent, body: { previewId: clean.body.previewId } });
  assert.equal(race.status, 409);
  assert.equal(f.db.state.entries.length, 0);
  assert.equal(f.db.previews.get(clean.body.previewId).consumed, undefined);
});

test('import CAS retry merges nonconflicting concurrent writes and expired previews cannot commit', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  const preview = await request(f, 'import-preview', { session: parent, body: { backup: legacyBackup() } });
  f.db.beforeCommit = db => {
    db.state.entries.push({ id: 'concurrent-entry', kind: 'points', childId: 'aava', actorId: 'hanna',
      createdAt: new Date().toISOString(), points: 1, topic: 'trash', reason: '' });
    db.revision++;
  };
  const committed = await request(f, 'import-commit', { session: parent, body: { previewId: preview.body.previewId } });
  assert.equal(committed.status, 200);
  assert.deepEqual(new Set(f.db.state.entries.map(e => e.id)), new Set(['concurrent-entry', 'legacy-entry']));
  const expired = await request(f, 'import-preview', { session: parent, body: { backup: legacyBackup() } });
  f.db.previews.get(expired.body.previewId).expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await request(f, 'import-commit', { session: parent, body: { previewId: expired.body.previewId } })).status, 409);
});

test('accountless imported profiles can receive new login, existing cloud accounts cannot be reset', async () => {
  const f = fixture(), parent = await login(f, 'ilkka');
  const preview = await request(f, 'import-preview', { session: parent, body: { backup: legacyBackup() } });
  await request(f, 'import-commit', { session: parent, body: { previewId: preview.body.previewId } });
  const password = randomBytes(24).toString('base64url');
  const setup = await request(f, 'credentials', { session: parent, body: { id: 'imported-child', username: 'new-child', password } });
  assert.equal(setup.status, 200);
  const loggedIn = await request(f, 'login', { body: { username: 'new-child', password } });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.user.mustChange, true);
  const before = canonical(f.db.accounts);
  assert.equal((await request(f, 'credentials', { session: parent, body: { id: 'imported-child', username: 'another', password } })).status, 409);
  assert.equal(canonical(f.db.accounts), before);
});

test('logout revokes one session, supports safe retry, and expired sessions cannot be read or resurrected', async () => {
  const f = fixture(), one = await login(f, 'elli'), two = await login(f, 'elli');
  const sameKey = key();
  const out = await request(f, 'logout', { session: one, idempotencyKey: sameKey });
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
  const retry = await request(f, 'logout', { session: one, idempotencyKey: sameKey });
  assert.equal(retry.status, 200);
  assert.deepEqual(out.body, retry.body);
  assert.equal((await request(f, 'state', { method: 'GET', session: two })).status, 200);
  const session = f.db.sessions.get(sha256(two.cookie.split('=')[1]));
  session.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await request(f, 'state', { method: 'GET', session: two })).status, 401);
});

test('configuration, uninitialized databases, malformed data and network failures are honest errors', async () => {
  const f = fixture();
  const missing = createHandler({ env: {} });
  const configError = await request(f, 'session', { method: 'GET', handler: missing });
  assert.equal(configError.status, 503);
  const empty = fixture({ state: null, accounts: [] });
  const status = await request(empty, 'session', { method: 'GET' });
  assert.equal(status.status, 503);
  assert.equal(status.body.error.code, 'initialization_required');
  assert.match(status.body.error.message, /INITIAL_USER_PASSWORD.*Redeploy/);
  assert.equal(empty.db.calls.some(c => c.name === 'pb_initialize'), false);
  assert.equal((await request(empty, 'login', { body: { username: 'elli', password: passwords.elli } })).status, 503);
  f.db.networkDown = true;
  assert.equal((await request(f, 'session', { method: 'GET' })).status, 503);
  f.db.networkDown = false;
  assert.equal((await request(f, 'login', { body: '{"bad-json"' })).status, 400);
  assert.equal((await request(f, 'login', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(f, 'unknown', { method: 'GET' })).status, 404);
  assert.equal((await request(f, 'session', { method: 'POST' })).status, 405);
  assert.equal((await request(f, 'login', { idempotencyKey: 'too-short', body: {} })).status, 400);
  const invalidDatabase = createHandler({ env, fetchImpl: async () => new Response('{"unexpected":true}', { status: 200 }) });
  assert.equal((await request(f, 'session', { method: 'GET', handler: invalidDatabase })).status, 503);
  const brokenDatabase = createHandler({ env, fetchImpl: async () => new Response('{"message":"secret database error details"}', { status: 500 }) });
  const broken = await request(f, 'session', { method: 'GET', handler: brokenDatabase });
  assert.equal(broken.status, 503);
  assert.ok(!JSON.stringify(broken.body).includes('secret database'));
  const badOrigin = createHandler({ env: { ...env, APP_ORIGIN: `${env.APP_ORIGIN}/` } });
  assert.equal((await request(f, 'session', { method: 'GET', handler: badOrigin })).status, 503);
  const legacyKey = createHandler({ env: { ...env, SUPABASE_SECRET_KEY: 'eyJ.not.accepted.jwt' } });
  assert.equal((await request(f, 'session', { method: 'GET', handler: legacyKey })).status, 503);
  assert.equal((await request(f, 'login', { body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await request(f, 'session&op=state', { method: 'GET' })).status, 400);
  f.db.state.people[0].credential = { unknown: true };
  assert.equal((await request(f, 'session', { method: 'GET' })).status, 503);
});

test('bootstrap prompts privately, hashes individually, is atomic, and refuses subsequent setup without prompts', async () => {
  const f = fixture({ state: null, accounts: [] });
  let askCount = 0, secretCount = 0;
  const secrets = FAMILY.map(() => randomBytes(24).toString('base64url'));
  const done = await bootstrap({
    env, store: f.store,
    ask: async () => { askCount++; return ''; },
    secretAsk: async () => secrets[Math.floor(secretCount++ / 2)]
  });
  assert.deepEqual(done, { ready: true });
  assert.equal(askCount, 5);
  assert.equal(secretCount, 10);
  assert.deepEqual(f.db.state.people.map(p => p.id), FAMILY.map(p => p.id));
  assert.equal(new Set(f.db.accounts.map(a => a.credential.salt)).size, 5);
  assert.ok(f.db.accounts.every(a => a.credential.mustChange));
  assert.ok(secrets.every(secret => !JSON.stringify(f.db.accounts).includes(secret)));
  const before = f.db.fingerprint();
  await assert.rejects(bootstrap({ env, store: f.store, ask: async () => { throw new Error('Must not prompt'); } }), /jo alustettu/);
  assert.equal(f.db.fingerprint(), before);
  await assert.rejects(f.store.initialize(initialState(), initialAccounts), /jo alustettu/);
  assert.equal(f.db.fingerprint(), before);
});

test('cancelled/mismatched bootstrap never creates partial people or accounts; competing initializers never reset', async () => {
  const f = fixture({ state: null, accounts: [] });
  await assert.rejects(bootstrap({
    env, store: f.store, ask: async () => '',
    secretAsk: async () => randomBytes(24).toString('hex')
  }), /eivät täsmää/);
  assert.equal(f.db.state, null);
  assert.deepEqual(f.db.accounts, []);
  const accounts = structuredClone(initialAccounts).map(a => ({ ...a, credential: { ...a.credential, mustChange: true } }));
  const results = await Promise.allSettled([f.store.initialize(initialState(), accounts), f.store.initialize(initialState(), accounts)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.db.accounts.length, 5);
});
test('SQL declares every table protected and grants RPCs only to service_role (static checks, not DB execution)', async () => {
  const sql = await readFile(new URL('../sql/setup.sql', import.meta.url), 'utf8');
  for (const table of ['ledger', 'accounts', 'sessions', 'rate_buckets', 'idempotency_results', 'import_previews']) {
    assert.match(sql, new RegExp(`alter table public\\.pb_${table} enable row level security`));
  }
  assert.match(sql, /from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function %s to service_role/);
  assert.ok(!/create policy|grant .* to anon|grant .* to authenticated/i.test(sql));
  assert.match(sql, /for update/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /PB_LAST_PARENT/);
});
