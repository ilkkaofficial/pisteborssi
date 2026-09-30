import { AppError, fail, unavailable } from '../lib/errors.js';
import { loadConfig } from '../lib/config.js';
import { sha256 } from '../lib/crypto.js';
import { SupabaseStore } from '../lib/store.js';
import { PisteborssiService } from '../lib/service.js';

const COOKIE = '__Host-pisteborssi';
const MAX_BODY = 2 * 1024 * 1024;
function header(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}
function cookieToken(req) {
  const matches = (header(req, 'cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
async function readBody(req) {
  if ((header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'content_type', 'Käytä application/json-sisältötyyppiä.');
  let raw = req.body;
  if (raw === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) fail(413, 'too_large', 'Pyyntö on liian suuri.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > MAX_BODY) fail(413, 'too_large', 'Pyyntö on liian suuri.');
    try { return JSON.parse(raw); } catch { fail(400, 'invalid_json', 'JSON ei kelpaa.'); }
  }
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > MAX_BODY) fail(413, 'too_large', 'Pyyntö on liian suuri.');
  return raw;
}
export function createHandler({ env = process.env, store, fetchImpl, clock } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Vary', 'Cookie, Origin');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const config = loadConfig(env);
      const url = new URL(req.url, config.origin);
      if (url.origin !== config.origin) fail(403, 'origin', 'Pyynnön alkuperä ei kelpaa.');
      const origin = header(req, 'origin');
      const fetchSite = header(req, 'sec-fetch-site');
      if (origin && origin !== config.origin) fail(403, 'origin', 'Pyynnön alkuperä ei kelpaa.');
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) fail(403, 'origin', 'Ristikkäinen pyyntö estettiin.');
      if (req.method === 'POST' && origin !== config.origin) fail(403, 'origin', 'Pyynnön alkuperä puuttuu.');
      if (!['GET', 'POST'].includes(req.method)) fail(405, 'method_not_allowed', 'HTTP-metodi ei kelpaa.');
      if (url.searchParams.getAll('op').length !== 1) fail(400, 'invalid_operation', 'Valitse yksi toiminto.');
      const rawToken = cookieToken(req);
      // Normal requests initialize only the five fixed FAMILY accounts in an empty DB.
      // INITIAL_USER_PASSWORD remains server-only; existing databases are never reset.
      const service = new PisteborssiService(store ?? new SupabaseStore(config, fetchImpl), config, clock);
      // Vercel's platform-controlled header, never arbitrary X-Forwarded-For.
      const ip = header(req, 'x-vercel-forwarded-for')?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      const result = await service.execute({
        op: url.searchParams.get('op'), method: req.method,
        body: req.method === 'POST' ? await readBody(req) : {},
        sessionHash: rawToken ? sha256(rawToken) : null,
        csrfToken: header(req, 'x-csrf-token'), idempotencyKey: header(req, 'idempotency-key'), ip
      });
      if (result.cookie) {
        const value = result.cookie.clear ? '' : result.cookie.token;
        const remaining = result.cookie.clear ? 0 : Math.max(0, Math.floor((Date.parse(result.cookie.expiresAt) - Date.now()) / 1000));
        res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${remaining}; Expires=${result.cookie.clear ? 'Thu, 01 Jan 1970 00:00:00 GMT' : new Date(result.cookie.expiresAt).toUTCString()}`);
      }
      res.statusCode = 200;
      res.end(JSON.stringify(result.body));
    } catch (error) {
      const safe = error instanceof AppError ? error : unavailable();
      if (safe.status === 429) res.setHeader('Retry-After', '900');
      res.statusCode = safe.status;
      res.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
    }
  };
}
export default createHandler();
