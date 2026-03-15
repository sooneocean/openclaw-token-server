export const config = {
  get databaseUrl() { return process.env.DATABASE_URL || 'postgres://localhost:5432/openclaw_token_dev'; },
  get githubClientId() { return process.env.GITHUB_CLIENT_ID || ''; },
  get githubClientSecret() { return process.env.GITHUB_CLIENT_SECRET || ''; },
  get port() { return parseInt(process.env.PORT || '3000', 10); },
  // 上游 LLM API 設定
  get upstreamApiKey() { return process.env.UPSTREAM_API_KEY || ''; },
  get upstreamApiBase() { return process.env.UPSTREAM_API_BASE || 'https://api.openai.com'; },
  // Stripe 設定
  get stripeSecretKey() { return process.env.STRIPE_SECRET_KEY || ''; },
  get stripeWebhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ''; },
  get appBaseUrl() { return process.env.APP_BASE_URL || 'http://localhost:3000'; },
};
