import { compactWhitespace, decodeHtmlEntities, fetchTextWithRetry, nowIso, readJsonFile, round, toNumber, writeJsonFile } from './utils.js';

function textFromHtml(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n'))
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
}

function compactText(lines) {
  return ` ${lines.join(' ')} `;
}

function parseMoneyScale(value) {
  const match = String(value || '').match(/\$?\s*([0-9,.]+)\s*([KMBT])?/i);
  if (!match) {
    return null;
  }
  const numeric = toNumber(match[1]);
  if (numeric === null) {
    return null;
  }
  const scale = String(match[2] || '').toUpperCase();
  const multiplier = scale === 'T' ? 1_000_000_000_000 : scale === 'B' ? 1_000_000_000 : scale === 'M' ? 1_000_000 : scale === 'K' ? 1_000 : 1;
  return numeric * multiplier;
}

function valueAfterLabel(lines, label) {
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  return index >= 0 ? lines[index + 1] || null : null;
}

function numberAfterLabel(lines, label) {
  return toNumber(valueAfterLabel(lines, label));
}

function moneyAfterLabel(lines, label) {
  return parseMoneyScale(valueAfterLabel(lines, label));
}

function firstTableNumberSequence(lines, headingPattern, rowLabel) {
  const pattern = headingPattern instanceof RegExp ? headingPattern : new RegExp(`^${String(headingPattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const headingIndex = lines.findIndex((line) => pattern.test(line));
  if (headingIndex < 0) {
    return [];
  }
  const nextHeading = lines.findIndex((line, index) => index > headingIndex && /^##\s/.test(line));
  const section = lines.slice(headingIndex, nextHeading > headingIndex ? nextHeading : headingIndex + 280);
  const rowIndex = section.findIndex((line) => line.toLowerCase() === rowLabel.toLowerCase());
  if (rowIndex < 0) {
    return [];
  }
  const values = [];
  for (const line of section.slice(rowIndex + 1)) {
    if (/^(gross profit|operating income|ebitda|interest expense|depreciation|income before tax|income tax expense|net income|net profit margin)$/i.test(line)) {
      break;
    }
    const numeric = toNumber(line);
    if (numeric !== null) {
      values.push(numeric);
    }
  }
  return values;
}

function percentGrowth(first, last) {
  const start = toNumber(first);
  const end = toNumber(last);
  if (start === null || end === null || start === 0) {
    return null;
  }
  return round(((end - start) / start) * 100, 2);
}

export function deriveIndMoneySlug(ticker, profile = {}) {
  const symbol = String(ticker || '').trim().toLowerCase();
  const base = String(profile.name || profile.companyName || symbol)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base && symbol ? `${base}-share-price-${symbol}` : null;
}

export function parseIndMoneyStockPage(html, ticker) {
  const lines = textFromHtml(html);
  const joined = compactText(lines);
  const quarterlyRevenue = firstTableNumberSequence(lines, /Quarterly Profit & Loss$/i, 'Total Revenue');
  const annualRevenue = firstTableNumberSequence(lines, /Annual Profit & Loss$/i, 'Total Revenue');
  const quarterlyOperatingIncome = firstTableNumberSequence(lines, /Quarterly Profit & Loss$/i, 'Operating Income');
  const latestQuarterRevenue = quarterlyRevenue.at(-1) ?? null;
  const latestQuarterOperatingIncome = quarterlyOperatingIncome.at(-1) ?? null;
  const computedOperatingMargin =
    latestQuarterRevenue && latestQuarterOperatingIncome
      ? round((latestQuarterOperatingIncome / latestQuarterRevenue) * 100, 2)
      : null;
  const marketCap = moneyAfterLabel(lines, 'Market Cap');
  const revenueTtm = moneyAfterLabel(lines, 'Revenue (TTM)');
  const peTTM = numberAfterLabel(lines, 'PE Ratio (TTM)');
  const pegRatio = numberAfterLabel(lines, 'PEG Ratio');
  const epsTTM = numberAfterLabel(lines, 'EPS (TTM)');
  const netMargin = numberAfterLabel(lines, 'Profit Margin');
  const roe = numberAfterLabel(lines, 'Return On Equity TTM');
  const targetPriceMatch = joined.match(/Average target price of \$([0-9.]+)/i);

  return {
    ticker,
    source: 'INDmoney',
    marketCap,
    revenueTtm,
    peTTM,
    pegRatio,
    epsTTM,
    netMargin,
    operatingMargin: computedOperatingMargin,
    returnOnEquity: roe,
    revenueGrowthTTMYoy: percentGrowth(annualRevenue.at(-2), annualRevenue.at(-1)),
    quarterlyRevenueGrowthYoY: percentGrowth(quarterlyRevenue.at(-5), quarterlyRevenue.at(-1)),
    analystTargetPrice: targetPriceMatch ? toNumber(targetPriceMatch[1]) : null,
    latestQuarterRevenueMillions: latestQuarterRevenue,
    latestQuarterOperatingIncomeMillions: latestQuarterOperatingIncome,
    summary: compactWhitespace(
      `INDmoney fundamentals: revenue TTM ${revenueTtm ? `$${round(revenueTtm / 1_000_000_000, 2)}B` : 'n/a'}, ` +
      `PE ${peTTM ?? 'n/a'}, profit margin ${netMargin ?? 'n/a'}%, ROE ${roe ?? 'n/a'}%.`,
    ),
  };
}

export async function fetchIndMoneyStockSnapshot(ticker, profile = {}, config = {}) {
  const symbol = String(ticker || '').trim().toUpperCase();
  const slug = profile.indmoneySlug || deriveIndMoneySlug(symbol, profile);
  if (!symbol || !slug) {
    return null;
  }
  const url = `https://www.indmoney.com/us-stocks/${slug}`;
  const html = await fetchTextWithRetry(
    url,
    {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    {
      userAgent: config.userAgent,
      maxRetries: config.indMoneyMaxRetries ?? 1,
      timeoutMs: config.indMoneyTimeoutMs ?? 5000,
      retryBackoffMs: config.indMoneyRetryBackoffMs ?? 250,
    },
  );
  if (/Just a moment|Enable JavaScript and cookies|cf-chl|challenge-platform/i.test(html)) {
    throw new Error('INDmoney Cloudflare challenge blocked server fetch');
  }
  return {
    url,
    ...parseIndMoneyStockPage(html, symbol),
  };
}

export function buildFundamentalSnapshotFromIndMoney(snapshot = {}) {
  if (!snapshot) {
    return null;
  }
  const qualityScore =
    (toNumber(snapshot.revenueGrowthTTMYoy) || 0) >= 20 &&
    (toNumber(snapshot.netMargin) || 0) >= 20 &&
    (toNumber(snapshot.returnOnEquity) || 0) >= 20
      ? 3
      : 1;
  return {
    marketCap: snapshot.marketCap,
    pe: snapshot.peTTM,
    epsTTM: snapshot.epsTTM,
    revenueGrowthYoY: snapshot.revenueGrowthTTMYoy,
    epsGrowthYoY: null,
    operatingMargin: snapshot.operatingMargin,
    netMargin: snapshot.netMargin,
    debtToEquity: null,
    beta: null,
    week52High: null,
    week52Low: null,
    nextEarningsDate: null,
    nextEarningsHour: null,
    pegRatio: snapshot.pegRatio,
    revenueTtm: snapshot.revenueTtm,
    quarterlyRevenueGrowthYoY: snapshot.quarterlyRevenueGrowthYoY,
    returnOnEquity: snapshot.returnOnEquity,
    analystTargetPrice: snapshot.analystTargetPrice,
    source: snapshot.source,
    sourceUrl: snapshot.url,
    qualityScore,
    qualityLabel: qualityScore >= 2 ? 'strong' : 'supportive',
    summary:
      `INDmoney fundamentals supportive | rev ${snapshot.revenueGrowthTTMYoy ?? 'n/a'}% YoY | ` +
      `quarterly rev ${snapshot.quarterlyRevenueGrowthYoY ?? 'n/a'}% YoY | ` +
      `op margin ${snapshot.operatingMargin ?? 'n/a'}% | PE ${snapshot.peTTM ?? 'n/a'}`,
  };
}

function normalizeCachedSnapshot(ticker, snapshot = {}) {
  if (!snapshot) {
    return null;
  }
  return {
    ticker,
    fetchedAt: snapshot.fetchedAt || nowIso(),
    url: snapshot.url || '',
    source: snapshot.source || 'INDmoney cache',
    sourceDate: snapshot.sourceDate || null,
    marketCap: snapshot.marketCap ?? null,
    revenueTtm: snapshot.revenueTtm ?? null,
    peTTM: snapshot.peTTM ?? null,
    pegRatio: snapshot.pegRatio ?? null,
    epsTTM: snapshot.epsTTM ?? null,
    netMargin: snapshot.netMargin ?? null,
    operatingMargin: snapshot.operatingMargin ?? null,
    returnOnEquity: snapshot.returnOnEquity ?? null,
    revenueGrowthTTMYoy: snapshot.revenueGrowthTTMYoy ?? null,
    quarterlyRevenueGrowthYoY: snapshot.quarterlyRevenueGrowthYoY ?? null,
    analystTargetPrice: snapshot.analystTargetPrice ?? null,
  };
}

export async function readIndMoneyFundamentalsCache(config = {}) {
  const fallback = { version: 1, updatedAt: null, entries: {} };
  const cache = await readJsonFile(config.indMoneyCachePath, fallback);
  return cache && typeof cache === 'object' ? { ...fallback, ...cache, entries: cache.entries || {} } : fallback;
}

export async function writeIndMoneyFundamentalsCache(config = {}, cache = {}) {
  await writeJsonFile(config.indMoneyCachePath, {
    version: 1,
    updatedAt: nowIso(),
    entries: cache.entries || {},
  });
}

export function getCachedIndMoneySnapshot(cache = {}, ticker) {
  return cache.entries?.[String(ticker || '').toUpperCase()] || null;
}

export function buildIndMoneySeedSnapshot(ticker, profile = {}) {
  if (!profile.indmoneyFundamentals) {
    return null;
  }
  return normalizeCachedSnapshot(ticker, {
    url: profile.indmoneySlug ? `https://www.indmoney.com/us-stocks/${profile.indmoneySlug}` : '',
    ...profile.indmoneyFundamentals,
  });
}

export async function refreshIndMoneyFundamentalsCache(config = {}, tickers = []) {
  const cache = await readIndMoneyFundamentalsCache(config);
  const entries = { ...(cache.entries || {}) };
  const uniqueTickers = [...new Set(tickers.map((ticker) => String(ticker || '').toUpperCase()).filter(Boolean))];
  let liveFetchBlocked = false;
  const results = [];

  for (const ticker of uniqueTickers) {
    const profile = config.stockProfiles?.[ticker] || {};
    const seed = buildIndMoneySeedSnapshot(ticker, profile);
    if (seed && !entries[ticker]) {
      entries[ticker] = seed;
    }
    if (liveFetchBlocked || !profile.name) {
      results.push({ ticker, status: entries[ticker] ? 'cached' : 'missing' });
      continue;
    }
    try {
      const snapshot = await fetchIndMoneyStockSnapshot(ticker, profile, {
        ...config,
        indMoneyTimeoutMs: config.providers?.indmoneyTimeoutMs,
      });
      entries[ticker] = normalizeCachedSnapshot(ticker, snapshot);
      results.push({ ticker, status: 'updated' });
    } catch (error) {
      liveFetchBlocked = /Cloudflare|challenge|403|Forbidden|Fetch failed/i.test(error.message || '');
      if (seed) {
        entries[ticker] = seed;
      }
      results.push({ ticker, status: entries[ticker] ? 'cached' : 'blocked', error: error.message });
    }
  }

  await writeIndMoneyFundamentalsCache(config, { entries });
  return {
    ok: true,
    updatedAt: nowIso(),
    attempted: uniqueTickers.length,
    updated: results.filter((item) => item.status === 'updated').length,
    cached: results.filter((item) => item.status === 'cached').length,
    blocked: results.filter((item) => item.status === 'blocked').length,
    results,
  };
}
