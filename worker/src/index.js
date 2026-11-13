// copyrights-for-humans — the single authoritative signing service.
//
// Serves two front ends from ONE D1 database and ONE email sender:
//   1. Legacy OnlyUno page:  https://onlyuno.xyz/copyrightsforhumans/*
//      (stances: fully-human | human-at-the-helm | people-first)
//   2. Rights for Humans:    https://rightsforhumansnotrobots.org/{api,verify,certificate,unsubscribe}
//      (positions: for | against). Static pages are served by Cloudflare Pages;
//      only the dynamic paths above are routed to this Worker, so the form
//      submits same-origin and no secrets ever reach browser JavaScript.
//
// One email = one signature across both sites. Verification links are
// single-use and expire; certificates are rendered only from the verified
// server record. No AIN is issued here.
import PAGE_HTML from './legacy-onlyuno-page.html'; // Text module (wrangler default rule for *.html)

const BASE = '/copyrightsforhumans';
const SITE = 'https://onlyuno.xyz' + BASE;
const RFH_SITE = 'https://rightsforhumansnotrobots.org';
const RFH_HOME = RFH_SITE + '/';

const STANCES = {
  'fully-human': 'Fully Human',
  'human-at-the-helm': 'Human at the Helm',
  'people-first': 'People First, Open Mind',
};
const POSITIONS = { for: 'For', against: 'Against' };
const MOTIVATIONS = { concern: 'Concern for the future of creative work', involvement: 'Curiosity & involvement', profession: 'Personal experience' };

const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.net','sharklasers.com','10minutemail.com','tempmail.com',
  'temp-mail.org','yopmail.com','trashmail.com','getnada.com','dispostable.com','maildrop.cc','throwawaymail.com',
  'fakeinbox.com','mintemail.com','mohmal.com','emailondeck.com','tempr.email','discard.email','spamgourmet.com',
  'mailnesia.com','mytemp.email','burnermail.io','tempmailo.com','moakt.com','33mail.com','grr.la','spam4.me',
]);
const LIMIT_PER_IP_PER_HOUR = 5;
const LIMIT_GLOBAL_PER_MINUTE = 40;
const TOKEN_TTL_HOURS = 72;
const RESEND_MIN_MINUTES = 2;
const TOKEN_RE = /^[a-f0-9]{48}$/;

// ------------------------------------------------------------------ routing

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '');
    const RFH = /(^|\.)rightsforhumansnotrobots\.org$/.test(url.hostname);
    const L = RFH
      ? { rfh: true, base: '', site: RFH_SITE, home: RFH_HOME, origin: /^https:\/\/(www\.)?rightsforhumansnotrobots\.org$/ }
      : { rfh: false, base: BASE, site: SITE, home: BASE, origin: /^https:\/\/(www\.)?onlyuno\.xyz$/ };
    if (RFH) {
      path = path || '/';
      if (path === '/') return new Response('Not found', { status: 404 }); // landing page lives on Pages
    } else {
      if (!path.startsWith(BASE)) return new Response('Not found', { status: 404 });
      path = path.slice(BASE.length) || '/';
    }
    try {
      if (!RFH && path === '/' && request.method === 'GET') return page(env);
      if (path === '/api/count' && request.method === 'GET') return await count(env, L);
      if (path === '/api/comments' && request.method === 'GET') return await comments(env, L);
      if (path === '/api/sign') {
        if (request.method === 'POST') return await sign(request, env, ctx, L);
        return json({ ok: false, error: 'Method not allowed' }, 405, { allow: 'POST' });
      }
      if (path === '/verify' && request.method === 'GET') return await verify(url, env, L);
      if (path === '/certificate' && request.method === 'GET') return await certificatePage(url, env, L);
      if (path === '/unsubscribe' && request.method === 'GET') return await unsubscribe(url, env, L);
      if (path.startsWith('/admin/')) return await admin(path, url, request, env);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ ok: false, error: 'Something went wrong on our end. Nothing was recorded. Please try again shortly.' }, 500);
    }
  },
};

function page(env) {
  const html = PAGE_HTML.replace('__TURNSTILE_SITEKEY__', env.TURNSTILE_SITEKEY || '');
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' } });
}

// ------------------------------------------------------------- public reads

