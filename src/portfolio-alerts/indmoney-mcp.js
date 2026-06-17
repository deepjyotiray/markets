import { compactWhitespace, computeAbsoluteChange, nowIso, round, toNumber } from './utils.js';
import { createIndMoneyMcpHttpClient, hasIndMoneyMcpHttpAuth } from './indmoney-mcp-http-client.js';

export const INDMONEY_ASSET_TYPES = [
  'IND_STOCK',
  'MF',
  'US_STOCK',
  'BOND',
  'EPF',
  'NPS',
  'SA',
  'FD',
  'CRYPTO',
  'INSURANCE',
  'VEHICLE',
  'RE',
  'RD',
  'AIF',
  'PMS',
  'PPF',
];

export const INDMONEY_BREAKDOWN_TYPES = ['assets', 'sector', 'market_cap'];
export const INDMONEY_OHLC_INTERVALS = ['1minute', '5minute', '15minute', '30minute', '60minute', '240minute', '1day', '1week', '1month'];
export const INDMONEY_OHLC_LOOKBACKS = ['1d', '7d', '14d', '1y'];
export const INDMONEY_GREEKS_LOOKBACKS = ['1d', '7d'];
export const INDMONEY_SEGMENTS = ['analyst', 'news'];

const MUTUAL_FUND_CATEGORIES = new Set([
  'index-funds', 'equity-other', 'liquid', 'index-funds-fixed-income', 'fund-of-funds', 'low-duration',
  'overnight', 'ultra-short-duration', 'nifty-index-funds', 'money-market', 'arbitrage-fund',
  'short-duration', 'other-bond', 'corporate-bond', 'dynamic-bond',
  'fixed-maturity-intermediate-term-bond', 'large-cap', 'global-funds', 'aggressive-allocation',
  'flexi-cap', 'banking-psu', 'elss-tax-savings', 'large-cap-index-funds', 'gilt-funds',
  'dynamic-asset-allocation', 'equity-savings', 'sector-precious-metals', 'small-cap',
  'large-mid-cap', 'mid-cap', 'conservative-allocation', 'sector-financial-services',
  'multi-asset-allocation', 'multi-cap', 'focused-fund', 'fixed-maturity-short-term-bond',
  'floating-rate', 'medium-duration', 'equity-consumption', 'credit-risk',
  'medium-to-long-duration', 'value', 'mid-cap-index-funds', 'nifty-50-index-funds',
  'other-index-funds', 'equity-infrastructure', 'small-cap-index-funds', 'retirement',
  'sector-healthcare', 'long-duration', 'sector-technology', 'fixed-maturity-ultrashort-bond',
  'nifty-next-50-index-funds', '10-yr-government-bond', 'dividend-yield',
  'nifty-midcap-index-funds', 'equity-esg', 'children', 'balanced-allocation',
  'global-index-funds', 'nifty-smallcap-index-funds', 'sector-energy', 'contra', 'sector-fmcg',
]);

let defaultHttpClient = null;

export function resetDefaultIndMoneyMcpClient() {
  defaultHttpClient = null;
}

