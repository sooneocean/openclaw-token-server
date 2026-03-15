import { Hono } from 'hono';
import type { Sql } from '../db/client';
import { AppError } from '../errors';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';
import { generateManagementKey, generateDeviceCode, generateUserCode } from '../utils/token';

export function oauthRoutes(sql: Sql) {
  const app = new Hono();

  // POST /oauth/device/code
  app.post('/device/code', async (c) => {
    const body = await c.req.json();
    const { client_id } = body;

    if (!client_id) {
      throw new AppError('INVALID_INPUT', 'client_id is required', 400);
    }

    if (client_id !== config.githubClientId) {
      throw new AppError('INVALID_INPUT', 'Invalid client_id', 400);
    }

    // Call GitHub Device Flow
    let ghResponse: any;
    try {
      const res = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ client_id, scope: 'read:user user:email' }),
      });
      ghResponse = await res.json();
    } catch {
      throw new AppError('GITHUB_UNAVAILABLE', 'GitHub API is unreachable', 502);
    }

    if (ghResponse.error) {
      throw new AppError('GITHUB_ERROR', ghResponse.error_description || ghResponse.error, 502);
    }

    // Store session
    const deviceCode = ghResponse.device_code;
    const userCode = ghResponse.user_code;
    const expiresAt = new Date(Date.now() + (ghResponse.expires_in || 900) * 1000);

    await sql`
      INSERT INTO oauth_sessions (device_code, user_code, client_id, expires_at)
      VALUES (${deviceCode}, ${userCode}, ${client_id}, ${expiresAt})
    `;

    return c.json({
      data: {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: ghResponse.verification_uri || 'https://github.com/login/device',
        interval: ghResponse.interval || 5,
        expires_in: ghResponse.expires_in || 900,
      },
    });
  });

  // POST /oauth/device/token
  app.post('/device/token', async (c) => {
    const body = await c.req.json();
    const { device_code, grant_type } = body;

    if (!device_code) {
      return c.json({ error: 'bad_device_code', error_description: 'device_code is required' }, 400);
    }

    // Check session
    const sessions = await sql`
      SELECT id, status, expires_at, github_access_token
      FROM oauth_sessions WHERE device_code = ${device_code}
    `;

    if (sessions.length === 0) {
      return c.json({ error: 'bad_device_code', error_description: 'Invalid device code' }, 400);
    }

    const session = sessions[0];

    if (new Date() > session.expires_at) {
      await sql`UPDATE oauth_sessions SET status = 'expired' WHERE id = ${session.id}`;
      return c.json({ error: 'expired_token', error_description: 'Device code has expired' }, 400);
    }

    if (session.status === 'authorized' && session.github_access_token) {
      return c.json({
        data: {
          access_token: session.github_access_token,
          token_type: 'bearer',
        },
      });
    }

    // Poll GitHub
    let ghResponse: any;
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: config.githubClientId,
          device_code,
          grant_type: grant_type || 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      ghResponse = await res.json();
    } catch {
      throw new AppError('GITHUB_UNAVAILABLE', 'GitHub API is unreachable', 502);
    }

    if (ghResponse.error === 'authorization_pending') {
      return c.json({ error: 'authorization_pending', error_description: 'Waiting for user authorization' }, 400);
    }

    if (ghResponse.error === 'slow_down') {
      return c.json({ error: 'slow_down', error_description: 'Please slow down polling', interval: (ghResponse.interval || 10) }, 400);
    }

    if (ghResponse.error === 'expired_token') {
      await sql`UPDATE oauth_sessions SET status = 'expired' WHERE id = ${session.id}`;
      return c.json({ error: 'expired_token', error_description: 'Device code has expired' }, 400);
    }

    if (ghResponse.error) {
      return c.json({ error: ghResponse.error, error_description: ghResponse.error_description }, 400);
    }

    // Success - store access token
    const accessToken = ghResponse.access_token;
    await sql`
      UPDATE oauth_sessions
      SET github_access_token = ${accessToken}, status = 'authorized'
      WHERE id = ${session.id}
    `;

    return c.json({
      data: {
        access_token: accessToken,
        token_type: ghResponse.token_type || 'bearer',
      },
    });
  });

  // GET /oauth/userinfo
  app.get('/userinfo', authMiddleware(sql), async (c) => {
    const userId = c.get('userId');

    // Find the most recent authorized session for this user
    const sessions = await sql`
      SELECT github_access_token
      FROM oauth_sessions
      WHERE user_id = ${userId} AND status = 'authorized' AND github_access_token IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `;

    // Also try sessions by looking up via management key
    let ghToken: string | null = null;
    if (sessions.length > 0) {
      ghToken = sessions[0].github_access_token;
    } else {
      // Check if there's an authorized session not yet linked to user
      const unlinked = await sql`
        SELECT id, github_access_token
        FROM oauth_sessions
        WHERE status = 'authorized' AND github_access_token IS NOT NULL AND user_id IS NULL
        ORDER BY created_at DESC LIMIT 1
      `;
      if (unlinked.length > 0) {
        ghToken = unlinked[0].github_access_token;
        await sql`UPDATE oauth_sessions SET user_id = ${userId} WHERE id = ${unlinked[0].id}`;
      }
    }

    if (!ghToken) {
      throw new AppError('UNAUTHORIZED', 'No authorized OAuth session found', 401);
    }

    // Fetch GitHub user info
    let ghUser: any;
    let ghEmails: any[];
    try {
      const [userRes, emailsRes] = await Promise.all([
        fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/json' },
        }),
        fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/json' },
        }),
      ]);
      ghUser = await userRes.json();
      ghEmails = await emailsRes.json();
    } catch {
      throw new AppError('GITHUB_UNAVAILABLE', 'GitHub API is unreachable', 502);
    }

    const primaryEmail = Array.isArray(ghEmails)
      ? ghEmails.find((e: any) => e.primary)?.email || ghEmails[0]?.email
      : ghUser.email;

    if (!primaryEmail) {
      throw new AppError('EMAIL_REQUIRED', 'GitHub account must have a public email', 400);
    }

    const githubId = ghUser.id;
    const avatarUrl = ghUser.avatar_url;
    const name = ghUser.name || ghUser.login;

    // Upsert user
    let merged = false;
    let managementKey: string;

    const existingByGithub = await sql`SELECT id FROM users WHERE github_id = ${githubId}`;
    const existingByEmail = await sql`SELECT id, github_id FROM users WHERE email = ${primaryEmail}`;

    if (existingByGithub.length > 0) {
      // User already linked via GitHub
      const uid = existingByGithub[0].id;
      await sql`UPDATE users SET avatar_url = ${avatarUrl}, updated_at = now() WHERE id = ${uid}`;
      merged = true;

      const [mk] = await sql`
        SELECT key_value FROM management_keys WHERE user_id = ${uid} AND is_revoked = false ORDER BY created_at DESC LIMIT 1
      `;
      managementKey = mk.key_value;
    } else if (existingByEmail.length > 0) {
      // Merge: email exists but no github_id
      const uid = existingByEmail[0].id;
      await sql`UPDATE users SET github_id = ${githubId}, avatar_url = ${avatarUrl}, updated_at = now() WHERE id = ${uid}`;
      merged = true;

      const [mk] = await sql`
        SELECT key_value FROM management_keys WHERE user_id = ${uid} AND is_revoked = false ORDER BY created_at DESC LIMIT 1
      `;
      managementKey = mk.key_value;
    } else {
      // New user
      managementKey = generateManagementKey();

      await sql.begin(async (tx) => {
        const [user] = await tx`
          INSERT INTO users (email, github_id, avatar_url)
          VALUES (${primaryEmail}, ${githubId}, ${avatarUrl})
          RETURNING id
        `;

        await tx`INSERT INTO management_keys (user_id, key_value) VALUES (${user.id}, ${managementKey})`;
        await tx`INSERT INTO credit_balances (user_id) VALUES (${user.id})`;
      });
    }

    return c.json({
      data: {
        management_key: managementKey,
        email: primaryEmail,
        name,
        avatar_url: avatarUrl,
        merged,
      },
    });
  });

  return app;
}
