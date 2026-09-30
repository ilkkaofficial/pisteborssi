import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { canonical } from './crypto.js';

export const TOPICS = Object.freeze(['walk', 'trash', 'dishwasher', 'laundry', 'cooking', 'other']);
export const FAMILY = Object.freeze([
  { id: 'ilkka', name: 'Ilkka Paju', role: 'parent' },
  { id: 'hanna', name: 'Hanna Hoffren', role: 'parent' },
  { id: 'elli', name: 'Elli Paju', role: 'child' },
  { id: 'aava', name: 'Aava Paju', role: 'child' },
  { id: 'stella', name: 'Stella Paju', role: 'child' }
]);
export const initialState = () => ({ app: 'pisteborssi', version: 4, people: FAMILY.map(p => ({ ...p, archived: false })), entries: [] });
const idValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const stamp = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, 'invalid_input', `${label} on virheellinen.`);
  return value.trim();
}
export function pointFields(data) {
  if (![-2, -1, 1, 2].includes(data.points) || !TOPICS.includes(data.topic)) fail(400, 'invalid_points', 'Valitse ±1 tai ±2 ja tunnettu aihe.');
  const reason = data.reason === undefined ? '' : data.reason;
  if (typeof reason !== 'string' || reason.length > 300) fail(400, 'invalid_reason', 'Perustelun enimmäispituus on 300 merkkiä.');
  if (data.topic === 'other' && !reason.trim()) fail(400, 'invalid_reason', 'Aihe Muu tarvitsee perustelun.');
  if (data.topic !== 'other' && reason !== '') fail(400, 'invalid_reason', 'Vapaa perustelu kuuluu vain aiheeseen Muu.');
  if (data.points < 0 && (data.topic !== 'other' || !reason.trim())) fail(400, 'invalid_reason', 'Miinuspiste tarvitsee aiheen Muu ja perustelun.');
  return { points: data.points, topic: data.topic, reason: reason.trim() };
}
export function activePerson(state, id) {
  const person = state.people.find(p => p.id === id && !p.archived);
  if (!person) fail(403, 'inactive', 'Henkilö ei ole aktiivinen.');
  return person;
}
export function child(state, id) {
  const person = activePerson(state, id);
  if (person.role !== 'child') fail(400, 'invalid_child', 'Valitse aktiivinen lapsi.');
  return person;
}
export const balance = (state, id) => state.entries.reduce((sum, e) => sum + (e.childId === id && !e.deletedAt ? e.points : 0), 0);
export function assertCapacity(state) {
  if (state.people.length > 200 || state.entries.length > 20000 ||
      Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024) {
    fail(409, 'ledger_full', 'Tietomäärän enimmäisraja ylittyy. Säilytä varmuuskopio ja ota yhteys ylläpitäjään.');
  }
}
export function publicState(state, accounts) {
  return {
    app: 'pisteborssi', version: 4,
    people: state.people.map(p => {
      const account = accounts.find(a => a.personId === p.id);
      return { id: p.id, name: p.name, role: p.role, archived: p.archived, ...(account ? { username: account.username } : {}) };
    }),
    entries: structuredClone(state.entries)
  };
}
export function publicUser(person, account) {
  return { id: person.id, name: person.name, role: person.role, mustChange: !!account.credential.mustChange };
}
export function parseBackup(raw) {
  if (!raw || raw.app !== 'pisteborssi' || ![1, 2, 3, 4].includes(raw.version) ||
      !Array.isArray(raw.people) || !Array.isArray(raw.entries) || raw.people.length > 200 ||
      raw.entries.length > 20000) fail(400, 'invalid_backup', 'Varmuuskopion rakenne ei kelpaa.');
  const ids = new Set();
  const people = raw.people.map(p => {
    if (!p || !idValid(p.id) || ids.has(p.id) || !['parent', 'child'].includes(p.role) || typeof p.archived !== 'boolean') fail(400, 'invalid_backup', 'Henkilöluettelo ei kelpaa.');
    ids.add(p.id);
    return { id: p.id, name: text(p.name, 80, 'Nimi'), role: p.role, archived: p.archived };
  });
  const byId = new Map(people.map(p => [p.id, p]));
  const entryIds = new Set();
  const parent = id => byId.get(id)?.role === 'parent';
  const entries = raw.entries.map(e => {
    if (!e || !idValid(e.id) || entryIds.has(e.id) || !stamp(e.createdAt) ||
        byId.get(e.childId)?.role !== 'child' || !byId.has(e.actorId) ||
        (byId.get(e.actorId).role === 'child' && e.actorId !== e.childId)) fail(400, 'invalid_backup', 'Kirjaus ei kelpaa.');
    entryIds.add(e.id);
    const clean = { id: e.id, kind: e.kind, childId: e.childId, actorId: e.actorId, createdAt: e.createdAt, points: e.points };
    if (e.kind === 'points') {
      Object.assign(clean, pointFields(e));
      if (e.amount !== undefined) fail(400, 'invalid_backup', 'Pistekirjauksessa on rahasumma.');
      if (e.revisions !== undefined) {
        if (!Array.isArray(e.revisions) || e.revisions.length > 100) fail(400, 'invalid_backup', 'Muutoshistoria ei kelpaa.');
        clean.revisions = e.revisions.map(r => {
          if (!r || !stamp(r.at) || !parent(r.by)) fail(400, 'invalid_backup', 'Muutoshistorian tekijä tai aika ei kelpaa.');
          return { at: r.at, by: r.by, ...pointFields(r) };
        });
      }
    } else if (e.kind === 'reward' && parent(e.actorId) && e.points === -10 && e.amount === 5 &&
               e.topic === undefined && e.reason === undefined && e.revisions === undefined) clean.amount = 5;
    else fail(400, 'invalid_backup', 'Palkintokirjaus ei kelpaa.');
    if ((e.deletedAt === undefined) !== (e.deletedBy === undefined)) fail(400, 'invalid_backup', 'Poistomerkintä ei kelpaa.');
    if (e.deletedAt !== undefined) {
      if (!stamp(e.deletedAt) || !parent(e.deletedBy)) fail(400, 'invalid_backup', 'Poistomerkintä ei kelpaa.');
      clean.deletedAt = e.deletedAt;
      clean.deletedBy = e.deletedBy;
    }
    return clean;
  });
  return { app: 'pisteborssi', version: 4, people, entries };
}
export function mergeBackup(state, imported) {
  const merged = structuredClone(state);
  const summary = { newPeople: 0, newEntries: 0, duplicates: 0, conflicts: [] };
  for (const [kind, list] of [['person', 'people'], ['entry', 'entries']]) {
    const current = new Map(merged[list].map(item => [item.id, item]));
    for (const item of imported[list]) {
      const existing = current.get(item.id);
      if (!existing) {
        merged[list].push(structuredClone(item));
        summary[kind === 'person' ? 'newPeople' : 'newEntries']++;
      } else if (canonical(existing) === canonical(item)) summary.duplicates++;
      else summary.conflicts.push({ kind, id: item.id });
    }
  }
  assertCapacity(merged);
  return { state: merged, summary };
}
export const newId = () => randomUUID();
