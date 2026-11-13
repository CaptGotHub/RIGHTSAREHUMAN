// Local end-to-end test: real Worker code, SQLite-backed D1 shim, captured email.
// Usage: node worker/test/run.mjs   (Node >= 22.5)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = mkdtempSync(join(tmpdir(), 'cfh-'));
cpSync(join(root, 'src'), work, { recursive: true });
// Node cannot import .html; emulate wrangler's Text module rule.
const idx = join(work, 'index.js');
writeFileSync(join(work, 'legacy-onlyuno-page.mjs'), 'export default ' + JSON.stringify(readFileSync(join(work, 'legacy-onlyuno-page.html'), 'utf8')) + ';');
writeFileSync(idx, readFileSync(idx, 'utf8').replace("'./legacy-onlyuno-page.html'", "'./legacy-onlyuno-page.mjs'"));
const worker = (await import(pathToFileURL(join(work, 'index.js')).href)).default;

const sql = new DatabaseSync(':memory:');
class Stmt {
  constructor(q, args = []) { this.q = q; this.args = args; }
  bind(...a) { return new Stmt(this.q, a); }
  async first() { return sql.prepare(this.q).get(...this.args) ?? null; }
  async all() { return { results: sql.prepare(this.q).all(...this.args) }; }
  async run() { const r = sql.prepare(this.q).run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}
const DB = { prepare: q => new Stmt(q), batch: async s => Promise.all(s.map(x => x.all())) };
const sent = [];
const EMAIL = { send: async m => { sent.push(m); } };
const env = { DB, EMAIL, ADMIN_KEY: 'test-admin', FROM_EMAIL: 'proclamation@onlyuno.xyz', NOTIFY_TO: 'owner@example.test' };

// Legacy schema + legacy rows, then migrate.
sql.exec(readFileSync(join(root, 'migrations/0001_initial.sql'), 'utf8'));
const legacyTok = 'a'.repeat(48);
sql.prepare("INSERT INTO signatures (name,email,stance,verified,verify_token,verified_at,email_sent_at) VALUES ('Legacy Verified','legacy1@example.test','fully-human',1,?,datetime('now','-2 days'),datetime('now','-2 days'))").run(legacyTok);
sql.prepare("INSERT INTO signatures (name,email,stance,verify_token) VALUES ('Legacy Pending','legacy2@example.test','people-first',?)").run('b'.repeat(48));
sql.exec(readFileSync(join(root, 'migrations/0002_backup.sql'), 'utf8'));
sql.exec(readFileSync(join(root, 'migrations/0002_rfh_positions.sql'), 'utf8'));
assert.equal(sql.prepare('SELECT COUNT(*) n FROM signatures').get().n, 2);
assert.equal(sql.prepare('SELECT COUNT(*) n FROM signatures_backup_0002').get().n, 2);
assert.equal(sql.prepare("SELECT source FROM signatures WHERE id=1").get().source, 'onlyuno');

const ORG = 'https://rightsforhumansnotrobots.org';
const ONLY = 'https://onlyuno.xyz/copyrightsforhumans';
let ipn = 0;
async function call(url, { method = 'GET', body, origin, ip, headers = {}, e = env } = {}) {
  const h = new Headers(headers);
  if (body !== undefined) h.set('content-type', 'application/json');
  if (origin !== undefined && origin !== null) h.set('origin', origin);
  h.set('cf-connecting-ip', ip || `10.0.0.${++ipn}`);
  const waits = [];
  const res = await worker.fetch(new Request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), e, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  return res;
}
const form = (o = {}) => ({ name: 'Ada Lovelace', email: 'ada@example.test', stance: 'for', agree: true, human: true, website: '', motivation: 'concern', profession: 'Mathematician', opinion_text: '', publish_opinion: false, updates_opt_in: false, ...o });
const tokenFrom = m => (m.text.match(/verify\?t=([a-f0-9]{48})/) || [])[1];
const certFrom = loc => (loc.match(/c=([a-f0-9]{48})/) || [])[1];
const row = email => sql.prepare('SELECT * FROM signatures WHERE email = ?').get(email);
let passed = 0; const t = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

await t('rejects missing / foreign Origin and wrong method', async () => {
  assert.equal((await call(ORG + '/api/sign', { method: 'POST', body: form() })).status, 403);
  assert.equal((await call(ORG + '/api/sign', { method: 'POST', body: form(), origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(ORG + '/api/sign', { method: 'POST', body: form(), origin: 'https://onlyuno.xyz' })).status, 403);
  assert.equal((await call(ORG + '/api/sign', { origin: ORG })).status, 405);
  assert.equal((await call(ORG + '/', {})).status, 404);
  assert.equal(row('ada@example.test'), undefined);
});

await t('schema validation (stance per site, opinion rules, required boxes)', async () => {
  const bad = async (b, o = ORG, base = ORG) => (await call(base + '/api/sign', { method: 'POST', body: b, origin: o })).status;
  assert.equal(await bad(form({ stance: 'fully-human' })), 400);
  assert.equal(await bad(form({ stance: 'for' }), 'https://onlyuno.xyz', ONLY), 400);
  assert.equal(await bad(form({ publish_opinion: true, opinion_text: '' })), 400);
  assert.equal(await bad(form({ opinion_text: 'x'.repeat(1001) })), 400);
  assert.equal(await bad(form({ agree: false })), 400);
  assert.equal(await bad(form({ human: false })), 400);
  assert.equal(await bad(form({ motivation: 'bogus' })), 400);
  assert.equal(await bad(form({ name: '<script>' })), 400);
  assert.equal(await bad(form({ email: 'x@mailinator.com' })), 400);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM signatures").get().n, 2);
});

await t('honeypot returns ok but records nothing', async () => {
  const r = await call(ORG + '/api/sign', { method: 'POST', body: form({ website: 'spam' }), origin: ORG });
  assert.equal(r.status, 200); assert.equal(row('ada@example.test'), undefined); assert.equal(sent.length, 0);
});

await t('no email binding fails closed (503, nothing recorded)', async () => {
  const r = await call(ORG + '/api/sign', { method: 'POST', body: form(), origin: ORG, e: { ...env, EMAIL: undefined } });
  assert.equal(r.status, 503); assert.equal(row('ada@example.test'), undefined);
});

let adaCert;
await t('For: submit → pending, not counted, email sent from proclamation@onlyuno.xyz with .org link', async () => {
  const r = await call(ORG + '/api/sign', { method: 'POST', body: form(), origin: ORG });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  const rw = row('ada@example.test');
  assert.equal(rw.verified, 0); assert.equal(rw.source, 'rfh'); assert.equal(rw.confirmation_only, 1); assert.equal(rw.profession, 'Mathematician');
  const m = sent.at(-1);
  assert.equal(m.to, 'ada@example.test'); assert.equal(m.from.email, 'proclamation@onlyuno.xyz'); assert.equal(m.bcc, undefined);
  assert.match(m.text, /https:\/\/rightsforhumansnotrobots\.org\/verify\?t=[a-f0-9]{48}/); assert.match(m.subject, /For/);
  const c = await (await call(ORG + '/api/count')).json();
  assert.deepEqual(c, { movement: 0, for: 0, against: 0, total_responses: 0 });
});

await t('verify → 303 to certificate, counted, owner notified, token burned', async () => {
  const tok = tokenFrom(sent.at(-1)); const before = sent.length;
  const r = await call(ORG + '/verify?t=' + tok);
  assert.equal(r.status, 303); adaCert = certFrom(r.headers.get('location'));
  assert.ok(adaCert); assert.ok(r.headers.get('location').startsWith('/certificate?c='));
  const rw = row('ada@example.test'); assert.equal(rw.verified, 1); assert.equal(rw.verify_token, null);
  assert.equal(sent.length, before + 1); assert.equal(sent.at(-1).to, 'owner@example.test');
  assert.equal((await (await call(ORG + '/api/count')).json()).movement, 1);
  assert.equal((await call(ORG + '/verify?t=' + tok)).status, 400, 'reused token must fail');
});

await t('certificate comes from server record, offers text/MD/HTML/print + invite link, never shows email', async () => {
  const r = await call(ORG + '/certificate?c=' + adaCert); const h = await r.text();
  assert.equal(r.status, 200);
  for (const s of ['Ada Lovelace', 'FOR — Supporter of the movement', 'Supporter No. 1', 'Copy text', 'Copy Markdown', 'Copy HTML', 'Print / Save as PDF', 'https://rightsforhumansnotrobots.org/', 'No AIN has been issued'])
    assert.ok(h.includes(s), 'missing ' + s);
  assert.ok(!h.includes('ada@example.test'));
  assert.ok(!h.includes('Mathematician'), 'profession must stay private');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call(ORG + '/certificate?c=' + 'f'.repeat(48))).status, 404);
});

await t('Against + publish: recorded, not in movement, comment public without email', async () => {
  const op = 'I disagree because </script><img src=x onerror=alert(1)> reasons';
  await call(ORG + '/api/sign', { method: 'POST', body: form({ name: 'Bob Contrarian', email: 'bob@example.test', stance: 'against', publish_opinion: true, opinion_text: op, updates_opt_in: true }), origin: ORG });
  const r = await call(ORG + '/verify?t=' + tokenFrom(sent.at(-1)));
  const cert = await (await call(ORG + r.headers.get('location'))).text();
  assert.ok(cert.includes('AGAINST — Recorded opinion, not a supporter')); assert.ok(!cert.includes('Supporter No.'));
  assert.ok(!cert.includes('<img src=x'));
  const c = await (await call(ORG + '/api/count')).json();
  assert.deepEqual(c, { movement: 1, for: 1, against: 1, total_responses: 2 });
  const cm = await (await call(ORG + '/api/comments')).json();
  assert.equal(cm.comments.length, 1); assert.equal(cm.comments[0].name, 'Bob Contrarian'); assert.equal(cm.comments[0].position, 'Against');
  assert.ok(!JSON.stringify(cm).includes('@'));
  assert.equal(row('bob@example.test').confirmation_only, 0);
});

await t('unpublished opinions stay private', async () => {
  await call(ORG + '/api/sign', { method: 'POST', body: form({ name: 'Cy Private', email: 'cy@example.test', opinion_text: 'secret reasons', publish_opinion: false }), origin: ORG });
  await call(ORG + '/verify?t=' + tokenFrom(sent.at(-1)));
  const cm = await (await call(ORG + '/api/comments')).json();
  assert.ok(!JSON.stringify(cm).includes('secret reasons'));
});

await t('expired token rejected and burned', async () => {
  await call(ORG + '/api/sign', { method: 'POST', body: form({ name: 'Dee Late', email: 'dee@example.test' }), origin: ORG });
  const tok = tokenFrom(sent.at(-1));
  sql.prepare("UPDATE signatures SET token_issued_at = datetime('now','-73 hours') WHERE email='dee@example.test'").run();
  assert.equal((await call(ORG + '/verify?t=' + tok)).status, 400);
  assert.equal(row('dee@example.test').verified, 0); assert.equal(row('dee@example.test').verify_token, null);
});

await t('resubmit while pending: throttled within 2 min, then fresh token replaces old', async () => {
  await call(ORG + '/api/sign', { method: 'POST', body: form({ name: 'Eve Again', email: 'eve@example.test', stance: 'for' }), origin: ORG });
  const t1 = tokenFrom(sent.at(-1)); const n = sent.length;
  await call(ORG + '/api/sign', { method: 'POST', body: form({ name: 'Eve Again', email: 'eve@example.test', stance: 'against' }), origin: ORG });
  assert.equal(sent.length, n, 'no resend inside 2 minutes'); assert.equal(row('eve@example.test').stance, 'for');
  sql.prepare("UPDATE signatures SET email_sent_at = datetime('now','-5 minutes') WHERE email='eve@example.test'").run();
  await call(ORG + '/api/sign', { method: 'POST', body: form({ name: 'Eve Again', email: 'EVE@example.test', stance: 'against' }), origin: ORG });
  const t2 = tokenFrom(sent.at(-1)); assert.notEqual(t1, t2); assert.equal(row('eve@example.test').stance, 'against');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM signatures WHERE email='eve@example.test'").get().n, 1, 'one email = one row');
  assert.equal((await call(ORG + '/verify?t=' + t1)).status, 400);
  assert.equal((await call(ORG + '/verify?t=' + t2)).status, 303);
});

await t('resubmit after verified: record unchanged, certificate link re-sent', async () => {
  sql.prepare("UPDATE signatures SET email_sent_at = datetime('now','-5 minutes') WHERE email='ada@example.test'").run();
  await call(ORG + '/api/sign', { method: 'POST', body: form({ stance: 'against', name: 'Ada Changed' }), origin: ORG });
  const rw = row('ada@example.test'); assert.equal(rw.stance, 'for'); assert.equal(rw.name, 'Ada Lovelace');
  const m = sent.at(-1); assert.equal(m.subject, 'Your certificate link'); assert.ok(m.text.includes('/certificate?c=' + adaCert));
});

await t('legacy onlyuno flow intact; legacy verified link works once then moves to certificate link', async () => {
  assert.equal((await call(ONLY + '/')).status, 200);
  const r = await call(ONLY + '/verify?t=' + legacyTok);
  assert.equal(r.status, 303); assert.ok(r.headers.get('location').startsWith('/copyrightsforhumans/certificate?c='));
  const h = await (await call('https://onlyuno.xyz' + r.headers.get('location'))).text();
  assert.ok(h.includes('Certificate of Humanity')); assert.ok(h.includes('Legacy Verified'));
  assert.equal((await call(ONLY + '/verify?t=' + legacyTok)).status, 400);
  const s = await call(ONLY + '/api/sign', { method: 'POST', body: { name: 'Old Form', email: 'old@example.test', stance: 'human-at-the-helm', agree: true, human: true }, origin: 'https://onlyuno.xyz' });
  assert.equal(s.status, 200); assert.match(sent.at(-1).text, /onlyuno\.xyz\/copyrightsforhumans\/verify\?t=/);
  await call(ONLY + '/verify?t=' + tokenFrom(sent.at(-1)));
  const lc = await (await call(ONLY + '/api/count')).json();
  assert.equal(lc.total, 2); assert.equal(lc.by_stance['for'], undefined, 'legacy count excludes .org positions');
});

await t('unsubscribe with certificate token', async () => {
  const bobCert = row('bob@example.test').cert_token;
  await call(ORG + '/unsubscribe?t=' + bobCert); assert.equal(row('bob@example.test').confirmation_only, 1);
});

await t('per-IP rate limit', async () => {
  const ip = '10.9.9.9'; let last;
  for (let i = 0; i < 6; i++) last = await call(ORG + '/api/sign', { method: 'POST', body: form({ email: `rl${i}@example.test` }), origin: ORG, ip });
  assert.equal(last.status, 429);
});

await t('admin requires key', async () => {
  assert.equal((await call(ORG + '/admin/stats')).status, 404);
  const s = await (await call(ORG + '/admin/stats', { headers: { authorization: 'Bearer test-admin' } })).json();
  assert.ok(s.rfh_for >= 2 && s.rfh_against >= 2);
});

console.log(`\n${passed} test groups passed`);
