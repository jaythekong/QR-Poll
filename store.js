'use strict';

// Optional Postgres persistence. When DATABASE_URL is set (e.g. a Neon database),
// the whole app state is saved to / loaded from a single JSONB row, so votes,
// sessions and the poll config survive restarts and redeploys. When it isn't
// set, the app runs purely in-memory (local dev / no-DB mode) as before.

const { Pool } = require('pg');

const URL = (process.env.DATABASE_URL || '').trim();
const enabled = !!URL;
let pool = null;

if (enabled) {
  pool = new Pool({
    connectionString: URL,
    // Managed Postgres (Neon/Render/etc.) requires SSL; local Postgres doesn't.
    ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
    max: 4
  });
  if (typeof pool.on === 'function') {
    pool.on('error', (e) => console.error('  [db] pool error:', e.message));
  }
}

// Create the table if needed and return the saved state (or null if empty).
async function init() {
  if (!pool) return null;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS poll_state (
       id int PRIMARY KEY,
       data jsonb NOT NULL,
       updated_at timestamptz DEFAULT now()
     )`
  );
  const r = await pool.query('SELECT data FROM poll_state WHERE id = 1');
  return r.rows[0] ? r.rows[0].data : null;
}

// Upsert the entire app state into the single row.
async function save(data) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO poll_state (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [data]
  );
}

module.exports = { enabled, init, save };
