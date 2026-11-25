require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

// CHANGE THESE PASSWORDS before or right after your first deploy.
const users = [
  { username: 'aline', password: 'changeme1', display_name: 'Aline', role: 'operator' },
  { username: 'vikash', password: 'changeme2', display_name: 'Vikash', role: 'operator' },
  { username: 'priya', password: 'changeme3', display_name: 'Priya', role: 'accountant' },
];

(async () => {
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, display_name = $3, role = $4`,
      [u.username, hash, u.display_name, u.role]
    );
    console.log('Seeded user:', u.username);
  }
  await pool.end();
  console.log('Done. Remember to change these default passwords.');
})();