async function count(env, L) {
  if (L.rfh) {
    const { results } = await env.DB.prepare(
      "SELECT stance, COUNT(*) AS n FROM signatures WHERE verified = 1 AND stance IN ('for','against') GROUP BY stance").all();
    const out = { for: 0, against: 0 };
    for (const r of results) out[r.stance] = r.n;
    // Only For joins the movement.
    return json({ movement: out.for, for: out.for, against: out.against, total_responses: out.for + out.against }, 200, { 'cache-control': 'public, max-age=30' });
  }
  const { results } = await env.DB.prepare(
    "SELECT stance, COUNT(*) AS n FROM signatures WHERE verified = 1 AND stance IN ('fully-human','human-at-the-helm','people-first') GROUP BY stance").all();
  const by_stance = {}; let total = 0;
  for (const r of results) { by_stance[r.stance] = r.n; total += r.n; }
  return json({ total, by_stance }, 200, { 'cache-control': 'public, max-age=30' });
}

async function comments(env, L) {
  if (!L.rfh) return new Response('Not found', { status: 404 });
  // Email is never selected here.
  const { results } = await env.DB.prepare(
    `SELECT name, stance, opinion_text, verified_at FROM signatures
     WHERE verified = 1 AND publish_opinion = 1 AND stance IN ('for','against') AND opinion_text IS NOT NULL AND opinion_text <> ''
     ORDER BY verified_at DESC, id DESC LIMIT 100`).all();
  const items = results.map(r => ({ name: r.name, position: POSITIONS[r.stance], comment: r.opinion_text, verified_on: (r.verified_at || '').slice(0, 10) }));
  return json({ comments: items }, 200, { 'cache-control': 'public, max-age=60' });
}

// ------------------------------------------------------------------- sign

