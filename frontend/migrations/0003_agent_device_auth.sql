-- D1 schema for OIDC PKCE Device Flow sessions (headless CLI login bridge)

CREATE TABLE IF NOT EXISTS agent_device_sessions (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  oauth_state TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  status TEXT NOT NULL,
  auth_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_device_expires ON agent_device_sessions(expires_at);
