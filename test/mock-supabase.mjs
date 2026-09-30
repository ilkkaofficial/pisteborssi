// Test-only PostgREST/RPC persistence emulator; never imported by production modules.
import { canonical } from '../lib/crypto.js';

export class MockSupabase {
  constructor(state = null, accounts = []) {
    this.state = structuredClone(state);
    this.accounts = structuredClone(accounts);
    this.revision = 0;
    this.sessions = new Map();
    this.idempotency = new Map();
    this.previews = new Map();
    this.buckets = new Map();
    this.calls = [];
    this.networkDown = false;
    this.beforeCommit = null;
    this.casConflicts = 0;
  }
  async fetch(url, options) {
    if (this.networkDown) throw new Error('Simulated network failure');
    const name = new URL(url).pathname.split('/').at(-1);
    const args = JSON.parse(options.body);
    this.calls.push({ name, args: structuredClone(args), headers: options.headers });
    await Promise.resolve();
    try {
      const result = this.rpc(name, args);
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      return new Response(JSON.stringify({ message: error.message }), { status: 400 });
    }
  }
  cached(scope, key, request) {
    const result = this.idempotency.get(`${scope}:${key}`);
    if (!result) return null;
    if (result.request !== request) throw new Error('PB_IDEMPOTENCY_CONFLICT');
    return structuredClone(result.result);
  }
  rpc(name, p) {
    if (name === 'pb_snapshot') {
      const session = this.sessions.get(p.p_session_hash);
      return { ready: !!this.state, state: structuredClone(this.state), revision: this.revision,
        accounts: structuredClone(this.accounts),
        session: session && Date.parse(session.expiresAt) > Date.now() ? structuredClone(session) : null };
    }
    if (name === 'pb_idempotency') return this.cached(p.p_scope, p.p_key_hash, p.p_request_hash);
    if (name === 'pb_rate') {
      let allowed = true;
      for (const bucket of p.p_buckets) {
        const old = this.buckets.get(bucket.key);
        const next = !old || old.start + bucket.window * 1000 <= Date.now() ? { start: Date.now(), count: 1 } : { ...old, count: old.count + 1 };
        this.buckets.set(bucket.key, next);
        if (next.count > bucket.limit) allowed = false;
      }
      return { allowed };
    }
    if (name === 'pb_preview') {
      const preview = this.previews.get(p.p_id);
      return preview?.actorId === p.p_actor_id && Date.parse(preview.expiresAt) > Date.now() ? structuredClone(preview) : null;
    }
    if (name === 'pb_initialize') {
      if (this.state || this.accounts.length) throw new Error('PB_ALREADY_INITIALIZED');
      if (p.p_state.people.length !== 5 || p.p_accounts.length !== 5) throw new Error('PB_INVALID_INITIALIZATION');
      if (new Set(p.p_accounts.map(a => a.personId)).size !== 5 || new Set(p.p_accounts.map(a => a.username)).size !== 5) throw new Error('PB_INVALID_INITIALIZATION');
      if (p.p_state.entries.length || p.p_state.people.some(person =>
        !['ilkka', 'hanna', 'elli', 'aava', 'stella'].includes(person.id) || person.archived ||
        person.role !== (['ilkka', 'hanna'].includes(person.id) ? 'parent' : 'child')) ||
        p.p_accounts.some(a => !p.p_state.people.some(person => person.id === a.personId) ||
          a.credential.mustChange !== true)) throw new Error('PB_INVALID_INITIALIZATION');
      this.state = structuredClone(p.p_state);
      this.accounts = structuredClone(p.p_accounts);
      return { ready: true, revision: 0 };
    }
    if (name === 'pb_commit') {
      if (this.beforeCommit) {
        const hook = this.beforeCommit;
        this.beforeCommit = null;
        hook(this, p);
      }
      const cached = this.cached(p.p_scope, p.p_key_hash, p.p_request_hash);
      if (cached) return { committed: true, result: cached };
      if (p.p_expected_revision !== this.revision) { this.casConflicts++; return { committed: false }; }
      if (p.p_session_hash) {
        const session = this.sessions.get(p.p_session_hash);
        if (!session || session.personId !== p.p_actor_id || Date.parse(session.expiresAt) <= Date.now()) throw new Error('PB_SESSION_INVALID');
      }
      if (!this.state.people.some(person => person.id === p.p_actor_id && !person.archived)) throw new Error('PB_SESSION_INVALID');
      const accounts = structuredClone(this.accounts);
      for (const account of p.p_accounts) {
        if (accounts.some(a => a.username === account.username && a.personId !== account.personId)) throw new Error('PB_USERNAME_TAKEN');
        const index = accounts.findIndex(a => a.personId === account.personId);
        if (index < 0) accounts.push(structuredClone(account));
        else accounts[index] = structuredClone(account);
      }
      if (!p.p_state.people.some(person => person.role === 'parent' && !person.archived && accounts.some(a => a.personId === person.id))) throw new Error('PB_LAST_PARENT');
      if (p.p_consume_preview) {
        const preview = this.previews.get(p.p_consume_preview);
        if (!preview || preview.actorId !== p.p_actor_id || preview.consumed || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('PB_PREVIEW_INVALID');
      }
      // Apply all changes after validation, modeling the RPC's atomic transaction.
      this.accounts = accounts;
      this.state = structuredClone(p.p_state);
      this.revision++;
      if (p.p_preview) this.previews.set(p.p_preview.id, structuredClone(p.p_preview));
      if (p.p_consume_preview) this.previews.get(p.p_consume_preview).consumed = true;
      for (const [hash, session] of this.sessions) {
        if (p.p_remove_sessions.includes(hash) || session.personId === p.p_revoke_actor || Date.parse(session.expiresAt) <= Date.now()) this.sessions.delete(hash);
      }
      for (const session of p.p_sessions) this.sessions.set(session.tokenHash, structuredClone(session));
      this.idempotency.set(`${p.p_scope}:${p.p_key_hash}`, { request: p.p_request_hash, result: structuredClone(p.p_result) });
      if (p.p_revoke_actor === p.p_actor_id && p.p_sessions.length && p.p_session_hash) {
        this.idempotency.set(`password-retry:${p.p_session_hash}:${p.p_key_hash}`, { request: p.p_request_hash, result: structuredClone(p.p_result) });
      }
      return { committed: true, result: structuredClone(p.p_result) };
    }
    throw new Error(`Unknown mock RPC ${name}`);
  }
  fingerprint() { return canonical({ state: this.state, accounts: this.accounts, revision: this.revision }); }
}
