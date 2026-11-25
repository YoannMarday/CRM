CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator','accountant'))
);

-- Single JSON "blob" table holding the whole company ledger.
-- Simple and reliable at this scale (a handful of users, modest data volume).
-- A future iteration could normalize this into per-entity tables if the
-- team needs finer-grained server-side permissions or reporting queries.
CREATE TABLE IF NOT EXISTS ledger (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{"invoices":[],"revenueEntries":[],"bankBatches":[],"bankLines":[],"expenses":[]}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO ledger (id, data)
VALUES (1, '{"invoices":[],"revenueEntries":[],"bankBatches":[],"bankLines":[],"expenses":[]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Invoice bot: invoices read from the mailbox / uploaded scans, held until Aline validates them.
CREATE TABLE IF NOT EXISTS bot_invoices (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_ref TEXT,
  from_addr TEXT,
  subject TEXT,
  filename TEXT,
  mime TEXT,
  file BYTEA,
  file_hash TEXT,
  extracted JSONB,
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft JSONB,
  supplier_id TEXT,
  invoice_no TEXT,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','validated','rejected')),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  handled_by TEXT,
  handled_at TIMESTAMPTZ,
  voucher_id TEXT,
  voucher_no TEXT,
  reject_reason TEXT
);
CREATE INDEX IF NOT EXISTS bot_invoices_hash_idx ON bot_invoices (file_hash);
CREATE INDEX IF NOT EXISTS bot_invoices_supplier_idx ON bot_invoices (supplier_id, invoice_no);
CREATE TABLE IF NOT EXISTS bot_mail_seen (
  message_id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_meta (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
