import path from 'node:path';
import { createIndMoneyMcpProvider } from './indmoney-mcp.js';
import {
  getIndMoneyMcpAdaptiveMinIntervalMs,
  getIndMoneyMcpBlockedUntil,
  noteIndMoneyMcpRateLimit,
  noteIndMoneyMcpSuccess,
} from './indmoney-mcp-budget.js';
import { normalizeIndMoneyHoldings } from './indmoney-dashboard.js';
import { createIndMoneyMcpHttpClient, hasIndMoneyMcpHttpAuth } from './indmoney-mcp-http-client.js';
import { ensureJsonFile, nowIso, readJsonFile, round, toNumber, writeJsonFile } from './utils.js';
import {
  getHistoricalDailyPrices,
  getHistoricalMinutePrices,
  getLivePrices,
  getPreviousClosePrices,
  getPriceSession,
} from './indmoney2-price-service.js';

export const INDMONEY2_BASELINE_DATE = '2026-06-05';

const DEFAULT_FX_CONFIG = {
  manualActualInvestedUsd: null,
  effectiveUsdInrRate: null,
  lastMcpTotalInvestedInr: null,
  manualHoldingInvestedUsd: {},
  portfolioStartDate: null,
  updatedAt: null,
};

const DEFAULT_HOLDINGS_CACHE = {
  payload: null,
  fetchedAt: 0,
};

const serviceState = {
  holdingsCacheByPath: new Map(),
  rateLimitedUntil: 0,
};

function holdingsCacheKey(filePath) {
  return filePath || '__default__';
}

function getServiceHoldingsCache(filePath) {
  const key = holdingsCacheKey(filePath);
  if (!serviceState.holdingsCacheByPath.has(key)) {
    serviceState.holdingsCacheByPath.set(key, {
      payload: null,
      fetchedAt: 0,
    });
  }
  return serviceState.holdingsCacheByPath.get(key);
}

function setServiceHoldingsCache(filePath, value) {
  serviceState.holdingsCacheByPath.set(holdingsCacheKey(filePath), {
    payload: value?.payload || null,
    fetchedAt: Number(value?.fetchedAt || 0),
  });
}

function normalizeTicker(value = '') {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
}

function dedupeWarnings(list = []) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

function formatEtMinuteLabel(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function etDateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function etTimestampMs(year, month, day, hour = 0, minute = 0) {
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute);
  const probeParts = etDateParts(approxUtc);
  if (!probeParts) return null;
  return approxUtc + (
    ((year - probeParts.year) * 525600)
    + ((month - probeParts.month) * 43200)
    + ((day - probeParts.day) * 1440)
    + ((hour - probeParts.hour) * 60)
    + (minute - probeParts.minute)
  ) * 60000;
}

function currentMarketDayEnvelope(value) {
  const parts = etDateParts(value);
  if (!parts) return null;
  return {
    startMs: etTimestampMs(parts.year, parts.month, parts.day, 4, 0),
    endMs: etTimestampMs(parts.year, parts.month, parts.day, 20, 0),
    marketTimezone: 'America/New_York',
  };
}

function currentMarketWeekEnvelope(value) {
  const parts = etDateParts(value);
  if (!parts) return null;
  const middayMs = etTimestampMs(parts.year, parts.month, parts.day, 12, 0);
  const weekday = new Date(middayMs).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const fridayOffset = mondayOffset + 4;
  const mondayParts = etDateParts(middayMs + mondayOffset * 86400000);
  const fridayParts = etDateParts(middayMs + fridayOffset * 86400000);
  return {
    startMs: etTimestampMs(mondayParts.year, mondayParts.month, mondayParts.day, 4, 0),
    endMs: etTimestampMs(fridayParts.year, fridayParts.month, fridayParts.day, 20, 0),
    marketTimezone: 'America/New_York',
  };
}

function floorTimestampMs(timestamp, intervalMs) {
  const value = toNumber(timestamp);
  const interval = Math.max(1, Number(intervalMs) || 1);
  if (value === null) {
    return null;
  }
  return Math.floor(value / interval) * interval;
}

function sumValue(rows = [], field) {
  return round((Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + (toNumber(row?.[field]) || 0), 0), 2) || 0;
}