export function parseMcpToolResult(response) {
  let value = response && typeof response === 'object' && 'result' in response ? response.result : response;
  if (value && typeof value === 'object' && value.structuredContent && typeof value.structuredContent === 'object') {
    value = 'result' in value.structuredContent ? value.structuredContent.result : value.structuredContent;
  }
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray(value.content) &&
    value.content[0] &&
    typeof value.content[0].text === 'string'
  ) {
    value = value.content[0].text;
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getDefaultMcpClient() {
  const injected = globalThis.__INDMONEY_MCP_CLIENT__ || globalThis.indmoneyMcpClient || null;
  if (injected) {
    return injected;
  }
  if (!defaultHttpClient && hasIndMoneyMcpHttpAuth()) {
    defaultHttpClient = createIndMoneyMcpHttpClient();
  }
  return defaultHttpClient;
}

async function callMcpTool(client, toolName, args = {}) {
  if (!client) {
    throw new Error('INDmoney MCP client is not available in this Node runtime');
  }
  if (typeof client[toolName] === 'function') {
    return parseMcpToolResult(await client[toolName](args));
  }
  if (typeof client.callTool === 'function') {
    return parseMcpToolResult(await client.callTool(toolName, args));
  }
  if (typeof client.call === 'function') {
    return parseMcpToolResult(await client.call(toolName, args));
  }
  throw new Error('INDmoney MCP client does not expose a supported call interface');
}

function cacheKey(toolName, args) {
  return `${toolName}:${JSON.stringify(args || {})}`;
}

export function createIndMoneyMcpProvider(options = {}) {
  const client = options.client || getDefaultMcpClient();
  const cacheSeconds = Math.max(0, Number(options.cacheSeconds ?? 0));
  const cache = new Map();

  async function call(toolName, args = {}) {
    const key = cacheKey(toolName, args);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.payload;
    }
    const payload = await callMcpTool(client || getDefaultMcpClient(), toolName, args);
    if (cacheSeconds > 0) {
      cache.set(key, { expiresAt: Date.now() + cacheSeconds * 1000, payload });
    }
    return payload;
  }

  return {
    isAvailable() {
      return Boolean(client || getDefaultMcpClient());
    },
    clearCache() {
      cache.clear();
    },
    networthSnapshot: () => call('networth_snapshot'),
    networthHoldings: (assetType) => call('networth_holdings', { asset_type: assetType }),
    networthAllocationBreakdown: (assetType, breakdownBy) =>
      call('networth_allocation_breakdown', { asset_type: assetType, breakdown_by: breakdownBy }),
    userWatchlist: (type = 'all') => call('user_watchlist', { type }),
    mfSips: () => call('mf_sips'),
    indianStocksSips: () => call('indian_stocks_sips'),
    getUsStocksDetails: (symbols, segments = null) => call('get_us_stocks_details', { symbols, segments }),
    lookupIndKeys: (names, filterType = undefined) => call('lookup_ind_keys', { names, ...(filterType ? { filter_type: filterType } : {}) }),
    getIndianStocksDetails: (indKeys, segments = null) => call('get_indian_stocks_details', { ind_keys: indKeys, segments }),
    getIndianStocksOhlc: (indKey, interval, lookback) =>
      call('get_indian_stocks_ohlc', { ind_key: indKey, interval, lookback }),
    getIndianStocksOptionChain: (indKey, options = {}) =>
      call('get_indian_stocks_option_chain', Object.fromEntries(Object.entries({
        ind_key: indKey,
        use_expiry_date: Boolean(options.useExpiryDate),
        expiry_date: options.expiryDate || undefined,
        strikes_around_atm: options.strikesAroundAtm ?? undefined,
      }).filter(([, value]) => value !== undefined))),
    getIndianStocksGreeksHistory: (indKey, lookback = '1d') =>
      call('get_indian_stocks_greeks_history', { ind_key: indKey, lookback }),
    getMfByCategory: (categories, options = {}) =>
      call('get_mf_by_category', Object.fromEntries(Object.entries({
        categories,
        size: options.size ?? undefined,
        sort_key: options.sortKey ?? undefined,
        sort_asc: options.sortAsc ?? undefined,
      }).filter(([, value]) => value !== undefined))),
    getMfFundsDetails: (fundIds, includes = null) => call('get_mf_funds_details', { fund_ids: fundIds, includes }),
  };
}

export function normalizeMcpWatchlists(payload = {}) {
  return {
    ...payload,
    watchlists: (payload.watchlists || []).map((watchlist) => ({
      ...watchlist,
      stocks: (watchlist.stocks || []).filter((stock) => stock?.ticker || stock?.ind_key),
    })),
  };
}

function normalizeName(value) {
  return compactWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sanitizeTicker(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, '')
    .replace(/\.+$/, '')
    .slice(0, 15);
}

function isLikelyTicker(value = '') {
  return /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(sanitizeTicker(value));
}

