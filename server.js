const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express();
app.set('trust proxy', 1); // behind Render's proxy: lets req.ip be the real visitor
app.use(express.json({ limit: '10mb' }));

const USER = process.env.APP_USER, PASS = process.env.APP_PASS;
const STAFF_USER = process.env.STAFF_USER, STAFF_PASS = process.env.STAFF_PASS; // optional: limited staff login
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
function role(req) { // 'owner', 'staff' or null
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)crm=([^;]+)/);
  if (!m) return null;
  const [exp, r, sig] = m[1].split('.');
  if (!sig || (r !== 'owner' && r !== 'staff')) return null;
  // must still be valid AND no more than 5 minutes ahead
  return +exp > Date.now() && +exp <= Date.now() + IDLE + 5000 && same(sig, sign(exp + '.' + r)) ? r : null;
}
function devOk(req) { // a browser that has logged in successfully before is never locked out
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dev=([^;]+)/);
  if (!m) return false;
  const [id, sig] = m[1].split('.');
  return !!id && !!sig && same(sig, sign('dev|' + id));
}
function issue(req, res, newDevice, r) {
  const exp = String(Date.now() + IDLE);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const c = [`crm=${exp}.${r}.${sign(exp + '.' + r)}; HttpOnly; Path=/; Max-Age=${IDLE / 1000}; SameSite=Lax${secure}`];
  if (newDevice) { const id = crypto.randomBytes(12).toString('hex'); c.push(`dev=${id}.${sign('dev|' + id)}; HttpOnly; Path=/; Max-Age=${180 * 86400}; SameSite=Lax${secure}`); }
  res.setHeader('Set-Cookie', c);
}
const guard = allowed => (req, res, next) => {
  const r = role(req);
  if (!r) return res.status(401).json({ error: 'login' });
  if (!allowed.includes(r)) return res.status(403).json({ error: 'not allowed' });
  issue(req, res, false, r); req.role = r; next();
};
const needOwner = guard(['owner']), needStaff = guard(['staff']), needAny = guard(['owner', 'staff']);

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
  const pw = String(pass == null ? '' : pass), okPw = w => same(pw, w) || same(pw.trim(), w);
  const isOwner = same(norm(user), norm(USER)) && okPw(PASS);
  const isStaff = !!STAFF_USER && !!STAFF_PASS && same(norm(user), norm(STAFF_USER)) && okPw(STAFF_PASS);
  if (isOwner || isStaff) {
    attempts.delete(ip);
    const r = isOwner ? 'owner' : 'staff';
    issue(req, res, !known, r);
    return res.json({ ok: true, role: r });
  }
  if (!known) { list.push(now); attempts.set(ip, list); }
  const left = MAXTRY - list.length;
  res.status(401).json({ error: 'Wrong username or password.' + (!known && left > 0 && left <= 3 ? ` (${left} attempt${left > 1 ? 's' : ''} left)` : '') });
});
app.post('/api/ping', needAny, (req, res) => res.json({ ok: true }));
const money = n => 'Rs ' + Number(n || 0).toLocaleString('en', { maximumFractionDigits: 0 });
const fmtD = d => { if (!d) return '—'; const [y, m, dd] = String(d).split('-'); return new Date(y, m - 1, dd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const paidO = o => (o.payments || []).reduce((t, p) => t + +p.amount, 0), balO = o => (+o.amount || 0) - paidO(o);
const rtok = (o, i, p) => sign(['rcpt', o.id, i, p.amount, p.date, p.method].join('|')).slice(0, 32);
app.post('/api/receipt-link', needOwner, async (req, res) => {
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

// ---------- shared data helpers ----------
// One request at a time touches the data, so two people saving at once can never overwrite each other.
let chain = Promise.resolve();
const locked = fn => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
const rd = async () => JSON.parse((await load()) || '{}'); // throws (and nothing is written) if the stored data is unreadable
const pendOf = d => ({ c: (d._pend && d._pend.c) || [], o: (d._pend && d._pend.o) || [] });
const pub = d => { const { _pend, ...rest } = d; return rest; };

app.get('/api/data', needOwner, async (req, res) => {
  try {
    const out = await locked(async () => {
      const d = await rd(), p = pendOf(d);
      if (p.c.length || p.o.length) { d._pend = { c: [], o: [] }; await store(JSON.stringify(d)); } // the owner now has them
      return pub(d);
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Could not load' }); }
});
app.put('/api/data', needOwner, async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.clients) || !Array.isArray(body.orders)) return res.status(400).json({ error: 'Invalid data' });
  try {
    const out = await locked(async () => {
      const cur = await rd(), pend = pendOf(cur), renum = {};
      const hasC = new Set(body.clients.map(x => x && x.id)), hasO = new Set(body.orders.map(x => x && x.id));
      // Customers/orders added by staff that this browser has not received yet are kept, never dropped.
      const keepC = [], keepO = [];
      for (const id of pend.c) if (!hasC.has(id)) { const r = (cur.clients || []).find(x => x.id === id); if (r) { body.clients.push(r); keepC.push(id); } }
      for (const id of pend.o) if (!hasO.has(id)) { const r = (cur.orders || []).find(x => x.id === id); if (r) { body.orders.push(r); keepO.push(id); } }
      // Order numbers stay unique even if staff and owner created orders at the same moment.
      let seq = Math.max(+body.seq || 0, +cur.seq || 0);
      const curIds = new Set((cur.orders || []).map(x => x.id)), used = new Map();
      for (const o of body.orders) if (curIds.has(o.id)) used.set(o.no, o.id);
      for (const o of body.orders) if (!curIds.has(o.id)) { if (used.has(o.no) && used.get(o.no) !== o.id) { o.no = ++seq; renum[o.id] = o.no; } used.set(o.no, o.id); }
      for (const o of body.orders) seq = Math.max(seq, +o.no || 0);
      body.seq = seq; body._pend = { c: keepC, o: keepO };
      await store(JSON.stringify(body));
      return { ok: true, seq, renum };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Could not save' }); }
});
// The owner's browser asks for anything staff added since it last looked.
app.get('/api/staff/new', needOwner, async (req, res) => {
  try {
    const d = await rd(), p = pendOf(d);
    res.json({ clients: (d.clients || []).filter(c => p.c.includes(c.id)), orders: (d.orders || []).filter(o => p.o.includes(o.id)), seq: +d.seq || 0 });
  } catch (e) { res.status(500).json({ error: 'Could not load' }); }
});

// ---------- staff: only customers, new orders, delivery status and calendar. Never money. ----------
const clean = (v, n = 200) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
const okDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v));
const TYP = ['Personalised item', '3D cut-out', 'Birthday deco', 'Mixed order'], PRI = ['Normal', 'High', 'Urgent'], SRC = ['WhatsApp', 'Facebook', 'Instagram', 'Referral', 'Other'];
const newId = used => { let id; do { id = crypto.randomBytes(5).toString('hex'); } while (used.has(id)); return id; };
const done = new Map(); // request id -> answer, so a double tap never creates two records
const remember = (rid, out) => { if (!rid) return; done.set(rid, out); if (done.size > 500) done.delete(done.keys().next().value); };
const sClient = c => ({ id: c.id, name: c.name, phone: c.phone || '', child: c.child || '' });
const sOrder = o => ({ id: o.id, no: o.no, clientId: o.clientId, title: o.title, type: o.type, status: o.status, orderDate: o.orderDate || '', deliveryDate: o.deliveryDate || '', addr: o.addr || '' });
const today = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); // Mauritius date

app.get('/api/staff/data', needStaff, async (req, res) => {
  try {
    const d = await rd();
    res.json({ clients: (d.clients || []).map(sClient), orders: (d.orders || []).map(sOrder) });
  } catch (e) { res.status(500).json({ error: 'Could not load' }); }
});
app.post('/api/staff/client', needStaff, async (req, res) => {
  const b = req.body || {}, name = clean(b.name, 120);
  if (!name) return res.status(400).json({ error: 'Please enter the customer name.' });
  try {
    const out = await locked(async () => {
      if (b.rid && done.has(b.rid)) return done.get(b.rid);
      const d = await rd(); d.clients = d.clients || [];
      const phone = clean(b.phone, 40), dg = phone.replace(/\D/g, '').slice(-8);
      if (dg.length >= 7) { const ex = d.clients.find(c => String(c.phone || '').replace(/\D/g, '').slice(-8) === dg); if (ex) return { code: 409, body: { error: 'exists', client: sClient(ex) } }; }
      const c = { id: newId(new Set(d.clients.map(x => x.id))), name, phone, email: clean(b.email, 120), source: SRC.includes(b.source) ? b.source : 'WhatsApp', child: clean(b.child, 120), bday: okDate(b.bday) ? b.bday : '', addr: clean(b.addr, 300), notes: clean(b.notes, 2000), by: 'staff' };
      d.clients.push(c);
      const p = pendOf(d); p.c.push(c.id); d._pend = p;
      await store(JSON.stringify(d));
      const o = { code: 200, body: { client: sClient(c) } }; remember(b.rid, o); return o;
    });
    res.status(out.code).json(out.body);
  } catch (e) { res.status(500).json({ error: 'Could not save. Please try again.' }); }
});
app.post('/api/staff/order', needStaff, async (req, res) => {
  const b = req.body || {}, title = clean(b.title, 200);
  if (!title) return res.status(400).json({ error: 'Please enter the order title.' });
  try {
    const out = await locked(async () => {
      if (b.rid && done.has(b.rid)) return done.get(b.rid);
      const d = await rd(); d.clients = d.clients || []; d.orders = d.orders || [];
      if (!d.clients.some(c => c.id === b.clientId)) return { code: 400, body: { error: 'Please choose a customer.' } };
      let no = (+d.seq || 1000) + 1; while (d.orders.some(x => x.no === no)) no++;
      d.seq = no;
      const o = { id: newId(new Set(d.orders.map(x => x.id))), no, clientId: b.clientId, title, type: TYP.includes(b.type) ? b.type : TYP[0], status: 'Enquiry', details: clean(b.details, 2000), amount: 0, priority: PRI.includes(b.priority) ? b.priority : 'Normal', orderDate: okDate(b.orderDate) ? b.orderDate : today(), deliveryDate: okDate(b.deliveryDate) ? b.deliveryDate : '', addr: clean(b.addr, 300), payments: [], by: 'staff', at: Date.now() };
      d.orders.push(o);
      const p = pendOf(d); p.o.push(o.id); d._pend = p;
      await store(JSON.stringify(d));
      const r = { code: 200, body: { order: sOrder(o) } }; remember(b.rid, r); return r;
    });
    res.status(out.code).json(out.body);
  } catch (e) { res.status(500).json({ error: 'Could not save. Please try again.' }); }
});
app.get('/staff', (req, res) => res.redirect('/staff.html'));

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Kikoo CRM running'));
