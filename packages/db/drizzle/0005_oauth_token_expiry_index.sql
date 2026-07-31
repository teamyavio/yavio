-- pruneExpired deletes from oauth_tokens by expiry, but neither expiry column
-- was indexed — so the sweep sequentially scanned and row-locked the whole
-- table, on the hot path of ~1% of token requests. The table grows one row per
-- rotation per grant (hourly refreshes ≈ 720 rows/grant/month), so this only
-- gets worse with use.

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_expiry
  ON oauth_tokens (access_token_expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_expiry
  ON oauth_tokens (refresh_token_expires_at)
  WHERE refresh_token_expires_at IS NOT NULL;
