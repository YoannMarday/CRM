const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express();
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

const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const hash = v => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

function authed(req) {
  const m = (req.headers.cookie || '').match(/crm=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return +exp > Date.now() && !!sig && same(sig, sign(exp));
}
const need = (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'login' });

let fails = [];
app.post('/api/login', (req, res) => {
  fails = fails.filter(t => t > Date.now() - 10 * 60000);
  if (fails.length >= 8) return res.status(429).json({ error: 'Too many attempts. Wait 10 minutes.' });
  if (!USER || !PASS) return res.status(500).json({ error: 'APP_USER and APP_PASS are not set on the server.' });
  const { user, pass } = req.body || {};
  if (same(user, USER) && same(pass, PASS)) {
    const exp = String(Date.now() + 30 * 864e5);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `crm=${exp}.${sign(exp)}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${secure}`);
    return res.json({ ok: true });
  }
  fails.push(Date.now());
  res.status(401).json({ error: 'Wrong username or password' });
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
app.listen(process.env.PORT || 3000, () => console.log('Party CRM running'));
