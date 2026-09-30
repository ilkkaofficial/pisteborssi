import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './errors.js';

const scryptAsync = promisify(scrypt);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const keyedHash = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function normalizeUsername(value) {
  if (typeof value !== 'string') fail(400, 'invalid_username', 'Käyttäjätunnus on virheellinen.');
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(result)) fail(400, 'invalid_username', 'Käyttäjätunnus: 3–40 merkkiä (a–z, 0–9, piste, alaviiva tai viiva).');
  return result;
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 ||
      Buffer.byteLength(password) > 1024) fail(400, 'invalid_password', 'Salasanan pituus on 12–256 merkkiä.');
}
export function validateTemporaryPassword(password) {
  if (typeof password !== 'string' || password.length < 5 || password.length > 256 ||
      Buffer.byteLength(password) > 1024 || !password.trim()) fail(400, 'invalid_temporary_password', 'Tilapäisen aloitussalasanan pituus on 5–256 merkkiä.');
}
async function deriveCredential(password, mustChange) {
  const salt = randomBytes(32).toString('hex');
  const derived = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return { algorithm: 'scrypt', N: 32768, r: 8, p: 3, salt, hash: derived.toString('hex'), mustChange };
}
export async function hashPassword(password, mustChange = true) {
  validatePassword(password);
  return deriveCredential(password, mustChange);
}
export async function hashTemporaryPassword(password) {
  validateTemporaryPassword(password);
  // A short password is permitted ONLY while every write requires a password change.
  return deriveCredential(password, true);
}
export async function verifyPassword(password, credential) {
  if (typeof password !== 'string' || password.length > 256) return false;
  if (!credential || credential.algorithm !== 'scrypt' || credential.N !== 32768 ||
      credential.r !== 8 || credential.p !== 3 || !/^[a-f0-9]{64}$/.test(credential.salt) ||
      !/^[a-f0-9]{128}$/.test(credential.hash)) return false;
  const derived = await scryptAsync(password, credential.salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(derived, Buffer.from(credential.hash, 'hex'));
}
export function seal(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyedHash(secret, 'cookie-result'), 'hex'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(v => v.toString('base64url')).join('.');
}
export function unseal(value, secret) {
  const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyedHash(secret, 'cookie-result'), 'hex'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
