-- Drop obsolete Device Flow table after switching to Cloudflare Access Managed OAuth

DROP TABLE IF EXISTS agent_device_sessions;
