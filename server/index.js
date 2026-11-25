require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');

// ---------- Security hardening ----------
// 1. In production the server refuses to start without a strong JWT_SECRET.
const IS_PROD = !!(process.env.RENDER || process.env.NODE_ENV === 'production');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (IS_PROD && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('FATAL: JWT_SECRET must be set to a random value of at least 32 characters.');
  process.exit(1);
}
const JWT_ALG = 'HS256';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind one proxy: needed for real client IPs and https detection

// 2. Security headers on every response.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Only anti-framing / anti-injection directives: scripts, fonts and libraries load exactly as before.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// 3. CORS: the app and its API are on the same address, so other websites get no access.
//    (Optional: set ALLOWED_ORIGINS to a comma-separated list if you ever host the front end elsewhere.)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Small in-memory helpers (fine for a single small instance).
const sweepers = [];
setInterval(() => {
  const now = Date.now();
  for (const { map, windowMs } of sweepers) for (const [k, r] of map) if (now - r.t > windowMs) map.delete(k);
}, 10 * 60 * 1000).unref();
function counterStore(windowMs) {
  const map = new Map();
  sweepers.push({ map, windowMs });
  const rec = (key) => {
    const now = Date.now();
    let r = map.get(key);
    if (!r || now - r.t > windowMs) { r = { n: 0, t: now }; map.set(key, r); }
    return r;
  };
  const retrySeconds = (r) => Math.max(1, Math.ceil((r.t + windowMs - Date.now()) / 1000));
  return { map, rec, retrySeconds };
}

// 4. Overall request limit per IP (generous: normal use, including chat polling, stays far below it).
const apiHits = counterStore(60 * 1000);
app.use('/api', (req, res, next) => {
  const r = apiHits.rec('ip:' + req.ip);
  r.n += 1;
  if (r.n > 600) {
    res.setHeader('Retry-After', String(apiHits.retrySeconds(r)));
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
  }
  next();
});

// 5. Sign-in brute-force protection: 5 wrong passwords for the same username from the same
//    device/network lock that combination for 15 minutes (a legitimate user on another network is not locked out),
//    and 20 wrong attempts from one IP in total lock that IP for 15 minutes.
const LOGIN_WINDOW = 15 * 60 * 1000;
const loginByUser = counterStore(LOGIN_WINDOW);
const loginByIp = counterStore(LOGIN_WINDOW);
// Compared against when the username does not exist, so response time does not reveal which usernames are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// 6. Every request re-checks that the user still exists and that their password has not changed since
//    the session was issued (so removing a user or changing a password signs old sessions out).
//    Role and name always come from the database, never from the token alone.
const pwFingerprint = (hash) => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 16);
const userCache = new Map(); // id -> { u, t }  (30-second cache to spare the database)
async function loadUser(id) {
  const c = userCache.get(id);
  if (c && Date.now() - c.t < 30000) return c.u;
  const { rows } = await pool.query('SELECT id, username, display_name, role, password_hash FROM users WHERE id = $1', [id]);
  const u = rows[0] ? { id: rows[0].id, username: rows[0].username, name: rows[0].display_name, role: rows[0].role, pv: pwFingerprint(rows[0].password_hash) } : null;
  userCache.set(id, { u, t: Date.now() });
  return u;
}
sweepers.push({ map: userCache, windowMs: 60 * 1000 });

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALG] });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  try {
    const u = await loadUser(payload.id);
    if (!u || !payload.pv || payload.pv !== u.pv) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = { id: u.id, username: u.username, name: u.name, role: u.role };
    next();
  } catch (e) {
    console.error('Auth lookup failed:', e.message);
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  }
}


