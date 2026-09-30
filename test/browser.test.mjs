// Browser + real Node handler + test-only Supabase RPC emulator; no HTTP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHandler } from '../api/pisteborssi.js';
import { loadConfig } from '../lib/config.js';
import { hashPassword } from '../lib/crypto.js';
import { FAMILY, initialState, balance } from '../lib/ledger.js';
import { SupabaseStore } from '../lib/store.js';
import { MockSupabase } from './mock-supabase.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try { ({ chromium } = require('/usr/local/lib/node_modules/docgen-utils/node_modules/playwright')); } catch {}
}
const configuredBrowser = '/opt/docgen-browsers/chromium-1208/chrome-linux64/chrome';
const browserAvailable = chromium && (existsSync(configuredBrowser) || existsSync(chromium.executablePath()));
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const env = { SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_only_not_a_real_credential',
  APP_ORIGIN: 'https://pisteborssi.example', RATE_LIMIT_SECRET: randomBytes(32).toString('hex') };
const passwords = Object.fromEntries(FAMILY.map(p => [p.id, randomBytes(24).toString('base64url')]));
const accounts = await Promise.all(FAMILY.map(async p => ({ personId: p.id, username: p.id,
  credential: await hashPassword(passwords[p.id], false) })));

test('mobile browser: shared visibility, polling, user creation by both parents, idempotent payout, import and failures',
  { skip: !browserAvailable, timeout: 120000 }, async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(existsSync(configuredBrowser) ? { executablePath: configuredBrowser } : {}) });
    const state = initialState();
    for (let i = 0; i < 5; i++) state.entries.push({ id: randomUUID(), kind: 'points', childId: 'elli',
      actorId: 'ilkka', createdAt: new Date().toISOString(), points: 2, topic: 'walk', reason: '' });
    const db = new MockSupabase(state, accounts);
    const handler = createHandler({ env, store: new SupabaseStore(loadConfig(env), db.fetch.bind(db)) });
    let lostRewardResponses = 0, apiUnavailable = false;
    const errors = [], requests = [], responseBodies = [];
    async function pageFor(viewport) {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      await context.route('https://pisteborssi.example/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        if (url.pathname !== '/api/pisteborssi') return route.fulfill({ status: 404, body: '' });
        const op = url.searchParams.get('op');
        const headers = await request.allHeaders(), body = request.postDataJSON() || {};
        requests.push({ op, body });
        if (apiUnavailable) return route.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'unavailable', message: 'Yhteinen tietokanta ei ole käytössä. Tarkista palvelinasetukset.' } }) });
        const output = { headers: {}, body: '' };
        const response = { statusCode: 0, setHeader(k,v) { output.headers[k] = v; },
          end(v) { output.status = this.statusCode; output.body = v; } };
        await handler({ method: request.method(), url: url.pathname + url.search, headers,
          body, socket: { remoteAddress: '192.0.2.20' } }, response);
        responseBodies.push(output.body);
        if (op === 'reward' && lostRewardResponses > 0 && output.status === 200) {
          lostRewardResponses--;
          return route.fulfill({ status: 503, contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'unavailable', message: 'Simuloitu kadonnut vastaus.' } }) });
        }
        await route.fulfill({ status: output.status, headers: output.headers, body: output.body });
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(env.APP_ORIGIN);
      await page.waitForFunction(() => !document.getElementById('loginSubmit').disabled);
      return { page, context };
    }
    async function login(page, id) {
      await page.locator('#loginUsername').fill(' '+id.toUpperCase()+' ');
      await page.locator('#loginPassword').fill(passwords[id]);
      await page.locator('#loginSubmit').tap();
      await page.locator('#appContent').waitFor({ state: 'visible' });
    }
    async function point(page, value=2, topic='walk') {
      await page.locator('#quickEntry').tap();
      await page.locator(`input[name="points"][value="${value}"]`).check();
      await page.locator(`input[name="topic"][value="${topic}"]`).check();
      await page.locator('#entrySubmit').tap();
      await page.waitForFunction(() => !document.getElementById('entrySubmit').disabled);
    }
    const score = async page => Number(await page.locator('[data-child-id="elli"] .score').textContent());
    const paid = async page => Number(await page.locator('[data-child-id="elli"] .earnings').getAttribute('data-paid-total'));
    try {
      const a = await pageFor({ width: 390, height: 844 }), b = await pageFor({ width: 320, height: 740 });
      await login(a.page, 'ilkka'); await login(b.page, 'elli');
      await b.page.locator('#tab-family').tap();
      assert(await b.page.getByRole('button',{name:'Lisää käyttäjä',exact:true}).isDisabled());
      await b.page.locator('#tab-scores').tap();
      const cookies = await a.context.cookies();
      assert(cookies.some(c=>c.name==='__Host-pisteborssi'&&c.httpOnly&&c.secure&&c.sameSite==='Lax'));
      assert.equal(await a.page.evaluate(()=>document.cookie.includes('__Host-pisteborssi')), false);
      assert.equal(await score(a.page), 10); assert.equal(await score(b.page), 10);
      await point(a.page);
      assert.equal(await score(a.page), 12);
      await b.page.bringToFront();
      await b.page.waitForFunction(()=>document.querySelector('[data-child-id="elli"] .score').textContent==='12', { timeout: 12000 });
      await point(b.page);
      assert.equal(await score(b.page), 14);
      assert(await b.page.locator('#entryChild').isDisabled());
      assert.equal(await b.page.locator('#entryChild').inputValue(), 'elli');
      assert.equal(await b.page.getByRole('button',{name:'Kuittaa maksettu 5 €: Elli Paju',exact:true}).count(),0);
      await a.page.reload(); await a.page.locator('#appContent').waitFor({state:'visible'});
      assert.equal(await score(a.page), 14);
      lostRewardResponses=2;
      await a.page.getByRole('button',{name:'Kuittaa maksettu 5 €: Elli Paju',exact:true}).tap();
      await a.page.locator('#confirmYes').tap();
      await a.page.locator('#retrySave').waitFor({state:'visible'});
      assert.equal(db.state.entries.filter(e=>e.kind==='reward').length,1);
      assert.equal(balance(db.state,'elli'),4);
      await a.page.locator('#retrySave').tap();
      await a.page.locator('#retrySave').waitFor({state:'hidden'});
      assert.equal(await score(a.page),4);assert.equal(await paid(a.page),5);
      assert.equal(db.state.entries.filter(e=>e.kind==='reward').length,1);
      await b.page.bringToFront();
      await b.page.waitForFunction(()=>document.querySelector('[data-child-id="elli"] .earnings').dataset.paidTotal==='5', {timeout:12000});
      for(const viewport of [{width:320,height:740},{width:390,height:844},{width:568,height:320},{width:844,height:390}]){
        await a.page.setViewportSize(viewport);
        for(const tab of ['scores','history','family']){
          await a.page.locator('#tab-'+tab).tap();
          assert(await a.page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
          await a.page.locator('#quickEntry').tap();
          assert(await a.page.locator('#entryForm').isVisible());
        }
      }
      await a.page.locator('#tab-family').tap();
      const details=a.page.locator('details').filter({has:a.page.locator('#importText')});
      if(!await a.page.locator('#importText').isVisible())await details.locator('summary').tap();
      const backup={app:'pisteborssi',version:3,
        people:FAMILY.map(p=>({...p,archived:false,username:p.id,credential:{untrusted:true}})),
        entries:[{id:'legacy-import',kind:'points',childId:'elli',actorId:'ilkka',createdAt:'2026-09-01T12:00:00.000Z',points:2,topic:'trash',reason:''}]};
      for(let i=0;i<2;i++){
        await a.page.locator('#importText').fill(JSON.stringify(backup));
        await a.page.locator('#importPaste').tap();
        await a.page.locator('#confirmDialog').waitFor({state:'visible'});
        await a.page.locator('#confirmYes').tap();
        await a.page.locator('#confirmDialog').waitFor({state:'hidden'});
        assert.equal(db.state.entries.filter(e=>e.id==='legacy-import').length,1);
      }
      assert(requests.filter(r=>r.op==='import-preview').every(r=>r.body.backup.people.every(p=>!Object.hasOwn(p,'credential')&&!Object.hasOwn(p,'username')&&!Object.hasOwn(p,'email'))));
      const c = await pageFor({ width: 320, height: 740 });
      await login(c.page, 'hanna');
      for (const [page, id] of [[a.page, 'ilkka'], [c.page, 'hanna']]) {
        await page.locator('#tab-family').tap();
        for (const role of ['child', 'parent']) {
          const username = `${id}.${role}`;
          const temporary = randomBytes(3).toString('hex').slice(0, 5);
          await page.locator('#personName').fill(`Test ${id} ${role}`);
          await page.locator('#personUsername').fill(username);
          await page.locator('#personPassword').fill(temporary);
          await page.locator('#personPassword').press('Enter');
          assert.equal(await page.evaluate(()=>document.activeElement.id),'personRole');
          await page.locator('#personRole').selectOption(role);
          // Keyboard submit exercises the same form path as tapping the button.
          await page.locator('#personRole').press('Enter');
          await page.waitForFunction(username=>document.querySelector('#peopleList').textContent.includes(username),username);
          assert(await page.locator('#personError').isHidden());
          assert.equal(db.accounts.filter(account=>account.username===username).length,1);
          assert.equal(db.state.people.find(person=>person.id===db.accounts.find(account=>account.username===username).personId).role,role);
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
        }
      }
      await c.context.close();
      const changed=randomBytes(24).toString('base64url');
      await a.page.locator('#accountOpen').tap();
      await a.page.locator('#currentPassword').fill(passwords.ilkka);
      await a.page.locator('#newPassword').fill(changed);
      await a.page.locator('#repeatPassword').fill(changed);
      await a.page.locator('#passwordSubmit').tap();
      await a.page.waitForFunction(()=>!document.getElementById('passwordSubmit').disabled);
      await a.page.reload();await a.page.locator('#appContent').waitFor({state:'visible'});
      apiUnavailable=true;
      await a.page.reload();
      await a.page.locator('#storageWarning').waitFor({state:'visible'});
      assert(await a.page.locator('#appContent').isHidden());
      assert(await a.page.locator('#loginSubmit').isDisabled());
      assert.match(await a.page.locator('#storageWarning').textContent(),/ei.*paikallisesti/);
      assert.equal(await a.page.evaluate(()=>localStorage.length),0);
      assert(!/bootstrapAccounts|crypto\.subtle|localStorage|PBKDF2/.test(html));
      assert(responseBodies.every(body=>!/"credential"|"salt"|"hash"|"SUPABASE_SECRET_KEY"/.test(body)));
      assert.equal(errors.length,0,errors.join(';'));
    } finally { await browser.close(); }
  });

