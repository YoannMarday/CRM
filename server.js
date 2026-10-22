const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express();
app.set('trust proxy', 1); // behind Render's proxy: lets req.ip be the real visitor
app.use(express.json({ limit: '10mb' }));

const USER = process.env.APP_USER, PASS = process.env.APP_PASS;
const SECRET = process.env.SESSION_SECRET || 'please-change-this-secret';
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'data.json');
// Free hosting: if DATABASE_URL is set, data is kept in a free Postgres database (Neon) instead of a local file.
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  pool.query('create table if not exists kv(k text primary key, v text)').catch(e => console.error('DB setup failed', e.message));
}
async function load() {
  if (pool) { const r = await pool.query("select v from kv where k='data'"); return r.rows[0] ? r.rows[0].v : '{}'; }
  try { return fs.readFileSync(FILE, 'utf8'); } catch (e) { return '{}'; }
}
async function store(txt) {
  if (pool) { await pool.query("insert into kv(k,v) values('data',$1) on conflict(k) do update set v=excluded.v", [txt]); return; }
  const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, FILE);
}

const RP = require('./public/receipt-pdf.js');
const LOGO = (() => { try { return fs.readFileSync(path.join(__dirname, 'public', 'logo-receipt.jpg')); } catch (e) { return null; } })();
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const hash = v => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

const IDLE = 5 * 60000; // auto log-off after 5 minutes without activity
function authed(req) {
  const m = (req.headers.cookie || '').match(/crm=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  // must still be valid AND no more than 5 minutes ahead (this also retires old 30-day logins)
  return +exp > Date.now() && +exp <= Date.now() + IDLE + 5000 && !!sig && same(sig, sign(exp));
}
function devOk(req) { // a browser that has logged in successfully before is never locked out
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dev=([^;]+)/);
  if (!m) return false;
  const [id, sig] = m[1].split('.');
  return !!id && !!sig && same(sig, sign('dev|' + id));
}
function issue(req, res, newDevice) {
  const exp = String(Date.now() + IDLE);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const c = [`crm=${exp}.${sign(exp)}; HttpOnly; Path=/; Max-Age=${IDLE / 1000}; SameSite=Lax${secure}`];
  if (newDevice) { const id = crypto.randomBytes(12).toString('hex'); c.push(`dev=${id}.${sign('dev|' + id)}; HttpOnly; Path=/; Max-Age=${180 * 86400}; SameSite=Lax${secure}`); }
  res.setHeader('Set-Cookie', c);
}
const need = (req, res, next) => { if (!authed(req)) return res.status(401).json({ error: 'login' }); issue(req, res); next(); };

// Wrong-password limit is kept per visitor (IP), so strangers guessing cannot lock you out.
const WINDOW = 5 * 60000, MAXTRY = 10, attempts = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of attempts) { const f = v.filter(t => t > n - WINDOW); f.length ? attempts.set(k, f) : attempts.delete(k); } }, 60000).unref();
const norm = v => String(v == null ? '' : v).trim().toLowerCase();
app.post('/api/login', (req, res) => {
  if (!USER || !PASS) return res.status(500).json({ error: 'APP_USER and APP_PASS are not set on the server.' });
  const known = devOk(req), ip = req.ip || 'x', now = Date.now(), list = (attempts.get(ip) || []).filter(t => t > now - WINDOW);
  if (!known && list.length >= MAXTRY) {
    const w = Math.max(1, Math.ceil((list[0] + WINDOW - now) / 60000));
    return res.status(429).json({ error: `Too many wrong attempts. Please wait ${w} minute${w > 1 ? 's' : ''} and try again.` });
  }
  const { user, pass } = req.body || {};
  if (same(norm(user), norm(USER)) && (same(pass, PASS) || same(String(pass == null ? '' : pass).trim(), PASS))) {
    attempts.delete(ip);
    issue(req, res, !known);
    return res.json({ ok: true });
  }
  if (!known) { list.push(now); attempts.set(ip, list); }
  const left = MAXTRY - list.length;
  res.status(401).json({ error: 'Wrong username or password.' + (!known && left > 0 && left <= 3 ? ` (${left} attempt${left > 1 ? 's' : ''} left)` : '') });
});
app.post('/api/ping', need, (req, res) => res.json({ ok: true }));
const money = n => 'Rs ' + Number(n || 0).toLocaleString('en', { maximumFractionDigits: 0 });
const fmtD = d => { if (!d) return '—'; const [y, m, dd] = String(d).split('-'); return new Date(y, m - 1, dd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const paidO = o => (o.payments || []).reduce((t, p) => t + +p.amount, 0), balO = o => (+o.amount || 0) - paidO(o);
const rtok = (o, i, p) => sign(['rcpt', o.id, i, p.amount, p.date, p.method].join('|')).slice(0, 32);
app.post('/api/receipt-link', need, async (req, res) => {
  try {
    const d = JSON.parse(await load() || '{}'), { orderId, idx } = req.body || {};
    const o = (d.orders || []).find(x => String(x.id) === String(orderId)), i = +idx, p = o && (o.payments || [])[i];
    if (!p) return res.status(409).json({ error: 'Payment not saved yet' });
    res.json({ path: `/r/${o.id}-${i}-${rtok(o, i, p)}.pdf` });
  } catch (e) { res.status(500).json({ error: 'Could not create link' }); }
});
// Public (no login) but impossible to guess: only someone given the link can open that one receipt.
app.get('/r/:file', async (req, res) => {
  const m = /^(.+)-(\d+)-([0-9a-f]{32})\.pdf$/.exec(req.params.file || '');
  if (!m) return res.sendStatus(404);
  try {
    const d = JSON.parse(await load() || '{}'), o = (d.orders || []).find(x => String(x.id) === m[1]), i = +m[2], p = o && (o.payments || [])[i];
    if (!p || !same(m[3], rtok(o, i, p))) return res.sendStatus(404);
    const c = (d.clients || []).find(x => x.id == o.clientId) || { name: '', phone: '' };
    let biz = (d.settings && d.settings.biz) || 'Kikoo'; if (biz === 'My Party Studio') biz = 'Kikoo';
    const pdf = RP.receiptPdf({ o, c, p, i, biz, money, fmt: fmtD, paid: paidO, bal: balO, logo: LOGO, logoPx: 720 });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Kikoo-Receipt-R-${o.no}-${i + 1}.pdf"`, 'Cache-Control': 'private, max-age=60', 'X-Robots-Tag': 'noindex' });
    res.send(Buffer.from(pdf));
  } catch (e) { res.sendStatus(500); }
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'crm=; Path=/; Max-Age=0'); res.json({ ok: true }); });

app.get('/api/data', need, async (req, res) => {
  try { res.type('json').send(await load()); } catch (e) { res.status(500).json({ error: 'Could not load' }); }
});
app.put('/api/data', need, async (req, res) => {
  try { await store(JSON.stringify(req.body)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Could not save' }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Kikoo CRM running'));