// GUARD-START
// Invoice lock rules, enforced on the server for operators (the accountant is unrestricted).
// A posted invoice is "locked" unless the accountant has reopened it (unlocked = true).
function isLockedInvoice(inv) {
  return inv.status !== 'draft' && !inv.unlocked;
}
function stableJson(v) {
  return JSON.stringify(v === undefined ? null : v);
}
function checkOperatorChanges(oldData, newData) {
  const oldInvoices = (oldData && Array.isArray(oldData.invoices)) ? oldData.invoices : [];
  const newInvoices = Array.isArray(newData.invoices) ? newData.invoices : [];
  const newById = new Map(newInvoices.map((i) => [i.id, i]));
  const oldById = new Map(oldInvoices.map((i) => [i.id, i]));

  for (const oldInv of oldInvoices) {
    const newInv = newById.get(oldInv.id);
    if (!newInv) return `Invoice ${oldInv.invoiceNumber} cannot be deleted.`;
    if (!oldInv.unlocked && newInv.unlocked) {
      return 'Only the accountant can reopen an invoice.';
    }
    if (isLockedInvoice(oldInv)) {
      // Status is included here too: an invoice only moves booked <-> paid when the
      // accountant approves a payment against it, which bypasses this operator check entirely.
      const keys = new Set([...Object.keys(oldInv), ...Object.keys(newInv)]);
      for (const k of keys) {
        if (stableJson(oldInv[k]) !== stableJson(newInv[k])) {
          return `Invoice ${oldInv.invoiceNumber} is locked. Ask the accountant to reopen it before changing it.`;
        }
      }
    }
  }

  for (const newInv of newInvoices) {
    if (!oldById.has(newInv.id) && newInv.unlocked) {
      return 'New invoices cannot be created in a reopened state.';
    }
  }

  // Revenue entries belonging to locked invoices must stay exactly as they are.
  const lockedIds = new Set(oldInvoices.filter(isLockedInvoice).map((i) => i.id));
  const newRevenue = Array.isArray(newData.revenueEntries) ? newData.revenueEntries : [];
  const newRevById = new Map(newRevenue.map((r) => [r.id, r]));
  const oldRevenue = (oldData && Array.isArray(oldData.revenueEntries)) ? oldData.revenueEntries : [];
  for (const r of oldRevenue) {
    if (!lockedIds.has(r.invoiceId)) continue;
    const nr = newRevById.get(r.id);
    if (!nr || stableJson(nr) !== stableJson(r)) {
      return 'Revenue entries of locked invoices cannot be changed.';
    }
  }
  return null;
}
// GUARD-END


// GUARD-PAYROLL-START
// Payroll rules, enforced on the server for operators (the accountant is unrestricted).
// - Only the accountant may validate or reject a submitted entry.
// - A 'submitted' or 'validated' entry is locked for operators; only a 'rejected'
//   entry can be edited (and resubmitted) or deleted by an operator.
// - Payroll expense lines already posted to the GL (category 'Payroll') cannot be
//   altered by an operator.
function checkPayrollChanges(oldData, newData) {
  const oldEntries = (oldData && Array.isArray(oldData.payrollEntries)) ? oldData.payrollEntries : [];
  const newEntries = Array.isArray(newData.payrollEntries) ? newData.payrollEntries : [];
  const newById = new Map(newEntries.map((e) => [e.id, e]));
  const oldById = new Map(oldEntries.map((e) => [e.id, e]));

  for (const oldE of oldEntries) {
    const newE = newById.get(oldE.id);
    if (oldE.status !== 'rejected') {
      if (!newE) return `Payroll entry for ${oldE.employeeName} (${oldE.month}) cannot be deleted.`;
      if (stableJson(oldE) !== stableJson(newE)) {
        return `Payroll entry for ${oldE.employeeName} (${oldE.month}) is locked. Only the accountant can validate or reject it.`;
      }
    } else if (newE && stableJson(oldE) !== stableJson(newE) && newE.status !== 'submitted') {
      return `A rejected payroll entry can only be resubmitted, not set to '${newE.status}'.`;
    }
  }
  for (const newE of newEntries) {
    if (!oldById.has(newE.id) && newE.status !== 'submitted') {
      return 'A new payroll entry must be submitted, not created as validated or rejected.';
    }
  }

  const oldExpenses = (oldData && Array.isArray(oldData.expenses)) ? oldData.expenses : [];
  const newExpenses = Array.isArray(newData.expenses) ? newData.expenses : [];
  const newExpById = new Map(newExpenses.map((x) => [x.id, x]));
  for (const x of oldExpenses) {
    if (x.category !== 'Payroll') continue;
    const nx = newExpById.get(x.id);
    if (!nx || stableJson(nx) !== stableJson(x)) {
      return 'Payroll expense entries already posted to the financials cannot be changed.';
    }
  }
  return null;
}
// GUARD-PAYROLL-END

