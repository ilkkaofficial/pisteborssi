import { AppError, fail, unavailable } from './errors.js';
import { canonical, equal, hashPassword, hashTemporaryPassword, keyedHash, normalizeUsername, seal, sha256, token, unseal, validatePassword, validateTemporaryPassword, verifyPassword } from './crypto.js';
import { activePerson, assertCapacity, balance, child, mergeBackup, newId, parseBackup, pointFields, publicState, publicUser, RULE_LIMIT, ruleFields, text } from './ledger.js';
import { initializedSnapshot } from './initialize.js';

const READS = new Set(['session', 'state', 'backup']);
const WRITES = new Set(['login', 'logout', 'points', 'reward', 'edit', 'delete', 'person', 'archive', 'credentials', 'password', 'password-reset', 'rule-create', 'rule-edit', 'rule-delete', 'import-preview', 'import-commit']);
const PARENT = new Set(['reward', 'edit', 'delete', 'person', 'archive', 'credentials', 'password-reset', 'rule-create', 'rule-edit', 'rule-delete', 'import-preview', 'import-commit']);
const parentOnly = person => { if (person.role !== 'parent') fail(403, 'forbidden', 'Toiminto on vain vanhemmille.'); };
const authError = () => new AppError(401, 'invalid_login', 'Käyttäjätunnus tai salasana ei kelpaa.');
const blankCommit = () => ({ p_accounts: [], p_sessions: [], p_remove_sessions: [], p_revoke_actor: null, p_preview: null, p_consume_preview: null });

