import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  getIndMoneyMcpAdaptiveMinIntervalMs,
  getIndMoneyMcpBlockedUntil,
  noteIndMoneyMcpRateLimit,
  noteIndMoneyMcpSuccess,
  readIndMoneyMcpBudgetState,
  resolveIndMoneyMcpBudgetPath,
} from '../src/portfolio-alerts/indmoney-mcp-budget.js';

test('resolveIndMoneyMcpBudgetPath points at the daily budget file', () => {
  assert.equal(
    resolveIndMoneyMcpBudgetPath('/tmp/market'),
    '/tmp/market/data/indmoney-mcp-budget.json',
  );
});

test('budget state resets by IST day and tracks successful calls', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-budget-'));
  const budgetPath = path.join(tmpDir, 'budget.json');
  const now = Date.parse('2026-06-12T01:00:00.000Z');

  let state = await readIndMoneyMcpBudgetState(budgetPath, now);
  assert.equal(state.totalCalls, 0);

  await noteIndMoneyMcpSuccess(budgetPath, 'networth', now);
  state = await readIndMoneyMcpBudgetState(budgetPath, now);
  assert.equal(state.totalCalls, 1);
  assert.equal(state.tools.networth.calls, 1);
});

test('adaptive spacing grows as daily budget is consumed', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-budget-'));
  const budgetPath = path.join(tmpDir, 'budget.json');
  const now = Date.parse('2026-06-12T01:00:00.000Z');

  const initialSpacing = await getIndMoneyMcpAdaptiveMinIntervalMs(budgetPath, {
    now,
    minimumSpacingMs: 15_000,
  });

  for (let index = 0; index < 1000; index += 1) {
    await noteIndMoneyMcpSuccess(budgetPath, 'networth', now + index);
  }

  const laterSpacing = await getIndMoneyMcpAdaptiveMinIntervalMs(budgetPath, {
    now: now + 5_000,
    minimumSpacingMs: 15_000,
  });

  assert.equal(initialSpacing >= 15_000, true);
  assert.equal(laterSpacing > initialSpacing, true);
});

test('rate limit blocks all keys until retry window expires', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-budget-'));
  const budgetPath = path.join(tmpDir, 'budget.json');
  const now = Date.parse('2026-06-12T01:00:00.000Z');

  await noteIndMoneyMcpRateLimit(budgetPath, 'holdings:US_STOCK', 120, now);

  const blockedSameKey = await getIndMoneyMcpBlockedUntil(budgetPath, 'holdings:US_STOCK', now + 1);
  const blockedOtherKey = await getIndMoneyMcpBlockedUntil(budgetPath, 'networth', now + 1);

  assert.equal(blockedSameKey > now, true);
  assert.equal(blockedOtherKey > now, true);
});

test('default budget uses full daily quota when no reserve env is set', async () => {
  const previousReserve = process.env.INDMONEY_MCP_RESERVE_CALLS_PER_DAY;
  delete process.env.INDMONEY_MCP_RESERVE_CALLS_PER_DAY;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney-budget-'));
  const budgetPath = path.join(tmpDir, 'budget.json');
  const now = Date.parse('2026-06-12T00:00:00.000Z');

  const spacing = await getIndMoneyMcpAdaptiveMinIntervalMs(budgetPath, {
    now,
    minimumSpacingMs: 1,
  });

  assert.equal(spacing <= 20_000, true);

  if (previousReserve == null) {
    delete process.env.INDMONEY_MCP_RESERVE_CALLS_PER_DAY;
  } else {
    process.env.INDMONEY_MCP_RESERVE_CALLS_PER_DAY = previousReserve;
  }
});