// GUARD-PAYMENTS-START
// Payment rules, enforced on the server for operators (the accountant is unrestricted).
// - Only the accountant may approve or return a submitted payment.
// - A 'submitted' or 'approved' payment is locked for operators; only a 'returned'
//   payment can be edited (and resubmitted) or deleted by an operator.
// - A payment created without a status (pre-dating this feature) is treated as
//   already-approved and therefore locked, same as checkPayrollChanges' pattern.
function checkPaymentChanges(oldData, newData) {
  const oldPayments = (oldData && Array.isArray(oldData.payments)) ? oldData.payments : [];
  const newPayments = Array.isArray(newData.payments) ? newData.payments : [];
  const newById = new Map(newPayments.map((p) => [p.id, p]));
  const oldById = new Map(oldPayments.map((p) => [p.id, p]));
  // Treat a missing 'status' as the same thing as an explicit 'approved' one, so a
  // save that merely fills in that default isn't mistaken for an unauthorized change.
  const withDefaultStatus = (p) => (p.status ? p : { ...p, status: 'approved' });

  for (const oldP of oldPayments) {
    const status = oldP.status || 'approved';
    const newP = newById.get(oldP.id);
    if (status !== 'returned') {
      if (!newP) return `Payment ${oldP.bankReference || oldP.id} cannot be deleted.`;
      if (stableJson(withDefaultStatus(oldP)) !== stableJson(withDefaultStatus(newP))) {
        return `Payment ${oldP.bankReference || oldP.id} is locked. Only the accountant can approve or return it.`;
      }
    } else if (newP && stableJson(oldP) !== stableJson(newP) && newP.status !== 'submitted') {
      return `A returned payment can only be resubmitted, not set to '${newP.status}'.`;
    }
  }
  for (const newP of newPayments) {
    if (!oldById.has(newP.id) && newP.status && newP.status !== 'submitted') {
      return 'A new payment must be submitted, not created as approved or returned.';
    }
  }
  return null;
}
// GUARD-PAYMENTS-END


