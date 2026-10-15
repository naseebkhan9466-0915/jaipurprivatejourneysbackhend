'use strict';
/*
 * Jaipur Private Journeys - backend
 *  - serves the website from /public
 *  - POST /api/reviews      : customer submits a review (stored as "pending")
 *  - GET  /api/reviews      : only APPROVED reviews (shown to everyone)
 *  - every new review is emailed to ADMIN_EMAIL with Approve / Reject links
 */
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const SECRET = process.env.APPROVAL_SECRET || '';
const SITE_NAME = process.env.SITE_NAME || 'Jaipur Private Journeys';

if (SECRET.length < 16) {
  console.error('ERROR: APPROVAL_SECRET set karo (kam se kam 16 random characters).');
  process.exit(1);
}

/* ---------- email ---------- */
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && ADMIN_EMAIL) {
  const port = Number(process.env.SMTP_PORT) || 465;
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn('WARNING: SMTP/ADMIN_EMAIL set nahi hai - review save honge par email nahi jayega.');
}
const MAIL_FROM = process.env.MAIL_FROM || `"${SITE_NAME}" <${process.env.SMTP_USER || 'no-reply@localhost'}>`;

/* ---------- storage (JSON file + photo files) ---------- */
const DB_FILE = path.join(DATA_DIR, 'reviews.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

let reviews = [];
try { reviews = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { reviews = []; }
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reviews));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const sign = (id, action) => crypto.createHmac('sha256', SECRET).update(id + ':' + action).digest('hex').slice(0, 32);
function okToken(id, action, t) {
  const a = Buffer.from(sign(id, action));
  const b = Buffer.from(String(t || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/* simple per-IP rate limit: 5 reviews / hour */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= 5) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr); return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) { const f = v.filter((t) => now - t < 3600e3); f.length ? hits.set(k, f) : hits.delete(k); }
}, 600e3).unref();