async function sign(request, env, ctx, L) {
  // Fail closed: a browser always sends Origin on a fetch POST.
  const origin = request.headers.get('origin');
  if (!origin || !L.origin.test(origin)) return json({ ok: false, error: 'Forbidden' }, 403);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return json({ ok: false, error: 'Bad request' }, 415);
  const raw = await request.text();
  if (raw.length > 6000) return json({ ok: false, error: 'Bad request' }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ ok: false, error: 'Bad request' }, 400);

  if (b.website) return json({ ok: true }); // honeypot

  const name = clean(b.name, 80);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  const location = clean(b.location, 80);
  const stance = String(b.stance || '');
  let rec;

  if (L.rfh) {
    if (!POSITIONS[stance]) return json({ ok: false, error: 'Please select For or Against.' }, 400);
    const motivation = b.motivation ? String(b.motivation) : '';
    if (motivation && !MOTIVATIONS[motivation]) return json({ ok: false, error: 'Bad request' }, 400);
    const profession = clean(b.profession, 120);
    const opinion = cleanMultiline(b.opinion_text, 1000);
    if (String(b.opinion_text || '').length > 1000) return json({ ok: false, error: 'Please keep your comments within 1,000 characters.' }, 400);
    const publish = b.publish_opinion === true;
    if (publish && !opinion) return json({ ok: false, error: 'Please write an explanation if you want your named opinion shared publicly.' }, 400);
    if (/https?:\/\/|www\.|<|>/i.test(profession)) return json({ ok: false, error: 'Please use plain text (no links).' }, 400);
    rec = { source: 'rfh', stance, motivation: motivation || null, profession: profession || null, opinion_text: opinion || null,
            publish_opinion: publish ? 1 : 0, confirmation_only: b.updates_opt_in === true ? 0 : 1 };
  } else {
    if (!STANCES[stance]) return json({ ok: false, error: 'Please choose where you stand on the spectrum.' }, 400);
    rec = { source: 'onlyuno', stance, motivation: null, profession: null, opinion_text: null, publish_opinion: 0,
            confirmation_only: b.confirmation_only === true ? 1 : 0 };
  }

  if (name.length < 2) return json({ ok: false, error: 'Please add your name.' }, 400);
  if (/https?:\/\/|www\.|<|>/i.test(name + ' ' + location)) return json({ ok: false, error: 'Please use plain text for your name and location (no links).' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  if (DISPOSABLE.has(email.split('@')[1])) return json({ ok: false, error: 'Disposable email addresses can\'t sign. Please use your real email.' }, 400);
  if (b.agree !== true || b.human !== true) return json({ ok: false, error: 'Please tick both required boxes.' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipHash = await sha256(ip + '|' + (env.ADMIN_KEY || ''));

  if (env.TURNSTILE_SECRET) {
    const fd = new FormData();
    fd.append('secret', env.TURNSTILE_SECRET);
    fd.append('response', String(b.ts_token || ''));
    fd.append('remoteip', ip);
    const tv = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd }).then(r => r.json()).catch(() => ({}));
    if (!tv.success) return json({ ok: false, error: 'The human check didn\'t pass. Please try again.' }, 400);
  }

  const rl = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM signatures WHERE ip_hash = ? AND created_at > datetime('now','-1 hour')").bind(ipHash),
    env.DB.prepare("SELECT COUNT(*) AS n FROM signatures WHERE created_at > datetime('now','-1 minute')"),
  ]);
  if (rl[0].results[0].n >= LIMIT_PER_IP_PER_HOUR) return json({ ok: false, error: 'Too many submissions from your connection. Please try again in an hour.' }, 429);
  if (rl[1].results[0].n >= LIMIT_GLOBAL_PER_MINUTE) return json({ ok: false, error: 'Lots of humans signing right now! Please try again in a minute.' }, 429);

  // Without email we cannot verify, so do not pretend anything was recorded.
  if (!env.EMAIL) return json({ ok: false, error: 'Confirmation email is temporarily unavailable. Nothing was recorded. Please try again later.' }, 503);

  const existing = await env.DB.prepare('SELECT * FROM signatures WHERE email = ?').bind(email).first();
  if (existing) {
    const recentlyEmailed = existing.email_sent_at && minutesSince(existing.email_sent_at) < RESEND_MIN_MINUTES;
    if (existing.verified) {
      // Already counted. Never change a verified record; re-send the certificate link instead.
      if (!recentlyEmailed) {
        const certToken = existing.cert_token || randomToken();
        if (!existing.cert_token) await env.DB.prepare('UPDATE signatures SET cert_token = ? WHERE id = ?').bind(certToken, existing.id).run();
        ctx.waitUntil(sendCertificateLink(env, { ...existing, cert_token: certToken }, L));
      }
      return json({ ok: true, status: 'already_verified' });
    }
    if (recentlyEmailed) return json({ ok: true, status: 'pending' });
    // Pending: take the latest submission and issue a fresh single-use token.
    const token = randomToken();
    await env.DB.prepare(
      `UPDATE signatures SET name = ?, location = ?, stance = ?, confirmation_only = ?, source = ?, motivation = ?, profession = ?,
         opinion_text = ?, publish_opinion = ?, verify_token = ?, token_issued_at = datetime('now') WHERE id = ? AND verified = 0`
    ).bind(name, location || null, rec.stance, rec.confirmation_only, rec.source, rec.motivation, rec.profession,
           rec.opinion_text, rec.publish_opinion, token, existing.id).run();
    ctx.waitUntil(sendVerify(env, { id: existing.id, name, email, token, stance: rec.stance }, L));
    return json({ ok: true, status: 'pending' });
  }

  const token = randomToken();
  const ins = await env.DB.prepare(
    `INSERT INTO signatures (name, email, location, stance, confirmation_only, verify_token, token_issued_at, ip_hash, country, user_agent,
       source, motivation, profession, opinion_text, publish_opinion)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(name, email, location || null, rec.stance, rec.confirmation_only, token, ipHash,
         request.cf && request.cf.country || null, (request.headers.get('user-agent') || '').slice(0, 200),
         rec.source, rec.motivation, rec.profession, rec.opinion_text, rec.publish_opinion).run();

  ctx.waitUntil(sendVerify(env, { id: ins.meta.last_row_id, name, email, token, stance: rec.stance }, L));
  return json({ ok: true, status: 'pending' });
}

// ------------------------------------------------------------------- email

function brand(L) {
  return L.rfh
    ? { name: 'Rights for Humans, Not Robots', title: 'Rights for Humans, Not Robots', eyebrow: 'RIGHTS FOR HUMANS, NOT ROBOTS · A PUBLIC PROCLAMATION', host: 'rightsforhumansnotrobots.org' }
    : { name: 'Copyrights for Humans', title: 'Copyrights for Humans', eyebrow: 'ONLYUNO · A PUBLIC PROCLAMATION', host: 'onlyuno.xyz/copyrightsforhumans' };
}
function positionLabel(stance) { return POSITIONS[stance] || STANCES[stance] || stance; }

async function sendVerify(env, { id, name, email, token, stance }, L) {
  const link = `${L.site}/verify?t=${token}`;
  const first = name.split(/\s+/)[0];
  const B = brand(L);
  const pos = positionLabel(stance);
  const lead = L.rfh
    ? `Please confirm your response to the Proclamation for the Protection of Human Personhood. You chose: ${pos}.${stance === 'for' ? ' Once confirmed, you join the movement.' : ' Once confirmed, your position is recorded; Against responses are not counted as supporters.'}`
    : 'Thanks for signing the Copyrights for Humans Proclamation. Click the link to confirm you\'re a real person. Your signature only counts once you do.';
  try {
    await env.EMAIL.send({
      to: email,
      from: { email: env.FROM_EMAIL || 'proclamation@onlyuno.xyz', name: B.name },
      subject: L.rfh ? `Confirm your response (${pos})` : 'One click to prove you\'re human',
      text: `Hi ${first},\n\n${lead}\n\nConfirm here (this link works once and expires in ${TOKEN_TTL_HOURS} hours):\n${link}\n\nIf you didn't do this, ignore this email and nothing will be recorded.\n\n— Nick Laudani\n${B.host}`,
      html: emailHtml(B, first, lead, link, L.rfh ? 'Confirm my response' : 'I am a human. Count my signature.'),
      ...(env.NOTIFY_TO ? { replyTo: env.NOTIFY_TO } : {}),
    });
    await env.DB.prepare("UPDATE signatures SET email_sent_at = datetime('now') WHERE id = ?").bind(id).run();
  } catch (e) {
    console.error('email send failed', e && e.message);
  }
}