function isLikelyUsTicker(value = '') {
  return /^[A-Z]{1,6}(?:\.[A-Z]{1,4})?$/.test(sanitizeTicker(value));
}

const MCP_HOLDING_TICKER_ALIASES = new Map([
  ['203532', 'SPCX'],
  ['spacex', 'SPCX'],
]);

function normalizeHoldingName(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\b(class|common|stock|inc|inc\.|corp|corp\.|corporation|company|co|co\.|ltd|ltd\.|limited|plc|adr|ads)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFallbackHoldingTicker(row = {}) {
  const codeAlias = MCP_HOLDING_TICKER_ALIASES.get(String(row.investment_code || '').trim());
  if (codeAlias) {
    return codeAlias;
  }
  const nameAlias = MCP_HOLDING_TICKER_ALIASES.get(normalizeHoldingName(row.investment || row.name || ''));
  if (nameAlias) {
    return nameAlias;
  }
  const investmentName = normalizeHoldingName(row.investment || row.name || row.company_name || row.fund_name || '');
  if (investmentName) {
    const tokens = investmentName.split(' ').filter(Boolean);
    if (tokens.length === 1) {
      return sanitizeTicker(tokens[0]).slice(0, 15);
    }
    const initials = sanitizeTicker(tokens.map((token) => token[0]).join(''));
    if (initials) {
      return initials.slice(0, 15);
    }
    return sanitizeTicker(tokens.join('')).slice(0, 15);
  }
  const code = sanitizeTicker(`MCP-${String(row.investment_code || '').trim()}`);
  return code || '';
}

function parseTickerFromInvestmentText(investment = '') {
  const text = String(investment || '');
  const parenMatch = text.match(/\(([A-Za-z0-9.\-]{2,15})\)/);
  if (parenMatch && isLikelyTicker(parenMatch[1])) {
    return sanitizeTicker(parenMatch[1]);
  }
  const dashMatch = text.match(/\b([A-Za-z0-9.\-]{2,15})\s*[\-–]\s*common stock\b/i);
  if (dashMatch && isLikelyTicker(dashMatch[1])) {
    return sanitizeTicker(dashMatch[1]);
  }
  return '';
}

function inferTickerFromHolding(row = {}, stockProfiles = {}, detailsBySymbol = {}) {
  const code = String(row.investment_code || '');
  const rawExplicitTicker = String(
    row.ticker
    || row.symbol
    || row.instrument_symbol
    || row.stock_symbol
    || '',
  ).trim();
  const explicitTicker = sanitizeTicker(rawExplicitTicker);
  for (const [symbol, details] of Object.entries(detailsBySymbol || {})) {
    if (!code) {
      break;
    }
    if (String(details?.entity_basic?.mycroft_id || '') === code) {
      return symbol.toUpperCase();
    }
  }
  if (code && detailsBySymbol[code]) {
    return String(code).toUpperCase();
  }
  if (explicitTicker && isLikelyUsTicker(explicitTicker)) {
    return explicitTicker;
  }
  const textTicker = parseTickerFromInvestmentText(row.investment);
  if (textTicker && isLikelyTicker(textTicker)) {
    return textTicker;
  }
  const holdingName = normalizeName(row.investment);
  for (const [ticker, profile] of Object.entries(stockProfiles || {})) {
    const names = [profile.name, profile.companyName, ticker]
      .map((value) => normalizeName(value))
      .filter(Boolean);
    if (names.some((name) => holdingName === name || holdingName.includes(name) || name.includes(holdingName))) {
      return ticker.toUpperCase();
    }
  }
  return buildFallbackHoldingTicker(row);
}

export function normalizeMcpUsStockDetails(payload = {}) {
  const entries = Object.entries(payload || {});
  return Object.fromEntries(entries.map(([symbol, details]) => {
    const stats = details?.entity_stats || {};
    const price = toNumber(stats.live_price);
    const previousClose = toNumber(stats.prev_close);
    const analyst = details?.analyst_forecast || null;
    const news = Array.isArray(details?.news) ? details.news : [];
    return [String(symbol || '').toUpperCase(), {
      symbol: String(symbol || '').toUpperCase(),
      name: details?.entity_basic?.name || details?.entity_basic?.display_name || symbol,
      source: 'INDmoney MCP',
      price,
      previousClose,
      pctChange: toNumber(stats.day_change_percentage),
      absChange: toNumber(stats.day_change) ?? computeAbsoluteChange(price, previousClose),
      timestamp: stats.last_updated || null,
      marketCap: toNumber(details?.entity_basic?.market_cap_in_currency),
      volume: toNumber(stats.volume),
      analyst,
      analystTargetPrice: toNumber(analyst?.target_price?.mean ?? analyst?.consensus?.target_prc),
      analystUpsidePct: toNumber(analyst?.target_price?.upside_per),
      analystSentiment: analyst?.consensus?.sentiment || null,
      news,
    }];
  }));
}

export function buildFundamentalSnapshotFromMcpUsDetails(symbol, details = {}) {
  const target = toNumber(details.analystTargetPrice);
  const sentiment = details.analystSentiment || 'n/a';
  const upside = toNumber(details.analystUpsidePct);
  const positiveNews = (details.news || []).filter((item) => item.sentiment === 'positive').length;
  const negativeNews = (details.news || []).filter((item) => item.sentiment === 'negative').length;
  return {
    marketCap: details.marketCap,
    pe: null,
    epsTTM: null,
    revenueGrowthYoY: null,
    epsGrowthYoY: null,
    operatingMargin: null,
    netMargin: null,
    debtToEquity: null,
    beta: null,
    week52High: null,
    week52Low: null,
    nextEarningsDate: null,
    nextEarningsHour: null,
    analystTargetPrice: target,
    analystUpsidePct: upside,
    analystSentiment: sentiment,
    source: 'INDmoney MCP',
    sourceUrl: '',
    qualityScore: sentiment === 'BUY' || positiveNews > negativeNews ? 2 : 1,
    qualityLabel: sentiment === 'BUY' ? 'supportive' : 'mixed',
    summary: `INDmoney MCP analyst ${sentiment} | target ${target ?? 'n/a'} | upside ${upside ?? 'n/a'}% | news +${positiveNews}/-${negativeNews}`,
  };
}

export function normalizeMcpUsHoldingsForAlertEngine({
  holdingsPayload = {},
  detailsPayload = {},
  usdInrRate,
  stockProfiles = {},
  now = new Date(),
} = {}) {
  const details = normalizeMcpUsStockDetails(detailsPayload);
  const rows = Array.isArray(holdingsPayload?.holdings) ? holdingsPayload.holdings : [];
  const explicitRate = toNumber(usdInrRate);
  const inferredRates = rows.map((row) => {
    const ticker = inferTickerFromHolding(row, stockProfiles, details);
    const detail = details[ticker] || {};
    const marketValueInr = toNumber(row.market_value);
    const units = toNumber(row.total_units);
    const livePriceUsd = toNumber(detail.price);
    if (marketValueInr !== null && units && livePriceUsd) {
      return marketValueInr / (units * livePriceUsd);
    }
    const investedInr = toNumber(row.invested_amount);
    const unitPriceInr = toNumber(row.unit_price);
    if (investedInr !== null && units && livePriceUsd) {
      return investedInr / (units * livePriceUsd);
    }
    if (unitPriceInr !== null && livePriceUsd) {
      return unitPriceInr / livePriceUsd;
    }
    return null;
  }).filter((value) => value !== null && value > 0);
  const rate = explicitRate && explicitRate > 0
    ? explicitRate
    : (inferredRates.length
      ? round(inferredRates.reduce((sum, value) => sum + value, 0) / inferredRates.length, 4)
      : null);
  if (!rate || rate <= 0) {
    throw new Error('A positive USD/INR rate is required to normalize INDmoney US holdings');
  }
  const holdings = rows.map((row) => {
    const ticker = inferTickerFromHolding(row, stockProfiles, details);
    if (!ticker) {
      return null;
    }
    const detail = details[ticker] || {};
    const marketValueInr = toNumber(row.market_value);
    const investedInr = toNumber(row.invested_amount);
    const pnlInr = toNumber(row.total_pnl);
    const units = toNumber(row.total_units);
    const unitPriceInr = toNumber(row.unit_price);
    return {
      ticker,
      name: row.investment || detail.name || stockProfiles[ticker]?.name || ticker,
      quantity: units ?? 0,
      avgPrice: investedInr !== null && units ? round((investedInr / units) / rate, 4) : null,
      invested: investedInr === null ? null : round(investedInr / rate, 2),
      currentValue: marketValueInr === null ? null : round(marketValueInr / rate, 2),
      currentValueUsd: marketValueInr === null ? null : round(marketValueInr / rate, 2),
      totalReturn: pnlInr === null ? null : round(pnlInr / rate, 2),
      totalActualReturn: pnlInr === null ? null : round(pnlInr / rate, 2),
      totalActualReturnUsd: pnlInr === null ? null : round(pnlInr / rate, 2),
      lastPrice: detail.price ?? (unitPriceInr === null ? null : round(unitPriceInr / rate, 4)),
      livePrice: detail.price ?? (unitPriceInr === null ? null : round(unitPriceInr / rate, 4)),
      movePct: detail.pctChange ?? null,
      oneDayPnlUsd: null,
      source: 'INDmoney MCP',
      sourceCurrency: 'INR',
      normalizedCurrency: 'USD',
      usdInrRate: rate,
      broker: row.broker || null,
      marketCap: row.market_cap || null,
      mcpInvestmentCode: row.investment_code || null,
    };
  }).filter(Boolean);

  if (!holdings.length) {
    throw new Error('INDmoney MCP US holdings did not include any mappable tickers');
  }

  const summary = {
    portfolioValue: round(holdings.reduce((sum, item) => sum + (toNumber(item.currentValue) || 0), 0), 2),
    investedValue: round(holdings.reduce((sum, item) => sum + (toNumber(item.invested) || 0), 0), 2),
    totalReturns: round(holdings.reduce((sum, item) => sum + (toNumber(item.totalReturn) || 0), 0), 2),
  };
  return {
    source: 'INDmoney MCP',
    updatedAt: nowIso(),
    exportedAt: now.toISOString(),
    sourceCurrency: 'INR',
    normalizedCurrency: 'USD',
    usdInrRate: rate,
    summary,
    holdings,
    mcpDetailsByTicker: details,
  };
}

export function normalizeMcpNetworthSnapshot(payload = {}) {
  return {
    ...payload,
    source: 'INDmoney MCP',
    updatedAt: nowIso(),
    investments: Array.isArray(payload.investments) ? payload.investments : [],
    assets: Array.isArray(payload.assets) ? payload.assets : [],
    sector: Array.isArray(payload.sector) ? payload.sector : [],
    market_cap: Array.isArray(payload.market_cap) ? payload.market_cap : [],
  };
}

export function validateIndMoneyAssetType(assetType) {
  const value = String(assetType || '').trim().toUpperCase();
  return INDMONEY_ASSET_TYPES.includes(value) ? value : null;
}

export function validateIndMoneyBreakdownType(type) {
  const value = String(type || '').trim().toLowerCase();
  return INDMONEY_BREAKDOWN_TYPES.includes(value) ? value : null;
}

export function parseCommaList(value, normalizer = (item) => item) {
  return String(value || '')
    .split(',')
    .map((item) => normalizer(item.trim()))
    .filter(Boolean);
}

export function parseSegments(value) {
  const segments = parseCommaList(value, (item) => item.toLowerCase()).filter((item) => INDMONEY_SEGMENTS.includes(item));
  return segments.length ? segments : null;
}

export function parseMutualFundCategories(value) {
  return parseCommaList(value, (item) => item.toLowerCase()).filter((item) => MUTUAL_FUND_CATEGORIES.has(item));
}
