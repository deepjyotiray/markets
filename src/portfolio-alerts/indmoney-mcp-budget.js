import path from 'node:path';
import { ensureJsonFile, readJsonFile, writeJsonFile } from './utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_STATE = {
  dayKey: '',
  totalCalls: 0,
  tools: {},
};

function getIstDayKey(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMsUntilNextIstMidnight(now = Date.now()) {
  const istNow = now + IST_OFFSET_MS;
  const nextIstMidnight = (Math.floor(istNow / DAY_MS) + 1) * DAY_MS;
  return Math.max(1000, nextIstMidnight - istNow);
}

function getBudgetLimits() {
  const maxCallsPerDay = Math.max(1, Number(process.env.INDMONEY_MCP_MAX_CALLS_PER_DAY || 5000));
  const reserveCalls = Math.max(0, Number(process.env.INDMONEY_MCP_RESERVE_CALLS_PER_DAY || 0));
  const minimumSpacingMs = Math.max(1000, Number(process.env.INDMONEY_MCP_MIN_SPACING_MS || 15000));
  return {
    maxCallsPerDay,
    reserveCalls,
    effectiveCallsPerDay: Math.max(1, maxCallsPerDay - reserveCalls),
    minimumSpacingMs,
  };
}

function normalizeState(payload, now = Date.now()) {
  const dayKey = getIstDayKey(now);
  if (!payload || payload.dayKey !== dayKey) {
    return {
      dayKey,
      totalCalls: 0,
      tools: {},
    };
  }
  return {
    dayKey,
    totalCalls: Math.max(0, Number(payload.totalCalls || 0)),
    tools: payload.tools && typeof payload.tools === 'object' ? payload.tools : {},
  };
}

export function resolveIndMoneyMcpBudgetPath(projectRoot) {
  return path.join(projectRoot, 'data', 'indmoney-mcp-budget.json');
}

export async function readIndMoneyMcpBudgetState(filePath, now = Date.now()) {
  await ensureJsonFile(filePath, DEFAULT_STATE);
  return normalizeState(await readJsonFile(filePath, DEFAULT_STATE), now);
}

async function writeIndMoneyMcpBudgetState(filePath, state) {
  await ensureJsonFile(filePath, DEFAULT_STATE);
  await writeJsonFile(filePath, state);
}

export async function getIndMoneyMcpAdaptiveMinIntervalMs(filePath, options = {}) {
  const now = Number(options.now || Date.now());
  const limits = getBudgetLimits();
  const minimumSpacingMs = Math.max(limits.minimumSpacingMs, Number(options.minimumSpacingMs || 0));
  const state = await readIndMoneyMcpBudgetState(filePath, now);
  const remainingCalls = Math.max(1, limits.effectiveCallsPerDay - state.totalCalls);
  const remainingMs = getMsUntilNextIstMidnight(now);
  return Math.max(minimumSpacingMs, Math.ceil(remainingMs / remainingCalls));
}

export async function getIndMoneyMcpBlockedUntil(filePath, key, now = Date.now()) {
  const state = await readIndMoneyMcpBudgetState(filePath, now);
  return Math.max(
    0,
    Number(state.tools?.__global__?.blockedUntil || 0),
    Number(state.tools?.[key]?.blockedUntil || 0),
  );
}

export async function noteIndMoneyMcpSuccess(filePath, key, now = Date.now()) {
  const state = await readIndMoneyMcpBudgetState(filePath, now);
  const toolState = state.tools[key] && typeof state.tools[key] === 'object' ? state.tools[key] : {};
  state.totalCalls += 1;
  state.tools[key] = {
    ...toolState,
    calls: Math.max(0, Number(toolState.calls || 0)) + 1,
    lastSuccessAt: now,
    blockedUntil: 0,
  };
  await writeIndMoneyMcpBudgetState(filePath, state);
  return state;
}

export async function noteIndMoneyMcpRateLimit(filePath, key, retryAfterSeconds, now = Date.now()) {
  const state = await readIndMoneyMcpBudgetState(filePath, now);
  const toolState = state.tools[key] && typeof state.tools[key] === 'object' ? state.tools[key] : {};
  const globalState = state.tools.__global__ && typeof state.tools.__global__ === 'object' ? state.tools.__global__ : {};
  const blockedUntil = now + Math.max(1, Number(retryAfterSeconds || 60)) * 1000;
  state.tools[key] = {
    ...toolState,
    blockedUntil,
    lastRateLimitAt: now,
  };
  state.tools.__global__ = {
    ...globalState,
    blockedUntil,
    lastRateLimitAt: now,
  };
  await writeIndMoneyMcpBudgetState(filePath, state);
  return state;
}