async function sendCertificateLink(env, row, L) {
  const link = `${L.site}/certificate?c=${row.cert_token}`;
  const first = row.name.split(/\s+/)[0];
  const B = brand(L);
  const lead = 'Your response is already confirmed. Here is the private link to your certificate. Keep it to yourself; to invite others, share the public page instead.';
  try {
    await env.EMAIL.send({
      to: row.email,
      from: { email: env.FROM_EMAIL || 'proclamation@onlyuno.xyz', name: B.name },
      subject: 'Your certificate link',
      text: `Hi ${first},\n\n${lead}\n\n${link}\n\nInvite others: ${L.rfh ? RFH_HOME : SITE}\n\n— Nick Laudani`,
      html: emailHtml(B, first, lead, link, 'Open my certificate'),
      ...(env.NOTIFY_TO ? { replyTo: env.NOTIFY_TO } : {}),
    });
    await env.DB.prepare("UPDATE signatures SET email_sent_at = datetime('now') WHERE id = ?").bind(row.id).run();
  } catch (e) {
    console.error('certificate email failed', e && e.message);
  }
}

function emailHtml(B, first, lead, link, cta) {
  return `<!doctype html><html><body style="margin:0;background:#2a2118;padding:30px 12px;font-family:Georgia,serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#f4ead5;border-radius:4px;padding:40px 36px;color:#2b1d0e">
<tr><td style="text-align:center;font-size:12px;letter-spacing:3px;color:#5a4630">${esc(B.eyebrow)}</td></tr>
<tr><td style="text-align:center;font-size:30px;padding:8px 0 18px">${esc(B.title)}</td></tr>
<tr><td style="font-size:17px;line-height:1.6">Hi ${esc(first)},<br><br>${esc(lead)}</td></tr>
<tr><td align="center" style="padding:28px 0">
<a href="${link}" style="display:inline-block;background:#9b1c1c;color:#f9e7c8;text-decoration:none;font-size:18px;padding:14px 28px;border-radius:999px">${esc(cta)}</a>
</td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#5a4630">This link is personal. If you didn't request it, ignore this email and nothing will be recorded.</td></tr>
<tr><td style="padding-top:26px;font-size:15px;font-style:italic">Nick Laudani</td></tr>
</table></td></tr></table></body></html>`;
}

async function notifyOwner(env, row) {
  if (!env.EMAIL || !env.NOTIFY_TO) return;
  try {
    const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM signatures WHERE verified = 1').first();
    const label = positionLabel(row.stance);
    const lines = [
      'A new verified response.', '',
      'Site: ' + (row.source === 'rfh' ? 'rightsforhumansnotrobots.org' : 'onlyuno.xyz/copyrightsforhumans'),
      'Name: ' + row.name, 'Email: ' + row.email, 'Position: ' + label,
      'Location: ' + (row.location || '-'), 'Country: ' + (row.country || '-'),
      'Wants updates: ' + (row.confirmation_only ? 'No (confirmation only)' : 'Yes'),
    ];
    if (row.source === 'rfh') {
      lines.push('Motivation: ' + (MOTIVATIONS[row.motivation] || '-'), 'Profession (private): ' + (row.profession || '-'),
        'Publish opinion: ' + (row.publish_opinion ? 'Yes' : 'No'), 'Opinion: ' + (row.opinion_text || '-'));
    }
    lines.push('', 'Total verified (both sites): ' + t.n);
    await env.EMAIL.send({
      to: env.NOTIFY_TO,
      from: { email: env.FROM_EMAIL || 'proclamation@onlyuno.xyz', name: 'Proclamation signing' },
      replyTo: row.email,
      subject: 'New verified response: ' + row.name + ' (' + label + ')',
      text: lines.join('\n'),
    });
  } catch (e) { console.error('notify failed', e && e.message); }
}

// --------------------------------------------------- verify / certificate

