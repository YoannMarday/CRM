require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

// Neon (and Render) need a secure connection. Only a database on your own computer does not.
const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  // Neon's free database sleeps when idle; give it time to wake up.
  connectionTimeoutMillis: 15000,
});

// Without this, a dropped idle connection (normal on Neon) could crash the app.
pool.on('error', (err) => console.error('Database connection error (ignored):', err.message));

module.exports = pool;