async function readPersistedPortfolioSeries(filePath, warnings = []) {
  if (!filePath) {
    return [];
  }
  const payload = await readJsonFile(filePath, []);
  const rows = (Array.isArray(payload) ? payload : [])
    .map((row) => {
      const timestamp = floorTimestampMs(new Date(row?.timestamp || row?.updatedAt || row?.time || '').getTime(), 60 * 1000);
      const portfolioValueUsd = toNumber(row?.currentValue ?? row?.portfolioValueUsd ?? row?.value);
      const time = formatEtMinuteLabel(timestamp);
      if (!Number.isFinite(timestamp) || portfolioValueUsd === null || !time) {
        return null;
      }
      return {
        time,
        timestamp,
        portfolioValueUsd: round(portfolioValueUsd, 2),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!rows.length) {
    warnings.push('Persisted portfolio history is unavailable for early baseline snapshots.');
  }
  return rows;
}

export async function readIndMoney2FxConfig(filePath) {
  await ensureJsonFile(filePath, DEFAULT_FX_CONFIG);
  const payload = await readJsonFile(filePath, DEFAULT_FX_CONFIG);
  return {
    ...DEFAULT_FX_CONFIG,
    ...(payload && typeof payload === 'object' ? payload : {}),
    manualHoldingInvestedUsd:
      payload?.manualHoldingInvestedUsd && typeof payload.manualHoldingInvestedUsd === 'object'
        ? payload.manualHoldingInvestedUsd
        : {},
  };
}

export async function writeIndMoney2FxConfig(filePath, payload) {
  const next = {
    ...DEFAULT_FX_CONFIG,
    ...(payload && typeof payload === 'object' ? payload : {}),
    updatedAt: nowIso(),
  };
  await writeJsonFile(filePath, next);
  return next;
}

export function computeEffectiveRate(totalInvestedInrFromMcp, manualActualInvestedUsd) {
  const investedInr = toNumber(totalInvestedInrFromMcp);
  const investedUsd = toNumber(manualActualInvestedUsd);
  if (investedInr === null || investedUsd === null || investedUsd <= 0) {
    return null;
  }
  return round(investedInr / investedUsd, 6);
}

function isRateLimitPayload(payload) {
  return String(payload?.error || '').trim().toLowerCase() === 'rate_limit_exceeded';
}

function extractHoldingsRows(payload) {
  if (Array.isArray(payload?.holdings)) return payload.holdings;
  if (Array.isArray(payload?.data?.holdings)) return payload.data.holdings;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function hasMeaningfulHoldingsPayload(payload) {
  return extractHoldingsRows(payload).length > 0;
}

async function readPersistedHoldingsCache(filePath) {
  if (!filePath) {
    return DEFAULT_HOLDINGS_CACHE;
  }
  await ensureJsonFile(filePath, DEFAULT_HOLDINGS_CACHE);
  const payload = await readJsonFile(filePath, DEFAULT_HOLDINGS_CACHE);
  return {
    payload: hasMeaningfulHoldingsPayload(payload?.payload) ? payload.payload : null,
    fetchedAt: Number(payload?.fetchedAt || 0),
  };
}

async function writePersistedHoldingsCache(filePath, payload, fetchedAt) {
  if (!filePath || !hasMeaningfulHoldingsPayload(payload)) {
    return;
  }
  await ensureJsonFile(filePath, DEFAULT_HOLDINGS_CACHE);
  await writeJsonFile(filePath, {
    payload,
    fetchedAt: Number(fetchedAt || Date.now()),
  });
}

async function writePersistedPortfolioSeries(filePath, rows = []) {
  if (!filePath) {
    return;
  }
  await ensureJsonFile(filePath, []);
  const payload = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const timestamp = toNumber(row?.timestamp);
      const portfolioValueUsd = toNumber(row?.portfolioValueUsd);
      if (timestamp === null || portfolioValueUsd === null) {
        return null;
      }
      return {
        timestamp,
        time: row.time || formatEtMinuteLabel(timestamp),
        portfolioValueUsd: round(portfolioValueUsd, 2),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  await writeJsonFile(filePath, payload);
}

async function fetchMcpHoldings(provider) {
  const payload = await provider.networthHoldings('US_STOCK');
  if (isRateLimitPayload(payload)) {
    const retryAfterSeconds = Math.max(1, Math.floor(toNumber(payload.retry_after_seconds) || 60));
    const error = new Error('INDmoney MCP rate limited');
    error.retryAfterSeconds = retryAfterSeconds;
    error.rateLimitPayload = payload;
    throw error;
  }
  return payload;
}

async function getRawHoldings(provider, warnings, options = {}) {
  const holdingsCachePath = options.holdingsCachePath || null;
  const budgetStatePath = options.budgetStatePath || null;
  const allowLiveFetch = options.allowLiveFetch !== false;
  const portfolioLabel = options.portfolioLabel || 'Portfolio';
  const now = Date.now();
  const serviceHoldingsCache = getServiceHoldingsCache(holdingsCachePath);
  if (!serviceHoldingsCache.payload && holdingsCachePath) {
    const persisted = await readPersistedHoldingsCache(holdingsCachePath);
    if (persisted.payload) {
      setServiceHoldingsCache(holdingsCachePath, persisted);
    }
  }
  const activeHoldingsCache = getServiceHoldingsCache(holdingsCachePath);
  if (!allowLiveFetch) {
    if (activeHoldingsCache.payload) {
      warnings.push(`${portfolioLabel} is using its own cached portfolio snapshot.`);
      return activeHoldingsCache.payload;
    }
    throw new Error(`${portfolioLabel} portfolio data is not configured yet. Load an independent snapshot before using this route.`);
  }
  const adaptiveMinIntervalMs = budgetStatePath
    ? await getIndMoneyMcpAdaptiveMinIntervalMs(budgetStatePath, { minimumSpacingMs: 15_000 })
    : 90 * 1000;
  const blockedUntil = budgetStatePath ? await getIndMoneyMcpBlockedUntil(budgetStatePath, 'networth_holdings', now) : 0;
  const cacheAgeMs = now - activeHoldingsCache.fetchedAt;
  if (activeHoldingsCache.payload && cacheAgeMs < adaptiveMinIntervalMs) {
    return activeHoldingsCache.payload;
  }
  if (Math.max(serviceState.rateLimitedUntil, blockedUntil) > now && activeHoldingsCache.payload) {
    warnings.push('INDMoney MCP rate limited. Showing cached holdings and refreshed market prices.');
    return activeHoldingsCache.payload;
  }
  try {
    const payload = await fetchMcpHoldings(provider);
    if (!hasMeaningfulHoldingsPayload(payload)) {
      if (activeHoldingsCache.payload && hasMeaningfulHoldingsPayload(activeHoldingsCache.payload)) {
        warnings.push('INDMoney returned an empty US holdings snapshot. Keeping the last non-empty portfolio snapshot.');
        return activeHoldingsCache.payload;
      }
      throw new Error('INDmoney returned an empty US holdings snapshot. Refresh again in a moment.');
    }
    setServiceHoldingsCache(holdingsCachePath, {
      payload,
      fetchedAt: now,
    });
    if (budgetStatePath) {
      await noteIndMoneyMcpSuccess(budgetStatePath, 'networth_holdings', now);
    }
    await writePersistedHoldingsCache(holdingsCachePath, payload, now);
    return payload;
  } catch (error) {
    if (error.retryAfterSeconds) {
      serviceState.rateLimitedUntil = now + error.retryAfterSeconds * 1000;
      if (budgetStatePath) {
        await noteIndMoneyMcpRateLimit(budgetStatePath, 'networth_holdings', error.retryAfterSeconds, now);
      }
      if (activeHoldingsCache.payload) {
        warnings.push('INDMoney MCP rate limited. Showing cached holdings and refreshed market prices.');
        return activeHoldingsCache.payload;
      }
      if (!hasIndMoneyMcpHttpAuth()) {
        throw new Error('INDmoney MCP login required. Open /api/indmoney/auth/start and reconnect your account.');
      }
      throw new Error('INDmoney MCP is rate limited and no cached holdings are available yet. Reconnect if your login expired, or wait briefly and refresh.');
    }
    throw error;
  }
}

export function resolveInvestedUsd(row, fxConfig, warnings) {
  const ticker = normalizeTicker(row.ticker || row.symbol);
  const manualHoldingInvestedUsd = toNumber(fxConfig.manualHoldingInvestedUsd?.[ticker]);
  if (manualHoldingInvestedUsd !== null) {
    return manualHoldingInvestedUsd;
  }
  const invested = toNumber(row.invested);
  if (invested === null) {
    return null;
  }
  if (String(row.currency || '').toUpperCase() === 'USD') {
    return invested;
  }
  const effectiveRate = toNumber(fxConfig.effectiveUsdInrRate);
  if (effectiveRate && effectiveRate > 0) {
    return round(invested / effectiveRate, 2);
  }
  const avgPrice = toNumber(row.avgPrice);
  const units = toNumber(row.units);
  const avgPriceCurrency = String(row.avgPriceCurrency || '').toUpperCase();
  if (avgPrice !== null && units !== null && avgPriceCurrency === 'USD') {
    return round(avgPrice * units, 2);
  }
  warnings.push('Manual USD invested amount is not configured. Using existing normalized USD values if available, otherwise USD PNL may be inaccurate.');
  return invested;
}

function resolveValueUsd(value, currency, fxConfig) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  if (String(currency || '').toUpperCase() === 'USD') {
    return numeric;
  }
  const effectiveRate = toNumber(fxConfig.effectiveUsdInrRate);
  if (effectiveRate && effectiveRate > 0) {
    return round(numeric / effectiveRate, 2);
  }
  return numeric;
}

export function canonicalizeHoldings(rows, quotesByTicker, fxConfig, warnings) {
  const map = new Map();
  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker || row.symbol);
    if (!ticker) {
      continue;
    }
    const quantity = toNumber(row.units ?? row.quantity);
    const live = quotesByTicker[ticker] || {};
    const sourceUpdatedAt = live.updatedAt || row.updatedAt || row.updated_at || null;
    const currentPriceUsd = toNumber(live.currentPriceUsd);
    const previousCloseUsd = toNumber(live.previousCloseUsd);
    const investedUsd = resolveInvestedUsd(row, fxConfig, warnings);
    const fallbackCurrentValueUsd = resolveValueUsd(row.currentValue, row.currency, fxConfig);
    const existing = map.get(ticker);
    const totalQuantity = quantity !== null
      ? round((toNumber(existing?.quantity) || 0) + quantity, 4)
      : toNumber(existing?.quantity);
    const totalInvestedUsd = investedUsd !== null
      ? round((toNumber(existing?.investedUsd) || 0) + investedUsd, 2)
      : toNumber(existing?.investedUsd);
    const currentHoldingValueUsd = totalQuantity !== null && currentPriceUsd !== null
      ? round(totalQuantity * currentPriceUsd, 2)
      : round((toNumber(existing?.currentHoldingValueUsd) || 0) + (fallbackCurrentValueUsd || 0), 2) || null;
    const oneDayPnlUsd = totalQuantity !== null && currentPriceUsd !== null && previousCloseUsd !== null
      ? round(totalQuantity * (currentPriceUsd - previousCloseUsd), 2)
      : null;
    const oneDayPnlPct = previousCloseUsd && currentPriceUsd !== null
      ? round(((currentPriceUsd - previousCloseUsd) / previousCloseUsd) * 100, 2)
      : null;
    const actualPnlUsd = currentHoldingValueUsd !== null && totalInvestedUsd !== null ? round(currentHoldingValueUsd - totalInvestedUsd, 2) : null;
    const actualPnlPct = totalInvestedUsd ? round((actualPnlUsd / totalInvestedUsd) * 100, 2) : null;
    const existingInvestedInr = toNumber(existing?.debug?.investedInr);
    const rowInvestedInr = String(row.currency || '').toUpperCase() === 'INR' ? toNumber(row.invested) : null;
    const debugInvestedInr = rowInvestedInr !== null
      ? round((existingInvestedInr || 0) + rowInvestedInr, 2)
      : existingInvestedInr;
    const originalCurrency = [existing?.debug?.originalCurrency, row.currency]
      .filter(Boolean)
      .map((value) => String(value).toUpperCase())
      .reduce((memo, value) => {
        if (!memo || memo === value) return value;
        return 'MIXED';
      }, null);
    const canonical = {
      ticker,
      name: existing?.name || row.name || ticker,
      quantity: totalQuantity,
      investedUsd: totalInvestedUsd,
      avgPriceUsd: totalQuantity ? round((totalInvestedUsd || 0) / totalQuantity, 4) : null,
      currentPriceUsd,
      previousCloseUsd,
      currentHoldingValueUsd,
      oneDayPnlUsd,
      oneDayPnlPct,
      actualPnlUsd,
      actualPnlPct,
      priceSession: live.priceSession || 'unknown',
      priceSource: live.priceSource || 'Yahoo Finance',
      updatedAt: sourceUpdatedAt,
      debug: {
        investedInr: debugInvestedInr,
        originalCurrency,
      },
    };
    map.set(ticker, canonical);
  }
  return [...map.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function shouldTreatCurrentOnlyPortfolioAsFreshAccount(historyMode, fxConfig) {
  if (historyMode !== 'current_only') {
    return false;
  }
  const manualActualInvestedUsd = toNumber(fxConfig?.manualActualInvestedUsd);
  const effectiveUsdInrRate = toNumber(fxConfig?.effectiveUsdInrRate);
  return manualActualInvestedUsd === null && effectiveUsdInrRate === null;
}

export function normalizeFreshAccountHoldings(holdings = []) {
  return holdings.map((holding) => {
    const currentHoldingValueUsd = toNumber(holding?.currentHoldingValueUsd);
    const quantity = toNumber(holding?.quantity);
    const currentPriceUsd = toNumber(holding?.currentPriceUsd);
    return {
      ...holding,
      investedUsd: currentHoldingValueUsd,
      avgPriceUsd: quantity && currentPriceUsd !== null ? currentPriceUsd : currentHoldingValueUsd,
      actualPnlUsd: currentHoldingValueUsd !== null ? 0 : null,
      actualPnlPct: currentHoldingValueUsd !== null ? 0 : null,
    };
  });
}

function shouldAutoSeedCurrentOnlyFx(historyMode, fxConfig, totalInvestedInrFromMcp, currentPortfolioValueUsd) {
  if (historyMode !== 'current_only') {
    return false;
  }
  const manualActualInvestedUsd = toNumber(fxConfig?.manualActualInvestedUsd);
  const effectiveUsdInrRate = toNumber(fxConfig?.effectiveUsdInrRate);
  const investedInr = toNumber(totalInvestedInrFromMcp);
  const currentValueUsd = toNumber(currentPortfolioValueUsd);
  return manualActualInvestedUsd === null
    && effectiveUsdInrRate === null
    && investedInr !== null
    && investedInr > 0
    && currentValueUsd !== null
    && currentValueUsd > 0;
}

function resolveCurrentOnlyOneDayBasisUsd(historyMode, fxConfig, investedValueUsd, previousClosePortfolioValueUsd, updatedAt) {
  if (historyMode !== 'current_only') {
    return previousClosePortfolioValueUsd;
  }
  const startDate = String(fxConfig?.portfolioStartDate || '').trim();
  const marketDay = etDateParts(updatedAt)?.dayKey || null;
  if (startDate && marketDay && startDate === marketDay) {
    const investedBasis = toNumber(investedValueUsd);
    if (investedBasis !== null && investedBasis > 0) {
      return investedBasis;
    }
  }
  return previousClosePortfolioValueUsd;
}

function buildSeriesPointsFromSnapshots(snapshots, investedUsd, previousClosePortfolioValueUsd = null) {
  const points = snapshots.map((point, index) => {
    const portfolioValueUsd = round(point.portfolioValueUsd, 2);
    const actualPnlUsd = investedUsd !== null ? round(portfolioValueUsd - investedUsd, 2) : null;
    const actualPnlPct = investedUsd ? round((actualPnlUsd / investedUsd) * 100, 2) : null;
    const previousPointValue = index > 0 ? toNumber(snapshots[index - 1]?.portfolioValueUsd) : null;
    const oneDayBasis = previousClosePortfolioValueUsd ?? previousPointValue;
    const oneDayPnlUsd = oneDayBasis !== null ? round(portfolioValueUsd - oneDayBasis, 2) : null;
    const oneDayPnlPct = oneDayBasis ? round((oneDayPnlUsd / oneDayBasis) * 100, 2) : null;
    return {
      time: point.time,
      timestamp: toNumber(point.timestamp),
      value: portfolioValueUsd,
      portfolioValueUsd,
      investedUsd,
      actualPnlUsd,
      actualPnlPct,
      oneDayPnlUsd,
      oneDayPnlPct,
    };
  });
  return {
    valuePoints: points,
    pnlPoints: points.map((point) => ({
      time: point.time,
      value: point.actualPnlUsd,
      currentValueUsd: point.portfolioValueUsd,
      investedUsd: point.investedUsd,
      actualPnlPct: point.actualPnlPct,
    })),
  };
}

function buildDailyRepricedSeries(holdings, dailyPricesByTicker, range, warnings) {
  const timeline = new Map();
  for (const holding of holdings) {
    const tickerRows = Array.isArray(dailyPricesByTicker[holding.ticker]) ? dailyPricesByTicker[holding.ticker] : [];
    let lastClose = null;
    for (const row of tickerRows) {
      const close = toNumber(row.close);
      if (close === null) {
        continue;
      }
      lastClose = close;
      const existing = timeline.get(row.time) || { time: row.time, portfolioValueUsd: 0 };
      existing.portfolioValueUsd += (toNumber(holding.quantity) || 0) * close;
      timeline.set(row.time, existing);
    }
    if (!tickerRows.length) {
      warnings.push(`Historical daily prices missing for ${holding.ticker}.`);
    } else if (lastClose === null) {
      warnings.push(`Historical closes missing for ${holding.ticker}.`);
    }
  }
  const allRows = [...timeline.values()]
    .map((row) => ({ ...row, portfolioValueUsd: round(row.portfolioValueUsd, 2) }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const filtered = range === '1w'
    ? allRows.slice(-7)
    : range === '1m'
      ? allRows.slice(-30)
      : allRows;
  return filtered;
}

export function buildMinuteRepricedSeries(holdings, minutePricesByTicker, warnings) {
  const timeline = new Map();
  const latestByTicker = new Map();
  const activeHoldings = [];
  for (const holding of holdings) {
    const tickerRows = Array.isArray(minutePricesByTicker[holding.ticker]) ? minutePricesByTicker[holding.ticker] : [];
    const normalizedRows = tickerRows.map((row) => {
      const close = toNumber(row.close);
      if (close === null) {
        return null;
      }
      const rawTimestamp = toNumber(row.timestamp) ?? (row.time ? Date.parse(`${String(row.time).replace(' ', 'T')}:00-04:00`) : Number.NaN);
      const timestamp = floorTimestampMs(rawTimestamp, 60 * 1000);
      return {
        ticker: holding.ticker,
        time: row.time,
        timestamp,
        close,
      };
    }).filter((row) => row?.time && Number.isFinite(row.timestamp));
    if (normalizedRows.length) {
      activeHoldings.push(holding);
      for (const row of normalizedRows) {
        const existing = timeline.get(row.time) || { time: row.time, timestamp: row.timestamp, prices: new Map() };
        existing.prices.set(holding.ticker, row.close);
        timeline.set(row.time, existing);
      }
    }
    if (!normalizedRows.length) {
      warnings.push(`Intraday minute prices missing for ${holding.ticker}.`);
    }
  }
  if (!activeHoldings.length) {
    return [];
  }
  return [...timeline.values()]
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map((row) => {
      for (const [ticker, close] of row.prices.entries()) {
        latestByTicker.set(ticker, close);
      }
      if (activeHoldings.some((holding) => !latestByTicker.has(holding.ticker))) {
        return null;
      }
      const portfolioValueUsd = activeHoldings.reduce((sum, holding) => {
        return sum + (toNumber(holding.quantity) || 0) * (latestByTicker.get(holding.ticker) || 0);
      }, 0);
      return {
        time: row.time,
        timestamp: row.timestamp,
        portfolioValueUsd: round(portfolioValueUsd, 2),
      };
    })
    .filter(Boolean)
    .filter((row) => row.portfolioValueUsd !== null);
}

export function fillSessionMinuteGaps(rows = []) {
  const sortedRows = rows
    .filter((row) => row?.time && Number.isFinite(toNumber(row?.timestamp)) && toNumber(row?.portfolioValueUsd) !== null)
    .slice()
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!sortedRows.length) {
    return [];
  }

  const bySessionDay = new Map();
  for (const row of sortedRows) {
    const key = String(row.time).slice(0, 10);
    if (!bySessionDay.has(key)) {
      bySessionDay.set(key, []);
    }
    bySessionDay.get(key).push({
      time: row.time,
      timestamp: row.timestamp,
      portfolioValueUsd: round(row.portfolioValueUsd, 2),
    });
  }

  const filledRows = [];
  for (const sessionRows of bySessionDay.values()) {
    sessionRows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let cursor = sessionRows[0].timestamp;
    let rowIndex = 0;
    let latestValue = sessionRows[0].portfolioValueUsd;
    const endTimestamp = sessionRows.at(-1).timestamp;

    while (cursor <= endTimestamp) {
      while (rowIndex + 1 < sessionRows.length && sessionRows[rowIndex + 1].timestamp <= cursor) {
        rowIndex += 1;
        latestValue = sessionRows[rowIndex].portfolioValueUsd;
      }
      filledRows.push({
        time: formatEtMinuteLabel(cursor),
        timestamp: cursor,
        portfolioValueUsd: round(latestValue, 2),
      });
      cursor += 60 * 1000;
    }
  }

  return filledRows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function sliceMinuteRowsByLookback(rows = [], lookbackMs) {
  const lastTimestamp = toNumber(rows.at(-1)?.timestamp);
  if (lastTimestamp === null || !lookbackMs) {
    return rows.slice();
  }
  const start = lastTimestamp - lookbackMs;
  return rows.filter((row) => toNumber(row.timestamp) !== null && row.timestamp >= start);
}

export function sliceLatestSessionRows(rows = []) {
  const last = rows.at(-1);
  if (!last?.time) {
    return rows.slice();
  }
  const latestDay = String(last.time).slice(0, 10);
  return rows.filter((row) => String(row.time || '').slice(0, 10) === latestDay);
}

function isSessionComplete(row) {
  const match = String(row?.time || '').match(/\s(\d{2}):(\d{2})$/);
  if (!match) {
    return false;
  }
  const totalMinutes = Number(match[1]) * 60 + Number(match[2]);
  return totalMinutes >= (19 * 60 + 55);
}

function rowMinuteOfDay(row) {
  const match = String(row?.time || '').match(/\s(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function sliceLatestContinuousSessionRows(rows = []) {
  const last = rows.at(-1);
  if (!last?.time) {
    return rows.slice();
  }
  return isSessionComplete(last)
    ? sliceLatestSessionRows(rows)
    : sliceLatestTradingSessionRows(rows, 2);
}

export function sliceCurrentMarketDayRows(rows = []) {
  const last = rows.at(-1);
  if (!last?.time) {
    return rows.slice();
  }
  const latestDay = String(last.time).slice(0, 10);
  const latestMinute = rowMinuteOfDay(last);
  if (latestMinute === null || latestMinute >= (9 * 60 + 30)) {
    return rows.filter((row) => String(row.time || '').slice(0, 10) === latestDay);
  }
  let priorDay = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const day = String(rows[index]?.time || '').slice(0, 10);
    if (day && day !== latestDay) {
      priorDay = day;
      break;
    }
  }
  return rows.filter((row) => {
    const day = String(row.time || '').slice(0, 10);
    if (day === latestDay) return true;
    return day === priorDay && (rowMinuteOfDay(row) || 0) >= (16 * 60);
  });
}

export function sliceLatestTradingSessionRows(rows = [], sessionCount = 5) {
  const targetCount = Math.max(1, Number(sessionCount) || 1);
  const sessions = [];
  const seen = new Set();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const key = String(rows[index]?.time || '').slice(0, 10);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    sessions.push(key);
    if (sessions.length >= targetCount) {
      break;
    }
  }
  const keep = new Set(sessions);
  return rows.filter((row) => keep.has(String(row.time || '').slice(0, 10)));
}

export function sliceCurrentMarketWeekRows(rows = []) {
  const last = rows.at(-1);
  if (!last?.timestamp && !last?.time) {
    return rows.slice();
  }
  const basis = rowTimestampMs(last);
  if (basis === null) {
    return rows.slice();
  }
  const lastParts = etDateParts(basis);
  if (!lastParts) {
    return rows.slice();
  }
  const weekEnvelope = currentMarketWeekEnvelope(basis);
  if (!weekEnvelope) {
    return rows.slice();
  }
  const filtered = rows.filter((row) => {
    const timestamp = rowTimestampMs(row);
    return timestamp !== null && timestamp >= weekEnvelope.startMs && timestamp <= weekEnvelope.endMs;
  });
  return filtered.length ? filtered : rows.slice();
}

export function sliceDailySessionEndRows(rows = []) {
  const byDay = new Map();
  for (const row of rows) {
    const key = String(row?.time || '').slice(0, 10);
    if (!key) {
      continue;
    }
    byDay.set(key, row);
  }
  return [...byDay.values()];
}

export function sliceHourlySnapshotRows(rows = []) {
  const byHour = new Map();
  for (const row of rows) {
    const key = String(row?.time || '').slice(0, 13);
    if (!key) {
      continue;
    }
    byHour.set(key, row);
  }
  return [...byHour.values()];
}

function rowTimestampMs(row) {
  const timestamp = toNumber(row?.timestamp);
  if (timestamp !== null) return timestamp;
  const time = String(row?.time || '').trim();
  if (!time) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(time)
    ? Date.parse(`${time}T12:00:00-04:00`)
    : Date.parse(`${time.replace(' ', 'T')}:00-04:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sliceRecentCalendarRows(rows = [], dayCount = 30) {
  const totalDays = Math.max(1, Number(dayCount) || 1);
  if (!Array.isArray(rows) || !rows.length) return [];
  const lastTimestamp = rowTimestampMs(rows.at(-1));
  if (lastTimestamp === null) return rows.slice();
  const startTimestamp = lastTimestamp - ((totalDays - 1) * 86400000);
  const filtered = rows.filter((row) => {
    const timestamp = rowTimestampMs(row);
    return timestamp !== null && timestamp >= startTimestamp && timestamp <= lastTimestamp;
  });
  return filtered.length ? filtered : rows.slice();
}

export function appendLivePortfolioSnapshot(rows = [], portfolioValueUsd, updatedAt) {
  const liveValue = toNumber(portfolioValueUsd);
  const liveTimestamp = floorTimestampMs(new Date(updatedAt || nowIso()).getTime(), 60 * 1000);
  if (liveValue === null || Number.isNaN(liveTimestamp)) {
    return rows.slice();
  }
  const date = new Date(liveTimestamp);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const next = rows.slice();
  const totalMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const inTradableSession = totalMinutes >= (4 * 60) && totalMinutes <= (20 * 60);
  const fallbackTime = !inTradableSession && next.length ? next.at(-1).time : null;
  const fallbackTimestamp = !inTradableSession && next.length ? next.at(-1).timestamp : null;
  const time = fallbackTime || `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  const liveRow = {
    time,
    timestamp: fallbackTimestamp || liveTimestamp,
    portfolioValueUsd: round(liveValue, 2),
  };
  if (next.length && next.at(-1).time === time) {
    next[next.length - 1] = liveRow;
  } else {
    next.push(liveRow);
  }
  return next.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function mergeAllTimeRows(persistedRows = [], minuteRows = [], dailyRows = []) {
  const leadingCandidatesByKey = new Map();
  for (const row of dailyRows.concat(persistedRows)) {
    const timestamp = rowTimestampMs(row);
    const key = timestamp === null ? String(row?.time || '') : String(timestamp);
    if (!key) continue;
    leadingCandidatesByKey.set(key, row);
  }
  const leadingCandidates = [...leadingCandidatesByKey.values()]
    .sort((left, right) => (rowTimestampMs(left) || 0) - (rowTimestampMs(right) || 0));
  if (minuteRows.length) {
    const firstMinuteTimestamp = rowTimestampMs(minuteRows[0]);
    const leadingRows = firstMinuteTimestamp === null
      ? leadingCandidates
      : leadingCandidates.filter((row) => {
          const timestamp = rowTimestampMs(row);
          return timestamp !== null && timestamp < firstMinuteTimestamp;
        });
    return leadingRows.concat(minuteRows);
  }
  return leadingCandidates;
}

async function buildSeries(holdings, investedUsd, previousClosePortfolioValueUsd, currentPortfolioValueUsd, updatedAt, warnings, options = {}) {
  const historyMode = options.historyMode || 'repriced';
  if (historyMode === 'current_only') {
    const persistedRows = await readPersistedPortfolioSeries(options.portfolioSeriesPath || null, []);
    const currentRows = appendLivePortfolioSnapshot(persistedRows, currentPortfolioValueUsd, updatedAt);
    await writePersistedPortfolioSeries(options.portfolioSeriesPath || null, currentRows);
    const oneDayRows = sliceCurrentMarketDayRows(currentRows);
    const oneWeekRows = sliceHourlySnapshotRows(sliceCurrentMarketWeekRows(currentRows));
    const oneMonthRows = sliceHourlySnapshotRows(sliceRecentCalendarRows(currentRows, 30));
    const ranges = {
      '1d': { rows: oneDayRows, granularity: 'minute', previousClosePortfolioValueUsd, viewport: currentMarketDayEnvelope(oneDayRows.at(-1)?.timestamp || updatedAt) },
      '1w': { rows: oneWeekRows, granularity: 'mixed', previousClosePortfolioValueUsd, viewport: currentMarketWeekEnvelope(oneWeekRows.at(-1)?.timestamp || updatedAt) },
      '1m': { rows: oneMonthRows, granularity: 'mixed', previousClosePortfolioValueUsd, marketTimezone: 'America/New_York' },
      all: { rows: currentRows, granularity: currentRows.length > 1 ? 'mixed' : 'point-in-time', previousClosePortfolioValueUsd },
    };
    return Object.fromEntries(Object.entries(ranges).map(([range, config]) => {
      const series = buildSeriesPointsFromSnapshots(config.rows, investedUsd, config.previousClosePortfolioValueUsd);
      const lastPoint = series.valuePoints.at(-1) || null;
      return [range, {
        ok: series.valuePoints.length > 0,
        range,
        currency: 'USD',
        displayCurrency: 'USD',
        baselineAt: null,
        granularity: config.granularity,
        pointCount: series.valuePoints.length,
        viewportStart: config.viewport?.startMs || null,
        viewportEnd: config.viewport?.endMs || null,
        marketTimezone: config.viewport?.marketTimezone || config.marketTimezone || 'America/New_York',
        source: 'current-account-value',
        warnings: dedupeWarnings([...warnings, 'Historical repricing is disabled for this portfolio.']),
        valuePoints: series.valuePoints,
        pnlPoints: series.pnlPoints,
        summary: lastPoint ? {
          currentPortfolioValueUsd: lastPoint.portfolioValueUsd,
          investedValueUsd: investedUsd,
          previousClosePortfolioValueUsd: previousClosePortfolioValueUsd ?? null,
          oneDayPnlUsd: lastPoint.oneDayPnlUsd,
          oneDayPnlPct: lastPoint.oneDayPnlPct,
          actualPnlUsd: lastPoint.actualPnlUsd,
          actualPnlPct: lastPoint.actualPnlPct,
        } : null,
      }];
    }));
  }
  const tickers = holdings.map((holding) => holding.ticker);
  const [minutePricesByTicker, dailyPricesByTicker] = await Promise.all([
    getHistoricalMinutePrices(tickers, INDMONEY2_BASELINE_DATE),
    getHistoricalDailyPrices(tickers, INDMONEY2_BASELINE_DATE),
  ]);
  const dailyRows = buildDailyRepricedSeries(holdings, dailyPricesByTicker, 'all', warnings);
  const minuteRows = fillSessionMinuteGaps(appendLivePortfolioSnapshot(
    buildMinuteRepricedSeries(holdings, minutePricesByTicker, warnings),
    currentPortfolioValueUsd,
    updatedAt,
  ));
  const oneDayRows = sliceCurrentMarketDayRows(minuteRows);
  const persistedAllRows = await readPersistedPortfolioSeries(options.portfolioSeriesPath || null, warnings);
  const allRows = mergeAllTimeRows(persistedAllRows, minuteRows, dailyRows);
  const oneWeekRows = sliceHourlySnapshotRows(sliceCurrentMarketWeekRows(allRows));
  const oneMonthRows = sliceHourlySnapshotRows(sliceRecentCalendarRows(allRows, 30));

  const dayEnvelope = currentMarketDayEnvelope(oneDayRows.at(-1)?.timestamp || updatedAt);
  const weekEnvelope = currentMarketWeekEnvelope(oneWeekRows.at(-1)?.timestamp || updatedAt);
  const ranges = {
    '1d': { rows: oneDayRows, granularity: 'minute', previousClosePortfolioValueUsd, viewport: dayEnvelope },
    '1w': { rows: oneWeekRows, granularity: minuteRows.length ? 'mixed' : 'daily', viewport: weekEnvelope },
    '1m': { rows: oneMonthRows, granularity: 'mixed', marketTimezone: 'America/New_York' },
    // ponytail: keep the continuous source raw so shorter ranges can pan left to the June 5 baseline.
    all: { rows: allRows, granularity: minuteRows.length ? 'mixed' : 'daily' },
  };

  return Object.fromEntries(Object.entries(ranges).map(([range, config]) => {
    const series = buildSeriesPointsFromSnapshots(config.rows, investedUsd, config.previousClosePortfolioValueUsd || null);
    const summary = series.valuePoints.at(-1)
      ? {
          currentPortfolioValueUsd: series.valuePoints.at(-1).portfolioValueUsd,
          investedValueUsd: investedUsd,
          previousClosePortfolioValueUsd,
          oneDayPnlUsd: series.valuePoints.at(-1).oneDayPnlUsd,
          oneDayPnlPct: series.valuePoints.at(-1).oneDayPnlPct,
          actualPnlUsd: series.valuePoints.at(-1).actualPnlUsd,
          actualPnlPct: series.valuePoints.at(-1).actualPnlPct,
        }
      : null;
    return [range, {
      ok: series.valuePoints.length > 0,
      range,
      currency: 'USD',
      displayCurrency: 'USD',
      baselineAt: INDMONEY2_BASELINE_DATE,
      granularity: config.granularity,
      pointCount: series.valuePoints.length,
      viewportStart: config.viewport?.startMs || null,
      viewportEnd: config.viewport?.endMs || null,
      marketTimezone: config.viewport?.marketTimezone || config.marketTimezone || null,
      source: 'canonical-price-service',
      warnings: dedupeWarnings(warnings),
      valuePoints: series.valuePoints,
      pnlPoints: series.pnlPoints,
      summary,
    }];
  }));
}

export async function buildIndMoney2Dashboard({ fxConfigPath, holdingsCachePath = null, budgetStatePath = null, portfolioSeriesPath = null, allowLiveFetch = true, portfolioLabel = 'Portfolio', historyMode = 'repriced', authPath = null }) {
  const warnings = [];
  if (!hasIndMoneyMcpHttpAuth(authPath ? { authPath } : {})) {
    throw new Error('INDmoney MCP login required. Open /api/indmoney/auth/start and reconnect your account.');
  }
  const provider = createIndMoneyMcpProvider({
    cacheSeconds: 0,
    client: createIndMoneyMcpHttpClient(authPath ? { authPath } : {}),
  });
  if (!provider.isAvailable()) {
    throw new Error('INDmoney MCP login required. Open /api/indmoney/auth/start and reconnect your account.');
  }

  const rawHoldings = await getRawHoldings(provider, warnings, { holdingsCachePath, budgetStatePath, allowLiveFetch, portfolioLabel });
  const normalizedRows = normalizeIndMoneyHoldings(extractHoldingsRows(rawHoldings));
  if (!normalizedRows.length) {
    throw new Error('INDmoney returned no usable US holdings rows for INDmoney2. Refresh again in a moment.');
  }
  const tickers = [...new Set(normalizedRows.map((row) => normalizeTicker(row.ticker || row.symbol)).filter(Boolean))];
  const totalInvestedInrFromMcp = round(normalizedRows.reduce((sum, row) => {
    const invested = toNumber(row.invested);
    const currency = String(row.currency || '').toUpperCase();
    return sum + (currency === 'INR' && invested !== null ? invested : 0);
  }, 0), 2);
  const persistedFxConfig = await readIndMoney2FxConfig(fxConfigPath);
  const fxConfig = {
    ...persistedFxConfig,
    lastMcpTotalInvestedInr: totalInvestedInrFromMcp,
    effectiveUsdInrRate: computeEffectiveRate(totalInvestedInrFromMcp, persistedFxConfig.manualActualInvestedUsd) ?? toNumber(persistedFxConfig.effectiveUsdInrRate),
  };
  if (persistedFxConfig.lastMcpTotalInvestedInr !== totalInvestedInrFromMcp || persistedFxConfig.effectiveUsdInrRate !== fxConfig.effectiveUsdInrRate) {
    await writeIndMoney2FxConfig(fxConfigPath, fxConfig);
  }

  const [livePrices, previousClosePrices] = await Promise.all([
    getLivePrices(tickers),
    getPreviousClosePrices(tickers),
  ]);
  const quotesByTicker = Object.fromEntries(tickers.map((ticker) => [ticker, {
    ...(livePrices[ticker] || {}),
    ...(previousClosePrices[ticker] || {}),
  }]));
  let activeFxConfig = fxConfig;
  let holdings = canonicalizeHoldings(normalizedRows, quotesByTicker, activeFxConfig, warnings);
  let currentPortfolioValueUsd = sumValue(holdings, 'currentHoldingValueUsd');
  if (shouldAutoSeedCurrentOnlyFx(historyMode, activeFxConfig, totalInvestedInrFromMcp, currentPortfolioValueUsd)) {
    activeFxConfig = await writeIndMoney2FxConfig(fxConfigPath, {
      ...activeFxConfig,
      manualActualInvestedUsd: round(currentPortfolioValueUsd, 2),
      lastMcpTotalInvestedInr: totalInvestedInrFromMcp,
      effectiveUsdInrRate: computeEffectiveRate(totalInvestedInrFromMcp, currentPortfolioValueUsd),
      autoSeededFreshAccount: true,
    });
    warnings.push('Fresh account baseline seeded from the first live snapshot. Portfolio return now tracks from today.');
    holdings = canonicalizeHoldings(normalizedRows, quotesByTicker, activeFxConfig, warnings);
    currentPortfolioValueUsd = sumValue(holdings, 'currentHoldingValueUsd');
  }
  const useFreshAccountFallback = shouldTreatCurrentOnlyPortfolioAsFreshAccount(historyMode, activeFxConfig);
  const normalizedHoldings = useFreshAccountFallback ? normalizeFreshAccountHoldings(holdings) : holdings;
  if (useFreshAccountFallback) {
    warnings.push('Fresh-account fallback applied: total return is held neutral until this portfolio has its own USD invested baseline.');
  }
  const investedValueUsd = sumValue(normalizedHoldings, 'investedUsd');
  const rawPreviousClosePortfolioValueUsd = round(holdings.reduce((sum, holding) => {
    const quantity = toNumber(holding.quantity) || 0;
    const previousCloseUsd = toNumber(holding.previousCloseUsd);
    return sum + (previousCloseUsd !== null ? quantity * previousCloseUsd : 0);
  }, 0), 2);
  const sessionMeta = getPriceSession();
  const updatedAt = nowIso();
  const previousClosePortfolioValueUsd = resolveCurrentOnlyOneDayBasisUsd(
    historyMode,
    activeFxConfig,
    investedValueUsd,
    rawPreviousClosePortfolioValueUsd,
    updatedAt,
  );
  if (previousClosePortfolioValueUsd !== rawPreviousClosePortfolioValueUsd && historyMode === 'current_only') {
    warnings.push('Opening-day basis applied: 1D change is anchored to invested capital until the first full market close.');
  }
  const oneDayPnlUsd = round(currentPortfolioValueUsd - previousClosePortfolioValueUsd, 2);
  const oneDayPnlPct = previousClosePortfolioValueUsd ? round((oneDayPnlUsd / previousClosePortfolioValueUsd) * 100, 2) : null;
  const actualPnlUsd = useFreshAccountFallback ? 0 : round(currentPortfolioValueUsd - investedValueUsd, 2);
  const actualPnlPct = useFreshAccountFallback ? 0 : (investedValueUsd ? round((actualPnlUsd / investedValueUsd) * 100, 2) : null);
  const seriesWarnings = [];
  const series = await buildSeries(
    normalizedHoldings,
    investedValueUsd,
    previousClosePortfolioValueUsd,
    currentPortfolioValueUsd,
    updatedAt,
    seriesWarnings,
    { portfolioSeriesPath, historyMode },
  );
  const mergedWarnings = dedupeWarnings([...warnings, ...seriesWarnings]);
  return {
    ok: true,
    updatedAt,
    baselineDate: historyMode === 'current_only' ? null : INDMONEY2_BASELINE_DATE,
    currency: 'USD',
    displayCurrency: 'USD',
    sourceCurrency: 'INR',
    priceSource: 'canonical-price-service',
    historyMode,
    fx: {
      manualActualInvestedUsd: toNumber(activeFxConfig.manualActualInvestedUsd),
      totalInvestedInrFromMcp,
      effectiveUsdInrRate: toNumber(activeFxConfig.effectiveUsdInrRate),
      updatedAt: activeFxConfig.updatedAt || null,
      autoSeededFreshAccount: Boolean(activeFxConfig.autoSeededFreshAccount),
    },
    sessionMeta,
    summary: {
      currentPortfolioValueUsd,
      investedValueUsd,
      previousClosePortfolioValueUsd,
      oneDayPnlUsd,
      oneDayPnlPct,
      actualPnlUsd,
      actualPnlPct,
    },
    holdings: normalizedHoldings,
    series,
    seriesAvailability: Object.fromEntries(Object.entries(series).map(([range, payload]) => [range, {
      ok: Boolean(payload.ok),
      pointCount: payload.pointCount || 0,
      warningCount: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
    }])),
    warnings: mergedWarnings,
    dataFreshness: {
      livePricesUpdatedAt: Object.values(livePrices).map((row) => row.updatedAt).filter(Boolean).sort().at(-1) || null,
      holdingsUpdatedAt: updatedAt,
      historicalPricesUpdatedAt: updatedAt,
      fxConfigUpdatedAt: activeFxConfig.updatedAt || null,
      isStale: mergedWarnings.length > 0,
    },
  };
}

export async function primeIndMoney2HoldingsCache(options = {}) {
  if (!hasIndMoneyMcpHttpAuth(options.authPath ? { authPath: options.authPath } : {})) {
    return false;
  }
  if (options.allowLiveFetch === false) {
    return false;
  }
  const provider = options.provider || createIndMoneyMcpProvider({
    cacheSeconds: 0,
    client: createIndMoneyMcpHttpClient(options.authPath ? { authPath: options.authPath } : {}),
  });
  if (!provider?.isAvailable?.()) {
    return false;
  }
  try {
    const payload = await getRawHoldings(provider, [], {
      holdingsCachePath: options.holdingsCachePath || null,
      budgetStatePath: options.budgetStatePath || null,
      allowLiveFetch: true,
      portfolioLabel: options.portfolioLabel || 'Portfolio',
    });
    const ok = hasMeaningfulHoldingsPayload(payload);
    if (ok && options.holdingsCachePath) {
      await writePersistedHoldingsCache(options.holdingsCachePath, payload, Date.now());
    }
    return ok;
  } catch {
    return false;
  }
}

export async function getIndMoney2FxConfigPayload({ fxConfigPath, holdingsCachePath = null, budgetStatePath = null }) {
  const dashboard = await buildIndMoney2Dashboard({ fxConfigPath, holdingsCachePath, budgetStatePath });
  return {
    ok: true,
    sourceCurrency: 'INR',
    displayCurrency: 'USD',
    totalInvestedInrFromMcp: dashboard.fx.totalInvestedInrFromMcp,
    manualActualInvestedUsd: dashboard.fx.manualActualInvestedUsd,
    effectiveUsdInrRate: dashboard.fx.effectiveUsdInrRate,
    updatedAt: dashboard.fx.updatedAt,
  };
}

export async function saveIndMoney2FxConfig({ fxConfigPath, holdingsCachePath = null, budgetStatePath = null, manualActualInvestedUsd, manualHoldingInvestedUsd = null }) {
  const existing = await readIndMoney2FxConfig(fxConfigPath);
  const next = {
    ...existing,
    manualActualInvestedUsd: toNumber(manualActualInvestedUsd),
    manualHoldingInvestedUsd:
      manualHoldingInvestedUsd && typeof manualHoldingInvestedUsd === 'object'
        ? Object.fromEntries(Object.entries(manualHoldingInvestedUsd).map(([ticker, value]) => [normalizeTicker(ticker), toNumber(value)]).filter(([, value]) => value !== null))
        : existing.manualHoldingInvestedUsd,
  };
  const dashboard = await buildIndMoney2Dashboard({ fxConfigPath, holdingsCachePath, budgetStatePath });
  next.lastMcpTotalInvestedInr = dashboard.fx.totalInvestedInrFromMcp;
  next.effectiveUsdInrRate = computeEffectiveRate(next.lastMcpTotalInvestedInr, next.manualActualInvestedUsd);
  const saved = await writeIndMoney2FxConfig(fxConfigPath, next);
  return {
    ok: true,
    sourceCurrency: 'INR',
    displayCurrency: 'USD',
    totalInvestedInrFromMcp: saved.lastMcpTotalInvestedInr,
    manualActualInvestedUsd: saved.manualActualInvestedUsd,
    effectiveUsdInrRate: saved.effectiveUsdInrRate,
    updatedAt: saved.updatedAt,
  };
}

export async function getIndMoney2SeriesRange({ fxConfigPath, holdingsCachePath = null, budgetStatePath = null, portfolioSeriesPath = null, range }) {
  const dashboard = await buildIndMoney2Dashboard({ fxConfigPath, holdingsCachePath, budgetStatePath, portfolioSeriesPath });
  return dashboard.series?.[range] || dashboard.series?.['1m'] || null;
}

export async function getIndMoney2Holdings({ fxConfigPath, holdingsCachePath = null, budgetStatePath = null, portfolioSeriesPath = null }) {
  const dashboard = await buildIndMoney2Dashboard({ fxConfigPath, holdingsCachePath, budgetStatePath, portfolioSeriesPath });
  return {
    ok: true,
    currency: 'USD',
    holdings: dashboard.holdings,
    updatedAt: dashboard.updatedAt,
    warnings: dashboard.warnings,
  };
}

export async function getIndMoney2LivePrices({ fxConfigPath, holdingsCachePath = null, budgetStatePath = null, portfolioSeriesPath = null }) {
  const dashboard = await buildIndMoney2Dashboard({ fxConfigPath, holdingsCachePath, budgetStatePath, portfolioSeriesPath });
  return {
    ok: true,
    currency: 'USD',
    livePrices: dashboard.holdings.map((holding) => ({
      ticker: holding.ticker,
      currentPriceUsd: holding.currentPriceUsd,
      previousCloseUsd: holding.previousCloseUsd,
      priceSession: holding.priceSession,
      priceSource: holding.priceSource,
      updatedAt: holding.updatedAt,
    })),
    updatedAt: dashboard.updatedAt,
    warnings: dashboard.warnings,
  };
}

export function resolveIndMoney2FxConfigPath(projectRoot) {
  return path.join(projectRoot, 'data', 'indmoney2-fx-config.json');
}

export function resolveIndMoney2HoldingsCachePath(projectRoot) {
  return path.join(projectRoot, 'data', 'indmoney2-holdings-cache.json');
}

export function resolveIndMoney2PortfolioSeriesPath(projectRoot) {
  return path.join(projectRoot, 'data', 'indmoney-us-portfolio-series.json');
}
