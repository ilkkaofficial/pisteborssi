#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { loadConfig } from '../lib/config.js';
import { hashPassword, normalizeUsername } from '../lib/crypto.js';
import { FAMILY, initialState } from '../lib/ledger.js';
import { SupabaseStore } from '../lib/store.js';

async function hiddenPrompt(label) {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) throw new Error('Turvallinen salasanakehote vaatii paikallisen interaktiivisen päätteen.');
  stdout.write(label);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const finish = error => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      for (const ch of decoder.write(chunk)) {
        if (ch === '\u0003' || ch === '\u0004') { value = ''; finish(new Error('Alustus keskeytetty.')); return; }
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ' && value.length < 257) value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
export async function bootstrap({ env = process.env, store, ask, secretAsk = hiddenPrompt } = {}) {
  const config = loadConfig(env);
  const database = store ?? new SupabaseStore(config);
  const status = await database.snapshot();
  if (status.ready) throw new Error('Palvelu on jo alustettu. Alustus ei muuta olemassa olevia tilejä.');
  if (!ask && (!stdin.isTTY || !stdout.isTTY)) throw new Error('Käynnistä alustus paikallisessa interaktiivisessa päätteessä. Salasanoja ei lueta argumenteista tai tiedostoista.');
  const accounts = [];
  const usernames = new Set();
  for (const person of FAMILY) {
    let username;
    if (ask) username = await ask(`${person.name}: käyttäjätunnus [${person.id}]: `);
    else {
      const line = createInterface({ input: stdin, output: stdout });
      try { username = await line.question(`${person.name}: käyttäjätunnus [${person.id}]: `); }
      finally { line.close(); }
    }
    username = normalizeUsername(username || person.id);
    if (usernames.has(username)) throw new Error('Käyttäjätunnusten täytyy olla yksilöllisiä.');
    usernames.add(username);
    let password = await secretAsk(`${person.name}: oma aloitussalasana (12–256 merkkiä, piilotettu): `);
    let confirmation = await secretAsk('Kirjoita sama salasana uudelleen (piilotettu): ');
    if (password !== confirmation) { password = confirmation = ''; throw new Error('Salasanat eivät täsmää. Mitään ei alustettu.'); }
    const credential = await hashPassword(password, true);
    password = confirmation = '';
    accounts.push({ personId: person.id, username, credential });
  }
  await database.initialize(initialState(), accounts);
  return { ready: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await bootstrap();
    stdout.write('Alustus valmis: viisi yksilöllistä tiliä. Jokainen vaihtaa salasanansa ensikirjautumisen jälkeen.\n');
  } catch (error) {
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
