export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://localhost:5432/openclaw_token_dev',
  githubClientId: process.env.GITHUB_CLIENT_ID || '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  port: parseInt(process.env.PORT || '3000', 10),
};
