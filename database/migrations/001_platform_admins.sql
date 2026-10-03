CREATE TABLE IF NOT EXISTS platform_admins (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_email_lower_uq
  ON platform_admins (LOWER(email));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform_admins TO sai_app;
GRANT USAGE, SELECT ON SEQUENCE platform_admins_id_seq TO sai_app;
