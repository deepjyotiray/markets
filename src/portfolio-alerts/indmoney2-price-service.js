import { computeAbsoluteChange, computePercentChange, fetchTextWithRetry, getTimePartsInZone, nowIso, round, toNumber } from './utils.js';

const ET_TIMEZONE = 'America/New_York';
const CACHE_TTLS_MS = {
  live: 10 * 1000,
  previousClose: 10 * 60 * 1000,
  intraday: 20 * 1000,
  intradayMinute: 20 * 1000,
  daily: 30 * 60 * 1000,
};

const cacheStore = {
  live: new Map(),
  previousClose: new Map(),
  intraday: new Map(),
  intradayMinute: new Map(),
  daily: new Map(),
};

function inferSessionFromTimestamp(timestampSeconds) {
  const value = toNumber(timestampSeconds);
  if (value === null) {
    return 'regular';
  }
  const parts = getTimePartsInZone(new Date(value * 1000), ET_TIMEZONE);
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes >= 240 && minutes < 570) {
    return 'pre_market';
  }
  if (minutes >= 570 && minutes < 960) {
    return 'regular';
  }
  if (minutes >= 960 && minutes < 1200) {
    return 'post_market';
  }
  return 'regular';
}

function cacheKey(tickers = [], extra = '') {
  const symbols = [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))];
  return `${symbols.join(',')}::${extra}`;
}

async function getCachedValue(store, key, ttlMs, loader) {
  const cached = store.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = await loader();
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

async function fetchJsonWithRetry(url, options = {}, retryCount = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      const text = await fetchTextWithRetry(url, options, {
        maxRetries: 1,
        retryBackoffMs: 500 * attempt,
        timeoutMs: 15000,
      });
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Fetch failed for ${url}`);
}

function quoteCachePayload(ticker, meta = {}, quote = {}, timestamps = []) {
  const regularPrice = toNumber(meta.regularMarketPrice);
  const previousClose = toNumber(meta.previousClose) ?? toNumber(meta.chartPreviousClose);
  const postMarketPrice = toNumber(meta.postMarketPrice);
  const preMarketPrice = toNumber(meta.preMarketPrice);
  const marketState = String(meta.marketState || '').trim().toUpperCase();
  const closes = Array.isArray(quote.close) ? quote.close.map(toNumber).filter((value) => value !== null) : [];
  const latestCandleClose = closes.length ? closes.at(-1) : null;
  const latestTimestampSeconds = Array.isArray(timestamps) && timestamps.length
    ? toNumber(timestamps.at(-1))
    : toNumber(meta.postMarketTime) ?? toNumber(meta.preMarketTime) ?? toNumber(meta.regularMarketTime);
  const sourceUpdatedAt = latestTimestampSeconds !== null
    ? new Date(latestTimestampSeconds * 1000).toISOString()
    : null;
  const fallbackSession = inferSessionFromTimestamp(latestTimestampSeconds);
  const priceSession = marketState === 'POST' || postMarketPrice !== null
    ? 'post_market'
    : marketState === 'PRE' || preMarketPrice !== null
      ? 'pre_market'
      : fallbackSession;
  const currentPrice = postMarketPrice
    ?? preMarketPrice
    ?? ((priceSession === 'post_market' || priceSession === 'pre_market') ? latestCandleClose : null)
    ?? regularPrice
    ?? latestCandleClose
    ?? null;
  return {
    ticker,
    name: meta.longName || meta.shortName || ticker,
    currentPriceUsd: currentPrice,
    regularPriceUsd: regularPrice,
    previousCloseUsd: previousClose,
    priceSession,
    priceSource: 'Yahoo Finance',
    updatedAt: sourceUpdatedAt || null,
    openUsd: toNumber(meta.regularMarketOpen) ?? toNumber(quote.open?.find((value) => toNumber(value) !== null)),
    dayHighUsd: toNumber(meta.regularMarketDayHigh),
    dayLowUsd: toNumber(meta.regularMarketDayLow),
    oneDayPnlPct: computePercentChange(currentPrice, previousClose),
    oneDayPnlUsdPerShare: computeAbsoluteChange(currentPrice, previousClose),
  };
}

async function fetchYahooQuote(ticker) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set('range', '1d');
  url.searchParams.set('interval', '1m');
  url.searchParams.set('includePrePost', 'true');
  url.searchParams.set('events', 'history');
  const payload = await fetchJsonWithRetry(url.toString(), { redirect: 'follow' });
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo quote unavailable for ${ticker}`);
  }
  return quoteCachePayload(
    ticker,
    result.meta || {},
    result.indicators?.quote?.[0] || {},
    Array.isArray(result.timestamp) ? result.timestamp : [],
  );
}

function formatEtLabel(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = getTimePartsInZone(date, ET_TIMEZONE);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:00`;
}

function formatEtMinuteLabel(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = getTimePartsInZone(date, ET_TIMEZONE);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatDailyLabel(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

async function fetchYahooChart(ticker, { interval = '1d', range = null, startDate = null, endDate = null, includePrePost = false } = {}) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  if (range) {
    url.searchParams.set('range', range);
  } else {
    const start = new Date(startDate || '2026-06-05T00:00:00Z');
    const end = new Date(endDate || Date.now());
    url.searchParams.set('period1', String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set('period2', String(Math.floor(end.getTime() / 1000)));
  }
  url.searchParams.set('interval', interval);
  url.searchParams.set('includePrePost', includePrePost ? 'true' : 'false');
  url.searchParams.set('events', 'history');
  url.searchParams.set('includeAdjustedClose', 'true');
  const payload = await fetchJsonWithRetry(url.toString(), { redirect: 'follow' });
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart unavailable for ${ticker}`);
  }
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    timestamp,
    close: toNumber(quote.close?.[index]),
    open: toNumber(quote.open?.[index]),
    high: toNumber(quote.high?.[index]),
    low: toNumber(quote.low?.[index]),
    volume: toNumber(quote.volume?.[index]),
  })).filter((row) => row.close !== null);
}

