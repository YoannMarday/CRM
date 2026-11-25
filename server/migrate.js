// One-time helper: copies your company data from the OLD Render database to Neon.
// Needs two settings: OLD_DATABASE_URL (Render) and DATABASE_URL (Neon).
require('dotenv').config();
const { Pool } = require('pg');
const make = (u) => new Pool({
  connectionString: u,
  ssl: /localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false },
});

(async () => {
  const oldUrl = process.env.OLD_DATABASE_URL, newUrl = process.env.DATABASE_URL;
  if (!oldUrl || !newUrl) { console.error('Set both OLD_DATABASE_URL and DATABASE_URL first.'); process.exit(1); }
  const from = make(oldUrl), to = make(newUrl);
  try {
    const { rows } = await from.query('SELECT data FROM ledger WHERE id = 1');
    if (!rows[0]) { console.log('No data found in the old database.'); return; }
    await to.query(
      `INSERT INTO ledger (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [JSON.stringify(rows[0].data)]
    );
    console.log('Done. Your data is now in Neon.');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await from.end(); await to.end();
  }
})();
