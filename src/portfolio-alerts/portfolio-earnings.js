import { round } from './utils.js';

function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function signedPct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}%`;
}

function buildHoldingRow(holding = {}, research = {}) {
  const currentValue = Number(holding.currentValue || 0);
  const invested = Number(holding.invested || 0);
  const weightPct = Number(holding.weightPct || 0);
  const totalReturnPct = Number(holding.totalReturnPct || 0);
  return {
    ticker: holding.ticker,
    name: holding.name,
    currentValue,
    invested,
    totalReturn: Number(holding.totalReturn || 0),
    totalReturnPct,
    weightPct,
    movePct: Number(holding.movePct || 0),
    verdict: research.verdict || 'Research not loaded.',
    action: research.action || 'watch',
    thesisChange: research.thesisChange || 'unrated',
    theme: research.theme || 'Unclassified',
    epsQuality: research.epsQuality || {
      status: 'not_provided',
      note: 'No EPS quality note provided.',
    },
    reportedPeriod: research.reportedPeriod || 'not provided',
    reportedAt: research.reportedAt || null,
    nextCatalyst: research.nextCatalyst || {
      label: 'Next catalyst',
      status: 'not_provided',
      note: 'No next catalyst provided.',
    },
    highlights: Array.isArray(research.highlights) ? research.highlights : [],
    managementEvidence: Array.isArray(research.managementEvidence) ? research.managementEvidence : [],
    sources: Array.isArray(research.sources) ? research.sources : [],
    summaryLine: `${holding.ticker} ${round(weightPct, 2)}% weight | ${signedPct(totalReturnPct)} total P/L | ${research.action || 'watch'}`,
  };
}

export function buildPortfolioEarningsPayload(portfolio = {}, research = {}, options = {}) {
  const asOfDate = options.asOfDate || research.asOfDate || new Date().toISOString().slice(0, 10);
  const todayMs = dateValue(asOfDate) || Date.now();
  const us = portfolio.US || portfolio.us || {};
  const summary = us.summary || {};
  const holdings = Array.isArray(us.holdings) ? us.holdings : [];
  const researchMap = research.holdings || {};

  const rows = holdings
    .map((holding) => {
      const currentValue = Number(holding.currentValue || 0);
      const portfolioValue = Number(summary.portfolioValue || 0);
      return buildHoldingRow(
        {
          ...holding,
          currentValue,
          invested: Number(holding.invested || 0),
          totalReturn: Number(holding.totalReturn || 0),
          totalReturnPct: Number(holding.totalReturnPct || 0),
          weightPct: portfolioValue > 0 ? (currentValue / portfolioValue) * 100 : 0,
        },
        researchMap[holding.ticker] || {},
      );
    })
    .sort((left, right) => right.currentValue - left.currentValue);

  const top4WeightPct = round(rows.slice(0, 4).reduce((sum, row) => sum + row.weightPct, 0), 2) || 0;
  const infraWeightPct = round(rows.filter((row) => row.theme === 'AI infrastructure' || row.theme === 'AI memory' || row.theme === 'AI networking and custom silicon' || row.theme === 'AI foundry').reduce((sum, row) => sum + row.weightPct, 0), 2) || 0;
  const flaggedNames = rows.filter((row) => row.epsQuality?.status === 'trigger_identified');
  const upcomingCatalysts = rows
    .filter((row) => dateValue(row.nextCatalyst?.date) && dateValue(row.nextCatalyst?.date) >= todayMs)
    .sort((left, right) => dateValue(left.nextCatalyst?.date) - dateValue(right.nextCatalyst?.date))
    .map((row) => ({
      ticker: row.ticker,
      name: row.name,
      weightPct: row.weightPct,
      label: row.nextCatalyst.label,
      date: row.nextCatalyst.date,
      note: row.nextCatalyst.note,
    }));

  return {
    ok: true,
    asOfDate,
    sourcePosture: research.sourcePosture || 'Source posture not provided.',
    estimateSet: research.estimateSet || 'estimate timestamp not provided',
    updatedAt: us.updatedAt || null,
    portfolio: {
      valueUsd: Number(summary.portfolioValue || 0),
      investedUsd: Number(summary.investedValue || 0),
      totalReturnUsd: Number(summary.totalReturns || 0),
      totalReturnPct: Number(summary.totalReturnsPct || 0),
      holdingsCount: Number(summary.holdingsCount || rows.length || 0),
      top4WeightPct,
      infraWeightPct,
      epsQualityFlagCount: flaggedNames.length,
    },
    portfolioView: {
      verdict: research.portfolioView?.verdict || '',
      thesisChange: research.portfolioView?.thesisChange || 'unrated',
      action: research.portfolioView?.action || '',
    },
    upcomingCatalysts,
    epsQualityFlags: flaggedNames.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      weightPct: row.weightPct,
      note: row.epsQuality.note,
    })),
    limitations: Array.isArray(research.limitations) ? research.limitations : [],
    rows,
  };
}