// GUARD-VOUCHERS-START
// Expense voucher rules, enforced on the server for operators (the accountant is unrestricted).
// - A voucher gets its sequential number when submitted; numbers must be unique.
// - Only the accountant may post or return a submitted voucher.
// - 'submitted' and 'posted' vouchers are locked for operators and can't be deleted.
// - A 'returned' voucher can only be corrected and resubmitted (same number), never deleted.
// - A 'draft' has no number yet and can be edited, submitted or deleted.
// - Expense entries (which vouchers post into) are accountant-only.
function checkVoucherChanges(oldData, newData) {
  const oldV = (oldData && Array.isArray(oldData.expenseVouchers)) ? oldData.expenseVouchers : [];
  const newV = Array.isArray(newData.expenseVouchers) ? newData.expenseVouchers : [];
  const newById = new Map(newV.map((v) => [v.id, v]));
  const oldById = new Map(oldV.map((v) => [v.id, v]));
  const label = (v) => v.voucherNo || 'draft voucher';

  for (const o of oldV) {
    const n = newById.get(o.id);
    if (o.status === 'submitted' || o.status === 'posted') {
      if (!n) return `Voucher ${label(o)} cannot be deleted.`;
      if (stableJson(o) !== stableJson(n)) {
        return `Voucher ${label(o)} is locked. Only the accountant can post or return it.`;
      }
    } else if (o.status === 'returned') {
      if (!n) return `Voucher ${label(o)} has a number and cannot be deleted.`;
      if (stableJson(o) !== stableJson(n)) {
        if (n.status !== 'submitted') return 'A returned voucher can only be corrected and resubmitted.';
        if (n.voucherNo !== o.voucherNo) return 'A voucher number cannot be changed.';
      }
    } else if (n && stableJson(o) !== stableJson(n)) {
      if (n.status !== 'draft' && n.status !== 'submitted') {
        return 'A draft voucher can only be saved as a draft or submitted.';
      }
    }
  }
  for (const n of newV) {
    if (!oldById.has(n.id) && n.status !== 'draft' && n.status !== 'submitted') {
      return 'A new voucher must be a draft or submitted, not posted or returned.';
    }
    if (n.status === 'submitted' && !n.voucherNo) return 'A submitted voucher needs a voucher number.';
  }
  const seen = new Set();
  for (const n of newV) {
    if (!n.voucherNo) continue;
    if (seen.has(n.voucherNo)) return `Voucher number ${n.voucherNo} is already in use. Please refresh and try again.`;
    seen.add(n.voucherNo);
  }
  return null;
}
// Vouchers created from the invoice inbox must never disappear because someone saved an out-of-date copy of the data.
function checkBotVouchersKept(oldData, newData) {
  const oldV = (oldData && Array.isArray(oldData.expenseVouchers)) ? oldData.expenseVouchers : [];
  const newIds = new Set((Array.isArray(newData.expenseVouchers) ? newData.expenseVouchers : []).map((v) => v.id));
  const lost = oldV.find((v) => v.botInvoiceId && !newIds.has(v.id));
  return lost ? `Voucher ${lost.voucherNo || ''} was just added from the Invoice inbox. Please refresh the page and try again.` : null;
}
function checkExpensesLocked(oldData, newData) {
  const a = (oldData && Array.isArray(oldData.expenses)) ? oldData.expenses : [];
  const b = Array.isArray(newData.expenses) ? newData.expenses : [];
  if (stableJson(a) !== stableJson(b)) return 'Only the accountant can add or change expense entries.';
  return null;
}
// GUARD-VOUCHERS-END

// GUARD-BANK-START
// Bank statements, bank allocations and the opening-balance setting belong to the accountant.
// This also stops an out-of-date copy in an operator's browser from overwriting them.
function checkBankLocked(oldData, newData) {
  const keys = [['bankBatches', []], ['bankLines', []], ['allocations', []], ['bankSettings', {}]];
  for (const [k, def] of keys) {
    const a = oldData && oldData[k] !== undefined ? oldData[k] : def;
    const b = newData[k] !== undefined ? newData[k] : def;
    if (stableJson(a) !== stableJson(b)) return 'Bank statements and allocations can only be changed by the accountant. Please refresh the page and try again.';
  }
  return null;
}
// GUARD-BANK-END

