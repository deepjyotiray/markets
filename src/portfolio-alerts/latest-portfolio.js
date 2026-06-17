import { nowIso, round, toNumber } from './utils.js';

function parsePortfolioUpdatedAt(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const istMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*IST$/i);
  if (istMatch) {
    const [, year, month, day, hour, minute, second = '00'] = istMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 5, Number(minute) - 30, Number(second)));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasMarketData(snapshot = {}) {
  return Boolean(snapshot && (Array.isArray(snapshot.holdings) && snapshot.holdings.length));
}

function chooseMarketSnapshot(latestSnapshot = null, legacySnapshot = null) {
  if (!latestSnapshot) return legacySnapshot || null;
  if (!legacySnapshot) return latestSnapshot || null;
  const latestHasData = hasMarketData(latestSnapshot);
  const legacyHasData = hasMarketData(legacySnapshot);
  if (latestHasData && !legacyHasData) return latestSnapshot;
  if (legacyHasData && !latestHasData) return legacySnapshot;
  const latestTime = parsePortfolioUpdatedAt(latestSnapshot.updatedAt || latestSnapshot.exportedAt);
  const legacyTime = parsePortfolioUpdatedAt(legacySnapshot.updatedAt || legacySnapshot.exportedAt);
  if (latestTime && legacyTime) {
    return latestTime >= legacyTime ? latestSnapshot : legacySnapshot;
  }
  return latestSnapshot;
}

export function choosePreferredPortfolioStore(latestStore = {}, legacyStore = {}) {
  return {
    US: chooseMarketSnapshot(latestStore?.US || null, legacyStore?.US || null),
    IND: chooseMarketSnapshot(latestStore?.IND || null, legacyStore?.IND || null),
  };
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = toNumber(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

export function buildLatestUsPortfolioSnapshot({ summary = {}, holdings = [], updatedAt, source = 'INDmoney MCP', previousUs = null } = {}) {
  const normalizedHoldings = (Array.isArray(holdings) ? holdings : [])
    .map((row) => {
      const quantity = firstNumber(row, ['quantity', 'units']);
      const invested = firstNumber(row, ['invested', 'investedUsd']);
      const currentValue = firstNumber(row, ['currentValue', 'currentValueUsd', 'liveValue']);
      const totalReturn = firstNumber(row, ['pnl', 'totalReturn', 'liveReturn']);
      const totalReturnPct = firstNumber(row, ['pnlPct', 'totalReturnPct', 'liveReturnPct']);
      const lastPrice = firstNumber(row, ['lastPrice', 'livePrice', 'regularPrice']);
      return row?.ticker ? {
        ticker: String(row.ticker).trim().toUpperCase(),
        name: row.name || row.sourceTitle || row.ticker,
        quantity: quantity ?? 0,
        avgPrice: firstNumber(row, ['avgPrice']),
        lastPrice,
        movePct: firstNumber(row, ['movePct', 'oneDayReturnPct']),
        moveBasis: row.moveBasis || 'regular',
        invested,
        currentValue,
        totalReturn: totalReturn ?? (invested !== null && currentValue !== null ? round(currentValue - invested, 2) : null),
        totalReturnPct: totalReturnPct ?? (
          invested && currentValue !== null
            ? round(((currentValue - invested) / invested) * 100, 2)
            : null
        ),
      } : null;
    })
    .filter(Boolean);

  const investedValue = firstNumber(summary, ['investedValue', 'investedValueUsd'])
    ?? round(normalizedHoldings.reduce((sum, row) => sum + (toNumber(row.invested) || 0), 0), 2);
  const portfolioValue = firstNumber(summary, ['portfolioValue', 'portfolioValueUsd', 'currentValue'])
    ?? round(normalizedHoldings.reduce((sum, row) => sum + (toNumber(row.currentValue) || 0), 0), 2);
  const totalReturns = firstNumber(summary, ['totalReturns', 'totalReturnsUsd', 'pnl'])
    ?? (investedValue !== null && portfolioValue !== null ? round(portfolioValue - investedValue, 2) : null);

  return {
    source,
    updatedAt: updatedAt || nowIso(),
    exportedAt: nowIso(),
    summary: {
      portfolioValue,
      investedValue,
      totalReturns,
      totalReturnsPct: firstNumber(summary, ['totalReturnsPct', 'totalReturnsPctUsd'])
        ?? (investedValue ? round((totalReturns / investedValue) * 100, 2) : null),
      buyingPower: firstNumber(summary, ['buyingPower']),
      oneDayReturn: firstNumber(summary, ['oneDayReturn']),
      oneDayReturnPct: firstNumber(summary, ['oneDayReturnPct']),
      holdingsCount: normalizedHoldings.length,
    },
    holdings: normalizedHoldings,
    orders: Array.isArray(previousUs?.orders) ? previousUs.orders : [],
    history: previousUs?.history || null,
  };
}

export function buildLatestUsPortfolioSnapshotFromIndMoney2Dashboard(dashboard = {}, previousUs = null) {
  const holdings = (Array.isArray(dashboard?.holdings) ? dashboard.holdings : []).map((row) => ({
    ticker: row?.ticker,
    name: row?.name || row?.ticker,
    quantity: firstNumber(row, ['quantity']),
    avgPrice: firstNumber(row, ['avgPriceUsd', 'avgPrice']),
    lastPrice: firstNumber(row, ['currentPriceUsd', 'livePriceUsd', 'lastPrice']),
    movePct: firstNumber(row, ['oneDayPnlPct', 'movePct']),
    invested: firstNumber(row, ['investedUsd', 'invested']),
    currentValue: firstNumber(row, ['currentHoldingValueUsd', 'currentValueUsd', 'currentValue']),
    totalReturn: firstNumber(row, ['actualPnlUsd', 'totalReturn']),
    totalReturnPct: firstNumber(row, ['actualPnlPct', 'totalReturnPct']),
  }));

  return buildLatestUsPortfolioSnapshot({
    updatedAt: dashboard?.updatedAt || nowIso(),
    source: 'INDmoney2 canonical live prices',
    previousUs,
    summary: {
      portfolioValue: firstNumber(dashboard?.summary, ['currentPortfolioValueUsd', 'portfolioValueUsd', 'portfolioValue']),
      investedValue: firstNumber(dashboard?.summary, ['investedValueUsd', 'investedValue']),
      totalReturns: firstNumber(dashboard?.summary, ['actualPnlUsd', 'totalReturns']),
      totalReturnsPct: firstNumber(dashboard?.summary, ['actualPnlPct', 'totalReturnsPct']),
      oneDayReturn: firstNumber(dashboard?.summary, ['oneDayPnlUsd', 'oneDayReturn']),
      oneDayReturnPct: firstNumber(dashboard?.summary, ['oneDayPnlPct', 'oneDayReturnPct']),
      holdingsCount: holdings.length,
    },
    holdings,
  });
}