function deletePhotos(r) {
  (r.photos || []).forEach((f) => { try { fs.unlinkSync(path.join(PHOTO_DIR, path.basename(f))); } catch (_) {} });
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

app.get('/healthz', (req, res) => res.send('ok'));

/* public: approved reviews only */
app.get('/api/reviews', (req, res) => {
  const out = reviews
    .filter((r) => r.status === 'approved')
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((r) => ({
      id: r.id,
      n: esc(r.name),
      c: esc(r.from) || 'Traveller',
      t: esc(r.text).replace(/\n/g, '<br>'),
      rating: r.rating,
      d: fmtDate(r.date),
      a: r.avatar,
      photos: (r.photos || []).map((f) => '/photos/' + f),
    }));
  res.set('Cache-Control', 'no-cache').json(out);
});

/* public: submit a review */
app.post('/api/reviews', express.json({ limit: '3mb' }), (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Bahut zyada reviews bheje gaye. Thodi der baad try karein.' });
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot (bots fill this)

  const name = clean(b.name, 60);
  const from = clean(b.from, 60);
  const text = clean(b.text, 800);
  const rating = Math.max(1, Math.min(5, Math.round(Number(b.rating) || 5)));
  if (!name || !text) return res.status(400).json({ error: 'Naam aur review likhna zaroori hai.' });
  if (reviews.filter((r) => r.status === 'pending').length >= 200) {
    return res.status(503).json({ error: 'Abhi review nahi le sakte, baad mein try karein.' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const photos = [];
  const list = Array.isArray(b.photos) ? b.photos.slice(0, 4) : [];
  for (let i = 0; i < list.length; i++) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(list[i]));
    if (!m) continue;
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 500 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) continue; // JPEG only, <=500KB
    const file = `${id}-${i}.jpg`;
    fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
    photos.push(file);
  }

  const r = { id, name, from, text, rating, photos, status: 'pending', avatar: Math.floor(Math.random() * 8), date: new Date().toISOString() };
  reviews.push(r);
  save();
  notifyOwner(r).catch((e) => console.error('Email fail hua:', e.message));
  res.json({ ok: true });
});

async function notifyOwner(r) {
  if (!mailer) return;
  const approve = `${BASE_URL}/admin/review/${r.id}/approve?t=${sign(r.id, 'approve')}`;
  const reject = `${BASE_URL}/admin/review/${r.id}/reject?t=${sign(r.id, 'reject')}`;
  const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
  await mailer.sendMail({
    from: MAIL_FROM,
    to: ADMIN_EMAIL,
    subject: `Naya review ${r.rating}★ - ${r.name}`,
    text: `Naya review aaya hai.\n\nNaam: ${r.name}\nKahan se: ${r.from || '-'}\nRating: ${r.rating}/5\nPhotos: ${r.photos.length}\n\n${r.text}\n\nApprove (website par dikhane ke liye): ${approve}\nReject / hata dein: ${reject}\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px">
      <h2 style="margin:0 0 6px">Naya review aaya hai</h2>
      <p style="color:#b8860b;font-size:20px;margin:4px 0">${stars}</p>
      <p><b>${esc(r.name)}</b> &middot; ${esc(r.from || '-')}</p>
      <blockquote style="margin:12px 0;padding:10px 14px;background:#f6f6f6;border-left:4px solid #ccc">${esc(r.text).replace(/\n/g, '<br>')}</blockquote>
      <p>Photos: ${r.photos.length}${r.photos.length ? ' (attachment mein)' : ''}</p>
      <p style="margin-top:20px">
        <a href="${approve}" style="background:#1a7f37;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Approve</a>
        &nbsp;
        <a href="${reject}" style="background:#c0392b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reject</a>
      </p>
      <p style="color:#777;font-size:12px">Approve karne par review sabko website par dikhne lagega. Baad mein hatana ho to isi mail ka Reject link use karein.</p>
    </div>`,
    attachments: r.photos.map((f, i) => ({ filename: `photo-${i + 1}.jpg`, path: path.join(PHOTO_DIR, f) })),
  });
}

/* approved photos are public; pending ones are only reachable by their random URL */
app.use('/photos', express.static(PHOTO_DIR, { maxAge: '7d', index: false }));

/* ---------- owner approve / reject (links from the email) ---------- */
const page = (title, body) => `<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f1ec;margin:0;padding:24px}.box{max-width:520px;margin:30px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}button{border:0;border-radius:8px;padding:12px 22px;font-size:16px;color:#fff;cursor:pointer}.ok{background:#1a7f37}.no{background:#c0392b}blockquote{margin:12px 0;padding:10px 14px;background:#f6f6f6;border-left:4px solid #ccc}</style></head><body><div class="box"><h2 style="margin-top:0">${esc(title)}</h2>${body}</div></body></html>`;

function adminHeaders(res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
}
function adminCheck(req, res, t) {
  const { id, action } = req.params;
  if (!/^[a-f0-9]{16}$/.test(id) || !['approve', 'reject'].includes(action) || !okToken(id, action, t)) {
    res.status(403).send(page('Link sahi nahi hai', '<p>Ye link galat ya adhura hai. Email se poora link kholein.</p>'));
    return null;
  }
  return { id, action, review: reviews.find((x) => x.id === id) };
}

app.get('/admin/review/:id/:action', (req, res) => {
  adminHeaders(res);
  const c = adminCheck(req, res, String(req.query.t || ''));
  if (!c) return;
  if (!c.review) return res.send(page('Review nahi mila', '<p>Ye review ab maujood nahi hai (shayad pehle hi hata diya gaya).</p>'));
  const r = c.review;
  const label = c.action === 'approve' ? 'Approve karein (sabko dikhega)' : 'Reject karein (hata dein)';
  res.send(page(c.action === 'approve' ? 'Review approve karein?' : 'Review hata dein?',
    `<p><b>${esc(r.name)}</b> &middot; ${esc(r.from || '-')} &middot; ${'★'.repeat(r.rating)}</p><blockquote>${esc(r.text).replace(/\n/g, '<br>')}</blockquote>
     <p>Status abhi: <b>${r.status === 'approved' ? 'approved (website par dikh raha hai)' : 'pending'}</b></p>
     <form method="post"><input type="hidden" name="t" value="${esc(req.query.t || '')}"><button class="${c.action === 'approve' ? 'ok' : 'no'}" type="submit">${label}</button></form>`));
});

app.post('/admin/review/:id/:action', express.urlencoded({ extended: false }), (req, res) => {
  adminHeaders(res);
  const c = adminCheck(req, res, String((req.body && req.body.t) || ''));
  if (!c) return;
  const r = c.review;
  if (!r) return res.send(page('Review nahi mila', '<p>Ye review ab maujood nahi hai.</p>'));
  if (c.action === 'approve') {
    r.status = 'approved';
    save();
    return res.send(page('Approve ho gaya', '<p>Ye review ab website par sabko dikhega.</p>'));
  }
  deletePhotos(r);
  reviews = reviews.filter((x) => x.id !== r.id);
  save();
  res.send(page('Hata diya gaya', '<p>Ye review hata diya gaya hai.</p>'));
});

/* ---------- website ---------- */
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 413 ? 'Photos bahut badi hain, kam ya chhoti photos lagayein.' : 'Kuch gadbad ho gayi, dobara try karein.' });
});

app.listen(PORT, () => console.log(`Server chal raha hai: ${BASE_URL}  (data: ${DATA_DIR})`));
