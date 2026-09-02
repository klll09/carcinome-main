-- 09_poc_observers.sql — every patient can carry a Carcinome POC (the intern
-- who owns that family's follow-up). The POC rides cases as an observer
-- participant: log-style milestone updates, never the raw message dump, plus
-- the STATUS keyword for an on-demand grouped digest of all their patients.

ALTER TYPE participant_role ADD VALUE IF NOT EXISTS 'poc';

ALTER TABLE patients ADD COLUMN IF NOT EXISTS poc_name TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS poc_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_patients_poc_phone ON patients (poc_phone) WHERE poc_phone IS NOT NULL;
