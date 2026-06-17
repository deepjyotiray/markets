import fs from 'node:fs';
import fsp from 'node:fs/promises';

const DEFAULT_MCP_URL = 'https://mcp.indmoney.com/mcp';
const DEFAULT_TOKEN_URL = 'https://mcp.indmoney.com/token';

function defaultAuthBackupPath(filePath) {
  return `${filePath}.bak`;
}

function parseMcpHttpResponse(text, contentType = '') {
  if (contentType.includes('text/event-stream')) {
    const dataLines = String(text || '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines.at(-1);
    return last ? JSON.parse(last) : null;
  }
  return text ? JSON.parse(text) : null;
}

function defaultAuthPath() {
  return `${process.env.HOME || process.cwd()}/.codex/indmoney-mcp-market-auth.json`;
}

async function readAuthFile(filePath) {
  if (!filePath) {
    return null;
  }
  const candidates = [filePath, defaultAuthBackupPath(filePath)];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      return JSON.parse(await fsp.readFile(candidate, 'utf8'));
    } catch {
      continue;
    }
  }
  return null;
}

function readAuthFileSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAuthFile(filePath, payload) {
  await fsp.mkdir(filePath.split('/').slice(0, -1).join('/'), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(filePath, 0o600).catch(() => {});
  const backupPath = defaultAuthBackupPath(filePath);
  await fsp.writeFile(backupPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(backupPath, 0o600).catch(() => {});
}

export function createIndMoneyMcpHttpClient(options = {}) {
  const mcpUrl = options.mcpUrl || process.env.INDMONEY_MCP_URL || DEFAULT_MCP_URL;
  const tokenUrl = options.tokenUrl || process.env.INDMONEY_MCP_TOKEN_URL || DEFAULT_TOKEN_URL;
  const authPath = options.authPath || process.env.INDMONEY_MCP_AUTH_PATH || defaultAuthPath();
  let bearerToken = options.bearerToken || process.env.INDMONEY_MCP_BEARER_TOKEN || '';
  let bearerTokenExpiresAt = options.bearerToken ? Number.MAX_SAFE_INTEGER : 0;
  let sessionId = null;
  let initializePromise = null;

  function clearRuntimeAuthState() {
    bearerToken = '';
    bearerTokenExpiresAt = 0;
    sessionId = null;
    initializePromise = null;
  }

  async function refreshBearerTokenIfNeeded() {
    if (bearerToken && Date.now() < bearerTokenExpiresAt - 60_000) {
      return bearerToken;
    }
    const auth = await readAuthFile(authPath);
    if (!auth?.access_token) {
      throw new Error(`INDmoney MCP auth is missing. Run scripts/indmoney-mcp-auth.mjs or set INDMONEY_MCP_BEARER_TOKEN.`);
    }
    const expiresAt = Number(auth.expires_at || 0);
    if (!auth.refresh_token || !auth.client_id || !auth.client_secret || Date.now() < expiresAt - 60_000) {
      bearerToken = auth.access_token;
      bearerTokenExpiresAt = expiresAt || (Date.now() + 55 * 60_000);
      return bearerToken;
    }
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: auth.client_id,
      client_secret: auth.client_secret,
    });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`INDmoney MCP token refresh failed: ${payload.error_description || payload.error || response.status}`);
    }
    const nextAuth = {
      ...auth,
      ...payload,
      refresh_token: payload.refresh_token || auth.refresh_token,
      expires_at: Date.now() + Math.max(0, Number(payload.expires_in || 3600)) * 1000,
      updated_at: new Date().toISOString(),
    };
    await writeAuthFile(authPath, nextAuth);
    bearerToken = nextAuth.access_token;
    bearerTokenExpiresAt = Number(nextAuth.expires_at || 0) || (Date.now() + 55 * 60_000);
    return bearerToken;
  }

  async function rpc(method, params, { notification = false, allowRetry = true } = {}) {
    const token = await refreshBearerTokenIfNeeded();
    const body = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: `${Date.now()}:${Math.random()}`, method, params };
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const nextSessionId = response.headers.get('mcp-session-id');
    if (nextSessionId) {
      sessionId = nextSessionId;
    }
    const text = await response.text();
    const payload = parseMcpHttpResponse(text, response.headers.get('content-type') || '');
    if (!response.ok || payload?.error) {
      const message = payload?.error?.message || payload?.error_description || payload?.error || `HTTP ${response.status}`;
      if (
        allowRetry &&
        !notification &&
        (
          response.status === 401
          || /authentication required|unauthorized|invalid token|token expired/i.test(String(message))
        )
      ) {
        clearRuntimeAuthState();
        return rpc(method, params, { notification, allowRetry: false });
      }
      throw new Error(`INDmoney MCP ${method} failed: ${message}`);
    }
    return payload?.result ?? payload ?? null;
  }

  async function initialize() {
    if (!initializePromise) {
      initializePromise = (async () => {
        await rpc('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'market-dashboard', version: '1.0.0' },
        });
        await rpc('notifications/initialized', {}, { notification: true }).catch(() => null);
      })();
    }
    return initializePromise;
  }

  return {
    async callTool(name, args = {}) {
      await initialize();
      return rpc('tools/call', { name, arguments: args });
    },
  };
}

export function hasIndMoneyMcpHttpAuth(options = {}) {
  const authPath = options.authPath || process.env.INDMONEY_MCP_AUTH_PATH || defaultAuthPath();
  if (options.bearerToken || process.env.INDMONEY_MCP_BEARER_TOKEN) {
    return true;
  }
  const auth = readAuthFileSync(authPath);
  if (!auth?.access_token) {
    return false;
  }
  const expiresAt = Number(auth.expires_at || 0);
  if (!expiresAt || Date.now() < expiresAt - 60_000) {
    return true;
  }
  return Boolean(auth.refresh_token && auth.client_id && auth.client_secret);
}

export { defaultAuthPath, readAuthFile, writeAuthFile };
