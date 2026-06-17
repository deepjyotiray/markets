import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { createIndMoneyMcpHttpClient, readAuthFile, writeAuthFile } from '../src/portfolio-alerts/indmoney-mcp-http-client.js';

test('writeAuthFile writes both primary and backup auth files', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-auth-'));
  const authPath = path.join(tmpDir, 'auth.json');
  const payload = {
    access_token: 'token-1',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3600_000,
  };

  await writeAuthFile(authPath, payload);

  const primary = JSON.parse(await fsp.readFile(authPath, 'utf8'));
  const backup = JSON.parse(await fsp.readFile(`${authPath}.bak`, 'utf8'));

  assert.equal(primary.access_token, 'token-1');
  assert.equal(backup.access_token, 'token-1');
});

test('readAuthFile falls back to backup when the primary file is missing', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-auth-'));
  const authPath = path.join(tmpDir, 'auth.json');
  const payload = {
    access_token: 'token-2',
    refresh_token: 'refresh-2',
    expires_at: Date.now() + 3600_000,
  };

  await writeAuthFile(authPath, payload);
  await fsp.rm(authPath, { force: true });

  const restored = await readAuthFile(authPath);
  assert.equal(restored.access_token, 'token-2');
});

test('client refreshes expired cached token without a process restart', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-auth-'));
  const authPath = path.join(tmpDir, 'auth.json');
  await writeAuthFile(authPath, {
    access_token: 'stale-token',
    refresh_token: 'refresh-token',
    client_id: 'client-id',
    client_secret: 'client-secret',
    expires_at: Date.now() - 1000,
  });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ result: { ok: true } }),
    };
  };

  try {
    const client = createIndMoneyMcpHttpClient({
      authPath,
      mcpUrl: 'https://example.com/mcp',
      tokenUrl: 'https://example.com/token',
    });
    const result = await client.callTool('networth_snapshot', {});
    assert.deepEqual(result, { ok: true });
    assert.equal(calls[0].url, 'https://example.com/token');
    assert.match(String(calls[1].options.headers.Authorization), /Bearer fresh-token/);
  } finally {
    global.fetch = originalFetch;
  }
});
