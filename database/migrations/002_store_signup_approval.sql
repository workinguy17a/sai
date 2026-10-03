ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('pending_approval', 'active', 'suspended'));

GRANT UPDATE ON TABLE stores TO sai_app;
