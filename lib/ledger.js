import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { canonical } from './crypto.js';

export const TOPICS = Object.freeze(['walk', 'trash', 'dishwasher', 'laundry', 'cooking', 'cycling_training', 'other']);
export const FAMILY = Object.freeze([
  { id: 'ilkka', name: 'Ilkka Paju', role: 'parent' },
  { id: 'hanna', name: 'Hanna Hoffren', role: 'parent' },
  { id: 'elli', name: 'Elli Paju', role: 'child' },
  { id: 'aava', name: 'Aava Paju', role: 'child' },
  { id: 'stella', name: 'Stella Paju', role: 'child' }
]);
export const initialState = () => ({ app: 'pisteborssi', version: 4, people: FAMILY.map(p => ({ ...p, archived: false })), entries: [], rules: [] });
const idValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const stamp = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, 'invalid_input', `${label} on virheellinen.`);
  return value.trim();
}
export const RULE_LIMIT = 100;
const RULE_KEYS = new Set(['id', 'title', 'content', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'revisions', 'deletedAt', 'deletedBy']);
const RULE_HISTORY_KEYS = new Set(['at', 'by', 'title', 'content']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ruleTextValid = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
export function ruleFields(data) {
  if (!ruleTextValid(data.title, 120) || !ruleTextValid(data.content, 4000)) {
    fail(400, 'invalid_rule', 'Säännön otsikko on 1–120 ja sisältö 1–4000 merkkiä; kumpikin on pakollinen.');
  }
  return { title: data.title, content: data.content };
}
export function cleanRules(raw, people) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > RULE_LIMIT) fail(400, 'invalid_rule', 'Sääntöluettelo ei kelpaa (enintään 100 sääntöä historioineen).');
  const ids = new Set();
  const parent = id => people.some(p => p.id === id && p.role === 'parent');
  return raw.map(rule => {
    if (!object(rule) || !idValid(rule.id) || ids.has(rule.id) || !stamp(rule.createdAt) || !stamp(rule.updatedAt) ||
        Date.parse(rule.updatedAt) < Date.parse(rule.createdAt) || !parent(rule.createdBy) || !parent(rule.updatedBy) ||
        Object.keys(rule).some(k => !RULE_KEYS.has(k))) fail(400, 'invalid_rule', 'Säännön tunniste, tekijä tai aika ei kelpaa.');
    ids.add(rule.id);
    const clean = { id: rule.id, ...ruleFields(rule), createdAt: rule.createdAt, createdBy: rule.createdBy,
      updatedAt: rule.updatedAt, updatedBy: rule.updatedBy };
    if (rule.revisions !== undefined) {
      if (!Array.isArray(rule.revisions) || rule.revisions.length > 100) fail(400, 'invalid_rule', 'Säännön muutoshistoria ei kelpaa.');
      clean.revisions = rule.revisions.map(r => {
        if (!object(r) || !stamp(r.at) || !parent(r.by) || Object.keys(r).some(k => !RULE_HISTORY_KEYS.has(k))) fail(400, 'invalid_rule', 'Säännön muutoshistoria ei kelpaa.');
        return { at: r.at, by: r.by, ...ruleFields(r) };
      });
    }
    if ((rule.deletedAt === undefined) !== (rule.deletedBy === undefined)) fail(400, 'invalid_rule', 'Säännön poistomerkintä ei kelpaa.');
    if (rule.deletedAt !== undefined) {
      if (!stamp(rule.deletedAt) || Date.parse(rule.deletedAt) < Date.parse(rule.createdAt) || !parent(rule.deletedBy)) fail(400, 'invalid_rule', 'Säännön poistomerkintä ei kelpaa.');
      Object.assign(clean, { deletedAt: rule.deletedAt, deletedBy: rule.deletedBy });
    }
    return clean;
  });
}
export function rulesValid(raw, people) {
  try { cleanRules(raw, people); return true; } catch { return false; }
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
  if (state.people.length > 200 || state.entries.length > 20000 || (state.rules?.length ?? 0) > RULE_LIMIT ||
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
    entries: structuredClone(state.entries),
    rules: cleanRules(state.rules, state.people)
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
  const result = { app: 'pisteborssi', version: 4, people, entries, rules: cleanRules(raw.rules, people) };
  assertCapacity(result);
  return result;
}
export function mergeBackup(state, imported) {
  const merged = structuredClone(state);
  merged.rules ??= [];
  const summary = { newPeople: 0, newEntries: 0, newRules: 0, duplicates: 0, conflicts: [] };
  for (const [kind, list, count] of [['person', 'people', 'newPeople'], ['entry', 'entries', 'newEntries'], ['rule', 'rules', 'newRules']]) {
    const current = new Map(merged[list].map(item => [item.id, item]));
    for (const item of imported[list] ?? []) {
      const existing = current.get(item.id);
      if (!existing) {
        merged[list].push(structuredClone(item));
        summary[count]++;
        current.set(item.id, item);
      } else if (canonical(existing) === canonical(item)) summary.duplicates++;
      else summary.conflicts.push({ kind, id: item.id });
    }
  }
  if (!summary.conflicts.length) cleanRules(merged.rules, merged.people);
  assertCapacity(merged);
  return { state: merged, summary };
}
export const newId = () => randomUUID();