function splitDateRangeIntoChunks(startDate, endDate, maxDays = 7) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return [];
  }
  const chunks = [];
  let cursor = start.getTime();
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  while (cursor < end.getTime()) {
    const next = Math.min(end.getTime(), cursor + maxMs);
    chunks.push({
      startDate: new Date(cursor).toISOString(),
      endDate: new Date(next).toISOString(),
    });
    cursor = next;
  }
  return chunks;
}

export function getPriceSession(now = new Date()) {
  const parts = getTimePartsInZone(now, ET_TIMEZONE);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
    return { marketSession: 'closed', timezone: ET_TIMEZONE };
  }
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes >= 240 && minutes < 570) {
    return { marketSession: 'pre_market', timezone: ET_TIMEZONE };
  }
  if (minutes >= 570 && minutes < 960) {
    return { marketSession: 'regular', timezone: ET_TIMEZONE };
  }
  if (minutes >= 960 && minutes < 1200) {
    return { marketSession: 'post_market', timezone: ET_TIMEZONE };
  }
  return { marketSession: 'closed', timezone: ET_TIMEZONE };
}

export async function getLivePrices(tickers = []) {
  const key = cacheKey(tickers);
  return getCachedValue(cacheStore.live, key, CACHE_TTLS_MS.live, async () => {
    const entries = await Promise.allSettled(
      [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
        .map(async (ticker) => [ticker, await fetchYahooQuote(ticker)]),
    );
    return Object.fromEntries(entries.flatMap((entry) => {
      if (entry.status !== 'fulfilled') {
        return [];
      }
      return [entry.value];
    }));
  });
}

export async function getPreviousClosePrices(tickers = []) {
  const key = cacheKey(tickers);
  return getCachedValue(cacheStore.previousClose, key, CACHE_TTLS_MS.previousClose, async () => {
    const dailyHistory = await getHistoricalDailyPrices(tickers, '2026-06-01');
    return Object.fromEntries(
      [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
        .map((ticker) => {
          const rows = Array.isArray(dailyHistory[ticker]) ? dailyHistory[ticker] : [];
          const previous = rows.length ? rows.at(-1) : null;
          return [ticker, {
            ticker,
            previousCloseUsd: toNumber(previous?.close),
            updatedAt: nowIso(),
            priceSource: 'Yahoo Finance daily history',
          }];
        }),
    );
  });
}

export async function getHistoricalDailyPrices(tickers = [], startDate = '2026-06-05', endDate = null) {
  const endLabel = endDate || new Date().toISOString().slice(0, 10);
  const key = cacheKey(tickers, `${startDate}:${endLabel}`);
  return getCachedValue(cacheStore.daily, key, CACHE_TTLS_MS.daily, async () => {
    const entries = await Promise.allSettled(
      [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
        .map(async (ticker) => {
          const rows = await fetchYahooChart(ticker, {
            interval: '1d',
            startDate,
            endDate: endLabel,
            includePrePost: false,
          });
          return [ticker, rows.map((row) => ({
            time: formatDailyLabel(row.timestamp * 1000),
            close: round(row.close, 4),
          })).filter((row) => row.time && row.close !== null)];
        }),
    );
    return Object.fromEntries(entries.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []));
  });
}

export async function getIntradayHourlyPrices(tickers = []) {
  const key = cacheKey(tickers);
  return getCachedValue(cacheStore.intraday, key, CACHE_TTLS_MS.intraday, async () => {
    const entries = await Promise.allSettled(
      [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
        .map(async (ticker) => {
          const rows = await fetchYahooChart(ticker, {
            interval: '60m',
            range: '5d',
            includePrePost: true,
          });
          return [ticker, rows.map((row) => ({
            time: formatEtLabel(row.timestamp * 1000),
            close: round(row.close, 4),
          })).filter((row) => row.time && row.close !== null)];
        }),
    );
    return Object.fromEntries(entries.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []));
  });
}

export async function getHistoricalMinutePrices(tickers = [], startDate = '2026-06-05', endDate = null) {
  const endIso = endDate || new Date().toISOString();
  const key = cacheKey(tickers, `${startDate}:minute`);
  return getCachedValue(cacheStore.intradayMinute, key, CACHE_TTLS_MS.intradayMinute, async () => {
    const chunks = splitDateRangeIntoChunks(`${startDate}T00:00:00.000Z`, endIso, 7);
    const entries = await Promise.allSettled(
      [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
        .map(async (ticker) => {
          const seriesParts = await Promise.all(chunks.map((chunk) => fetchYahooChart(ticker, {
            interval: '1m',
            startDate: chunk.startDate,
            endDate: chunk.endDate,
            includePrePost: true,
          })));
          const rows = [];
          const seen = new Set();
          for (const part of seriesParts) {
            for (const row of part) {
              const time = formatEtMinuteLabel(row.timestamp * 1000);
              const close = round(row.close, 4);
              if (!time || close === null || seen.has(time)) {
                continue;
              }
              seen.add(time);
              rows.push({ time, timestamp: row.timestamp * 1000, close });
            }
          }
          rows.sort((a, b) => String(a.time).localeCompare(String(b.time)));
          return [ticker, rows];
        }),
    );
    return Object.fromEntries(entries.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []));
  });
}

export async function getCachedOrFetchPrices(tickers = []) {
  return getLivePrices(tickers);
}
