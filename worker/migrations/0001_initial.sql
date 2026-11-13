-- 0001: schema as deployed on 2026-11-08 (recorded from the live D1 database).
CREATE TABLE signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  location TEXT,
  stance TEXT NOT NULL CHECK (stance IN ('fully-human','human-at-the-helm','people-first')),
  confirmation_only INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT NOT NULL,
  ip_hash TEXT,
  country TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT,
  email_sent_at TEXT
);
CREATE INDEX idx_sig_token ON signatures(verify_token);
CREATE INDEX idx_sig_ip_time ON signatures(ip_hash, created_at);
CREATE INDEX idx_sig_verified ON signatures(verified, stance);