test('mobile first opening initializes on server, requires twelve-character change, and resumes without setup secret',
  { skip: !browserAvailable, timeout: 60000 }, async () => {
    const temporary = randomBytes(3).toString('hex').slice(0, 4) + String.fromCharCode(0xf6);
    const initEnv = { ...env, INITIAL_USER_PASSWORD: temporary };
    const db = new MockSupabase();
    const store = new SupabaseStore(loadConfig(initEnv), db.fetch.bind(db));
    let handler = createHandler({ env: initEnv, store });
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(existsSync(configuredBrowser) ? { executablePath: configuredBrowser } : {}) });
    const errors = [];
    try {
      const context = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
      await context.route('https://pisteborssi.example/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        if (url.pathname !== '/api/pisteborssi') return route.fulfill({ status: 404, body: '' });
        const output = { headers: {} };
        const response = { statusCode: 0, setHeader(k,v) { output.headers[k] = v; },
          end(v) { output.status = this.statusCode; output.body = v; } };
        await handler({ method: request.method(), url: url.pathname + url.search, headers: await request.allHeaders(),
          body: request.postDataJSON() || {}, socket: { remoteAddress: '192.0.2.21' } }, response);
        await route.fulfill({ status: output.status, headers: output.headers, body: output.body });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(env.APP_ORIGIN);
      await page.waitForFunction(()=>!document.getElementById('loginSubmit').disabled);
      assert.equal(db.accounts.length,5);
      await page.locator('#loginUsername').fill(' HANNA ');
      await page.locator('#loginPassword').fill(temporary);
      await page.locator('#loginPassword').press('Enter');
      await page.locator('#initialPasswordNotice').waitFor({state:'visible'});
      assert(await page.locator('#personSubmit').isDisabled());
      assert.equal(await page.evaluate(()=>document.activeElement.id),'currentPassword');
      const short = randomBytes(6).toString('hex').slice(0,11);
      await page.locator('#currentPassword').fill(temporary);
      await page.locator('#newPassword').fill(short);
      await page.locator('#repeatPassword').fill(short);
      await page.locator('#passwordSubmit').tap();
      await page.locator('#passwordError').waitFor({state:'visible'});
      assert.match(await page.locator('#passwordError').textContent(),/12–256/);
      assert(await page.locator('#personSubmit').isDisabled());
      const next = randomBytes(6).toString('hex');
      await page.locator('#currentPassword').fill(temporary);
      await page.locator('#newPassword').fill(next);
      await page.locator('#repeatPassword').fill(next);
      await page.locator('#passwordSubmit').tap();
      await page.locator('#initialPasswordNotice').waitFor({state:'hidden'});
      await page.waitForFunction(()=>!document.getElementById('personSubmit').disabled);
      handler = createHandler({ env, store });
      await page.reload();
      await page.locator('#appContent').waitFor({state:'visible'});
      await page.locator('#tab-scores').focus();
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-family');
      assert(await page.locator('#personSubmit').isEnabled());
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
      assert.equal(db.calls.filter(call=>call.name==='pb_initialize').length,1);
      assert.equal(errors.length,0,errors.join(';'));
    } finally { await browser.close(); }
  });
