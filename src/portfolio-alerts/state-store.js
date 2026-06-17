import path from 'node:path';

import {
  appendJsonEvent,
  ensureJsonFile,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from './utils.js';

function buildDefaultState() {
  return {
    version: 1,
    updatedAt: null,
    currentDayKey: null,
    cooldowns: {},
    openTriggers: {},
    tickerSessionCounts: {},
    lastAlertByKey: {},
    threadRefs: {},
    intraday: {
      highPortfolioValueUsd: null,
      lowPortfolioValueUsd: null,
      highestUnrealizedProfitUsd: null,
      lowestUnrealizedProfitUsd: null,
      dayMaxProfitUsd: null,
    },
    dailySummary: {
      lastSentDayKey: null,
    },
  };
}

export async function ensureAlertStateFiles(config) {
  await ensureJsonFile(config.statePath, buildDefaultState());
  await ensureJsonFile(config.eventsPath, []);
}

export async function readAlertState(config) {
  const state = await readJsonFile(config.statePath, buildDefaultState());
  return state && typeof state === 'object' ? { ...buildDefaultState(), ...state } : buildDefaultState();
}

export async function writeAlertState(config, state) {
  const payload = {
    ...state,
    updatedAt: nowIso(),
  };
  await writeJsonFile(config.statePath, payload);
}

export async function appendAlertEvent(config, event) {
  await appendJsonEvent(config.eventsPath, { ...event, recordedAt: nowIso() });
}

export function resetDailyStateIfNeeded(state, marketDayKey) {
  if (state.currentDayKey === marketDayKey) {
    return state;
  }
  return {
    ...state,
    currentDayKey: marketDayKey,
    cooldowns: {},
    openTriggers: {},
    tickerSessionCounts: {},
    intraday: {
      highPortfolioValueUsd: null,
      lowPortfolioValueUsd: null,
      highestUnrealizedProfitUsd: null,
      lowestUnrealizedProfitUsd: null,
      dayMaxProfitUsd: null,
    },
    dailySummary: {
      lastSentDayKey: null,
    },
  };
}

export function updateIntradayState(state, portfolio) {
  const next = { ...state, intraday: { ...(state.intraday || {}) } };
  const currentValue = portfolio.summary.portfolioValueUsd;
  const currentProfit = portfolio.summary.unrealizedProfitUsd;
  next.intraday.highPortfolioValueUsd =
    next.intraday.highPortfolioValueUsd === null
      ? currentValue
      : Math.max(next.intraday.highPortfolioValueUsd, currentValue);
  next.intraday.lowPortfolioValueUsd =
    next.intraday.lowPortfolioValueUsd === null
      ? currentValue
      : Math.min(next.intraday.lowPortfolioValueUsd, currentValue);
  next.intraday.highestUnrealizedProfitUsd =
    next.intraday.highestUnrealizedProfitUsd === null
      ? currentProfit
      : Math.max(next.intraday.highestUnrealizedProfitUsd, currentProfit);
  next.intraday.lowestUnrealizedProfitUsd =
    next.intraday.lowestUnrealizedProfitUsd === null
      ? currentProfit
      : Math.min(next.intraday.lowestUnrealizedProfitUsd, currentProfit);
  next.intraday.dayMaxProfitUsd =
    next.intraday.dayMaxProfitUsd === null ? currentProfit : Math.max(next.intraday.dayMaxProfitUsd, currentProfit);
  return next;
}

export function getThreadRef(state, threadId) {
  return state.threadRefs?.[threadId] || null;
}

export function setThreadRef(state, threadId, ref) {
  return {
    ...state,
    threadRefs: {
      ...(state.threadRefs || {}),
      [threadId]: ref,
    },
  };
}

export function incrementTickerSessionCount(state, sessionKey, ticker, severity) {
  const key = `${sessionKey}:${ticker}:${severity}`;
  return {
    ...state,
    tickerSessionCounts: {
      ...(state.tickerSessionCounts || {}),
      [key]: (state.tickerSessionCounts?.[key] || 0) + 1,
    },
  };
}

export function getTickerSessionCount(state, sessionKey, ticker, severity) {
  return state.tickerSessionCounts?.[`${sessionKey}:${ticker}:${severity}`] || 0;
}

export function setCooldown(state, key, payload) {
  return {
    ...state,
    cooldowns: {
      ...(state.cooldowns || {}),
      [key]: payload,
    },
  };
}

export function setLastAlertByKey(state, key, payload) {
  return {
    ...state,
    lastAlertByKey: {
      ...(state.lastAlertByKey || {}),
      [key]: payload,
    },
  };
}

export function setOpenTrigger(state, key, payload) {
  return {
    ...state,
    openTriggers: {
      ...(state.openTriggers || {}),
      [key]: payload,
    },
  };
}

export function clearOpenTrigger(state, key) {
  if (!state.openTriggers?.[key]) {
    return state;
  }
  const next = { ...(state.openTriggers || {}) };
  delete next[key];
  return {
    ...state,
    openTriggers: next,
  };
}

export function markDailySummarySent(state, marketDayKey) {
  return {
    ...state,
    dailySummary: {
      ...(state.dailySummary || {}),
      lastSentDayKey: marketDayKey,
    },
  };
}

