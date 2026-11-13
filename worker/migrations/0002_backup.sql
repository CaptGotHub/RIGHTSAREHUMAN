-- Run before 0002_rfh_positions.sql. Keeps an in-database copy of every row.
CREATE TABLE IF NOT EXISTS signatures_backup_0002 AS SELECT * FROM signatures;