async function verify(url, env, L) {
  const t = url.searchParams.get('t') || '';
  const bad = () => htmlPage(L, simpleMsg(L, 'Link not valid', 'This confirmation link has already been used, has expired, or isn\'t recognized. Submit the form again with the same email and we\'ll send a fresh link. If you already confirmed, we\'ll email you your certificate link.'), 400);
  if (!TOKEN_RE.test(t)) return bad();
  const row = await env.DB.prepare('SELECT * FROM signatures WHERE verify_token = ?').bind(t).first();
  if (!row) return bad();
  const issued = row.token_issued_at || row.email_sent_at || row.created_at;
  if (!row.verified && minutesSince(issued) > TOKEN_TTL_HOURS * 60) {
    await env.DB.prepare('UPDATE signatures SET verify_token = NULL WHERE id = ? AND verified = 0').bind(row.id).run();
    return bad();
  }
  const certToken = row.cert_token || randomToken();
  if (!row.verified) {
    // Single-use: the same statement verifies and burns the token, guarded against races.
    const r = await env.DB.prepare(
      "UPDATE signatures SET verified = 1, verified_at = datetime('now'), verify_token = NULL, cert_token = ? WHERE id = ? AND verified = 0 AND verify_token = ?"
    ).bind(certToken, row.id, t).run();
    if (!r.meta.changes) return bad();
    const fresh = await env.DB.prepare('SELECT * FROM signatures WHERE id = ?').bind(row.id).first();
    await notifyOwner(env, fresh);
  } else {
    // Legacy: rows verified before single-use tokens existed. Burn the old token once and move to a certificate link.
    await env.DB.prepare('UPDATE signatures SET verify_token = NULL, cert_token = COALESCE(cert_token, ?) WHERE id = ?').bind(certToken, row.id).run();
  }
  const final = await env.DB.prepare('SELECT cert_token FROM signatures WHERE id = ?').bind(row.id).first();
  return new Response(null, { status: 303, headers: { location: `${L.base}/certificate?c=${final.cert_token}&new=1`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

async function certificatePage(url, env, L) {
  const c = url.searchParams.get('c') || '';
  if (!TOKEN_RE.test(c)) return htmlPage(L, simpleMsg(L, 'Certificate not found', 'This certificate link isn\'t recognized.'), 404);
  const row = await env.DB.prepare('SELECT * FROM signatures WHERE cert_token = ? AND verified = 1').bind(c).first();
  if (!row) return htmlPage(L, simpleMsg(L, 'Certificate not found', 'This certificate link isn\'t recognized.'), 404);
  const isNew = url.searchParams.get('new') === '1';
  if (row.source === 'rfh' || POSITIONS[row.stance]) {
    // Serve on the .org even if reached via onlyuno, so links stay consistent.
    return htmlPage({ ...L, rfh: true }, rfhCertificate(row, await supporterNumber(env, row), c, isNew, L));
  }
  const num = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM signatures WHERE verified = 1 AND stance IN ('fully-human','human-at-the-helm','people-first') AND (verified_at < ? OR (verified_at = ? AND id <= ?))"
  ).bind(row.verified_at, row.verified_at, row.id).first();
  return htmlPage(L, legacyCertificate(row, num.n, c, L));
}

async function supporterNumber(env, row) {
  if (row.stance !== 'for') return null;
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM signatures WHERE verified = 1 AND stance = 'for' AND (verified_at < ? OR (verified_at = ? AND id <= ?))"
  ).bind(row.verified_at, row.verified_at, row.id).first();
  return r.n;
}

async function unsubscribe(url, env, L) {
  const t = url.searchParams.get('t') || '';
  if (TOKEN_RE.test(t)) await env.DB.prepare('UPDATE signatures SET confirmation_only = 1 WHERE cert_token = ? OR verify_token = ?').bind(t, t).run();
  return htmlPage(L, simpleMsg(L, 'You\'re off the list', 'Your response still counts. We just won\'t send you any more update emails.'));
}

function fmtDate(ts) {
  return new Date(ts.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function rfhCertificate(row, supporterNo, token, isNew, L) {
  const isFor = row.stance === 'for';
  const date = fmtDate(row.verified_at);
  const iso = row.verified_at.replace(' ', 'T') + 'Z';
  const posLine = isFor ? 'FOR — Supporter of the movement' : 'AGAINST — Recorded opinion, not a supporter';
  const numLine = supporterNo ? `Supporter No. ${supporterNo.toLocaleString('en-US')}` : '';
  const title = 'Proclamation Participation Certificate';
  const procl = 'Copyright Is for Humans, Not the Robots. A Proclamation for the Protection of Human Personhood';

  const text = [
    title.toUpperCase(), procl, '',
    `Name: ${row.name}`, `Position: ${isFor ? 'For' : 'Against'}`, ...(numLine ? [numLine] : []),
    `Confirmed by email: ${date} (${iso})`, '',
    `Respond to the Proclamation: ${RFH_HOME}`,
  ].join('\n');
  const md = [
    `## ${title}`, `*${procl}*`, '',
    `**Name:** ${mdEsc(row.name)}  `, `**Position:** ${isFor ? 'For' : 'Against'}  `, ...(numLine ? [`**${numLine}**  `] : []),
    `**Confirmed by email:** ${date}`, '',
    `Respond to the Proclamation: ${RFH_HOME}`,
  ].join('\n');
  const htmlSnippet = `<article style="font-family:Georgia,serif;border:4px double #b99b6f;background:#f4ead5;color:#2b1d0e;padding:24px;max-width:560px;text-align:center">`
    + `<p style="letter-spacing:.15em;font-size:12px">RIGHTS FOR HUMANS, NOT ROBOTS</p><h2 style="font-weight:normal">${title}</h2>`
    + `<p style="font-size:26px;font-style:italic">${esc(row.name)}</p><p><strong>${esc(posLine)}</strong>${numLine ? '<br>' + esc(numLine) : ''}</p>`
    + `<p>Confirmed by email ${esc(date)}</p><p><a href="${RFH_HOME}">${RFH_HOME}</a></p></article>`;
  const data = JSON.stringify({ text, md, html: htmlSnippet, invite: RFH_HOME }).replace(/</g, '\\u003c');

  return `
${isNew ? '<p class="banner">✓ Confirmed. Your response is recorded.</p>' : ''}
<p class="eyebrow">Rights for Humans, Not Robots</p>
<h1>${title}</h1>
<p class="sub">${esc(procl)}</p>
<div class="rule">❦</div>
<p class="body">This certifies that</p>
<p class="who">${esc(row.name)}</p>
<p class="body">confirmed by email a response to the Proclamation, recorded as</p>
<p class="stance">${esc(posLine)}</p>
${numLine ? `<div class="seal"><span>For</span><b>No. ${supporterNo.toLocaleString('en-US')}</b></div>` : ''}
<div class="foot"><div><div class="line">${esc(date)}</div><small>Date of email confirmation</small></div>
<div><div class="line sig">Nick Laudani</div><small>Author of the Proclamation</small></div></div>
<p class="fine">Issued from the verified server record. No AIN has been issued for this certificate.</p>
<div class="actions">
  <button type="button" data-copy="text">Copy text</button>
  <button type="button" data-copy="md">Copy Markdown</button>
  <button type="button" data-copy="html">Copy HTML</button>
  <button type="button" id="dl">Download HTML</button>
  <button type="button" onclick="window.print()">Print / Save as PDF</button>
</div>
<p id="fb" class="fine" role="status" aria-live="polite"></p>
<div class="invite">
  <h2>Invite others</h2>
  <p class="body">Share the public page, including with people who may disagree. Keep this certificate link private.</p>
  <p><a href="${RFH_HOME}">${RFH_HOME}</a></p>
  <div class="actions"><button type="button" id="copyInvite">Copy invitation link</button><button type="button" id="share">Share</button></div>
</div>
${row.confirmation_only ? '' : `<p class="fine"><a href="${L.base}/unsubscribe?t=${token}">Stop update emails</a></p>`}
<script type="application/json" id="cert-data">${data}</script>
<script>
(()=>{const D=JSON.parse(document.getElementById('cert-data').textContent),fb=document.getElementById('fb');
async function copy(s,m){try{await navigator.clipboard.writeText(s);fb.textContent=m||'Copied.';}catch{fb.textContent='Copy unavailable here. Select and copy manually.';}}
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>copy(D[b.dataset.copy])));
document.getElementById('dl').addEventListener('click',()=>{const doc='<!doctype html><meta charset="utf-8"><title>Proclamation Participation Certificate</title>'+D.html;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([doc],{type:'text/html'}));a.download='proclamation-certificate.html';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
document.getElementById('copyInvite').addEventListener('click',()=>copy(D.invite,'Invitation link copied.'));
document.getElementById('share').addEventListener('click',async()=>{const d={title:'Rights for Humans, Not Robots',text:'Are you for or against? Add your voice to the Proclamation.',url:D.invite};if(navigator.share){try{await navigator.share(d);}catch{}}else{window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(d.text)+'&url='+encodeURIComponent(d.url),'_blank','noopener');}});
if(location.search.includes('new=1'))history.replaceState(null,'',location.pathname+location.search.replace(/&new=1/,''));
})();
</script>`;
}

function legacyCertificate(row, n, token, L) {
  const date = fmtDate(row.verified_at);
  const SITE_ = L.rfh ? SITE : L.site;
  return `
<p class="eyebrow">OnlyUno · Copyrights for Humans</p>
<h1>Certificate of Humanity</h1>
<p class="sub">Be it known to all persons, and to any robots who may be reading</p>
<div class="rule">❦</div>
<p class="body">that</p>
<p class="who">${esc(row.name)}</p>
<p class="body">did, of their own free and entirely human will, add their name to the <em>Proclamation of Copyrights for Humans</em>, standing at the position of</p>
<p class="stance">${esc(STANCES[row.stance] || row.stance)}</p>
<p class="body">and is hereby recognized as</p>
<div class="seal"><span>Human</span><b>No. ${n.toLocaleString('en-US')}</b></div>
<div class="foot"><div><div class="line">${date}</div><small>Date of confirmation</small></div>
<div><div class="line sig">Nick Laudani</div><small>Author of the Proclamation</small></div></div>
<p class="fine">Proclamation first signed November 8, 2026. Verified by the ancient method of clicking a link in an email. Witnessed by an AI, who remains unable to sign.</p>
<div class="actions">
  <button onclick="window.print()">Print certificate</button>
  <button onclick="navigator.share?navigator.share({title:'Copyrights for Humans',text:'I\\'m Human No. ${n}. I signed the Proclamation: copyrights belong to people, not the robots.',url:'${SITE_}'}):window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent('I\\'m Human No. ${n}. I signed the Proclamation: copyrights belong to people, not the robots.')+'&url='+encodeURIComponent('${SITE_}'))">Share</button>
  <a href="${L.rfh ? SITE : L.home}">Back to the Proclamation</a>
</div>
${row.confirmation_only ? '' : `<p class="fine"><a href="${L.base}/unsubscribe?t=${token}">Don't want any more emails? Click here.</a></p>`}`;
}

function simpleMsg(L, title, body) {
  const eyebrow = L.rfh ? 'Rights for Humans, Not Robots' : 'OnlyUno · Copyrights for Humans';
  return `<p class="eyebrow">${eyebrow}</p><h1>${esc(title)}</h1><div class="rule">❦</div><p class="body">${esc(body)}</p><div class="actions"><a href="${L.home}">Back to the Proclamation</a></div>`;
}

function htmlPage(L, inner, status = 200) {
  const title = L.rfh ? 'Proclamation Certificate · Rights for Humans, Not Robots' : 'Certificate of Humanity · OnlyUno';
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;background:#1c160f;background-image:radial-gradient(ellipse at top,#3b2e20,#1c160f 70%);font-family:"IM Fell English",Georgia,serif;color:#2b1d0e;padding:40px 16px;min-height:100vh}
.card{max-width:720px;margin:0 auto;background:#f4ead5;background-image:radial-gradient(ellipse at 20% 10%,rgba(255,255,255,.45),transparent 55%);padding:60px 56px;position:relative;text-align:center;border-radius:4px;box-shadow:0 30px 80px rgba(0,0,0,.55),inset 0 0 90px rgba(120,80,30,.25)}
.card:before{content:"";position:absolute;inset:14px;border:1px solid #cdb88f;outline:3px double #cdb88f;outline-offset:4px;pointer-events:none}
.banner{font-family:Inter,sans-serif;font-size:14px;background:#e6f2e2;border:1px solid #6b8f5e;color:#2f4a26;border-radius:6px;padding:8px 12px;display:inline-block;margin:0 0 16px}
.eyebrow{font-family:"IM Fell English SC",serif;letter-spacing:.25em;font-size:13px;color:#5a4630;margin:0 0 8px}
h1{font-family:"IM Fell English SC",serif;font-weight:400;font-size:clamp(30px,6vw,46px);margin:0 0 6px;line-height:1.05}
h2{font-family:"IM Fell English SC",serif;font-weight:400;font-size:26px;margin:0 0 6px}
.sub{font-style:italic;color:#5a4630;margin:0}.rule{color:#b8892f;margin:22px 0}
.body{font-size:19px;margin:6px 0}.who{font-style:italic;font-size:clamp(34px,7vw,52px);margin:6px 0 10px;border-bottom:1px solid #2b1d0e;display:inline-block;padding:0 20px}
.stance{font-family:"IM Fell English SC",serif;font-size:24px;color:#9b1c1c;margin:4px 0 10px}
.seal{width:150px;height:150px;border-radius:50%;margin:18px auto;display:grid;place-content:center;background:radial-gradient(circle at 35% 30%,#c23030,#9b1c1c 55%,#6e1212);color:#f9e7c8;box-shadow:0 6px 0 #6e1212,0 12px 24px rgba(0,0,0,.3);transform:rotate(-6deg)}
.seal span{font-family:"IM Fell English SC",serif;font-size:24px}.seal b{font-weight:400;font-size:20px}
.foot{display:flex;justify-content:space-around;gap:20px;flex-wrap:wrap;margin-top:26px}.foot .line{border-bottom:1px solid #2b1d0e;min-width:200px;padding:0 8px 2px;font-size:19px}.foot .sig{font-style:italic;font-size:26px}
.foot small{font-family:Inter,sans-serif;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#5a4630}
.fine{font-size:14px;font-style:italic;color:#5a4630;margin-top:24px}.fine a{color:#5a4630}
.invite{margin-top:30px;padding-top:22px;border-top:1px dashed #cdb88f}.invite a{color:#9b1c1c}
.actions{margin-top:24px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.actions button,.actions a{font-family:Inter,sans-serif;font-size:13px;padding:9px 16px;border-radius:999px;border:1px solid #5a4630;background:transparent;color:#2b1d0e;cursor:pointer;text-decoration:none}
.actions button:hover,.actions a:hover{background:#2b1d0e;color:#f4ead5}
@media print{body{background:#fff;padding:0}.card{box-shadow:none}.actions,.fine a,.invite .actions,.banner,#fb{display:none}}
@media(max-width:600px){.card{padding:44px 24px}}
</style></head><body><main class="card">${inner}</main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
}

// ------------------------------------------------------------------- admin

async function admin(path, url, request, env) {
  const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || !(await safeEqual(key, env.ADMIN_KEY))) return new Response('Not found', { status: 404 });
  if (path === '/admin/signatures.csv') {
    const only = url.searchParams.get('verified');
    const where = only === '1' ? 'WHERE verified = 1' : '';
    const cols = ['id','source','name','email','location','stance','motivation','profession','publish_opinion','opinion_text','confirmation_only','verified','country','created_at','verified_at'];
    const { results } = await env.DB.prepare(`SELECT ${cols.join(',')} FROM signatures ${where} ORDER BY id`).all();
    const csv = [cols.join(',')].concat(results.map(r => cols.map(c => csvCell(r[c])).join(','))).join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="proclamation-signatures.csv"', 'cache-control': 'no-store' } });
  }
  if (path === '/admin/stats') {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS total, SUM(verified) AS verified, SUM(CASE WHEN verified=0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN verified=1 AND stance='for' THEN 1 ELSE 0 END) AS rfh_for, SUM(CASE WHEN verified=1 AND stance='against' THEN 1 ELSE 0 END) AS rfh_against,
      SUM(CASE WHEN verified=1 AND confirmation_only=0 THEN 1 ELSE 0 END) AS mailing_list, SUM(CASE WHEN email_sent_at IS NULL THEN 1 ELSE 0 END) AS never_emailed FROM signatures`).first();
    return json({ ...r, email_sending_enabled: !!env.EMAIL, turnstile_enabled: !!env.TURNSTILE_SECRET });
  }
  if (path === '/admin/send-pending' && request.method === 'POST') {
    if (!env.EMAIL) return json({ ok: false, error: 'Email sending is not connected.' }, 400);
    const { results } = await env.DB.prepare('SELECT id,name,email,stance,source FROM signatures WHERE verified = 0 AND email_sent_at IS NULL ORDER BY id LIMIT 50').all();
    for (const r of results) {
      const token = randomToken();
      await env.DB.prepare("UPDATE signatures SET verify_token = ?, token_issued_at = datetime('now') WHERE id = ?").bind(token, r.id).run();
      const L = r.source === 'rfh' ? { rfh: true, base: '', site: RFH_SITE } : { rfh: false, base: BASE, site: SITE };
      await sendVerify(env, { id: r.id, name: r.name, email: r.email, token, stance: r.stance }, L);
    }
    return json({ ok: true, sent: results.length, note: 'Sends up to 50 per call. Run again if more remain.' });
  }
  return new Response('Not found', { status: 404 });
}

// ----------------------------------------------------------------- helpers

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
}
function clean(v, max) { return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanMultiline(v, max) { return String(v || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function mdEsc(s) { return String(s).replace(/([\\`*_{}\[\]()#+\-!|<>])/g, '\\$1'); }
function csvCell(v) { if (v == null) return ''; let s = String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function randomToken() { const a = new Uint8Array(24); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function safeEqual(a, b) { const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]); let r = 0; for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i); return r === 0; }
function minutesSince(ts) { return (Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime()) / 60000; }

export const __test = { TOKEN_TTL_HOURS };
