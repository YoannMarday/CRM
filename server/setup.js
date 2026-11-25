require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

// CHANGE THESE PASSWORDS before or right after your first deploy.
const users = [
  { username: 'aline', password: 'changeme1', display_name: 'Aline', role: 'operator' },
  { username: 'vikash', password: 'changeme2', display_name: 'Vikash', role: 'operator' },
  { username: 'priya', password: 'changeme3', display_name: 'Priya', role: 'accountant' },
];

(async () => {
  try {
    console.log('Applying database schema...');
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Schema ready.');

    // Safe on every deploy: users that already exist keep their current password.
    // (Previously every deploy reset all passwords back to the defaults below.)
    // To deliberately reset passwords to the values below, run:  RESET_PASSWORDS=1 npm run setup
    const reset = process.env.RESET_PASSWORDS === '1';
    const created = [];
    for (const u of users) {
      // Passwords can be set from the Render dashboard (Environment tab) with PASSWORD_ALINE, PASSWORD_VIKASH, PASSWORD_PRIYA.
      // If one is set (10+ characters) it becomes that person's password on this deploy.
      const envPw = process.env['PASSWORD_' + u.username.toUpperCase()];
      if (envPw && envPw.length < 10) {
        console.log('PASSWORD_' + u.username.toUpperCase() + ' is shorter than 10 characters, so it was ignored.');
      }
      const chosen = envPw && envPw.length >= 10 ? envPw : null;
      const hash = await bcrypt.hash(chosen || u.password, chosen ? 12 : 10);
      const { rowCount } = await pool.query(
        (reset || chosen)
          ? `INSERT INTO users (username, password_hash, display_name, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (username) DO UPDATE SET password_hash = $2, display_name = $3, role = $4`
          : `INSERT INTO users (username, password_hash, display_name, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (username) DO NOTHING`,
        [u.username, hash, u.display_name, u.role]
      );
      if (chosen) console.log('Password set from the environment setting for: ' + u.username);
      else if (rowCount) { created.push(u); console.log((reset ? 'Set user: ' : 'Created user: ') + u.username); }
      else console.log('User already exists, password kept: ' + u.username);
    }

    console.log('\nSetup complete!');
    if (created.length) {
      console.log('New accounts start with these passwords:');
      created.forEach(u => console.log(`  ${u.username} / ${u.password}  (${u.role})`));
      console.log('\nChange them right away:  set PASSWORD_<NAME> in the Render Environment tab (see README section 17)');
    }
  } catch (e) {
    console.error('Setup failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
