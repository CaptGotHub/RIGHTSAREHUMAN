-- 0002: let the Rights for Humans (.org) form share the one signatures table.
-- * widens the stance CHECK to include 'for' / 'against'
-- * adds source, motivation, profession, opinion_text, publish_opinion
-- * adds token_issued_at (72h expiry) and cert_token (certificate link,
--   separate from the single-use verify_token, which becomes nullable)
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.
-- Run 0002_backup.sql first.

CREATE TABLE signatures_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  location TEXT,
  stance TEXT NOT NULL CHECK (stance IN ('fully-human','human-at-the-helm','people-first','for','against')),
  confirmation_only INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  ip_hash TEXT,
  country TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT,
  email_sent_at TEXT,
  source TEXT NOT NULL DEFAULT 'onlyuno' CHECK (source IN ('onlyuno','rfh')),
  motivation TEXT CHECK (motivation IS NULL OR motivation IN ('concern','involvement','profession')),
  profession TEXT,
  opinion_text TEXT CHECK (opinion_text IS NULL OR length(opinion_text) <= 1000),
  publish_opinion INTEGER NOT NULL DEFAULT 0,
  token_issued_at TEXT,
  cert_token TEXT UNIQUE
);

INSERT INTO signatures_new (id, name, email, location, stance, confirmation_only, verified, verify_token, ip_hash, country,
  user_agent, created_at, verified_at, email_sent_at, source, token_issued_at)
SELECT id, name, email, location, stance, confirmation_only, verified, verify_token, ip_hash, country,
  user_agent, created_at, verified_at, email_sent_at, 'onlyuno', COALESCE(email_sent_at, created_at)
FROM signatures;

DROP TABLE signatures;
ALTER TABLE signatures_new RENAME TO signatures;

CREATE INDEX idx_sig_token ON signatures(verify_token);
CREATE INDEX idx_sig_ip_time ON signatures(ip_hash, created_at);
CREATE INDEX idx_sig_verified ON signatures(verified, stance);
CREATE INDEX idx_sig_created ON signatures(created_at);
CREATE INDEX idx_sig_public ON signatures(verified, publish_opinion, verified_at);
