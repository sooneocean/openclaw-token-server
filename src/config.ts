export const config = {
  get databaseUrl() { return process.env.DATABASE_URL || 'postgres://localhost:5432/openclaw_token_dev'; },
  get githubClientId() { return process.env.GITHUB_CLIENT_ID || ''; },
  get githubClientSecret() { return process.env.GITHUB_CLIENT_SECRET || ''; },
  get port() { return parseInt(process.env.PORT || '3000', 10); },
};
