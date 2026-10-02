import { AppError, unavailable } from './errors.js';

const INITIALIZATION_ERRORS = new Map([
  ['PB_INVALID_STATE', ['initialization_invalid_state', 'Tietokanta hylkäsi ensialustuksen: alkutilan rakenne tai sisältö ei läpäissyt tarkistusta. Viite: PB_INVALID_STATE.']],
  ['PB_INVALID_ACCOUNT', ['initialization_invalid_account', 'Tietokanta hylkäsi ensialustuksen: tilitiedot eivät läpäisseet tarkistusta. Viite: PB_INVALID_ACCOUNT.']],
  ['PB_INVALID_INITIALIZATION', ['initialization_invalid_initialization', 'Tietokanta hylkäsi ensialustuksen: viiden vakiotilin alustus ei läpäissyt tarkistusta. Viite: PB_INVALID_INITIALIZATION.']]
]);
function initializationError(body, status) {
  // Exact known reasons only; never forward upstream message/details/hint or request data.
  const known = INITIALIZATION_ERRORS.get(body?.message);
  if (known) return new AppError(400, known[0], known[1]);
  const rawCode = body?.code;
  const code = typeof rawCode === 'string' &&
    ((rawCode.length === 5 && rawCode !== 'PGRST' && /^[0-9A-Z]{5}$/.test(rawCode)) ||
     (rawCode.length === 8 && /^PGRST[0-9]{3}$/.test(rawCode))) ? rawCode : null;
  const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
  // Preserve the unavailable status for other upstream errors; expose only bounded diagnostics.
  return new AppError(503, 'initialization_failed',
    'Palvelun ensialustus epäonnistui. Viite: PB_INIT_FAILED.' +
    (httpStatus === null ? '' : ` HTTP ${httpStatus}.`) + (code === null ? '' : ` Koodi: ${code}.`));
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const resultValid = value => object(value) && object(value.body) && (value.cookie === undefined || typeof value.cookie === 'string');
const credentialValid = c => object(c) && c.algorithm === 'scrypt' && c.N === 32768 && c.r === 8 && c.p === 3 &&
  /^[a-f0-9]{64}$/.test(c.salt) && /^[a-f0-9]{128}$/.test(c.hash) && typeof c.mustChange === 'boolean';
const PROFILE_KEYS = new Set(['id', 'name', 'role', 'archived']);
const ENTRY_KEYS = new Set(['id', 'kind', 'childId', 'actorId', 'createdAt', 'points', 'topic', 'reason', 'amount', 'revisions', 'deletedAt', 'deletedBy']);
const HISTORY_KEYS = new Set(['at', 'by', 'points', 'topic', 'reason']);
function snapshotValid(s) {
  if (!object(s) || typeof s.ready !== 'boolean' || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !Array.isArray(s.accounts) || s.accounts.some(a => !object(a) || typeof a.personId !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{2,39}$/.test(a.username) || !credentialValid(a.credential))) return false;
  if (s.session !== null && (!object(s.session) || typeof s.session.personId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(s.session.csrfToken) || !Number.isFinite(Date.parse(s.session.expiresAt)))) return false;
  if (!s.ready) return s.accounts.length === 0 && s.session === null;
  const state = s.state;
  return object(state) && state.app === 'pisteborssi' && state.version === 4 && Array.isArray(state.people) &&
    Array.isArray(state.entries) && state.people.length <= 200 && state.entries.length <= 20000 &&
    state.people.every(p => object(p) && typeof p.id === 'string' && typeof p.name === 'string' &&
      ['child', 'parent'].includes(p.role) && typeof p.archived === 'boolean' &&
      Object.keys(p).every(k => PROFILE_KEYS.has(k))) &&
    state.entries.every(e => object(e) && ['points', 'reward'].includes(e.kind) && typeof e.id === 'string' &&
      Number.isFinite(e.points) && Object.keys(e).every(k => ENTRY_KEYS.has(k)) &&
      (e.revisions === undefined || (Array.isArray(e.revisions) && e.revisions.every(r =>
        object(r) && Object.keys(r).every(k => HISTORY_KEYS.has(k))))));
}

export class SupabaseStore {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }
  async rpc(name, args = {}) {
    try {
      const response = await this.fetch(`${this.config.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: this.config.supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(12000),
        redirect: 'error'
      });
      const body = await response.json();
      if (!response.ok) {
        if (body?.message === 'PB_IDEMPOTENCY_CONFLICT') throw new AppError(409, 'idempotency_conflict', 'Sama avain on jo käytetty eri pyynnölle.');
        if (body?.message === 'PB_LAST_PARENT') throw new AppError(409, 'last_parent', 'Viimeistä kirjautuvaa vanhempaa ei voi arkistoida.');
        if (body?.message === 'PB_ALREADY_INITIALIZED') throw new AppError(409, 'already_initialized', 'Palvelu on jo alustettu. Mitään tilejä ei muutettu.');
        if (body?.message === 'PB_SESSION_INVALID') throw new AppError(401, 'unauthorized', 'Kirjaudu uudelleen.');
        if (body?.message === 'PB_USERNAME_TAKEN') throw new AppError(409, 'username_taken', 'Käyttäjätunnus on jo käytössä.');
        if (body?.message === 'PB_PREVIEW_INVALID') throw new AppError(409, 'preview_expired', 'Esikatselu on vanhentunut tai käytetty.');
        if (name === 'pb_initialize') throw initializationError(body, response.status);
        throw unavailable();
      }
      return body;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
  async snapshot(sessionHash = null) {
    const result = await this.rpc('pb_snapshot', { p_session_hash: sessionHash });
    if (!snapshotValid(result)) throw unavailable();
    return result;
  }
  async lookup(scope, keyHash, requestHash) {
    const result = await this.rpc('pb_idempotency', { p_scope: scope, p_key_hash: keyHash, p_request_hash: requestHash });
    if (result !== null && !resultValid(result)) throw unavailable();
    return result;
  }
  async commit(args) {
    const result = await this.rpc('pb_commit', args);
    if (!object(result) || typeof result.committed !== 'boolean' || (result.committed && !resultValid(result.result))) throw unavailable();
    return result;
  }
  async rate(buckets) {
    const result = await this.rpc('pb_rate', { p_buckets: buckets });
    if (!object(result) || typeof result.allowed !== 'boolean') throw unavailable();
    if (!result.allowed) throw new AppError(429, 'rate_limited', 'Liian monta kirjautumisyritystä tai muuta pyyntöä lyhyessä ajassa. Turvaraja on ylittynyt tilapäisesti. Odota 15 minuuttia ilman uusia yrityksiä ja yritä sitten uudelleen.');
    return result;
  }
  async preview(id, actorId) {
    const result = await this.rpc('pb_preview', { p_id: id, p_actor_id: actorId });
    if (result !== null && (!object(result) || result.actorId !== actorId || !object(result.imported) ||
        !Number.isSafeInteger(result.sourceRevision) || !/^[a-f0-9]{64}$/.test(result.sourceHash) ||
        !Number.isFinite(Date.parse(result.expiresAt)))) throw unavailable();
    return result;
  }
  async initialize(state, accounts) {
    const result = await this.rpc('pb_initialize', { p_state: state, p_accounts: accounts });
    if (!object(result) || result.ready !== true || result.revision !== 0) throw unavailable();
    return result;
  }
}
