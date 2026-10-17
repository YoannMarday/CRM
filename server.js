const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express();
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

const USER = process.env.APP_USER, PASS = process.env.APP_PASS;
const SECRET = process.env.SESSION_SECRET || 'please-change-this-secret';
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
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


// ---------- WhatsApp (Meta WhatsApp Cloud API) ----------
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN, WA_TOKEN = process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID, WA_APP_SECRET = process.env.WHATSAPP_APP_SECRET;
if (pool) pool.query('create table if not exists wa_messages(id text primary key, phone text not null, name text, dir text not null, body text, ts bigint not null)').catch(e => console.error('WA table failed', e.message));
const digitsOnly = v => String(v || '').replace(/\D/g, '');

// Meta calls this once to check the webhook is yours
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode']) console.log('WA webhook: Meta verification check ' + (WA_VERIFY && req.query['hub.verify_token'] === WA_VERIFY ? 'passed' : 'FAILED (verify word differs)'));
  if (WA_VERIFY && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
// Meta sends every new client message here
app.post('/webhook', async (req, res) => {
  try {
    console.log('WA webhook: request received');
    if (!WA_APP_SECRET || !req.rawBody) { console.log('WA webhook REFUSED: WHATSAPP_APP_SECRET is missing in Render'); return res.sendStatus(403); }
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const exp = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(req.rawBody).digest('hex');
    if (!sig || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) { console.log('WA webhook REFUSED: wrong signature - WHATSAPP_APP_SECRET in Render does not match the App secret in Meta'); return res.sendStatus(403); }
    if (!pool) console.log('WA webhook: no DATABASE_URL, message not stored');
    let stored = 0;
    if (pool) for (const en of (req.body.entry || [])) for (const ch of (en.changes || [])) {
      const v = ch.value || {}, names = {};
      (v.contacts || []).forEach(c => { names[c.wa_id] = c.profile && c.profile.name; });
      for (const m of (v.messages || [])) {
        const body = (m.text && m.text.body) || (m[m.type] && m[m.type].caption) || ('📎 ' + m.type + ' (open WhatsApp to view)');
        await pool.query('insert into wa_messages(id,phone,name,dir,body,ts) values($1,$2,$3,$4,$5,$6) on conflict do nothing',
          [m.id, digitsOnly(m.from), names[m.from] || null, 'in', body, (+m.timestamp || Math.floor(Date.now() / 1000)) * 1000]);
        stored++;
      }
    }
    console.log('WA webhook OK: stored ' + stored + ' message(s)');
    res.sendStatus(200);
  } catch (e) { console.error('WA webhook ERROR:', e.message); res.sendStatus(200); }
});
app.get('/api/wa/chats', need, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not connected' });
  try {
    const r = await pool.query(`select phone, max(name) as name, max(ts) as last_ts,
      (array_agg(body order by ts desc))[1] as last_body, (array_agg(dir order by ts desc))[1] as last_dir
      from wa_messages group by phone order by max(ts) desc limit 100`);
    res.json(r.rows.map(x => ({ ...x, last_ts: +x.last_ts })));
  } catch (e) { res.status(500).json({ error: 'Could not load chats' }); }
});
app.get('/api/wa/messages', need, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not connected' });
  try {
    const r = await pool.query('select * from (select id,dir,body,ts from wa_messages where phone=$1 order by ts desc limit 300) t order by ts asc', [digitsOnly(req.query.phone)]);
    res.json(r.rows.map(x => ({ ...x, ts: +x.ts })));
  } catch (e) { res.status(500).json({ error: 'Could not load messages' }); }
});
app.post('/api/wa/send', need, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not connected' });
  if (!WA_TOKEN || !WA_PHONE_ID) return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
  const to = digitsOnly(req.body && req.body.to), text = String((req.body && req.body.text) || '').trim();
  if (!to || !text) return res.status(400).json({ error: 'Nothing to send' });
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ error: (j.error && j.error.message) || 'WhatsApp refused the message' });
    const id = (j.messages && j.messages[0] && j.messages[0].id) || 'out-' + Date.now();
    await pool.query('insert into wa_messages(id,phone,dir,body,ts) values($1,$2,$3,$4,$5) on conflict do nothing', [id, to, 'out', text, Date.now()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not send' }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Party CRM running'));
