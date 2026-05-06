-- migrations/0079_claudia_documents_seq.sql
--
-- Add a per-user monotonic sequence number to claudia_documents so
-- Wes (and Claudia) can refer to docs by short "#N" identifiers
-- instead of UUIDs, and Claudia can answer "anything since #N?" with
-- a clean diff of new arrivals — fixing the freshness/dup confusion
-- where similar filenames across batches got conflated.
--
-- Per-user, not global, so each user's numbering starts at 1 and
-- doesn't leak counts across mailboxes.

ALTER TABLE claudia_documents ADD COLUMN seq INTEGER;

-- Backfill existing rows in (user_id, created_at, id) order. The id
-- tiebreaker keeps the assignment deterministic when timestamps
-- collide. Correlated subquery (vs UPDATE FROM) for max SQLite
-- compatibility.
UPDATE claudia_documents
   SET seq = (
     SELECT row_num FROM (
       SELECT id,
              ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) AS row_num
         FROM claudia_documents
     ) AS numbered
      WHERE numbered.id = claudia_documents.id
   )
 WHERE seq IS NULL;

-- Concurrent inserts could race on `MAX(seq)+1`; the unique index
-- makes the loser fail loudly with a constraint violation rather than
-- quietly clobbering a number. Only Wes uses this today so a true
-- collision is unlikely, but the index also speeds up `since=N`
-- range scans in list_documents.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claudia_documents_user_seq
  ON claudia_documents(user_id, seq);
