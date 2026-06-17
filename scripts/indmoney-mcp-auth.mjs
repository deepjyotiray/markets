#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { defaultAuthPath, writeAuthFile } from '../src/portfolio-alerts/indmoney-mcp-http-client.js';

const execFileAsync = promisify(execFile);
const ISSUER = process.env.INDMONEY_MCP_ISSUER || 'https://mcp.indmoney.com';
const SCOPES = process.env.INDMONEY_MCP_SCOPES || 'portfolio:read market:read';
const PORT = Number(process.env.INDMONEY_MCP_AUTH_PORT || 49321);
const HOST = '127.0.0.1';
const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;
const AUTH_PATH = process.env.INDMONEY_MCP_AUTH_PATH || defaultAuthPath();

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url} failed: ${payload.error_description || payload.error || response.status}`);
  }
  return payload;
}

async function openBrowser(url) {
  try {
    await execFileAsync('open', [url]);
  } catch {
    console.log(`Open this URL in your browser:\n${url}\n`);
  }
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (error || state !== expectedState || !code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('INDmoney MCP authorization failed. You can close this tab.');
        server.close();
        reject(new Error(error || 'OAuth state mismatch or missing code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('INDmoney MCP authorization complete. You can close this tab.');
      server.close();
      resolve(code);
    });
    server.listen(PORT, HOST, () => {});
  });
}

const metadata = await fetchJson(`${ISSUER}/.well-known/oauth-authorization-server`);
const registration = await fetchJson(metadata.registration_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Market Dashboard INDmoney MCP',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    scope: SCOPES,
  }),
});

const state = randomToken(24);
const codeVerifier = randomToken(64);
const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
const authorizeUrl = new URL(metadata.authorization_endpoint);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', registration.client_id);
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authorizeUrl.searchParams.set('scope', SCOPES);
authorizeUrl.searchParams.set('state', state);
authorizeUrl.searchParams.set('code_challenge', codeChallenge);
authorizeUrl.searchParams.set('code_challenge_method', 'S256');

console.log(`Starting INDmoney MCP OAuth callback on ${REDIRECT_URI}`);
await openBrowser(authorizeUrl.toString());
const code = await waitForCallback(state);

const tokenPayload = await fetchJson(metadata.token_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: registration.client_id,
    client_secret: registration.client_secret,
    code_verifier: codeVerifier,
  }).toString(),
});

await writeAuthFile(AUTH_PATH, {
  ...tokenPayload,
  client_id: registration.client_id,
  client_secret: registration.client_secret,
  issuer: ISSUER,
  scopes: SCOPES,
  token_endpoint: metadata.token_endpoint,
  expires_at: Date.now() + Math.max(0, Number(tokenPayload.expires_in || 3600)) * 1000,
  updated_at: new Date().toISOString(),
});

console.log(`INDmoney MCP auth saved to ${AUTH_PATH}`);
