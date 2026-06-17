import { nowIso, round, toNumber } from './utils.js';
import { STOCK_PROFILES } from './config.js';

export const INDMONEY_DASHBOARD_SOURCE = 'INDmoney MCP';
export const STALE_INDIAN_ASSET_TYPES = new Set(['MF', 'STOCK', 'IND_STOCK', 'IN_STOCK', 'INDIAN_STOCK']);
export const STALE_INDIAN_ASSET_CLASSES = new Set(['INDIAN EQUITY']);
export const US_STOCK_PNL_BASELINE_DATE = '2026-06-05';
export const US_PORTFOLIO_SERIES_BASELINE_AT = '2026-06-05 00:00:00 IST';
export const US_PORTFOLIO_SERIES_RANGES = new Set(['1d', '1w', '1m', '3m', '1y', 'all']);

export function getIndMoneyHistoryDateKey(timestamp = nowIso(), timezone = 'Asia/Kolkata') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return String(timestamp || nowIso()).slice(0, 10);
  }
}

function firstNumber(...values) {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) {
      return number;
    }
  }
  return null;
}

function normalizeCurrencyCode(value) {
  const valueString = String(value || '').trim().toUpperCase();
  return valueString === 'USD' || valueString === 'INR' ? valueString : null;
}

function parseUsPortfolioTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/IST$/i.test(raw)) {
    const normalized = raw
      .replace(/\s+IST$/i, '+05:30')
      .replace(' ', 'T');
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeUsPortfolioTicker(value = '') {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
}

function usPortfolioTradeValue(order = {}) {
  const quantity = firstNumber(order.quantity, order.units, order.shares) || 0;
  return firstNumber(order.orderValue, order.order_value)
    ?? firstNumber(order.grossAmount, order.gross_amount)
    ?? firstNumber(order.netAmount, order.net_amount)
    ?? (quantity ? firstNumber(order.avgPrice, order.avg_price, order.price) * quantity : null)
    ?? 0;
}

export function getUsPortfolioSeriesBaselineAt() {
  return US_PORTFOLIO_SERIES_BASELINE_AT;
}

export function normalizeUsPortfolioRange(value = '1m') {
  const range = String(value || '1m').trim().toLowerCase();
  return US_PORTFOLIO_SERIES_RANGES.has(range) ? range : '1m';
}

export function getUsPortfolioRangeStart(range = '1m', now = new Date()) {
  const normalized = normalizeUsPortfolioRange(range);
  const end = now instanceof Date ? now : new Date(now);
  if (normalized === 'all') {
    return parseUsPortfolioTime(US_PORTFOLIO_SERIES_BASELINE_AT);
  }
  const days = {
    '1d': 1,
    '1w': 7,
    '1m': 30,
    '3m': 90,
    '1y': 365,
  }[normalized] || 30;
  const candidate = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const baseline = parseUsPortfolioTime(US_PORTFOLIO_SERIES_BASELINE_AT);
  return baseline && candidate < baseline ? baseline : candidate;
}

export function floorUsPortfolioHour(timestamp = nowIso()) {
  const date = parseUsPortfolioTime(timestamp) || new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const floored = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00+05:30`);
  return Number.isNaN(floored.getTime()) ? null : floored.toISOString();
}

export function normalizeUsPortfolioSeriesPoint(point = {}) {
  const timestamp = floorUsPortfolioHour(point.timestamp || point.date || nowIso());
  if (!timestamp) return null;
  const currentValue = firstNumber(point.currentValue, point.current_value, point.value);
  const invested = firstNumber(point.invested, point.totalInvested, point.total_invested);
  const pnl = firstNumber(point.pnl, point.totalReturn, point.total_return)
    ?? (currentValue !== null && invested !== null ? round(currentValue - invested, 2) : null);
  if (currentValue === null && pnl === null) return null;
  const explicitPnlPct = firstNumber(point.pnlPct, point.pnl_pct, point.totalReturnPct, point.total_return_pct);
  const pnlPct = explicitPnlPct ?? (pnl !== null && invested ? (pnl / invested) * 100 : null);
  return {
    timestamp,
    currentValue: currentValue === null ? null : round(currentValue, 2),
    invested: invested === null ? null : round(invested, 2),
    pnl: pnl === null ? null : round(pnl, 2),
    pnlPct: pnlPct === null ? null : round(pnlPct, 2),
    holdingsCount: firstNumber(point.holdingsCount, point.holdings_count) ?? null,
    source: point.source || 'portfolio_series',
  };
}

export function appendUsPortfolioSeriesPoint(series = [], point) {
  const normalized = normalizeUsPortfolioSeriesPoint(point);
  const rows = (Array.isArray(series) ? series : [])
    .map(normalizeUsPortfolioSeriesPoint)
    .filter(Boolean);
  if (!normalized) {
    return { series: rows, appended: false, reason: 'missing_point' };
  }
  const existingIndex = rows.findIndex((row) => row.timestamp === normalized.timestamp);
  if (existingIndex >= 0) {
    rows[existingIndex] = normalized;
  } else {
    rows.push(normalized);
  }
  rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return {
    series: rows,
    appended: existingIndex < 0,
    reason: existingIndex >= 0 ? 'replaced_hour' : 'appended_hour',
    point: normalized,
  };
}

export function filterUsPortfolioSeriesByRange(series = [], range = '1m', now = new Date()) {
  const normalizedRange = normalizeUsPortfolioRange(range);
  const start = getUsPortfolioRangeStart(normalizedRange, now);
  return (Array.isArray(series) ? series : [])
    .map(normalizeUsPortfolioSeriesPoint)
    .filter(Boolean)
    .filter((point) => normalizedRange === 'all' || !start || new Date(point.timestamp) >= start)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

export function reconstructUsPortfolioPositionsAt(portfolio = {}, timestamp = nowIso(), options = {}) {
  const at = parseUsPortfolioTime(timestamp) || new Date(timestamp);
  const us = portfolio.US || portfolio.us || portfolio;
  const universe = new Set((options.universe || []).map(normalizeUsPortfolioTicker).filter(Boolean));
  const holdings = Array.isArray(us?.holdings) ? us.holdings : [];
  const positions = new Map();
  for (const holding of holdings) {
    const ticker = normalizeUsPortfolioTicker(holding.ticker || holding.symbol);
    if (!ticker || (universe.size && !universe.has(ticker))) continue;
    positions.set(ticker, {
      ticker,
      name: holding.name || ticker,
      quantity: firstNumber(holding.quantity, holding.units, holding.shares) || 0,
      invested: firstNumber(holding.invested, holding.investedValue, holding.costValue) || 0,
      avgPrice: firstNumber(holding.avgPrice, holding.avg_price),
    });
  }

  const orders = (Array.isArray(us?.orders) ? us.orders : [])
    .map((order) => ({
      ...order,
      ticker: normalizeUsPortfolioTicker(order.ticker || order.symbol),
      time: parseUsPortfolioTime(order.filledAt || order.placedAt || order.timestamp),
    }))
    .filter((order) => order.ticker && order.time && order.time > at)
    .sort((a, b) => b.time.getTime() - a.time.getTime());

  for (const order of orders) {
    if (universe.size && !universe.has(order.ticker)) continue;
    const side = String(order.side || '').trim().toUpperCase();
    const quantity = firstNumber(order.quantity, order.units, order.shares) || 0;
    const value = usPortfolioTradeValue(order);
    const existing = positions.get(order.ticker) || {
      ticker: order.ticker,
      name: order.name || order.ticker,
      quantity: 0,
      invested: 0,
      avgPrice: null,
    };
    if (side === 'BUY') {
      existing.quantity -= quantity;
      existing.invested -= value;
    } else if (side === 'SELL') {
      existing.quantity += quantity;
      existing.invested += value;
    }
    if (Math.abs(existing.quantity) < 1e-9) existing.quantity = 0;
    if (Math.abs(existing.invested) < 1e-6) existing.invested = 0;
    existing.quantity = Math.max(0, existing.quantity);
    existing.invested = Math.max(0, existing.invested);
    existing.avgPrice = existing.quantity ? round(existing.invested / existing.quantity, 4) : existing.avgPrice;
    positions.set(order.ticker, existing);
  }

  return Array.from(positions.values())
    .filter((row) => row.quantity > 0 || row.invested > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker))
    .map((row) => ({
      ...row,
      quantity: round(row.quantity, 9),
      invested: round(row.invested, 2),
      avgPrice: row.quantity ? round(row.invested / row.quantity, 4) : row.avgPrice,
    }));
}

export function buildUsPortfolioSeriesPoint({ timestamp, positions = [], prices = {}, source = 'Historical prices', baseline = false } = {}) {
  const priceMap = prices instanceof Map ? prices : new Map(Object.entries(prices || {}));
  let currentValue = 0;
  let invested = 0;
  let pricedHoldings = 0;
  const missingTickers = [];
  for (const position of Array.isArray(positions) ? positions : []) {
    const ticker = normalizeUsPortfolioTicker(position.ticker);
    const quantity = firstNumber(position.quantity, position.units, position.shares) || 0;
    if (!ticker || !quantity) continue;
    const price = firstNumber(priceMap.get(ticker), priceMap.get(ticker.toLowerCase()), position.lastPrice, position.close);
    invested += firstNumber(position.invested, position.costValue) || 0;
    if (price === null) {
      missingTickers.push(ticker);
      continue;
    }
    currentValue += quantity * price;
    pricedHoldings += 1;
  }
  if (!pricedHoldings) return null;
  const effectiveInvested = baseline ? currentValue : invested;
  const pnl = currentValue - effectiveInvested;
  return normalizeUsPortfolioSeriesPoint({
    timestamp,
    currentValue,
    invested: effectiveInvested,
    pnl,
    pnlPct: effectiveInvested ? (pnl / effectiveInvested) * 100 : null,
    holdingsCount: pricedHoldings,
    source,
    missingTickers,
  });
}

export function buildUsPortfolioSeriesPayload(series = [], options = {}) {
  const range = normalizeUsPortfolioRange(options.range || '1m');
  const points = filterUsPortfolioSeriesByRange(series, range, options.now || new Date());
  const last = points.at(-1) || null;
  return {
    ok: true,
    range,
    currency: options.currency || 'USD',
    baselineAt: US_PORTFOLIO_SERIES_BASELINE_AT,
    pointCount: points.length,
    source: options.source || 'US stock portfolio series',
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
    valuePoints: points
      .filter((point) => point.currentValue !== null)
      .map((point) => ({ time: point.timestamp, value: point.currentValue, invested: point.invested, pnl: point.pnl, pnlPct: point.pnlPct })),
    pnlPoints: points
      .filter((point) => point.pnl !== null)
      .map((point) => ({ time: point.timestamp, value: point.pnl, currentValue: point.currentValue, invested: point.invested, pnlPct: point.pnlPct })),
    summary: last
      ? {
          currentValue: last.currentValue,
          invested: last.invested,
          pnl: last.pnl,
          pnlPct: last.pnlPct,
          timestamp: last.timestamp,
        }
      : {
          currentValue: null,
          invested: null,
          pnl: null,
          pnlPct: null,
          timestamp: null,
        },
  };
}

function normalizeHoldingQuantity(row = {}) {
  return firstNumber(row.quantity, row.units, row.total_units, row.shares);
}

function resolveHoldingLatestPrice(row = {}) {
  const explicit = firstNumber(row.lastPrice, row.livePrice, row.regularPrice, row.price, row.close);
  if (explicit !== null) return explicit;
  const quantity = normalizeHoldingQuantity(row);
  const currentValue = firstNumber(row.currentValue, row.current_value, row.market_value, row.value);
  return quantity ? round(currentValue / quantity, 6) : null;
}

function resolveHoldingCurrentValue(row = {}) {
  const explicit = firstNumber(row.currentValue, row.current_value, row.market_value, row.value);
  if (explicit !== null) return explicit;
  const quantity = normalizeHoldingQuantity(row);
  const latestPrice = resolveHoldingLatestPrice(row);
  return quantity !== null && latestPrice !== null ? round(quantity * latestPrice, 2) : null;
}

function normalizePriceLookup(input = {}) {
  const map = new Map();
  if (input instanceof Map) {
    for (const [key, value] of input.entries()) {
      const ticker = normalizeUsPortfolioTicker(key);
      const price = toNumber(value);
      if (ticker && price !== null) {
        map.set(ticker, price);
      }
    }
    return map;
  }
  for (const [key, value] of Object.entries(input || {})) {
    const ticker = normalizeUsPortfolioTicker(key);
    const price = toNumber(value);
    if (ticker && price !== null) {
      map.set(ticker, price);
    }
  }
  return map;
}

export function buildCurrentHoldingsBaseline(rows = [], baselinePrices = {}) {
  const priceMap = normalizePriceLookup(baselinePrices);
  const holdings = [];
  const missingBaselineTickers = [];
  let baselineValueUsd = 0;
  let latestValueUsd = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const ticker = normalizeUsPortfolioTicker(row.ticker || row.symbol);
    const quantity = normalizeHoldingQuantity(row);
    if (!ticker || quantity === null || quantity <= 0) continue;
    const latestPrice = resolveHoldingLatestPrice(row);
    const currentValue = resolveHoldingCurrentValue(row);
    const baselinePrice = firstNumber(priceMap.get(ticker));
    const baselineValue = baselinePrice !== null ? round(quantity * baselinePrice, 2) : null;
    const latestValue = currentValue !== null
      ? round(currentValue, 2)
      : latestPrice !== null
        ? round(quantity * latestPrice, 2)
        : null;
    const change = baselineValue !== null && latestValue !== null ? round(latestValue - baselineValue, 2) : null;
    const changePct = change !== null && baselineValue ? round((change / baselineValue) * 100, 2) : null;
    if (baselineValue === null) {
      missingBaselineTickers.push(ticker);
    } else {
      baselineValueUsd += baselineValue;
    }
    if (latestValue !== null) {
      latestValueUsd += latestValue;
    }
    holdings.push({
      name: row.name || ticker,
      ticker,
      quantity: round(quantity, 9),
      invested: firstNumber(row.invested, row.invested_amount, row.cost_value),
      baselinePrice: baselinePrice === null ? null : round(baselinePrice, 4),
      baselineValue,
      latestPrice: latestPrice === null ? null : round(latestPrice, 4),
      latestValue,
      change,
      changePct,
      currency: normalizeCurrencyCode(row.currency) || 'USD',
    });
  }

  const totalChangeUsd = baselineValueUsd || latestValueUsd ? round(latestValueUsd - baselineValueUsd, 2) : null;
  return {
    baselineDate: US_STOCK_PNL_BASELINE_DATE,
    baselineMethod: 'current_holdings_repriced',
    baselineValueUsd: baselineValueUsd ? round(baselineValueUsd, 2) : 0,
    latestValueUsd: latestValueUsd ? round(latestValueUsd, 2) : 0,
    changeUsd: totalChangeUsd,
    changePct: totalChangeUsd !== null && baselineValueUsd ? round((totalChangeUsd / baselineValueUsd) * 100, 2) : null,
    missingBaselineTickers,
    holdings,
  };
}

export function buildCurrentHoldingsRepricedSeries(options = {}) {
  const {
    rows = [],
    baselineValueUsd = null,
    snapshots = [],
    fallbackLatestTimestamp = null,
  } = options;
  const holdings = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      ticker: normalizeUsPortfolioTicker(row.ticker || row.symbol),
      quantity: normalizeHoldingQuantity(row),
      latestPrice: resolveHoldingLatestPrice(row),
    }))
    .filter((row) => row.ticker && row.quantity !== null && row.quantity > 0);
  const normalizedSnapshots = (Array.isArray(snapshots) ? snapshots : [])
    .filter((snapshot) => snapshot && snapshot.timestamp)
    .map((snapshot) => ({
      timestamp: snapshot.timestamp,
      source: snapshot.source || 'historical_us_stock_candles',
      prices: normalizePriceLookup(snapshot.prices),
    }))
    .filter((snapshot) => snapshot.prices.size > 0)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const points = [];
  for (const snapshot of normalizedSnapshots) {
    let currentValue = 0;
    let pricedCount = 0;
    for (const holding of holdings) {
      const price = firstNumber(snapshot.prices.get(holding.ticker));
      if (price === null) continue;
      currentValue += holding.quantity * price;
      pricedCount += 1;
    }
    if (!pricedCount) continue;
    points.push(normalizeUsPortfolioSeriesPoint({
      timestamp: snapshot.timestamp,
      currentValue,
      invested: baselineValueUsd,
      pnl: baselineValueUsd !== null ? currentValue - baselineValueUsd : null,
      pnlPct: baselineValueUsd ? ((currentValue - baselineValueUsd) / baselineValueUsd) * 100 : null,
      holdingsCount: pricedCount,
      source: snapshot.source,
    }));
  }

  const latestTimestamp = fallbackLatestTimestamp || new Date().toISOString();
  let latestCurrentValue = 0;
  let latestPricedCount = 0;
  for (const holding of holdings) {
    if (holding.latestPrice === null) continue;
    latestCurrentValue += holding.quantity * holding.latestPrice;
    latestPricedCount += 1;
  }
  if (latestPricedCount) {
    points.push(normalizeUsPortfolioSeriesPoint({
      timestamp: latestTimestamp,
      currentValue: latestCurrentValue,
      invested: baselineValueUsd,
      pnl: baselineValueUsd !== null ? latestCurrentValue - baselineValueUsd : null,
      pnlPct: baselineValueUsd ? ((latestCurrentValue - baselineValueUsd) / baselineValueUsd) * 100 : null,
      holdingsCount: latestPricedCount,
      source: 'INDmoney MCP',
    }));
  }

  return points
    .filter(Boolean)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .filter((point, index, list) => index === 0 || point.timestamp !== list[index - 1].timestamp);
}

function normalizeAllocationRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const label =
        row?.label ||
        row?.name ||
        row?.asset ||
        row?.asset_type ||
        row?.assetclass_l2 ||
        row?.asset_class ||
        row?.category ||
        row?.sector ||
        row?.market_cap ||
        row?.title ||
        row?.investment ||
        row?.type ||
        'Unclassified';
      return {
        ...row,
        label,
        value: firstNumber(row?.value, row?.amount, row?.market_value, row?.current_value, row?.currentValue, row?.total_current_value),
        invested: firstNumber(row?.invested, row?.invested_value, row?.invested_amount, row?.total_invested),
        percent: firstNumber(row?.percent, row?.percentage, row?.allocation, row?.weight, row?.weight_pct, row?.allocation_percentage),
      };
    })
    .filter((row) => !row.excludedFromDashboard)
    .filter((row) => row.value !== null || row.invested !== null || row.percent !== null);
}

function normalizeAssetClassLabelForMatch(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
}

function isUsAssetClassLabel(value = '') {
  const label = normalizeAssetClassLabelForMatch(value);
  return (
    label === 'US_STOCK' ||
    label === 'USSTOCK' ||
    label === 'US_STOCKS' ||
    label === 'USSTOCKS' ||
    label.startsWith('US_STOCK') ||
    label.startsWith('USSTOCK')
  );
}

function isLikelyMarketPortfolioEngineSource(value = '') {
  return String(value || '').toLowerCase().includes('market portfolio engine');
}

function normalizeUsTicker(value = '') {
  const rawTicker = String(value || '').trim().toUpperCase();
  if (/\.(COM|INC|CORP|LTD|LLC|CO)$/.test(rawTicker)) {
    return '';
  }
  return /^[A-Z]{1,6}(?:\.[A-Z0-9]{1,5})?$/.test(rawTicker) ? rawTicker : '';
}

const MCP_HOLDING_TICKER_ALIASES = new Map([
  ['203532', 'SPCX'],
  ['spacex', 'SPCX'],
]);

function extractLikelyUsTicker(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const first = raw.match(/(?:\(([A-Za-z]{1,6}(?:\.[A-Za-z0-9]{1,5})?)\))|(?:\b([A-Z]{1,6}(?:\.[A-Z0-9]{1,5})?)\b)/i);
  if (!first) return '';
  const candidate = first[1] || first[2] || '';
  return normalizeUsTicker(candidate);
}

function resolveUsTicker(row = {}) {
  const direct = normalizeUsTicker(row?.ticker || row?.symbol || row?.tradingsymbol || row?.instrument_symbol || row?.stock_symbol || '');
  if (direct) {
    return direct;
  }
  const codeAlias = MCP_HOLDING_TICKER_ALIASES.get(String(row?.investment_code || '').trim());
  if (codeAlias) {
    return codeAlias;
  }
  const profileTicker = resolveKnownUsTickerByName(
    row?.investment ||
      row?.name ||
      row?.company_name ||
      row?.fund_name ||
      '',
  );
  if (profileTicker) {
    return profileTicker;
  }
  const nameAlias = MCP_HOLDING_TICKER_ALIASES.get(normalizeHoldingName(
    row?.investment ||
      row?.name ||
      row?.company_name ||
      row?.fund_name ||
      '',
  ));
  if (nameAlias) {
    return nameAlias;
  }
  const extracted = extractLikelyUsTicker(
    row?.investment_code ||
      row?.investment ||
      row?.name ||
      row?.company_name ||
      row?.fund_name ||
      '',
  );
  if (extracted) {
    return extracted;
  }
  const normalizedName = normalizeHoldingName(
    row?.investment ||
      row?.name ||
      row?.company_name ||
      row?.fund_name ||
      '',
  );
  if (normalizedName) {
    const tokens = normalizedName.split(' ').filter(Boolean);
    if (tokens.length === 1) {
      return sanitizeSyntheticTicker(tokens[0]);
    }
    return sanitizeSyntheticTicker(tokens.map((token) => token[0]).join('') || tokens.join(''));
  }
  return sanitizeSyntheticTicker(`MCP-${String(row?.investment_code || '').trim()}`);
}

function sanitizeSyntheticTicker(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, '')
    .slice(0, 15);
}

function normalizeHoldingName(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\b(class|common|stock|inc|inc\.|corp|corp\.|corporation|company|co|co\.|ltd|ltd\.|limited|plc|adr|ads)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let knownUsTickerNameIndex = null;

function getKnownUsTickerNameIndex() {
  if (knownUsTickerNameIndex) {
    return knownUsTickerNameIndex;
  }
  knownUsTickerNameIndex = Object.entries(STOCK_PROFILES || {})
    .map(([ticker, profile]) => [
      normalizeHoldingName(profile?.name || ''),
      normalizeUsTicker(ticker),
    ])
    .filter(([name, ticker]) => name && ticker);
  return knownUsTickerNameIndex;
}

function resolveKnownUsTickerByName(value = '') {
  const holdingName = normalizeHoldingName(value);
  if (!holdingName) {
    return '';
  }
  const match = getKnownUsTickerNameIndex().find(([profileName]) =>
    holdingName === profileName ||
    holdingName.includes(profileName) ||
    profileName.includes(holdingName),
  );
  return match?.[1] || '';
}

function normalizeHoldingIdentity(row = {}) {
  const ticker = resolveUsTicker(row);
  if (ticker) {
    return `ticker:${ticker}`;
  }
  const name = String(row.name || row.investment || row.fund_name || row.company_name || '').trim().toLowerCase();
  const normalizedName = normalizeHoldingName(name);
  if (normalizedName) {
    return `name:${normalizedName}`;
  }
  const units = firstNumber(row.units, row.quantity, row.total_units, row.shares);
  const invested = firstNumber(row.invested, row.invested_amount, row.cost_value);
  const currentValue = firstNumber(row.currentValue, row.current_value, row.market_value, row.value, row.total_current_value);
  if (units !== null || invested !== null || currentValue !== null) {
    return `value:${round(units ?? 0, 6)}|${round(invested ?? 0, 2)}|${round(currentValue ?? 0, 2)}`;
  }
  const broker = String(row.broker || row.broker_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return broker ? `broker:${broker}` : `holding:${round(units ?? 0, 6)}|${round(invested ?? 0, 2)}|${round(currentValue ?? 0, 2)}`;
}

function holdingCompletenessScore(row = {}) {
  let score = 0;
  if (row?.ticker) score += 6;
  if (row?.source && !isLikelyMarketPortfolioEngineSource(row.source)) score += 3;
  if (toNumber(row.units) !== null) score += 2;
  if (toNumber(row.invested) !== null) score += 2;
  if (toNumber(row.currentValue) !== null) score += 2;
  if (toNumber(row.lastPrice) !== null || toNumber(row.livePrice) !== null || toNumber(row.regularPrice) !== null) score += 1;
  return score;
}

function shouldReplaceDedupedHolding(existing, candidate) {
  if (!existing) return true;
  const existingIsMarketSource = isLikelyMarketPortfolioEngineSource(existing.source);
  const nextIsMarketSource = isLikelyMarketPortfolioEngineSource(candidate.source);
  const existingScore = holdingCompletenessScore(existing);
  const nextScore = holdingCompletenessScore(candidate);
  return nextScore > existingScore || (nextScore === existingScore && existingIsMarketSource && !nextIsMarketSource);
}

function dedupeIndMoneyHoldings(rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const deduped = new Map();
  const nameIndex = new Map();
  for (const row of normalizedRows) {
    const key = normalizeHoldingIdentity(row);
    if (shouldReplaceDedupedHolding(deduped.get(key), row)) {
      deduped.set(key, row);
    }
    if (key.startsWith('ticker:')) {
      const ticker = key.slice('ticker:'.length);
      const name = normalizeHoldingName(row.name || row.investment || row.fund_name || row.company_name || '');
      if (name && ticker) {
        const existingTicker = nameIndex.get(name);
        const existingRow = existingTicker ? deduped.get(`ticker:${existingTicker}`) : null;
        if (!existingRow || shouldReplaceDedupedHolding(existingRow, row)) {
          nameIndex.set(name, ticker);
        } else if (!existingTicker) {
          nameIndex.set(name, ticker);
        }
      }
    }
  }

  for (const row of normalizedRows) {
    const key = normalizeHoldingIdentity(row);
    if (key.startsWith('ticker:')) continue;
    const name = normalizeHoldingName(row.name || row.investment || row.fund_name || row.company_name || '');
    if (!name) {
      if (!deduped.has(key)) {
        deduped.set(key, row);
      }
      continue;
    }
    const targetTicker = nameIndex.get(name);
    if (!targetTicker) {
      if (!deduped.has(key)) {
        deduped.set(key, row);
      }
      continue;
    }
    const targetKey = `ticker:${targetTicker}`;
    if (shouldReplaceDedupedHolding(deduped.get(targetKey), row)) {
      deduped.set(targetKey, row);
    }
    deduped.delete(key);
  }
  return Array.from(deduped.values());
}

function resolveIndMoneyUsFxRate({
  usdInvested,
  usdCurrent,
  officialInvested,
  officialCurrent,
}) {
  const candidates = [];
  if (usdInvested !== null && officialInvested !== null && usdInvested > 0 && officialInvested > 0) {
    candidates.push(officialInvested / usdInvested);
  }
  if (usdCurrent !== null && officialCurrent !== null && usdCurrent > 0 && officialCurrent > 0) {
    candidates.push(officialCurrent / usdCurrent);
  }
  const likelyInrUsd = candidates.filter((rate) => rate >= 40 && rate <= 250);
  if (likelyInrUsd.length) {
    return round(likelyInrUsd.reduce((sum, value) => sum + value, 0) / likelyInrUsd.length, 4);
  }
  const almostOne = candidates.find((rate) => rate >= 0.5 && rate <= 2);
  if (almostOne !== undefined) {
    return 1;
  }
  const inverseCandidates = candidates
    .filter((rate) => rate > 0 && rate < 1)
    .map((rate) => 1 / rate);
  const plausibleInverse = inverseCandidates.find((rate) => rate >= 40 && rate <= 250);
  return plausibleInverse ?? null;
}

function findUsStockAllocation(rows = []) {
  return (Array.isArray(rows) ? rows : []).find((row) => {
    const label = String(row?.asset_type || row?.label || row?.assetclass_l2 || row?.asset_class || '').trim().toUpperCase();
    return label === 'US_STOCK' || label === 'US STOCK';
  }) || null;
}

function getAllocationLabel(row = {}) {
  return String(
    row.asset_type ||
      row.assetclass_l2 ||
      row.asset_class ||
      row.label ||
      row.name ||
      row.asset ||
      row.category ||
      row.type ||
      '',
  ).trim();
}

function isUsAllocationRow(row = {}) {
  const label = getAllocationLabel(row).toUpperCase();
  const assetType = String(row.asset_type || '').toUpperCase();
  const assetClass = String(row.assetclass_l2 || row.asset_class || '').toUpperCase();
  const currency = String(row.currency || row.base_currency || '').toUpperCase();
  return (
    label.startsWith('US_')
    || label.startsWith('US STOCK')
    || assetType.startsWith('US_')
    || assetType === 'US STOCK'
    || assetClass === 'US STOCK'
    || assetClass.startsWith('US ')
    || assetClass.startsWith('US_')
    || currency === 'USD'
  );
}

function isStaleIndianAllocationRow(row = {}) {
  if (isUsAllocationRow(row)) {
    return false;
  }
  const label = getAllocationLabel(row).toUpperCase();
  return STALE_INDIAN_ASSET_TYPES.has(label) || STALE_INDIAN_ASSET_CLASSES.has(label);
}

function isIndianEquityAssetRow(row = {}) {
  return String(row.assetclass_l2 || row.label || '').trim().toUpperCase() === 'INDIAN EQUITY';
}

function normalizeStaleType(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function hasIndianStockCategory(staleTypeSet = new Set()) {
  const normalizedTypes = new Set(Array.from(staleTypeSet).map(normalizeStaleType));
  return (
    normalizedTypes.has('MF') ||
    normalizedTypes.has('STOCK') ||
    normalizedTypes.has('INDIANSTOCK') ||
    normalizedTypes.has('INSTOCK')
  );
}

function zeroStaleIndianRow(row = {}) {
  return {
    ...row,
    invested_value: 0,
    invested_amount: 0,
    invested: 0,
    total_invested: 0,
    current_value: 0,
    currentValue: 0,
    market_value: 0,
    total_current_value: 0,
    value: 0,
    amount: 0,
    return: 0,
    return_percentage: 0,
    total_return: 0,
    total_pnl: 0,
    total_pnl_percentage: 0,
    percent: 0,
    percentage: 0,
    allocation: 0,
    weight: 0,
    weight_pct: 0,
    allocation_percentage: 0,
    progress_value_percentage: 0,
    excludedFromDashboard: true,
    excludedReason: 'Indian MF and stock data is stale at INDmoney and is hidden from allocation detail.',
  };
}

export function adjustIndMoneySnapshotForStaleIndianData(snapshot = {}) {
  const investments = Array.isArray(snapshot.investments) ? snapshot.investments : [];
  const staleTypes = new Set();
  let staleRows = 0;
  let staleInvested = 0;
  let staleCurrent = 0;
  let staleAssetRows = 0;
  let staleAssetInvested = 0;
  let staleAssetCurrent = 0;
  const adjustedInvestments = investments.map((row) => {
    if (!isStaleIndianAllocationRow(row)) {
      return row;
    }
    staleRows += 1;
    staleTypes.add(String(getAllocationLabel(row)).toUpperCase());
    staleInvested += firstNumber(row.invested_value, row.invested, row.invested_amount, row.total_invested) || 0;
    staleCurrent += firstNumber(row.current_value, row.currentValue, row.market_value, row.value, row.total_current_value) || 0;
    return zeroStaleIndianRow(row);
  });

  const adjustedAssets = (Array.isArray(snapshot.assets) ? snapshot.assets : []).map((row) => {
    if (!isStaleIndianAllocationRow(row)) {
      return row;
    }
    staleAssetRows += 1;
    if (!hasIndianStockCategory(staleTypes) || !isIndianEquityAssetRow(row)) {
      staleAssetInvested += firstNumber(row.invested_value, row.invested, row.invested_amount, row.total_invested) || 0;
      staleAssetCurrent += firstNumber(row.current_value, row.currentValue, row.market_value, row.value, row.total_current_value) || 0;
    }
    return zeroStaleIndianRow(row);
  });

  const totalInvested = firstNumber(snapshot.total_invested, snapshot.totalInvested, snapshot.invested_amount);
  const totalCurrentValue = firstNumber(snapshot.total_current_value, snapshot.totalCurrentValue, snapshot.current_value);
  const staleRowsCount = staleRows + staleAssetRows;
  const staleInvestedTotal = staleInvested + staleAssetInvested;
  const staleCurrentTotal = staleCurrent + staleAssetCurrent;
  const liabilities = toNumber(snapshot.liabilities || snapshot.total_liabilities || snapshot.liability);
  const adjustedInvested =
    staleRowsCount && totalInvested !== null
      ? round(Math.max(0, toNumber(totalInvested) - staleInvestedTotal), 2)
      : totalInvested;
  const adjustedCurrentValue =
    staleRowsCount && totalCurrentValue !== null
      ? round(Math.max(0, toNumber(totalCurrentValue) - staleCurrentTotal), 2)
      : totalCurrentValue;
  const adjustedNetWorth = staleRowsCount && adjustedCurrentValue !== null
    ? (liabilities !== null ? round(adjustedCurrentValue + liabilities, 2) : adjustedCurrentValue)
    : firstNumber(snapshot.total_networth, snapshot.totalNetworth, snapshot.networth, snapshot.total);
  const totalReturn =
    firstNumber(snapshot.total_return, snapshot.total_pnl, snapshot.pnl) ??
    (adjustedCurrentValue !== null && adjustedInvested !== null ? round(adjustedCurrentValue - adjustedInvested, 2) : null);

  return {
    ...snapshot,
    total_invested: adjustedInvested,
    total_current_value: adjustedCurrentValue,
    total_networth: adjustedNetWorth,
    total_return: totalReturn,
    total_return_pct:
      firstNumber(snapshot.total_return_pct, snapshot.total_pnl_percentage, snapshot.return_percentage) ??
      (totalReturn !== null && adjustedInvested ? round((totalReturn / adjustedInvested) * 100, 2) : null),
    investments: adjustedInvestments,
    assets: adjustedAssets,
    sector: [],
    market_cap: [],
    dataAdjustments: [
      ...(Array.isArray(snapshot.dataAdjustments) ? snapshot.dataAdjustments : []),
      {
        rule: 'zero_stale_indian_mf_and_stocks',
        excludedAssetTypes: ['MF', 'STOCK'],
        excludedAssetClasses: ['Indian Equity'],
        sectorAndMarketCapSuppressed: true,
        topLineTotalsPreserved: false,
        affectedRows: staleRows + staleAssetRows,
        breakdownExcludedInvestedValue: round(staleInvestedTotal, 2),
        breakdownExcludedCurrentValue: round(staleCurrentTotal, 2),
        reason: 'Indian MF and stock data is stale at INDmoney. It is discounted from top-line totals and hidden from allocation detail. US stock data remains included.',
      },
    ],
  };
}

export function normalizeIndMoneyDashboardSummary(snapshot = {}) {
  const totalNetworth = firstNumber(snapshot.total_networth, snapshot.totalNetworth, snapshot.networth, snapshot.total);
  const totalInvested = firstNumber(snapshot.total_invested, snapshot.totalInvested, snapshot.invested_amount);
  const totalCurrentValue = firstNumber(snapshot.total_current_value, snapshot.totalCurrentValue, snapshot.current_value, totalNetworth);
  const liabilities = firstNumber(snapshot.liabilities, snapshot.total_liabilities, snapshot.liability);
  const totalReturn =
    firstNumber(snapshot.total_return, snapshot.total_pnl, snapshot.pnl) ??
    (totalCurrentValue !== null && totalInvested !== null ? round(totalCurrentValue - totalInvested, 2) : null);
  const totalReturnPct =
    firstNumber(snapshot.total_return_pct, snapshot.total_pnl_percentage, snapshot.return_percentage) ??
    (totalReturn !== null && totalInvested ? round((totalReturn / totalInvested) * 100, 2) : null);

  return {
    totalNetworth,
    totalInvested,
    totalCurrentValue,
    totalReturn,
    totalReturnPct,
    liabilities,
    source: snapshot.source || INDMONEY_DASHBOARD_SOURCE,
    updatedAt: snapshot.updatedAt || snapshot.updated_at || nowIso(),
  };
}

export function normalizeIndMoneyHoldings(rows = []) {
  const valuePerUnit = (value, units, digits = 4) =>
    units !== null && units !== 0 && value !== null ? round(value / units, digits) : null;
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const units = firstNumber(row?.units, row?.quantity, row?.total_units, row?.shares);
      const invested = firstNumber(row?.invested, row?.invested_amount, row?.cost_value, row?.total_invested);
      const regularValue = firstNumber(
        row?.regularValue,
        row?.regular_value,
        row?.currentValue,
        row?.current_value,
        row?.market_value,
        row?.value,
        row?.total_current_value,
      );
      const regularPnl =
        firstNumber(row?.regularPnl, row?.regular_pnl, row?.pnl, row?.total_pnl, row?.totalReturn, row?.gain_loss) ??
        (regularValue !== null && invested !== null ? round(regularValue - invested, 2) : null);
      const regularPnlPct =
        firstNumber(row?.regularPnlPct, row?.regular_pnl_pct, row?.pnlPct, row?.total_pnl_percentage, row?.totalReturnPct, row?.gain_loss_percentage) ??
        (regularPnl !== null && invested ? round((regularPnl / invested) * 100, 2) : null);
      const explicitAvgPrice = firstNumber(
        row?.avgPrice,
        row?.avg_price,
        row?.avg_cost,
        row?.average_price,
        row?.avgCost,
        row?.averageCost,
      );
      const rowCurrency = normalizeCurrencyCode(row?.sourceCurrency)
        || normalizeCurrencyCode(row?.normalizedCurrency)
        || normalizeCurrencyCode(row?.currency)
        || normalizeCurrencyCode(row?.base_currency)
        || 'INR';
      const basis = String(row?.moveBasis || row?.move_basis || '').toLowerCase();
      const unitPrice = firstNumber(row?.unitPrice, row?.unit_price);
      const explicitRegularPrice = firstNumber(
        row?.regularPrice,
        row?.regular_price,
        row?.lastPrice,
        row?.last_price,
        row?.livePrice,
        row?.live_price,
        row?.current_price,
        row?.price,
      );
      const derivedRegularPrice = valuePerUnit(regularValue, units);
      const regularPrice = explicitRegularPrice ?? unitPrice ?? derivedRegularPrice;
      const priceCurrency =
        normalizeCurrencyCode(row?.priceCurrency)
        || normalizeCurrencyCode(row?.price_currency)
        || normalizeCurrencyCode(row?.lastPriceCurrency)
        || normalizeCurrencyCode(row?.last_price_currency)
        || normalizeCurrencyCode(row?.unitPriceCurrency)
        || normalizeCurrencyCode(row?.unit_price_currency)
        || rowCurrency;
      const computedAvgPrice = valuePerUnit(invested, units);
      const avgPrice = explicitAvgPrice ?? computedAvgPrice ?? unitPrice;
      const explicitAvgPriceCurrency =
        normalizeCurrencyCode(row?.avgPriceCurrency)
        || normalizeCurrencyCode(row?.avg_price_currency)
        || normalizeCurrencyCode(row?.averagePriceCurrency)
        || normalizeCurrencyCode(row?.average_price_currency);
      const avgPriceCurrency = explicitAvgPriceCurrency || rowCurrency;
      const extendedPrice = firstNumber(row?.extendedPrice, row?.extended_price);
      const displayPrice = basis && basis !== 'regular' && extendedPrice !== null ? extendedPrice : regularPrice;
      const displayValue = regularValue ?? (units !== null && displayPrice !== null ? round(units * displayPrice, 2) : null);
      const displayPnl = displayValue !== null && invested !== null ? round(displayValue - invested, 2) : null;
      const displayPnlPct = displayPnl !== null && invested ? round((displayPnl / invested) * 100, 2) : null;
      const extendedValue =
        firstNumber(row?.extendedValue, row?.extended_value) ??
        (units !== null && extendedPrice !== null
          ? round(units * extendedPrice, 2)
          : null);
      const extendedPnl =
        firstNumber(row?.extendedReturn, row?.extended_return) ??
        (extendedValue !== null && invested !== null ? round(extendedValue - invested, 2) : null);
      const extendedPnlPct =
        firstNumber(row?.extendedReturnPct, row?.extended_return_pct) ??
        (extendedPnl !== null && invested ? round((extendedPnl / invested) * 100, 2) : null);
      const previousClose = firstNumber(
        row?.previousClose,
        row?.previous_close,
        row?.prevClose,
        row?.prev_close,
        row?.close_previous_day,
      );
      const shouldRecomputeOneDayFromUsdQuote =
        rowCurrency === 'INR' &&
        priceCurrency === 'USD' &&
        units !== null &&
        regularPrice !== null &&
        previousClose !== null;
      const computedOneDayReturn =
        units !== null && regularPrice !== null && previousClose !== null
          ? round(units * (regularPrice - previousClose), 2)
          : null;
      const oneDayReturn =
        shouldRecomputeOneDayFromUsdQuote
          ? computedOneDayReturn
          : firstNumber(row?.oneDayReturn, row?.one_day_return, row?.oneDayPnl, row?.dayPnl, row?.day_pnl) ?? computedOneDayReturn;
      const oneDayBasis =
        units !== null && previousClose !== null
          ? round(units * previousClose, 2)
          : null;
      const computedOneDayReturnPct =
        oneDayReturn !== null && oneDayBasis ? round((oneDayReturn / oneDayBasis) * 100, 2) : null;
      const oneDayReturnPct =
        shouldRecomputeOneDayFromUsdQuote
          ? computedOneDayReturnPct
          : firstNumber(row?.oneDayReturnPct, row?.one_day_return_pct, row?.dayPnlPct, row?.day_pnl_pct, row?.movePct, row?.pct_change) ?? computedOneDayReturnPct;
      const validUsTicker = resolveUsTicker(row);
      const source = row?.source || row?.dataSource || INDMONEY_DASHBOARD_SOURCE;
      const resolvedLastPrice = displayPrice ?? regularPrice;
      return {
        ...row,
        name: row?.name || row?.investment || row?.company_name || row?.fund_name || row?.symbol || row?.ticker || 'Holding',
        ticker: validUsTicker || null,
        broker: row?.broker || row?.broker_name || row?.source || null,
        units,
        invested,
        avgPrice,
        currentValue: displayValue,
        pnl: regularValue !== null ? regularPnl : displayPnl,
        pnlPct: regularValue !== null ? regularPnlPct : displayPnlPct,
        priceDerivedValue: displayValue,
        priceDerivedPnl: displayPnl,
        priceDerivedPnlPct: displayPnlPct,
        regularValue,
        regularPnl,
        regularPnlPct,
        lastPrice: resolvedLastPrice,
        lastPriceCurrency: priceCurrency,
        regularPrice,
        regularPriceCurrency: priceCurrency,
        avgPriceCurrency,
        extendedValue,
        extendedReturn: extendedPnl,
        extendedReturnPct: extendedPnlPct,
        previousClose,
        oneDayReturn,
        oneDayReturnPct,
        weightPct: firstNumber(row?.weightPct, row?.weight_pct, row?.allocation, row?.portfolio_percentage),
        sector: row?.sector || row?.sector_name || row?.category || null,
        marketCap: firstNumber(row?.marketCap, row?.market_cap, row?.marketCapitalization, row?.market_capitalization),
        currency: rowCurrency,
        source,
        sourceIsMarketPortfolioEngine: isLikelyMarketPortfolioEngineSource(source),
      };
    })
    .filter((row) => row.currentValue !== null || row.invested !== null || row.units !== null);
  const deduped = dedupeIndMoneyHoldings(normalized);
  return deduped.map((row) => ({
    ...row,
    source: INDMONEY_DASHBOARD_SOURCE,
  }));
}

export function normalizeIndMoneyHistoryPoint(snapshot = {}, options = {}) {
  const timestamp = options.timestamp || snapshot.updatedAt || snapshot.updated_at || nowIso();
  const summary = normalizeIndMoneyDashboardSummary({ ...snapshot, updatedAt: timestamp });
  if (summary.totalNetworth === null && summary.totalCurrentValue === null) {
    return null;
  }
  return {
    timestamp,
    date: getIndMoneyHistoryDateKey(timestamp, options.timezone),
    totalNetworth: summary.totalNetworth,
    totalInvested: summary.totalInvested,
    totalCurrentValue: summary.totalCurrentValue,
    totalReturn: summary.totalReturn,
    totalReturnPct: summary.totalReturnPct,
    liabilities: summary.liabilities,
    investments: normalizeAllocationRows(snapshot.investments),
    assets: normalizeAllocationRows(snapshot.assets),
    sector: normalizeAllocationRows(snapshot.sector),
    marketCap: normalizeAllocationRows(snapshot.market_cap || snapshot.marketCap),
    source: INDMONEY_DASHBOARD_SOURCE,
  };
}

export function appendIndMoneyHistoryPoint(history = [], point, options = {}) {
  const rows = Array.isArray(history) ? history.slice() : [];
  if (!point) {
    return { history: rows, appended: false, reason: 'missing_point' };
  }
  const date = point.date || getIndMoneyHistoryDateKey(point.timestamp, options.timezone);
  const existingIndex = options.allowMultiplePerDay
    ? -1
    : rows.findIndex((row) => (row.date || getIndMoneyHistoryDateKey(row.timestamp, options.timezone)) === date);
  const normalizedPoint = { ...point, date };
  if (existingIndex >= 0 && !options.force) {
    return { history: rows, appended: false, reason: 'already_captured_today' };
  }
  if (existingIndex >= 0) {
    rows[existingIndex] = normalizedPoint;
  } else {
    rows.push(normalizedPoint);
  }
  rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return { history: rows, appended: true, reason: options.allowMultiplePerDay ? 'intraday_appended' : existingIndex >= 0 ? 'replaced' : 'appended' };
}

export function buildIndMoneyGrowthSeries(history = []) {
  const points = (Array.isArray(history) ? history : [])
    .map((row) => {
      const netWorth = firstNumber(row.totalNetworth, row.total_networth);
      const currentValue = firstNumber(row.totalCurrentValue, row.total_current_value, row.totalNetworth);
      return {
        timestamp: row.timestamp,
        date: row.date || getIndMoneyHistoryDateKey(row.timestamp),
        value: currentValue ?? netWorth,
        netWorth,
        invested: firstNumber(row.totalInvested, row.total_invested),
        currentValue,
        source: row.source || INDMONEY_DASHBOARD_SOURCE,
      };
    })
    .filter((row) => row.timestamp && row.value !== null)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const first = points[0] || null;
  const last = points[points.length - 1] || null;
  const startValue = first?.value ?? null;
  const endValue = last?.value ?? null;
  const change = startValue !== null && endValue !== null ? round(endValue - startValue, 2) : null;
  const changePct = change !== null && startValue ? round((change / startValue) * 100, 2) : null;

  return {
    historyStatus: points.length > 1 ? 'tracking' : 'tracking_from_now',
    trackedSince: first?.date || null,
    points,
    pointCount: points.length,
    change,
    changePct,
  };
}

export function buildIndMoneyUsStockPnlSeries(history = [], options = {}) {
  const baselineDate = options.baselineDate || US_STOCK_PNL_BASELINE_DATE;
  const historyPoints = (Array.isArray(history) ? history : [])
    .map((row) => {
      const usStock = findUsStockAllocation(row.investments);
      if (!usStock) return null;
      const invested = firstNumber(usStock.invested_value, usStock.invested, usStock.invested_amount, usStock.total_invested);
      const currentValue = firstNumber(usStock.current_value, usStock.currentValue, usStock.market_value, usStock.value, usStock.total_current_value);
      if (invested === null || currentValue === null) return null;
      const pnl = round(currentValue - invested, 2);
      return {
        timestamp: row.timestamp,
        date: row.date || getIndMoneyHistoryDateKey(row.timestamp),
        invested,
        currentValue,
        pnl,
        pnlPct: invested ? round((pnl / invested) * 100, 2) : null,
        source: 'US_STOCK',
      };
    })
    .filter((row) => row?.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const baselineInvested = historyPoints[0]?.invested ?? null;
  const points = baselineInvested === null
    ? []
    : [
        {
          timestamp: `${baselineDate} 00:00:00 IST`,
          date: baselineDate,
          invested: baselineInvested,
          currentValue: baselineInvested,
          pnl: 0,
          pnlPct: 0,
          source: 'synthetic_us_stock_baseline',
        },
        ...historyPoints,
      ];
  const first = points[0] || null;
  const last = points[points.length - 1] || null;

  return {
    historyStatus: points.length > 1 ? 'tracking' : 'tracking_from_now',
    trackedSince: first?.date || null,
    points,
    pointCount: points.length,
    summary: last
      ? {
          invested: last.invested,
          currentValue: last.currentValue,
          pnl: last.pnl,
          pnlPct: last.pnlPct,
        }
      : {
          invested: null,
          currentValue: null,
          pnl: null,
          pnlPct: null,
        },
    change: first && last ? round(last.pnl - first.pnl, 2) : null,
    changePct: first && last && first.invested ? round(((last.pnl - first.pnl) / first.invested) * 100, 2) : null,
  };
}

export function buildUsStockCategoryPnl(rows = []) {
  const categories = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const invested = firstNumber(row.invested, row.invested_amount, row.cost_value);
    const currentValue = firstNumber(row.currentValue, row.current_value, row.market_value, row.value);
    if (invested === null && currentValue === null) continue;
    const label = String(row.sector || row.category || 'Unclassified').trim() || 'Unclassified';
    const existing = categories.get(label) || {
      label,
      invested: 0,
      currentValue: 0,
      pnl: 0,
      pnlPct: null,
      count: 0,
      currency: row.currency || 'USD',
    };
    existing.invested += invested || 0;
    existing.currentValue += currentValue || 0;
    existing.count += 1;
    categories.set(label, existing);
  }

  return Array.from(categories.values())
    .map((row) => {
      const pnl = round(row.currentValue - row.invested, 2);
      return {
        ...row,
        invested: round(row.invested, 2),
        currentValue: round(row.currentValue, 2),
        pnl,
        pnlPct: row.invested ? round((pnl / row.invested) * 100, 2) : null,
      };
    })
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || a.label.localeCompare(b.label));
}

export function buildAssetClassPnl(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const label = String(row.label || row.asset_type || row.assetclass_l2 || 'Unclassified').trim() || 'Unclassified';
      const invested = firstNumber(row.invested, row.invested_value, row.invested_amount, row.total_invested);
      const currentValue = firstNumber(row.value, row.current_value, row.currentValue, row.market_value, row.total_current_value);
      if (invested === null && currentValue === null) return null;
      const investedValue = invested || 0;
      const current = currentValue || 0;
      const pnl = round(current - investedValue, 2);
      return {
        label,
        invested: round(investedValue, 2),
        currentValue: round(current, 2),
        pnl,
        pnlPct: investedValue ? round((pnl / investedValue) * 100, 2) : null,
        currency: 'INR',
      };
    })
    .filter(Boolean);
}

export function buildUsOnlyAssetClassPnl(options = {}) {
  const summary = options.summary || {};
  const holdings = Array.isArray(options.holdings) ? options.holdings : [];
  const investments = Array.isArray(options.investments) ? options.investments : [];
  const summaryInvested = toNumber(summary.totalInvested);
  const summaryCurrentValue = toNumber(summary.totalCurrentValue);
  const summaryInvestedUsd = toNumber(summary.totalInvestedUsd);
  const summaryCurrentValueUsd = toNumber(summary.totalCurrentValueUsd);
  if (summaryInvested !== null || summaryCurrentValue !== null) {
    const invested = round(summaryInvested || 0, 2);
    const currentValue = round(summaryCurrentValue || 0, 2);
    const pnl = round(currentValue - invested, 2);
    return [{
      label: 'US_STOCK',
      invested,
      investedUsd: summaryInvestedUsd,
      currentValue,
      currentValueUsd: summaryCurrentValueUsd,
      pnl,
      pnlUsd:
        summaryCurrentValueUsd !== null && summaryInvestedUsd !== null
          ? round(summaryCurrentValueUsd - summaryInvestedUsd, 2)
          : null,
      pnlPct: invested ? round((pnl / invested) * 100, 2) : null,
      currency: 'INR',
    }];
  }
  const usInvestment = investments.find((row) => isUsAssetClassLabel(row?.label || row?.asset_type || row?.assetclass_l2 || row?.asset_class));
  if (usInvestment) {
    return buildAssetClassPnl([usInvestment]);
  }
  const invested = round(
    holdings.reduce((sum, row) => sum + (firstNumber(row.invested, row.invested_amount, row.cost_value) || 0), 0),
    2,
  );
  const currentValue = round(
    holdings.reduce((sum, row) => sum + (firstNumber(row.currentValue, row.current_value, row.market_value, row.value) || 0), 0),
    2,
  );
  const pnl = round(currentValue - invested, 2);
  return [{
    label: 'US_STOCK',
    invested,
    currentValue,
    pnl,
    pnlPct: invested ? round((pnl / invested) * 100, 2) : null,
    currency: 'USD',
  }];
}

export function buildUsSessionPnlSummary(holdings = [], assetClassPnl = []) {
  const usAsset = (Array.isArray(assetClassPnl) ? assetClassPnl : []).find((row) => isUsAssetClassLabel(
    row?.label || row?.asset_type || row?.assetclass_l2 || row?.asset_class,
  )) || {};
  const resolveHoldingFxRate = ({
    row,
    quantity,
    regularPriceUsd,
    extendedPriceUsd,
    regularValueNative,
    investedNative,
  }) => {
    const explicitFx = firstNumber(row?.usdInrRate, row?.usd_inr_rate, row?.fxRate, row?.fx_rate);
    if (explicitFx !== null && explicitFx >= 40 && explicitFx <= 250) {
      return explicitFx;
    }
    const primaryCandidates = [];
    if (quantity !== null && quantity > 0 && regularPriceUsd !== null && regularValueNative !== null) {
      primaryCandidates.push(regularValueNative / (quantity * regularPriceUsd));
    }
    const plausiblePrimary = primaryCandidates.filter((rate) => rate >= 40 && rate <= 250);
    if (plausiblePrimary.length) {
      return round(plausiblePrimary.reduce((sum, value) => sum + value, 0) / plausiblePrimary.length, 4);
    }
    const fallbackCandidates = [];
    if (quantity !== null && quantity > 0 && regularPriceUsd !== null && investedNative !== null) {
      fallbackCandidates.push(investedNative / (quantity * regularPriceUsd));
    }
    if (quantity !== null && quantity > 0 && extendedPriceUsd !== null && regularValueNative !== null) {
      fallbackCandidates.push(regularValueNative / (quantity * extendedPriceUsd));
    }
    const plausible = fallbackCandidates.filter((rate) => rate >= 40 && rate <= 250);
    if (!plausible.length) {
      return null;
    }
    return round(plausible.reduce((sum, value) => sum + value, 0) / plausible.length, 4);
  };
  const rows = (Array.isArray(holdings) ? holdings : [])
    .map((row) => {
      const ticker = normalizeUsTicker(row.ticker || row.symbol || row.tradingsymbol || '');
      const quantity = firstNumber(row.units, row.quantity);
      const investedNative = firstNumber(row.invested, row.invested_amount, row.cost_value);
      const regularValueNative = firstNumber(
        row.regularValue,
        row.regular_value,
        row.currentValue,
        row.current_value,
        row.market_value,
        row.value,
      );
      const regularPrice = firstNumber(
        row.regularPrice,
        row.regular_price,
        row.lastPrice,
        row.last_price,
        row.livePrice,
        row.live_price,
        row.price,
        regularValueNative !== null && quantity !== null && quantity !== 0 ? round(regularValueNative / quantity, 4) : null,
      );
      const extendedPrice = firstNumber(
        row.extendedPrice,
        row.extended_price,
        row.priceExtended,
        row.extended_price_inr,
        regularPrice,
      );
      const extendedValueUsdExplicit = firstNumber(row.extendedValue, row.extended_value, row.extended_value_usd);
      const previousClose = firstNumber(row.previousClose, row.previous_close);
      const oneDayPnlUsd =
        firstNumber(row.oneDayReturn, row.one_day_return, row.oneDayPnl, row.dayPnl, row.day_pnl) ??
        (quantity !== null && regularPrice !== null && previousClose !== null
          ? round(quantity * (regularPrice - previousClose), 2)
          : null);
      const oneDayBasisUsd =
        quantity !== null && previousClose !== null
          ? round(quantity * previousClose, 2)
          : null;
      const oneDayPnlPct =
        firstNumber(row.oneDayReturnPct, row.one_day_return_pct, row.oneDayPnlPct, row.dayPnlPct, row.day_pnl_pct) ??
        (oneDayPnlUsd !== null && oneDayBasisUsd ? round((oneDayPnlUsd / oneDayBasisUsd) * 100, 2) : null);
      if (!ticker || quantity === null || investedNative === null || regularValueNative === null) return null;
      const rowCurrency = normalizeCurrencyCode(
        row.currency || row.sourceCurrency || row.source_currency || row.base_currency,
      ) || 'USD';
      const priceCurrency = normalizeCurrencyCode(
        row.regularPriceCurrency || row.regular_price_currency || row.lastPriceCurrency || row.last_price_currency,
      ) || (regularPrice !== null ? 'USD' : rowCurrency);
      const holdingFxRate = rowCurrency === 'INR' && priceCurrency === 'USD'
        ? resolveHoldingFxRate({
            row,
            quantity,
            regularPriceUsd: regularPrice,
            extendedPriceUsd: extendedPrice,
            regularValueNative,
            investedNative,
          })
        : null;
      const investedUsd = rowCurrency === 'INR'
        ? (holdingFxRate ? round(investedNative / holdingFxRate, 2) : null)
        : investedNative;
      const explicitRegularValueUsd = rowCurrency === 'INR'
        ? (holdingFxRate ? round(regularValueNative / holdingFxRate, 2) : null)
        : regularValueNative;
      if (investedUsd === null) return null;
      const derivedRegularValueUsd = explicitRegularValueUsd ?? (
        regularPrice !== null ? round(quantity * regularPrice, 2) : null
      );
      if (derivedRegularValueUsd === null) return null;
      const derivedExtendedValueUsd = extendedPrice !== null ? round(quantity * extendedPrice, 2) : null;
      const explicitExtendedLooksUsd =
        extendedValueUsdExplicit !== null &&
        derivedExtendedValueUsd !== null &&
        Math.abs(extendedValueUsdExplicit - derivedExtendedValueUsd) <= Math.max(1, Math.abs(derivedExtendedValueUsd) * 0.05);
      const extendedValueUsd = extendedValueUsdExplicit !== null
        ? (
            rowCurrency === 'INR' && holdingFxRate && !explicitExtendedLooksUsd
              ? round(extendedValueUsdExplicit / holdingFxRate, 2)
              : extendedValueUsdExplicit
          )
        : derivedExtendedValueUsd ?? derivedRegularValueUsd;
      const regularPnlUsd = round(derivedRegularValueUsd - investedUsd, 2);
      const extendedPnlUsd = round(extendedValueUsd - investedUsd, 2);
      return {
        ticker,
        name: row.name || ticker,
        quantity,
        investedUsd,
        holdingFxRate,
        regularPrice,
        extendedPrice,
        regularValueUsd: derivedRegularValueUsd,
        extendedValueUsd,
        regularPnlUsd,
        extendedPnlUsd,
        extendedImpactUsd: round(extendedValueUsd - derivedRegularValueUsd, 2),
        oneDayPnlUsd,
        oneDayPnlPct,
        oneDayBasisUsd,
        regularMovePct: firstNumber(row.regularMovePct, row.regular_move_pct),
        extendedMovePct: firstNumber(row.extendedMovePct, row.extended_move_pct),
        moveBasis: row.moveBasis || row.move_basis || 'regular',
      };
    })
    .filter(Boolean);
  if (!rows.length && (toNumber(usAsset.invested) !== null || toNumber(usAsset.currentValue) !== null)) {
    const officialInvested = toNumber(usAsset.invested);
    const officialCurrentValue = toNumber(usAsset.currentValue);
    const officialPnlInrRaw = toNumber(usAsset.pnl);
    const officialPnlPctRaw = toNumber(usAsset.pnlPct);
    const officialPnlInr =
      officialPnlInrRaw ??
      (officialCurrentValue !== null && officialInvested !== null ? round(officialCurrentValue - officialInvested, 2) : null);
    const officialPnlPct =
      officialPnlPctRaw ??
      (officialPnlInr !== null && officialInvested ? round((officialPnlInr / officialInvested) * 100, 2) : null);
    return {
      basis: 'regular',
      holdingsCount: 0,
      fxRate: null,
      investedUsd: null,
      regularValueUsd: null,
      extendedValueUsd: null,
      regularPnlUsd: null,
      regularPnlPct: officialPnlPct,
      extendedPnlUsd: null,
      extendedPnlPct: officialPnlPct,
      extendedImpactUsd: null,
      extendedImpactPct: null,
      investedInr: officialInvested,
      regularValueInr: officialCurrentValue,
      extendedValueInr: officialCurrentValue,
      regularPnlInr: officialPnlInr,
      extendedPnlInr: officialPnlInr,
      extendedImpactInr: null,
      officialCurrentValueInr: officialCurrentValue,
      officialInvestedInr: officialInvested,
      officialPnlInr,
      officialPnlPct,
      oneDayPnlUsd: null,
      oneDayPnlPct: null,
      oneDayPnlInr: null,
      oneDayHoldingsCount: 0,
      topExtendedImpacts: [],
      overall: {
        basis: 'regular',
        valueInr: officialCurrentValue,
        valueUsd: null,
        pnlInr: officialPnlInr,
        pnlUsd: null,
        pnlPct: officialPnlPct,
      },
      oneDay: {
        basis: 'regular',
        currentValueInr: officialCurrentValue,
        currentValueUsd: null,
        previousCloseValueInr: officialCurrentValue,
        previousCloseValueUsd: null,
        pnlInr: 0,
        pnlUsd: null,
        pnlPct: 0,
      },
      actual: {
        basis: 'regular',
        valueInr: officialCurrentValue,
        valueUsd: null,
        pnlInr: officialPnlInr,
        pnlUsd: null,
        pnlPct: officialPnlPct,
      },
      reference: {
        officialCloseValueInr: officialCurrentValue,
        officialCloseValueUsd: null,
        investedInr: officialInvested,
        investedUsd: null,
        fxRate: null,
      },
    };
  }
  if (!rows.length) return null;

  const investedUsd = round(rows.reduce((sum, row) => sum + row.investedUsd, 0), 2);
  const regularValueUsd = round(rows.reduce((sum, row) => sum + row.regularValueUsd, 0), 2);
  const extendedValueUsd = round(rows.reduce((sum, row) => sum + row.extendedValueUsd, 0), 2);
  const regularPnlUsd = round(regularValueUsd - investedUsd, 2);
  const extendedPnlUsd = round(extendedValueUsd - investedUsd, 2);
  const extendedImpactUsd = round(extendedValueUsd - regularValueUsd, 2);
  const oneDayRows = rows.filter((row) => row.oneDayPnlUsd !== null);
  const oneDayPnlUsd = oneDayRows.length
    ? round(oneDayRows.reduce((sum, row) => sum + (row.oneDayPnlUsd || 0), 0), 2)
    : null;
  const oneDayBasisUsd = oneDayRows.length
    ? round(oneDayRows.reduce((sum, row) => sum + (row.oneDayBasisUsd || 0), 0), 2)
    : null;
  const basisCounts = rows.reduce((acc, row) => {
    const key = row.moveBasis || 'regular';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const dominantBasis = Object.entries(basisCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'regular';
  const marketBasis = String(dominantBasis || 'regular').toLowerCase();
  const isExtendedBasis = ['extended', 'pre-market', 'post-market', 'after-hours'].includes(marketBasis);
  const fxRate =
    resolveIndMoneyUsFxRate({
      usdInvested: investedUsd,
      usdCurrent: regularValueUsd,
      officialInvested: toNumber(usAsset.invested),
      officialCurrent: toNumber(usAsset.currentValue),
    }) || null;
  const toInr = (value) => (fxRate && value !== null && value !== undefined ? round(value * fxRate, 2) : null);
  const officialCurrentValueInr = toNumber(usAsset.currentValue);
  const officialInvestedInr = toNumber(usAsset.invested);
  const officialPnlInrRaw = toNumber(usAsset.pnl);
  const officialPnlPctRaw = toNumber(usAsset.pnlPct);
  const officialPnlInr =
    officialPnlInrRaw ?? (officialCurrentValueInr !== null && officialInvestedInr !== null
      ? round(officialCurrentValueInr - officialInvestedInr, 2)
      : null);
  const officialPnlPct =
    officialPnlPctRaw ??
    (officialPnlInr !== null && officialInvestedInr
      ? round((officialPnlInr / officialInvestedInr) * 100, 2)
      : null);
  const investedInr = officialInvestedInr ?? toInr(investedUsd);
  const regularValueInr = toInr(regularValueUsd);
  const extendedValueInr = toInr(extendedValueUsd);
  const regularPnlInr = regularValueInr !== null && investedInr !== null ? round(regularValueInr - investedInr, 2) : toInr(regularPnlUsd);
  const extendedPnlInr = extendedValueInr !== null && investedInr !== null ? round(extendedValueInr - investedInr, 2) : toInr(extendedPnlUsd);
  const oneDayPnlInr = toInr(oneDayPnlUsd);
  const officialCurrentValueUsd =
    officialCurrentValueInr !== null && fxRate ? round(officialCurrentValueInr / fxRate, 2) : null;
  const overallBasis = isExtendedBasis ? marketBasis : 'regular';
  const regularPnlPct = investedUsd ? round((regularPnlUsd / investedUsd) * 100, 2) : null;
  const extendedPnlPct = investedUsd ? round((extendedPnlUsd / investedUsd) * 100, 2) : null;
  const overall = {
    basis: overallBasis,
    valueInr: overallBasis === 'regular' ? regularValueInr : extendedValueInr,
    valueUsd: overallBasis === 'regular' ? regularValueUsd : extendedValueUsd,
    pnlInr: overallBasis === 'regular' ? regularPnlInr : extendedPnlInr,
    pnlUsd: overallBasis === 'regular' ? regularPnlUsd : extendedPnlUsd,
    pnlPct: overallBasis === 'regular' ? regularPnlPct : extendedPnlPct,
  };
  const actual = {
    basis: 'regular',
    valueInr: regularValueInr,
    valueUsd: regularValueUsd,
    pnlInr: regularPnlInr,
    pnlUsd: regularPnlUsd,
    pnlPct: regularPnlPct,
  };
  const oneDay = {
    basis: overall.basis,
    currentValueInr: overall.valueInr,
    currentValueUsd: overall.valueUsd,
    previousCloseValueInr: officialCurrentValueInr,
    previousCloseValueUsd: officialCurrentValueUsd,
    pnlInr:
      overall.valueInr !== null && officialCurrentValueInr !== null
        ? round(overall.valueInr - officialCurrentValueInr, 2)
        : null,
    pnlUsd:
      overall.valueUsd !== null && officialCurrentValueUsd !== null
        ? round(overall.valueUsd - officialCurrentValueUsd, 2)
        : null,
    pnlPct: null,
  };
  oneDay.pnlPct =
    oneDay.pnlInr !== null && officialCurrentValueInr
      ? round((oneDay.pnlInr / officialCurrentValueInr) * 100, 2)
      : null;
  const reference = {
    officialCloseValueInr: officialCurrentValueInr,
    officialCloseValueUsd: officialCurrentValueUsd,
    investedInr,
    investedUsd,
    fxRate: fxRate ? round(fxRate, 4) : null,
  };

  return {
    basis: dominantBasis,
    holdingsCount: rows.length,
    fxRate: fxRate ? round(fxRate, 4) : null,
    // Legacy flat fields are kept for compatibility while renderers migrate to grouped metrics below.
    investedUsd,
    regularValueUsd,
    extendedValueUsd,
    regularPnlUsd,
    regularPnlPct,
    extendedPnlUsd,
    extendedPnlPct,
    extendedImpactUsd,
    extendedImpactPct: regularValueUsd ? round((extendedImpactUsd / regularValueUsd) * 100, 2) : null,
    investedInr,
    regularValueInr,
    extendedValueInr,
    regularPnlInr,
    extendedPnlInr,
    extendedImpactInr: toInr(extendedImpactUsd),
    officialCurrentValueInr,
    officialInvestedInr,
    officialPnlInr,
    officialPnlPct,
    oneDayPnlUsd,
    oneDayPnlPct: oneDayPnlUsd !== null && oneDayBasisUsd ? round((oneDayPnlUsd / oneDayBasisUsd) * 100, 2) : null,
    oneDayPnlInr,
    oneDayHoldingsCount: oneDayRows.length,
    topExtendedImpacts: rows
      .filter((row) => row.extendedImpactUsd !== 0)
      .sort((a, b) => Math.abs(b.extendedImpactUsd) - Math.abs(a.extendedImpactUsd))
      .slice(0, 5),
    overall,
    oneDay,
    actual,
    reference,
  };
}

export function applyLiveUsSessionPricing(payload) {
  if (!payload) return payload;
  const session = payload.usSessionPnl || {};
  const baselineOverall = session.overall || null;
  const reference = session.reference || null;
  const sessionFxRate = toNumber(session.fxRate);
  const payloadFxRate = toNumber(payload.fxRate);
  const marketSession = String(payload.sessionMeta?.usSession || '').toLowerCase();
  const resolveInrPoint = (inrValue, usdValue) => {
    const inr = toNumber(inrValue);
    if (inr !== null) {
      return inr;
    }
    const usd = toNumber(usdValue);
    const fxRate = toNumber(sessionFxRate) || payloadFxRate;
    return Number.isFinite(usd) && Number.isFinite(fxRate) && fxRate > 0 ? round(usd * fxRate, 2) : null;
  };
  const resolveUsdPoint = (usdValue, inrValue) => {
    const usd = toNumber(usdValue);
    if (usd !== null) {
      return usd;
    }
    const inr = toNumber(inrValue);
    const fxRate = toNumber(sessionFxRate) || payloadFxRate;
    return Number.isFinite(inr) && Number.isFinite(fxRate) && fxRate > 0 ? round(inr / fxRate, 2) : null;
  };
  const reconcileUsdPoint = (usdValue, inrValue) => {
    const directUsd = toNumber(usdValue);
    const derivedUsd = resolveUsdPoint(null, inrValue);
    if (derivedUsd === null) {
      return directUsd;
    }
    if (directUsd === null) {
      return derivedUsd;
    }
    const tolerance = Math.max(0.02, Math.abs(derivedUsd) * 0.01);
    return Math.abs(directUsd - derivedUsd) <= tolerance ? directUsd : derivedUsd;
  };
  const computePct = (pnlValue, basisValue) =>
    pnlValue !== null && basisValue !== null && basisValue !== 0
      ? round((pnlValue / basisValue) * 100, 2)
      : null;
  const isExtendedSession = marketSession === 'pre-market' || marketSession === 'post-market';
  const isRegularSession = marketSession === 'live' ||
    marketSession === '15 min after open' ||
    marketSession === '60 min after open' ||
    marketSession === 'near close';
  const officialCloseValueInr = toNumber(reference?.officialCloseValueInr) ?? toNumber(session.officialCurrentValueInr);
  const officialCloseValueUsd = toNumber(reference?.officialCloseValueUsd);
  const officialClosePnlInr = toNumber(session.officialPnlInr);
  const officialClosePnlPct = toNumber(session.officialPnlPct);
  const actual = {
    basis: 'regular-close',
    valueInr: officialCloseValueInr,
    valueUsd: reconcileUsdPoint(officialCloseValueUsd, officialCloseValueInr),
    pnlInr: officialClosePnlInr,
    pnlUsd: reconcileUsdPoint(session.officialPnlUsd, officialClosePnlInr),
    pnlPct: officialClosePnlPct,
  };
  const hasExtendedPoint =
    toNumber(session.extendedValueInr) !== null ||
    (toNumber(session.extendedValueUsd) !== null &&
      ((toNumber(sessionFxRate) !== null && sessionFxRate > 0) || (Number.isFinite(payloadFxRate) && payloadFxRate > 0)));
  const resolvedOverallBasis = isExtendedSession && hasExtendedPoint
    ? marketSession
    : isRegularSession
      ? 'regular'
      : 'regular-close';
  const liveValueSource = resolvedOverallBasis === 'regular-close'
    ? { inr: actual.valueInr, usd: actual.valueUsd }
    : resolvedOverallBasis === 'regular'
      ? { inr: session.regularValueInr, usd: session.regularValueUsd }
      : { inr: session.extendedValueInr, usd: session.extendedValueUsd };
  const livePnlSource = resolvedOverallBasis === 'regular-close'
    ? { inr: actual.pnlInr, usd: actual.pnlUsd, pct: actual.pnlPct }
    : resolvedOverallBasis === 'regular'
      ? { inr: session.regularPnlInr, usd: session.regularPnlUsd, pct: session.regularPnlPct }
      : { inr: session.extendedPnlInr, usd: session.extendedPnlUsd, pct: session.extendedPnlPct };
  const investedInrBasis = toNumber(reference?.investedInr) ?? toNumber(session.investedInr);
  const investedUsdBasis = toNumber(reference?.investedUsd) ?? toNumber(session.investedUsd);
  const overallValueInr = resolveInrPoint(liveValueSource.inr, liveValueSource.usd);
  const overallValueUsd = reconcileUsdPoint(liveValueSource.usd, liveValueSource.inr);
  const overallPnlInr = resolveInrPoint(livePnlSource.inr, livePnlSource.usd);
  const overallPnlUsd = reconcileUsdPoint(livePnlSource.usd, livePnlSource.inr);
  const overallPnlPct =
    computePct(overallPnlInr, investedInrBasis) ??
    computePct(overallPnlUsd, investedUsdBasis) ??
    toNumber(livePnlSource.pct);
  const overall = {
    basis: resolvedOverallBasis,
    valueInr: overallValueInr,
    valueUsd: overallValueUsd,
    pnlInr: overallPnlInr,
    pnlUsd: overallPnlUsd,
    pnlPct: overallPnlPct,
  };
  const oneDay = {
    basis: overall.basis,
    currentValueInr: overall.valueInr,
    currentValueUsd: overall.valueUsd,
    previousCloseValueInr: officialCloseValueInr,
    previousCloseValueUsd: actual.valueUsd,
    pnlInr:
      overall.valueInr !== null && officialCloseValueInr !== null
        ? round(overall.valueInr - officialCloseValueInr, 2)
        : null,
    pnlUsd:
      overall.valueUsd !== null && actual.valueUsd !== null
        ? round(overall.valueUsd - actual.valueUsd, 2)
        : null,
    pnlPct: null,
  };
  oneDay.pnlPct =
    oneDay.pnlInr !== null && officialCloseValueInr
      ? round((oneDay.pnlInr / officialCloseValueInr) * 100, 2)
      : null;
  payload.usSessionPnl = {
    ...session,
    overall,
    oneDay,
    actual,
    reference: {
      ...(reference || {}),
      officialCloseValueInr,
      officialCloseValueUsd: actual.valueUsd,
    },
  };
  const liveCurrent = resolveInrPoint(
    overall?.valueInr,
    overall?.valueUsd,
  );
  const livePnl = resolveInrPoint(
    overall?.pnlInr,
    overall?.pnlUsd,
  );
  const livePnlPct = toNumber(overall?.pnlPct);
  const liveInvested = investedInrBasis;
  const resolvedBasis = String(overall?.basis || baselineOverall?.basis || session.basis || 'regular').toLowerCase();
  const hasLivePoint = liveInvested !== null && liveCurrent !== null && livePnl !== null;
  if (hasLivePoint) {
    payload.assetClassPnl = (Array.isArray(payload.assetClassPnl) ? payload.assetClassPnl : []).map((row) => {
      if (!isUsAssetClassLabel(row?.label || row?.asset_type || row?.assetclass_l2 || row?.asset_class)) return row;
      const finalInvested = liveInvested ?? toNumber(row.invested);
      const finalPnl = livePnl ?? toNumber(row.pnl);
      const finalPnlPct = computePct(finalPnl, finalInvested) ?? livePnlPct;
      return {
        ...row,
        invested: finalInvested ?? row.invested,
        investedUsd:
          resolveUsdPoint(reference?.investedUsd, reference?.investedInr) ??
          toNumber(row.investedUsd),
        currentValue: liveCurrent,
        currentValueUsd:
          reconcileUsdPoint(overall?.valueUsd, overall?.valueInr) ??
          toNumber(row.currentValueUsd),
        pnl: finalPnl,
        pnlUsd:
          reconcileUsdPoint(overall?.pnlUsd, overall?.pnlInr) ??
          toNumber(row.pnlUsd),
        pnlPct: finalPnlPct,
        priceBasis: resolvedBasis,
        officialCurrentValue: toNumber(reference?.officialCloseValueInr) ?? session.officialCurrentValueInr,
        officialPnl: toNumber(actual?.pnlInr) ?? session.officialPnlInr,
        officialPnlPct: toNumber(actual?.pnlPct) ?? session.officialPnlPct,
      };
    });

    const totalInvested = round(payload.assetClassPnl.reduce((sum, row) => sum + (toNumber(row.invested) || 0), 0), 2);
    const totalCurrentValue = round(payload.assetClassPnl.reduce((sum, row) => sum + (toNumber(row.currentValue) || 0), 0), 2);
    const totalReturn = round(totalCurrentValue - totalInvested, 2);
    const liabilities = toNumber(payload.summary?.liabilities);
    payload.summary = {
      ...(payload.summary || {}),
      priceBasis: resolvedBasis,
      totalInvested,
      totalCurrentValue,
      totalNetworth: liabilities !== null ? round(totalCurrentValue + liabilities, 2) : totalCurrentValue,
      totalReturn,
      totalReturnPct: totalInvested ? round((totalReturn / totalInvested) * 100, 2) : null,
      totalInvestedUsd: resolveUsdPoint(reference?.investedUsd, reference?.investedInr),
      totalCurrentValueUsd: resolveUsdPoint(overall?.valueUsd, overall?.valueInr),
      totalReturnUsd: resolveUsdPoint(overall?.pnlUsd, overall?.pnlInr),
      actualCurrentValue: resolveInrPoint(actual?.valueInr, actual?.valueUsd),
      actualCurrentValueUsd: resolveUsdPoint(actual?.valueUsd, actual?.valueInr),
      actualTotalReturn: resolveInrPoint(actual?.pnlInr, actual?.pnlUsd),
      actualTotalReturnUsd: resolveUsdPoint(actual?.pnlUsd, actual?.pnlInr),
      actualTotalReturnPct: toNumber(actual?.pnlPct),
      officialCloseValue: toNumber(reference?.officialCloseValueInr) ?? session.officialCurrentValueInr,
      officialCloseValueUsd: resolveUsdPoint(reference?.officialCloseValueUsd, reference?.officialCloseValueInr),
    };
  }

  const fallbackInvested = hasLivePoint ? liveInvested : toNumber(payload.summary?.totalInvested);
  const fallbackCurrent = hasLivePoint ? liveCurrent : toNumber(payload.summary?.totalCurrentValue);
  const fallbackPnl = hasLivePoint
    ? livePnl
    : fallbackInvested !== null && fallbackCurrent !== null
      ? round(fallbackCurrent - fallbackInvested, 2)
      : null;
  const fallbackPnlPct =
    hasLivePoint
      ? livePnlPct
      : fallbackInvested !== null && fallbackPnl !== null
        ? round((fallbackPnl / fallbackInvested) * 100, 2)
        : null;
  const usStockPnl = payload.usStockPnl;
  const points = Array.isArray(usStockPnl?.points) ? usStockPnl.points : [];
  if (points.length && hasLivePoint) {
    const timestamp = nowIso();
    const date = getIndMoneyHistoryDateKey(timestamp);
    const livePoint = {
      timestamp,
      date,
      invested: fallbackInvested,
      currentValue: fallbackCurrent,
      pnl: fallbackPnl,
      pnlPct: fallbackPnlPct,
      source: hasLivePoint
        ? `live_${resolvedBasis.replace(/[^a-z0-9]+/g, '_')}`
        : null,
    };
    const nextPoints = points.slice();
    const lastIndex = nextPoints.length - 1;
    if (nextPoints[lastIndex]?.date === date) nextPoints[lastIndex] = { ...nextPoints[lastIndex], ...livePoint };
    else nextPoints.push(livePoint);
    const first = nextPoints[0] || null;
    payload.usStockPnl = {
      ...usStockPnl,
      points: nextPoints,
      pointCount: nextPoints.length,
      summary: {
        invested: fallbackInvested,
        currentValue: fallbackCurrent,
        pnl: fallbackPnl,
        pnlPct: fallbackPnlPct,
      },
      change: first && fallbackPnl !== null ? round(fallbackPnl - (toNumber(first.pnl) || 0), 2) : null,
      changePct: first && toNumber(first.invested) && fallbackPnl !== null
        ? round(((fallbackPnl - (toNumber(first.pnl) || 0)) / toNumber(first.invested)) * 100, 2)
        : null,
    };
  }

  return payload;
}
function normalizedMarketCapUsd(value) {
  const marketCap = toNumber(value);
  if (marketCap === null) return null;
  return Math.abs(marketCap) < 10000000 ? marketCap * 1000000 : marketCap;
}

function classifyMarketCap(value) {
  const marketCap = normalizedMarketCapUsd(value);
  if (marketCap === null) return 'Unclassified';
  if (marketCap >= 200000000000) return 'Mega Cap';
  if (marketCap >= 10000000000) return 'Large Cap';
  if (marketCap >= 2000000000) return 'Mid Cap';
  if (marketCap >= 300000000) return 'Small Cap';
  return 'Micro Cap';
}

function buildUsHoldingAllocation(rows = [], labelForRow) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const currentValue = firstNumber(row.currentValue, row.current_value, row.market_value, row.value);
    if (currentValue === null) continue;
    const label = labelForRow(row);
    const existing = groups.get(label) || {
      label,
      value: 0,
      invested: 0,
      percent: null,
      currency: row.currency || 'USD',
      count: 0,
    };
    existing.value += currentValue;
    existing.invested += firstNumber(row.invested, row.invested_amount, row.cost_value) || 0;
    existing.count += 1;
    groups.set(label, existing);
  }
  const total = Array.from(groups.values()).reduce((sum, row) => sum + row.value, 0);
  return Array.from(groups.values())
    .map((row) => ({
      ...row,
      value: round(row.value, 2),
      invested: round(row.invested, 2),
      percent: total ? round((row.value / total) * 100, 2) : null,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export function buildUsHoldingSectorAllocations(rows = []) {
  return buildUsHoldingAllocation(rows, (row) => String(row.sector || 'Unclassified').trim() || 'Unclassified');
}

export function buildUsHoldingMarketCapAllocations(rows = []) {
  return buildUsHoldingAllocation(rows, (row) => classifyMarketCap(row.marketCap));
}

function latestInvestmentAllocations(history = []) {
  const latest = (Array.isArray(history) ? history : [])
    .filter((row) => Array.isArray(row?.investments) && row.investments.length)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  return latest ? normalizeAllocationRows(latest.investments) : [];
}

export function normalizeIndMoneyDashboardPayload(parts = {}) {
  const snapshot = parts.networth || {};
  const investmentAllocations = normalizeAllocationRows(snapshot.investments);
  const effectiveInvestmentAllocations = investmentAllocations.length ? investmentAllocations : latestInvestmentAllocations(parts.history || []);
  const effectiveUsInvestment = effectiveInvestmentAllocations.find((row) =>
    isUsAssetClassLabel(row?.label || row?.asset_type || row?.assetclass_l2 || row?.asset_class),
  );
  const summary = normalizeIndMoneyDashboardSummary(effectiveUsInvestment
    ? {
        ...snapshot,
        total_invested: firstNumber(
          effectiveUsInvestment.invested,
          effectiveUsInvestment.invested_value,
          effectiveUsInvestment.invested_amount,
          effectiveUsInvestment.total_invested,
        ),
        total_current_value: firstNumber(
          effectiveUsInvestment.value,
          effectiveUsInvestment.current_value,
          effectiveUsInvestment.currentValue,
          effectiveUsInvestment.market_value,
          effectiveUsInvestment.total_current_value,
        ),
        total_networth: firstNumber(
          effectiveUsInvestment.value,
          effectiveUsInvestment.current_value,
          effectiveUsInvestment.currentValue,
          effectiveUsInvestment.market_value,
          effectiveUsInvestment.total_current_value,
        ),
        total_return: null,
        total_return_pct: null,
      }
    : snapshot);
  const holdings = Object.fromEntries(
    Object.entries(parts.holdings || {}).map(([assetType, payload]) => [
      assetType,
      normalizeIndMoneyHoldings(payload?.holdings || payload?.data?.holdings || payload?.data || payload),
    ]),
  );
  const usStockPnl = buildIndMoneyUsStockPnlSeries(parts.history || []);
  const usHoldings = holdings.US_STOCK || [];
  const sectorAllocations = buildUsHoldingSectorAllocations(usHoldings);
  const marketCapAllocations = buildUsHoldingMarketCapAllocations(usHoldings);
  const assetClassPnl = buildUsOnlyAssetClassPnl({
    summary,
    holdings: usHoldings,
    investments: effectiveInvestmentAllocations,
  });
  const payload = {
    ok: true,
    updatedAt: nowIso(),
    connection: {
      source: INDMONEY_DASHBOARD_SOURCE,
      mcpAvailable: !parts.errors?.networth,
      errors: parts.errors || {},
    },
    summary,
    allocations: {
      sector: sectorAllocations,
      marketCap: marketCapAllocations,
    },
    holdings: {
      US_STOCK: usHoldings,
    },
    watchlist: parts.usWatchlist || parts.watchlist || { watchlists: [] },
    usWatchlist: parts.usWatchlist || { watchlists: [] },
    watchlistDetails: Array.isArray(parts.watchlistDetails) ? parts.watchlistDetails : [],
    chartUniverse: Array.isArray(parts.chartUniverse) ? parts.chartUniverse : [],
    growth: buildIndMoneyGrowthSeries(parts.history || []),
    sessionMeta: parts.sessionMeta || {},
    usStockPnl: {
      ...usStockPnl,
      categories: buildUsStockCategoryPnl(usHoldings),
    },
    assetClassPnl,
    usSessionPnl: buildUsSessionPnlSummary(usHoldings, assetClassPnl),
  };
  return applyLiveUsSessionPricing(payload);
}