export class PisteborssiService {
  constructor(store, config, clock = () => new Date()) {
    this.store = store;
    this.config = config;
    this.clock = clock;
  }
  user(snapshot) {
    const session = snapshot.session;
    const person = snapshot.state?.people.find(p => p.id === session?.personId && !p.archived);
    const account = snapshot.accounts?.find(a => a.personId === person?.id);
    return person && account ? { person, account, session } : null;
  }
  response(snapshot, identity, extra = {}) {
    return { state: publicState(snapshot.state, snapshot.accounts), revision: snapshot.revision,
      ...(identity ? { user: publicUser(identity.person, identity.account) } : {}), ...extra };
  }
  compact(result) {
    // Keep immutable operation metadata, not an O(N²) history of entire ledgers.
    const { state, ...body } = result.body;
    return { ...result, body };
  }
  async external(result, sessionHash = null) {
    const cookie = result.cookie ? unseal(result.cookie, this.config.rateSecret) : undefined;
    if (result.body.user === null) return { body: result.body, cookie };
    const snapshot = await this.store.snapshot(cookie?.token ? sha256(cookie.token) : sessionHash);
    const identity = this.user(snapshot);
    if (!identity || identity.person.id !== result.body.user?.id) fail(401, 'unauthorized', 'Kirjaudu uudelleen.');
    return { body: { ...result.body, ...this.response(snapshot, identity),
      ...(Object.hasOwn(result.body, 'csrfToken') ? { csrfToken: identity.session.csrfToken } : {}) }, cookie };
  }
  async execute({ op, method, body = {}, sessionHash = null, csrfToken, idempotencyKey, ip = 'unknown' }) {
    if (!READS.has(op) && !WRITES.has(op)) fail(404, 'unknown_operation', 'Tuntematon toiminto.');
    if ((READS.has(op) && method !== 'GET') || (WRITES.has(op) && method !== 'POST')) fail(405, 'method_not_allowed', 'HTTP-metodi ei kelpaa.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_input', 'Pyynnön pitää olla JSON-objekti.');
    if (method === 'POST' && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))) fail(400, 'idempotency_required', 'Idempotency-Key (16–128 merkkiä) puuttuu.');
    const initialSnapshot = await initializedSnapshot(this.store, this.config.initialUserPassword, sessionHash);
    if (method === 'GET') {
      const snapshot = initialSnapshot;
      const identity = this.user(snapshot);
      if (op === 'session') return { body: { user: identity ? publicUser(identity.person, identity.account) : null,
        csrfToken: identity?.session.csrfToken ?? null, ready: snapshot.ready,
        ...(identity ? this.response(snapshot, identity) : {}) } };
      if (!snapshot.ready) throw unavailable();
      if (!identity) fail(401, 'unauthorized', 'Kirjaudu sisään.');
      if (op === 'backup') {
        parentOnly(identity.person);
        return { body: { backup: publicState(snapshot.state, snapshot.accounts), revision: snapshot.revision } };
      }
      return { body: this.response(snapshot, identity) };
    }
    const keyHash = sha256(idempotencyKey);
    const requestHash = keyedHash(this.config.rateSecret, canonical({ op, body }));
    if (op === 'login') return this.login(body, ip, keyHash, requestHash, initialSnapshot);
    let snapshot = initialSnapshot;
    if (!snapshot.ready) throw unavailable();
    let identity = this.user(snapshot);
    const scope = op === 'logout' ? `logout:${sessionHash}` : identity?.person.id;
    if (!identity && op === 'logout' && sessionHash) {
      const existing = await this.store.lookup(scope, keyHash, requestHash);
      if (existing && equal(existing.csrfHash, sha256(csrfToken ?? ''))) return this.external(existing);
    }
    if (!identity && op === 'password' && sessionHash) {
      const existing = await this.store.lookup(`password-retry:${sessionHash}`, keyHash, requestHash);
      if (existing && equal(existing.csrfHash, sha256(csrfToken ?? ''))) {
        const result = await this.external(existing);
        const current = await this.store.snapshot(sha256(result.cookie.token));
        if (this.user(current)?.person.id === existing.actorId) return result;
      }
    }
    if (!identity) fail(401, 'unauthorized', 'Kirjaudu sisään.');
    if (!equal(csrfToken, identity.session.csrfToken)) fail(403, 'csrf', 'Turvatunniste ei kelpaa.');
    await this.store.rate([{ key: keyedHash(this.config.rateSecret, `writes:${sessionHash}`), limit: 120, window: 60 }]);
    let resetRateChecked = false, resetCredential;
    const originalTarget = op === 'password-reset' ? snapshot.accounts.find(a => a.personId === body.id)?.credential : null;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) snapshot = await this.store.snapshot(sessionHash);
      identity = this.user(snapshot);
      if (!identity) fail(401, 'unauthorized', 'Kirjaudu uudelleen.');
      if (!equal(csrfToken, identity.session.csrfToken)) fail(403, 'csrf', 'Turvatunniste ei kelpaa.');
      if (PARENT.has(op)) parentOnly(identity.person);
      if (identity.account.credential.mustChange && !['password', 'logout'].includes(op)) fail(403, 'password_change_required', 'Vaihda ensin oma salasanasi.');
      const existing = await this.store.lookup(scope, keyHash, requestHash);
      if (existing) return this.external(existing, sessionHash);
      const state = structuredClone(snapshot.state);
      const accounts = structuredClone(snapshot.accounts);
      const changes = blankCommit();
      const now = this.clock().toISOString();
      let extra = {}, nextIdentity = identity, cookie;
      if (op === 'rule-create' || op === 'rule-edit' || op === 'rule-delete') {
        state.rules ??= [];
        if (op === 'rule-create') {
          if (state.rules.length >= RULE_LIMIT) fail(409, 'rules_full', 'Sääntöjen ja niiden historian enimmäisraja on 100.');
          const rule = { id: newId(), ...ruleFields(body), createdAt: now, createdBy: identity.person.id,
            updatedAt: now, updatedBy: identity.person.id };
          state.rules.push(rule);
          extra.ruleId = rule.id;
        } else {
          const rule = state.rules.find(r => r.id === body.id && !r.deletedAt);
          if (!rule) fail(404, 'rule_not_found', 'Aktiivista sääntöä ei löydy.');
          if (op === 'rule-delete') Object.assign(rule, { deletedAt: now, deletedBy: identity.person.id, updatedAt: now, updatedBy: identity.person.id });
          else {
            const fields = ruleFields(body);
            if ((rule.revisions?.length ?? 0) >= 100) fail(409, 'revision_limit', 'Säännön muutosraja on täynnä.');
            rule.revisions ??= [];
            rule.revisions.push({ at: now, by: identity.person.id, title: rule.title, content: rule.content });
            Object.assign(rule, fields, { updatedAt: now, updatedBy: identity.person.id });
          }
        }
      } else if (op === 'password-reset') {
        if (!resetRateChecked) {
          await this.store.rate([{ key: keyedHash(this.config.rateSecret, `password-reset:${identity.person.id}`), limit: 5, window: 900 }]);
          resetRateChecked = true;
        }
        // Reauthenticate before disclosing target validity, including after a CAS retry.
        if (!await verifyPassword(body.currentPassword, identity.account.credential)) throw authError();
        if (body.id === identity.person.id) fail(400, 'self_reset', 'Vaihda oma salasanasi Oma salasana -lomakkeella.');
        const target = activePerson(state, body.id);
        const index = accounts.findIndex(a => a.personId === target.id);
        if (index < 0) fail(400, 'account_missing', 'Henkilölle on ensin luotava verkkotunnus.');
        if (canonical(accounts[index].credential) !== canonical(originalTarget)) fail(409, 'password_reset_conflict', 'Salasana muuttui samanaikaisesti. Mitään ei nollattu; tarkista tilanne ja tee uusi pyyntö.');
        validatePassword(body.temporaryPassword);
        resetCredential ??= await hashTemporaryPassword(body.temporaryPassword);
        const account = { ...accounts[index], credential: resetCredential };
        accounts[index] = account;
        changes.p_accounts.push(account);
        changes.p_revoke_actor = target.id;
        extra.resetPersonId = target.id;
      } else if (op === 'points') {
        const target = child(state, body.childId);
        if (identity.person.role !== 'parent' && target.id !== identity.person.id) fail(403, 'forbidden', 'Lapsi voi kirjata vain omia pisteitään.');
        if (state.entries.length >= 20000) fail(409, 'ledger_full', 'Kirjausraja on täynnä.');
        const entry = { id: newId(), kind: 'points', childId: target.id, actorId: identity.person.id, createdAt: now, ...pointFields(body) };
        state.entries.push(entry);
        extra.entryId = entry.id;
      } else if (op === 'reward') {
        const target = child(state, body.childId);
        if (balance(state, target.id) < 10) fail(409, 'insufficient_balance', 'Palkintoon tarvitaan vähintään 10 pistettä.');
        if (state.entries.length >= 20000) fail(409, 'ledger_full', 'Kirjausraja on täynnä.');
        const entry = { id: newId(), kind: 'reward', childId: target.id, actorId: identity.person.id, createdAt: now, points: -10, amount: 5 };
        state.entries.push(entry);
        extra.entryId = entry.id;
      } else if (op === 'edit' || op === 'delete') {
        const entry = state.entries.find(e => e.id === body.id && !e.deletedAt);
        if (!entry) fail(404, 'entry_not_found', 'Kirjausta ei löydy.');
        if (op === 'delete') Object.assign(entry, { deletedAt: now, deletedBy: identity.person.id });
        else {
          if (entry.kind !== 'points') fail(400, 'invalid_entry', 'Palkintoa ei voi muokata.');
          const fields = pointFields(body);
          if ((entry.revisions?.length ?? 0) >= 100) fail(409, 'revision_limit', 'Kirjauksen muutosraja on täynnä.');
          entry.revisions ??= [];
          entry.revisions.push({ at: now, by: identity.person.id, points: entry.points, topic: entry.topic, reason: entry.reason });
          Object.assign(entry, fields);
        }
      } else if (op === 'person' || op === 'credentials') {
        const username = normalizeUsername(body.username);
        validateTemporaryPassword(body.password);
        if (accounts.some(a => a.username === username)) fail(409, 'username_taken', 'Käyttäjätunnus on jo käytössä.');
        let target;
        if (op === 'person') {
          if (!['parent', 'child'].includes(body.role)) fail(400, 'invalid_role', 'Rooli ei kelpaa.');
          if (state.people.length >= 200) fail(409, 'people_limit', 'Henkilöraja on täynnä.');
          target = { id: newId(), name: text(body.name, 80, 'Nimi'), role: body.role, archived: false };
          state.people.push(target);
        } else {
          target = activePerson(state, body.id);
          if (accounts.some(a => a.personId === target.id)) fail(409, 'account_exists', 'Olemassa olevaa tiliä ei nollata. Käyttäjä vaihtaa salasanansa itse.');
        }
        const account = { personId: target.id, username, credential: await hashTemporaryPassword(body.password) };
        accounts.push(account);
        changes.p_accounts.push(account);
        extra.personId = target.id;
      } else if (op === 'archive') {
        const target = state.people.find(p => p.id === body.id);
        if (!target) fail(404, 'person_not_found', 'Henkilöä ei löydy.');
        target.archived = !target.archived;
        if (target.archived) changes.p_revoke_actor = target.id;
        if (target.archived && target.id === identity.person.id) {
          nextIdentity = null;
          extra = { user: null, csrfToken: null };
          cookie = { clear: true };
        }
      } else if (op === 'password') {
        if (!await verifyPassword(body.currentPassword, identity.account.credential)) throw authError();
        const account = { ...identity.account, credential: await hashPassword(body.newPassword, false) };
        accounts[accounts.findIndex(a => a.personId === account.personId)] = account;
        changes.p_accounts.push(account);
        changes.p_revoke_actor = account.personId;
        const issued = this.issueSession(account.personId);
        changes.p_sessions.push(issued.session);
        nextIdentity = { person: identity.person, account, session: issued.session };
        extra.csrfToken = issued.session.csrfToken;
        cookie = issued.cookie;
      } else if (op === 'logout') {
        changes.p_remove_sessions.push(sessionHash);
        cookie = { clear: true };
      } else if (op === 'import-preview') {
        const imported = parseBackup(body.backup);
        const merged = mergeBackup(state, imported);
        const preview = { id: newId(), actorId: identity.person.id, sourceRevision: snapshot.revision,
          sourceHash: sha256(canonical(imported)), imported, expiresAt: new Date(this.clock().getTime() + 30 * 60 * 1000).toISOString() };
        changes.p_preview = preview;
        extra = { previewId: preview.id, summary: { ...merged.summary, sourceRevision: snapshot.revision },
          expiresAt: preview.expiresAt, canCommit: merged.summary.conflicts.length === 0 };
      } else if (op === 'import-commit') {
        if (typeof body.previewId !== 'string') fail(400, 'invalid_preview', 'Esikatselun tunniste puuttuu.');
        const preview = await this.store.preview(body.previewId, identity.person.id);
        if (!preview || preview.consumed || Date.parse(preview.expiresAt) <= this.clock().getTime()) fail(409, 'preview_expired', 'Esikatselu on vanhentunut tai käytetty.');
        if (preview.sourceHash !== sha256(canonical(preview.imported))) throw unavailable();
        const merged = mergeBackup(state, preview.imported);
        if (merged.summary.conflicts.length) fail(409, 'import_conflict', 'Tuonnissa on ristiriitaisia tunnisteita. Mitään ei muutettu; tee uusi esikatselu.');
        Object.assign(state, merged.state);
        extra.summary = { ...merged.summary, sourceRevision: preview.sourceRevision };
        changes.p_consume_preview = preview.id;
      }
      assertCapacity(state);
      if (!state.people.some(p => p.role === 'parent' && !p.archived && accounts.some(a => a.personId === p.id))) fail(409, 'last_parent', 'Viimeistä kirjautuvaa vanhempaa ei voi arkistoida.');
      const result = {
        body: op === 'logout' ? { user: null, csrfToken: null, ready: true } :
          this.response({ state, accounts, revision: snapshot.revision + 1 }, nextIdentity, extra),
        ...(cookie ? { cookie: seal(cookie, this.config.rateSecret) } : {}),
        ...(['logout', 'password'].includes(op) ? { csrfHash: sha256(csrfToken) } : {}),
        ...(op === 'password' ? { actorId: identity.person.id } : {})
      };
      const commit = await this.store.commit({
        p_expected_revision: snapshot.revision, p_state: state, p_actor_id: identity.person.id,
        p_session_hash: sessionHash, p_scope: scope, p_key_hash: keyHash, p_request_hash: requestHash,
        p_result: this.compact(result), ...changes
      });
      if (commit.committed) return this.external(commit.result, sessionHash);
    }
    fail(409, 'busy', 'Samanaikaisia muutoksia on paljon. Yritä uudelleen samalla avaimella.');
  }
  issueSession(personId) {
    const rawToken = token();
    const expiresAt = new Date(this.clock().getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    return { session: { tokenHash: sha256(rawToken), personId, csrfToken: token(), expiresAt },
      cookie: { token: rawToken, expiresAt } };
  }
  async login(body, ip, keyHash, requestHash, initialSnapshot) {
    let username;
    try { username = normalizeUsername(body.username); } catch { username = ''; }
    const scope = `login:${keyedHash(this.config.rateSecret, `${username}:${ip}`)}`;
    await this.store.rate([
      { key: keyedHash(this.config.rateSecret, `login-user:${username}`), limit: 8, window: 900 },
      { key: keyedHash(this.config.rateSecret, `login-ip:${ip}`), limit: 40, window: 900 }
    ]);
    for (let attempt = 0; attempt < 8; attempt++) {
      const snapshot = attempt ? await this.store.snapshot() : initialSnapshot;
      if (!snapshot.ready) throw unavailable();
      const existing = await this.store.lookup(scope, keyHash, requestHash);
      if (existing) {
        // A revoked/expired session must never be resurrected by replaying a login.
        const cookie = unseal(existing.cookie, this.config.rateSecret);
        const current = await this.store.snapshot(sha256(cookie.token));
        if (!this.user(current)) throw authError();
        return this.external(existing);
      }
      const account = snapshot.accounts.find(a => a.username === username);
      const person = snapshot.state.people.find(p => p.id === account?.personId && !p.archived);
      const dummy = { algorithm: 'scrypt', N: 32768, r: 8, p: 3, salt: '0'.repeat(64), hash: '0'.repeat(128) };
      const valid = await verifyPassword(body.password, account?.credential ?? dummy);
      if (!account || !person || !valid) throw authError();
      const issued = this.issueSession(person.id);
      const result = { body: this.response({ ...snapshot, revision: snapshot.revision + 1 },
        { person, account }, { csrfToken: issued.session.csrfToken, ready: true }), cookie: seal(issued.cookie, this.config.rateSecret) };
      const commit = await this.store.commit({
        ...blankCommit(), p_sessions: [issued.session], p_expected_revision: snapshot.revision,
        p_state: snapshot.state, p_actor_id: person.id, p_session_hash: null, p_scope: scope,
        p_key_hash: keyHash, p_request_hash: requestHash, p_result: this.compact(result)
      });
      if (commit.committed) return this.external(commit.result);
    }
    fail(409, 'busy', 'Yritä uudelleen samalla avaimella.');
  }
}
