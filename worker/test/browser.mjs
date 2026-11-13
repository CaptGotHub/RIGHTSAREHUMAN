// Browser smoke test: static .org page + Worker on one local origin, driven by Playwright.
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(join(process.execPath, '../../lib/node_modules/playwright'));

const here = dirname(fileURLToPath(import.meta.url)); const root = join(here, '..'); const site = join(root, '..');
const work = mkdtempSync(join(tmpdir(), 'cfh-'));
cpSync(join(root, 'src'), work, { recursive: true });
// Node cannot import .html; emulate wrangler's Text module rule.
const idx = join(work, 'index.js');
writeFileSync(join(work, 'legacy-onlyuno-page.mjs'), 'export default ' + JSON.stringify(readFileSync(join(work, 'legacy-onlyuno-page.html'), 'utf8')) + ';');
writeFileSync(idx, readFileSync(idx, 'utf8').replace("'./legacy-onlyuno-page.html'", "'./legacy-onlyuno-page.mjs'"));
const worker = (await import(pathToFileURL(join(work, 'index.js')).href)).default;
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(join(root, 'migrations/0001_initial.sql'), 'utf8')); sql.exec(readFileSync(join(root, 'migrations/0002_rfh_positions.sql'), 'utf8'));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); } async first() { return sql.prepare(this.q).get(...this.a) ?? null; } async all() { return { results: sql.prepare(this.q).all(...this.a) }; } async run() { const r = sql.prepare(this.q).run(...this.a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } }
const sent = [];
const env = { DB: { prepare: q => new S(q), batch: async s => Promise.all(s.map(x => x.all())) }, EMAIL: { send: async m => sent.push(m) }, FROM_EMAIL: 'proclamation@onlyuno.xyz', NOTIFY_TO: 'owner@example.test', ADMIN_KEY: 'k' };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (/^\/(api|verify|certificate|unsubscribe)/.test(u.pathname)) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const h = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (k !== 'host') h.set(k, v);
    if (h.get('origin')) h.set('origin', 'https://rightsforhumansnotrobots.org');
    h.set('cf-connecting-ip', '127.0.0.1');
    const waits = [];
    const r = await worker.fetch(new Request('https://rightsforhumansnotrobots.org' + req.url, { method: req.method, headers: h, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' }), env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const f = join(site, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto(base + '/');
await page.locator('label.choice:has(input[value="for"])').click();
await page.fill('#opinion_text', 'Human rights should stay human.');
await page.locator('label.check:has(#publish_opinion)').click();
await page.fill('#name', 'Grace Hopper'); await page.fill('#email', 'grace@example.test');
await page.locator('label.check:has(#agree)').click(); await page.locator('label.check:has(#human)').click();
await page.click('#signBtn');
await page.waitForSelector('#success.show', { timeout: 5000 });
console.log('success panel:', (await page.textContent('#success')).replace(/\s+/g, ' ').trim().slice(0, 220));
await page.screenshot({ path: '/tmp/shot-success.png' });
const link = sent[0].text.match(/https:\/\/rightsforhumansnotrobots\.org(\/verify\?t=[a-f0-9]{48})/)[1];
await page.goto(base + link);
console.log('certificate url:', page.url().replace(/c=[a-f0-9]+/, 'c=<redacted>'));
console.log('certificate:', (await page.textContent('main')).replace(/\s+/g, ' ').trim().slice(0, 300));
await page.screenshot({ path: '/tmp/shot-cert.png', fullPage: true });
await page.goto(base + '/');
await page.waitForTimeout(300);
console.log('tally visible:', await page.isVisible('#tally'), (await page.textContent('#tally')).trim());
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
