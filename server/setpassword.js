// Change one user's password safely (it also signs that user out everywhere else).
// Usage (Render Shell, or locally):   cd server && npm run passwd -- aline "a-long-new-password"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

const COMMON = ['changeme1', 'changeme2', 'changeme3', 'password', '1234567890', 'qwertyuiop'];

(async () => {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: npm run passwd -- <username> "<new password>"');
    process.exit(1);
  }
  if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
  if (COMMON.includes(password.toLowerCase()) || password.toLowerCase() === username.toLowerCase()) {
    console.error('That password is too easy to guess. Choose another.'); process.exit(1);
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rowCount } = await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [hash, username]);
    if (!rowCount) { console.error('No such user: ' + username); process.exitCode = 1; return; }
    console.log('Password updated for ' + username + '. Any existing sessions for this user will be signed out within a minute.');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
