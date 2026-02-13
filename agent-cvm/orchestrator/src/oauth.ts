/**
 * OAuth flow manager — handles OAuth 2.0 + PKCE flows for service authentication.
 *
 * Token exchange happens entirely inside the CVM. The PWA only sees the
 * authorization URL and status updates — tokens never touch the browser.
 */

import type {
  MessageEnvelope,
  OAuthInitPayload,
} from '@luciaclaw/protocol';
import { setServiceCredential, getServiceCredential } from './vault.js';

interface OAuthConfig {
  service: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Pending PKCE challenges indexed by state parameter */
const pendingFlows = new Map<string, { service: string; account: string; codeVerifier: string; scopes: string[] }>();

async function getOAuthConfig(service: string): Promise<OAuthConfig | null> {
  const baseRedirectUri = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8080/oauth/callback';

  // Static config per provider (URLs are always fixed)
  const providers: Record<string, { authUrl: string; tokenUrl: string; envIdKey: string; envSecretKey: string; vaultService: string }> = {
    google: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      envIdKey: 'GOOGLE_CLIENT_ID',
      envSecretKey: 'GOOGLE_CLIENT_SECRET',
      vaultService: 'google_oauth_config',
    },
    slack: {
      authUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      envIdKey: 'SLACK_CLIENT_ID',
      envSecretKey: 'SLACK_CLIENT_SECRET',
      vaultService: 'slack_oauth_config',
    },
    github: {
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      envIdKey: 'GITHUB_CLIENT_ID',
      envSecretKey: 'GITHUB_CLIENT_SECRET',
      vaultService: 'github_oauth_config',
    },
  };

  const provider = providers[service];
  if (!provider) return null;

  // Vault-first: check for runtime-configured OAuth credentials
  let clientId = '';
  let clientSecret = '';
  const vaultValue = await getServiceCredential(provider.vaultService);
  if (vaultValue) {
    try {
      const parsed = JSON.parse(vaultValue);
      clientId = parsed.clientId || '';
      clientSecret = parsed.clientSecret || '';
    } catch {
      // Malformed vault entry — fall through to env vars
    }
  }

  // Env-var fallback
  if (!clientId) clientId = process.env[provider.envIdKey] || '';
  if (!clientSecret) clientSecret = process.env[provider.envSecretKey] || '';

  return {
    service,
    authUrl: provider.authUrl,
    tokenUrl: provider.tokenUrl,
    clientId,
    clientSecret,
    redirectUri: baseRedirectUri,
  };
}

/** Generate a PKCE code verifier and challenge */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = crypto.getRandomValues(new Uint8Array(32));
  const verifier = Buffer.from(array).toString('base64url');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(hash).toString('base64url');
  return { verifier, challenge };
}

/** Handle oauth.init — generate auth URL with PKCE and return it */
export async function handleOAuthInit(
  payload: OAuthInitPayload
): Promise<MessageEnvelope> {
  const oauthConfig = await getOAuthConfig(payload.service);
  if (!oauthConfig) {
    return {
      id: crypto.randomUUID(),
      type: 'oauth.status',
      timestamp: Date.now(),
      payload: {
        service: payload.service,
        authenticated: false,
      },
    };
  }

  if (!oauthConfig.clientId) {
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: {
        code: 1000,
        message: `OAuth not configured for ${payload.service} — missing client ID`,
      },
    };
  }

  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();

  // Store pending flow with account
  pendingFlows.set(state, {
    service: payload.service,
    account: payload.account || 'default',
    codeVerifier: verifier,
    scopes: payload.scopes,
  });

  // Auto-expire after 10 minutes
  setTimeout(() => pendingFlows.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: oauthConfig.clientId,
    redirect_uri: oauthConfig.redirectUri,
    response_type: 'code',
    scope: payload.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  const authUrl = `${oauthConfig.authUrl}?${params.toString()}`;

  return {
    id: crypto.randomUUID(),
    type: 'oauth.status',
    timestamp: Date.now(),
    payload: {
      service: payload.service,
      authenticated: false,
      authUrl,
      scopes: payload.scopes,
    },
  };
}

/** Handle OAuth callback from the redirect URL (called by Express route) */
export async function handleOAuthCallback(
  code: string,
  state: string
): Promise<MessageEnvelope> {
  const flow = pendingFlows.get(state);
  if (!flow) {
    return {
      id: crypto.randomUUID(),
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: {
        service: 'unknown',
        success: false,
        error: 'Invalid or expired OAuth state',
      },
    };
  }

  pendingFlows.delete(state);
  const oauthConfig = await getOAuthConfig(flow.service);
  if (!oauthConfig) {
    return {
      id: crypto.randomUUID(),
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: {
        service: flow.service,
        success: false,
        error: 'OAuth configuration not found',
      },
    };
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch(oauthConfig.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        code,
        redirect_uri: oauthConfig.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: flow.codeVerifier,
      }),
    });

    const tokenData = await tokenResponse.json() as any;

    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
    }

    // Store tokens encrypted in vault
    const tokenPayload = JSON.stringify({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
      token_type: tokenData.token_type || 'Bearer',
    });

    await setServiceCredential(
      flow.service,
      `${flow.service} OAuth`,
      'oauth',
      tokenPayload,
      flow.scopes,
      flow.account
    );

    console.log(`[oauth] Successfully authenticated ${flow.service}:${flow.account}`);

    return {
      id: crypto.randomUUID(),
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: {
        service: flow.service,
        success: true,
        grantedScopes: flow.scopes,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[oauth] Token exchange failed for ${flow.service}:`, message);

    return {
      id: crypto.randomUUID(),
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: {
        service: flow.service,
        success: false,
        error: message,
      },
    };
  }
}

/** Get a valid access token for a service, refreshing if expired */
export async function getAccessToken(service: string, account: string = 'default'): Promise<string | null> {
  const raw = await getServiceCredential(service, account);
  if (!raw) return null;

  const tokens = JSON.parse(raw);

  // If token is still valid (with 5-minute buffer), use it
  if (tokens.expires_at > Date.now() + 5 * 60 * 1000) {
    return tokens.access_token;
  }

  // Try to refresh
  if (!tokens.refresh_token) return null;

  const oauthConfig = await getOAuthConfig(service);
  if (!oauthConfig) return null;

  try {
    const refreshResponse = await fetch(oauthConfig.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const refreshData = await refreshResponse.json() as any;
    if (!refreshResponse.ok || refreshData.error) {
      throw new Error(refreshData.error_description || 'Refresh failed');
    }

    // Update stored tokens
    const updated = JSON.stringify({
      access_token: refreshData.access_token,
      refresh_token: refreshData.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (refreshData.expires_in || 3600) * 1000,
      token_type: refreshData.token_type || 'Bearer',
    });

    await setServiceCredential(service, `${service} OAuth`, 'oauth', updated, undefined, account);
    console.log(`[oauth] Refreshed token for ${service}:${account}`);

    return refreshData.access_token;
  } catch (err) {
    console.error(`[oauth] Token refresh failed for ${service}:`, err);
    return null;
  }
}