// Control check for destructive actions: the signed-in accountant must type their own username and password again.
// A wrong answer returns 403 (not 401, which would sign the person out). 5 wrong tries lock it for 10 minutes.
const verifyFails = new Map();
app.post('/api/verify-password', auth, async (req, res) => {
  if (req.user.role !== 'accountant') return res.status(403).json({ error: 'Only the accountant can do this.' });
  const key = String(req.user.id);
  const now = Date.now();
  const rec = verifyFails.get(key) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  if (rec.n >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Please wait 10 minutes and try again.' });
  const { username, password } = req.body || {};
  if (typeof password === 'string' && password.length > 200) return res.status(403).json({ error: 'Username or password is not correct.' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const u = rows[0];
    const ok = !!u && String(username || '').trim().toLowerCase() === String(u.username).toLowerCase()
      && await bcrypt.compare(String(password || ''), u.password_hash);
    if (!ok) {
      rec.n += 1; verifyFails.set(key, rec);
      return res.status(403).json({ error: 'Username or password is not correct.' });
    }
    verifyFails.delete(key);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }
  const userKey = req.ip + '|' + username.toLowerCase();
  const uRec = loginByUser.rec(userKey);
  const iRec = loginByIp.rec(req.ip);
  if (uRec.n >= 5 || iRec.n >= 20) {
    const wait = Math.max(uRec.n >= 5 ? loginByUser.retrySeconds(uRec) : 0, iRec.n >= 20 ? loginByIp.retrySeconds(iRec) : 0);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait ' + Math.ceil(wait / 60) + ' minute(s) and try again.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      uRec.n += 1; iRec.n += 1;
      console.warn('Failed sign-in for "' + username.slice(0, 30).replace(/[^\w.@-]/g, '?') + '" from ' + req.ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    loginByUser.map.delete(userKey);
    const token = jwt.sign(
      { id: user.id, name: user.display_name, role: user.role, pv: pwFingerprint(user.password_hash) },
      JWT_SECRET,
      { expiresIn: '12h', algorithm: JWT_ALG }
    );
    res.json({ token, user: { name: user.display_name, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM ledger WHERE id = 1');
    res.json({ data: rows[0] ? rows[0].data : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/state', auth, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Missing data' });
  try {
    const { rows } = await pool.query('SELECT data FROM ledger WHERE id = 1');
    const oldData = rows[0] ? rows[0].data : null;
    {
      const kept = checkBotVouchersKept(oldData, data);
      if (kept) return res.status(409).json({ error: kept });
    }
    if (req.user.role !== 'accountant') {
      const problem = checkOperatorChanges(oldData, data) || checkPayrollChanges(oldData, data) || checkPaymentChanges(oldData, data) || checkVoucherChanges(oldData, data) || checkExpensesLocked(oldData, data) || checkBankLocked(oldData, data);
      if (problem) return res.status(403).json({ error: problem });
    }
    // Chat messages are managed exclusively through /api/messages (appended atomically
    // there). A full-state save here always carries whatever the client last loaded, which
    // could be stale, so never let it overwrite messages someone else has sent since.
    data.messages = (oldData && Array.isArray(oldData.messages)) ? oldData.messages : (data.messages || []);
    await pool.query('UPDATE ledger SET data = $1, updated_at = now() WHERE id = 1', [
      JSON.stringify(data),
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM ledger WHERE id = 1');
    const messages = (rows[0] && Array.isArray(rows[0].data.messages)) ? rows[0].data.messages : [];
    res.json({ messages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/messages', auth, async (req, res) => {
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Message text is required' });
  if (text.length > 2000) return res.status(400).json({ error: 'Message is too long' });
  const message = { id: crypto.randomUUID(), from: req.user.name, text, at: new Date().toISOString() };
  try {
    // Atomic append via jsonb_set, so two people sending at the same moment can't clobber
    // each other the way a read-modify-write full-state save would.
    await pool.query(
      `UPDATE ledger SET data = jsonb_set(
         data, '{messages}',
         (COALESCE(data->'messages', '[]'::jsonb) || $1::jsonb)
       ), updated_at = now() WHERE id = 1`,
      [JSON.stringify([message])]
    );
    res.json({ message });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Invoice bot (Gmail mailbox + uploaded scans -> held for Aline's validation)
const bot = require('./bot').createBot({ pool, auth });
app.use('/api/bot', bot.router);

// Unknown API paths get a JSON 404 (not the web page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Fallback to the SPA for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Malformed or oversized requests get a short JSON error, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port ' + PORT));
