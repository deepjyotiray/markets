import { buildPortfolioAlertConfig } from './config.js';
import { buildDecisionReport } from './decision-engine.js';
import {
  chooseDisplayQuote,
  quoteIsStale,
} from './market-data.js';
import {
  buildFundamentalSnapshotFromMcpUsDetails,
  createIndMoneyMcpProvider,
  normalizeMcpUsHoldingsForAlertEngine,
  normalizeMcpUsStockDetails,
} from './indmoney-mcp.js';
import { buildPortfolioContext, scoreHolding } from './scoring-engine.js';
import {
  appendAlertEvent,
  ensureAlertStateFiles,
  getThreadRef,
  markDailySummarySent,
  readAlertState,
  resetDailyStateIfNeeded,
  setThreadRef,
  updateIntradayState,
  writeAlertState,
} from './state-store.js';
import { getSessionClock } from './session-clock.js';
import {
  buildEarningsAlerts,
  buildDecisionAlerts,
  buildPortfolioRiskAlerts,
  buildRotationAlerts,
  buildTickerRuleAlerts,
  applyAlertDeliveryState,
  formatAlertMessage,
  formatDailySummary,
  reconcileCandidates,
} from './trigger-engine.js';
import { createLogger, formatTimestampInZone, round, toNumber } from './utils.js';
import { sendWhatsappAlert } from './whatsapp.js';

const logger = createLogger('runtime');

function normalizeTicker(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function parsePortfolioTimestamp(value) {
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

export function getUsPortfolioPollIntervalMs(sessionClock, config) {
  const bucket = sessionClock?.bucket || 'CLOSED';
  if (bucket === 'PRE_MARKET') {
    return config.pollingIntervalMsPreMarket;
  }
  if (bucket === 'OPENING_RANGE' || bucket === 'REGULAR_MARKET' || bucket === 'POWER_HOUR') {
    return config.pollingIntervalMsRegular;
  }
  if (bucket === 'POST_MARKET') {
    return config.pollingIntervalMsPostMarket;
  }
  return config.pollingIntervalMsClosed;
}

function readHoldingNumber(holding, keys) {
  for (const key of keys) {
    const value = toNumber(holding?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function getSnapshotUpdatedAt(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  return snapshot.updatedAt || snapshot.updated_at || snapshot['Updated At'] || snapshot.exportedAt || snapshot.exported_at || snapshot.timestamp || null;
}

function isMcpPortfolioSource(snapshot = {}) {
  const source = String(snapshot?.source || '').toLowerCase();
  return source.includes('indmoney') && source.includes('mcp');
}

function getPortfolioValue(summary = {}) {
  return readHoldingNumber(summary, ['portfolioValueUsd', 'portfolioValue', 'portfolio_value', 'Portfolio Value']);
}

function getInvestedValue(summary = {}) {
  return readHoldingNumber(summary, ['investedValueUsd', 'investedValue', 'invested_value', 'Invested Value']);
}

function getTotalPnl(summary = {}) {
  return readHoldingNumber(summary, ['unrealizedProfitUsd', 'totalReturns', 'totalPnl', 'total_pnl', 'Total P&L']);
}

function getOneDayPnl(summary = {}) {
  return readHoldingNumber(summary, ['oneDayPnlUsd', 'oneDayReturn', 'dayPnl', 'day_pnl', '1D P&L', 'Day P&L']);
}

function getHoldingOneDayPnl(holding = {}) {
  return readHoldingNumber(holding, ['oneDayPnlUsd', 'oneDayReturn', 'oneDayPnl', 'dayPnl', '1D P&L', 'Day P&L']);
}

function extractMcpHoldingsRows(payload) {
  if (Array.isArray(payload?.holdings)) return payload.holdings;
  if (Array.isArray(payload?.data?.holdings)) return payload.data.holdings;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

export function selectLatestPortfolioSnapshot(raw) {
  if (raw?.US?.holdings) {
    return raw.US;
  }
  const candidates = [
    ...(Array.isArray(raw?.snapshots) ? raw.snapshots : []),
    ...(Array.isArray(raw?.exports) ? raw.exports : []),
  ]
    .map((item) => item?.US || item)
    .filter((item) => Array.isArray(item?.holdings));
  if (candidates.length) {
    return candidates
      .map((item, index) => ({ item, index, date: parsePortfolioTimestamp(getSnapshotUpdatedAt(item)) }))
      .sort((a, b) => ((b.date?.getTime() || 0) - (a.date?.getTime() || 0)) || b.index - a.index)[0].item;
  }
  return null;
}

export async function loadPortfolioSnapshot(config) {
  if (!config.providers?.indmoneyMcpEnabled) {
    throw new Error('INDmoney MCP provider is required');
  }
  return loadMcpUsPortfolioSnapshot(config);
}

async function loadMcpUsPortfolioSnapshot(config) {
  const provider = createIndMoneyMcpProvider({
    client: config.providers?.indmoneyMcpClient,
    cacheSeconds: config.providers?.indmoneyMcpCacheSeconds,
  });
  if (!provider.isAvailable()) {
    throw new Error('INDmoney MCP provider is not available');
  }
  let holdingsPayload = await provider.networthHoldings('US_STOCK');
  let rows = extractMcpHoldingsRows(holdingsPayload);
  if (!rows.length) {
    const refreshProvider = createIndMoneyMcpProvider({
      client: config.providers?.indmoneyMcpClient,
      cacheSeconds: 0,
    });
    holdingsPayload = await refreshProvider.networthHoldings('US_STOCK');
    rows = extractMcpHoldingsRows(holdingsPayload);
  }
  if (!rows.length) {
    throw new Error('INDmoney MCP returned no US stock holdings');
  }
  const profileSymbols = Object.keys(config.stockProfiles || {}).filter((ticker) => !['QQQ', 'SMH'].includes(ticker));
  const detailsPayload = profileSymbols.length ? await provider.getUsStocksDetails(profileSymbols, ['analyst', 'news']) : {};
  return normalizeMcpUsHoldingsForAlertEngine({
    holdingsPayload,
    detailsPayload,
    stockProfiles: config.stockProfiles,
  });
}

async function loadSectorIntelligenceSnapshot(config) {
  return null;
}

function deriveHoldingNumbers(holding, displayQuote, portfolioValueUsd) {
  const quantity = toNumber(holding.quantity) || 0;
  const avgPrice = toNumber(holding.avgPrice) || 0;
  const investedUsd = toNumber(holding.invested) ?? round(quantity * avgPrice, 2) ?? 0;
  const livePrice = toNumber(displayQuote.price) ?? toNumber(holding.lastPrice) ?? toNumber(holding.livePrice) ?? 0;
  const currentValueUsd =
    readHoldingNumber(holding, ['currentValueUsd', 'currentValue', 'current_value', 'Current Value']) ??
    round(quantity * (toNumber(holding.lastPrice) ?? livePrice), 2) ??
    0;
  const totalPnlUsd = round(currentValueUsd - investedUsd, 2) ?? 0;
  const totalActualReturnUsd =
    readHoldingNumber(holding, ['totalActualReturnUsd', 'totalActualReturn', 'total_actual_return', 'totalReturn', 'Total Actual Return']) ??
    totalPnlUsd;
  const rawOneDayPnlUsd = getHoldingOneDayPnl(holding);
  return {
    quantity,
    avgPrice,
    investedUsd,
    livePrice,
    currentValueUsd,
    totalPnlUsd,
    totalActualReturnUsd: round(totalActualReturnUsd, 2) ?? 0,
    profitContributionPct: portfolioValueUsd > 0 ? null : 0,
    oneDayPnlUsd: rawOneDayPnlUsd,
    oneDayPnlSource: rawOneDayPnlUsd === null ? 'missing' : 'holding_export',
    portfolioWeightPct: portfolioValueUsd > 0 ? round((currentValueUsd / portfolioValueUsd) * 100, 2) : 0,
  };
}

export function buildPortfolioDataQuality(portfolioStore, summary, holdings, config, now = new Date()) {
  const sourceTimestamp = getSnapshotUpdatedAt(portfolioStore);
  const sourceDate = parsePortfolioTimestamp(sourceTimestamp);
  const maxAgeMinutes = toNumber(config.thresholds?.portfolioSnapshotFreshnessMinutes) ?? 360;
  const ageMinutes = sourceDate ? Math.max(0, (now.getTime() - sourceDate.getTime()) / 60000) : null;
  const freshnessStatus = isMcpPortfolioSource(portfolioStore) ? 'FRESH' : (sourceDate && ageMinutes <= maxAgeMinutes ? 'FRESH' : 'STALE_DATA');
  const tolerance = toNumber(config.thresholds?.portfolioReconciliationToleranceUsd) ?? 2;
  const exportedPortfolioValueUsd = getPortfolioValue(portfolioStore?.summary || {});
  const exportedTotalPnlUsd = getTotalPnl(portfolioStore?.summary || {});
  const warnings = [];
  if (exportedPortfolioValueUsd !== null && Math.abs(exportedPortfolioValueUsd - summary.portfolioValueUsd) > tolerance) {
    warnings.push('WARNING_DATA_MISMATCH');
  }
  if (exportedTotalPnlUsd !== null && Math.abs(exportedTotalPnlUsd - summary.unrealizedProfitUsd) > tolerance) {
    warnings.push('WARNING_PNL_MISMATCH');
  }
  if (summary.missingOneDayHoldingCount > 0) {
    warnings.push('WARNING_1D_PNL_HOLDINGS_MISSING');
  }
  const byValue = [...holdings].sort((a, b) => (toNumber(b.currentValueUsd) || 0) - (toNumber(a.currentValueUsd) || 0));
  return {
    sourceTimestamp: sourceTimestamp || null,
    alertGenerationTimestamp: formatTimestampInZone(now, config.userTimezone),
    freshnessStatus,
    ageMinutes: ageMinutes === null ? null : round(ageMinutes, 1),
    maxAgeMinutes,
    reconciliationPassed: warnings.length === 0,
    warnings,
    exportedPortfolioValueUsd,
    exportedTotalPnlUsd,
    oneDayPnlSource: summary.oneDayPnlSource,
    missingOneDayHoldingCount: summary.missingOneDayHoldingCount || 0,
    calculatedPortfolioValueUsd: summary.portfolioValueUsd,
    calculatedTotalPnlUsd: summary.unrealizedProfitUsd,
    top3ConcentrationPct: summary.portfolioValueUsd > 0
      ? round((byValue.slice(0, 3).reduce((sum, item) => sum + (toNumber(item.currentValueUsd) || 0), 0) / summary.portfolioValueUsd) * 100, 2)
      : 0,
  };
}

async function gatherMarketState(config, sessionClock, portfolioStore) {
  const holdings = (portfolioStore?.holdings || []).map((holding) => normalizeTicker(holding.ticker));
  const benchmarks = ['QQQ', 'SMH'];
  const watchlist = [...new Set([...holdings, ...config.watchlist.external, ...benchmarks])];
  const indMoneyDetails = await fetchMcpUsDetailsMap(config, watchlist);
  const quoteMap = Object.fromEntries(
    watchlist
      .filter((ticker) => indMoneyDetails[ticker])
      .map((ticker) => [ticker, {
        ...indMoneyDetails[ticker],
        title: indMoneyDetails[ticker].name,
        exchange: '',
        fetchedAt: Date.now(),
      }]),
  );

  const benchmarkState = {
    qqqMovePct: chooseDisplayQuote(quoteMap.QQQ, sessionClock).movePct,
    smhMovePct: chooseDisplayQuote(quoteMap.SMH, sessionClock).movePct,
  };

  return {
    quoteMap,
    benchmarkState,
    usdInrRate: portfolioStore?.holdings?.[0]?.usdInrRate ?? null,
    capexFear: false,
    marketNews: [],
  };
}

async function fetchMcpUsDetailsMap(config, symbols = []) {
  if (!config.providers?.indmoneyMcpEnabled) {
    return {};
  }
  try {
    const provider = createIndMoneyMcpProvider({
      client: config.providers?.indmoneyMcpClient,
      cacheSeconds: config.providers?.indmoneyMcpCacheSeconds,
    });
    if (!provider.isAvailable()) {
      return {};
    }
    const payload = await provider.getUsStocksDetails(symbols.filter(Boolean), ['analyst', 'news']);
    return normalizeMcpUsStockDetails(payload);
  } catch (error) {
    logger.warn('INDmoney MCP US details failed', { error: error.message });
    return {};
  }
}

export async function buildLivePortfolio(config, sessionClock, portfolioStore, marketState) {
  const sourcePortfolio = portfolioStore || { holdings: [], summary: {}, source: 'INDmoney MCP' };
  const normalizedHoldings = (sourcePortfolio.holdings || []).map((holding) => {
    const ticker = normalizeTicker(holding.ticker);
    const profile = config.stockProfiles[ticker] || {};
    const quote = marketState.quoteMap[ticker];
    const displayQuote = chooseDisplayQuote(quote, sessionClock);
    return {
      ticker,
      name: holding.name || profile.name || ticker,
      profile,
      quote,
      displayQuote,
      importedHolding: holding,
      dataStale: quoteIsStale({ timestamp: displayQuote.timestamp }, sessionClock, config),
      rotationSourceRank: profile.rotationSourceRank || null,
      rotationTargetRank: profile.rotationTargetRank || null,
      movePct: toNumber(displayQuote.movePct) ?? toNumber(holding.movePct),
    };
  });

  const portfolioValueUsd = normalizedHoldings.reduce((sum, holding) => {
    const currentValue =
      readHoldingNumber(holding.importedHolding, ['currentValueUsd', 'currentValue', 'current_value', 'Current Value']) ??
      ((toNumber(holding.importedHolding.quantity) || 0) *
        (toNumber(holding.importedHolding.lastPrice) ?? toNumber(holding.displayQuote.price) ?? 0));
    return sum + currentValue;
  }, 0);

  let holdings = normalizedHoldings.map((holding) => ({
    ...holding,
    ...deriveHoldingNumbers(holding.importedHolding, { ...holding.displayQuote, previousClose: holding.quote?.previousClose }, portfolioValueUsd),
  }));

  const investedValueUsd = holdings.reduce((sum, holding) => sum + (toNumber(holding.investedUsd) || 0), 0);
  const unrealizedProfitUsd = holdings.reduce((sum, holding) => sum + (toNumber(holding.totalPnlUsd) || 0), 0);
  const exportedOneDayPnlUsd = getOneDayPnl(sourcePortfolio.summary || {});
  const holdingsWithOneDayPnl = holdings.filter((holding) => toNumber(holding.oneDayPnlUsd) !== null);
  const holdingOneDayPnlUsd = holdingsWithOneDayPnl.reduce((sum, holding) => sum + (toNumber(holding.oneDayPnlUsd) || 0), 0);
  const oneDayPnlUsd = holdingsWithOneDayPnl.length === holdings.length
    ? holdingOneDayPnlUsd
    : exportedOneDayPnlUsd;
  const buyingPowerUsd = toNumber(sourcePortfolio.summary?.buyingPower) ?? 0;
  const summary = {
    portfolioValueUsd: round(portfolioValueUsd, 2) ?? 0,
    investedValueUsd: round(investedValueUsd, 2) ?? 0,
    unrealizedProfitUsd: round(unrealizedProfitUsd, 2) ?? 0,
    totalReturnPct: investedValueUsd > 0 ? round((unrealizedProfitUsd / investedValueUsd) * 100, 2) : 0,
    oneDayPnlUsd: round(oneDayPnlUsd, 2),
    oneDayPnlSource: holdingsWithOneDayPnl.length === holdings.length ? 'holding_export' : 'portfolio_summary_fallback',
    missingOneDayHoldingCount: holdings.length - holdingsWithOneDayPnl.length,
    buyingPowerUsd,
    exportedPortfolioValueUsd: getPortfolioValue(sourcePortfolio.summary || {}),
    exportedInvestedValueUsd: getInvestedValue(sourcePortfolio.summary || {}),
    exportedTotalPnlUsd: getTotalPnl(sourcePortfolio.summary || {}),
    exportedOneDayPnlUsd,
  };
  holdings = holdings.map((holding) => ({
    ...holding,
    profitContributionPct: summary.unrealizedProfitUsd !== 0
      ? round(((toNumber(holding.totalActualReturnUsd) || 0) / summary.unrealizedProfitUsd) * 100, 2)
      : 0,
  }));

  return {
    importedUpdatedAt: getSnapshotUpdatedAt(sourcePortfolio),
    source: sourcePortfolio.source || null,
    holdings,
    summary,
    dataQuality: buildPortfolioDataQuality(sourcePortfolio, summary, holdings, config),
  };
}

async function scorePortfolioAndWatchlist(config, portfolio, marketState, sessionClock, portfolioContext, sectorIntelligence) {
  const sectorStocks = Object.fromEntries((sectorIntelligence?.stocks || []).map((stock) => [stock.ticker, stock]));
  const mcpUsDetails = Object.fromEntries(
    Object.entries(marketState.quoteMap || {})
      .filter(([, quote]) => quote?.source === 'INDmoney MCP')
      .map(([ticker, quote]) => [ticker, quote]),
  );
  async function getIndMoneyFundamentals(ticker, profile, researchSnapshot) {
    if (mcpUsDetails[ticker]) {
      return buildFundamentalSnapshotFromMcpUsDetails(ticker, mcpUsDetails[ticker]);
    }
    return null;
  }
  function chooseFundamentalSnapshot(researchSnapshot, indMoneyFundamentalSnapshot, profile = {}) {
    return researchSnapshot?.fundamentalSnapshot || indMoneyFundamentalSnapshot || null;
  }
  const scoredHoldings = [];
  for (const holding of portfolio.holdings) {
    const newsItems = [];
    const earnings = null;
    const researchSnapshot = sectorStocks[holding.ticker] || null;
    const indMoneyFundamentalSnapshot = await getIndMoneyFundamentals(holding.ticker, holding.profile, researchSnapshot);
    const score = scoreHolding(holding, holding.profile, marketState.benchmarkState, newsItems, portfolioContext, researchSnapshot);
    scoredHoldings.push({
      ...holding,
      newsItems,
      earnings,
      technicalSnapshot: researchSnapshot?.technicalSnapshot || null,
      fundamentalSnapshot: chooseFundamentalSnapshot(researchSnapshot, indMoneyFundamentalSnapshot, holding.profile),
      sectorContext: researchSnapshot?.sectorContext || null,
      shiftAlignment: researchSnapshot?.shiftAlignment || null,
      newsDigest: researchSnapshot?.newsDigest || null,
      researchQuality: researchSnapshot?.researchQuality || null,
      score,
    });
  }

  const scoredExternal = [];
  for (const ticker of config.watchlist.external) {
    const quote = marketState.quoteMap[ticker];
    if (!quote) {
      continue;
    }
    const profile = config.stockProfiles[ticker] || {};
    const displayQuote = chooseDisplayQuote(quote, sessionClock);
    const pseudoHolding = {
      ticker,
      name: profile.name || ticker,
      livePrice: toNumber(displayQuote.price),
      movePct: toNumber(displayQuote.movePct),
      totalPnlUsd: 0,
      portfolioWeightPct: 0,
    };
    const researchSnapshot = sectorStocks[ticker] || null;
    const indMoneyFundamentalSnapshot = await getIndMoneyFundamentals(ticker, profile, researchSnapshot);
    const score = scoreHolding(pseudoHolding, profile, marketState.benchmarkState, [], portfolioContext, researchSnapshot);
    scoredExternal.push({
      ...pseudoHolding,
      rotationTargetRank: profile.rotationTargetRank || null,
      technicalSnapshot: researchSnapshot?.technicalSnapshot || null,
      fundamentalSnapshot: chooseFundamentalSnapshot(researchSnapshot, indMoneyFundamentalSnapshot, profile),
      sectorContext: researchSnapshot?.sectorContext || null,
      shiftAlignment: researchSnapshot?.shiftAlignment || null,
      newsDigest: researchSnapshot?.newsDigest || null,
      researchQuality: researchSnapshot?.researchQuality || null,
      score,
    });
  }

  const scoresByTicker = {
    all: Object.fromEntries(scoredHoldings.map((holding) => [holding.ticker, holding])),
    externalTargets: scoredExternal,
  };

  return { scoredHoldings, scoredExternal, scoresByTicker };
}

function attachDecisionData(items, decisions) {
  const decisionMap = Object.fromEntries((decisions || []).map((item) => [item.ticker, item]));
  return items.map((item) => ({
    ...item,
    decisionReport: decisionMap[item.ticker] || null,
  }));
}

function collectCandidates(config, sessionClock, portfolio, scoredHoldings, scoredExternal, scoresByTicker, state, portfolioContext, decisionReport) {
  if (portfolio.dataQuality?.freshnessStatus === 'STALE_DATA') {
    return [{
      severity: 'L4',
      action: 'DATA_WARNING',
      ticker: null,
      title: 'Portfolio Snapshot Is Stale',
      triggerId: 'portfolio:stale-data',
      trigger: `Portfolio Updated At ${portfolio.dataQuality.sourceTimestamp || 'unknown'} is older than alert generation time.`,
      suggestedAction: 'Do not act on normal portfolio recommendations until a fresh export is loaded.',
      reason: 'The alert engine suppresses action recommendations when portfolio accounting data is stale.',
      portfolioImpact: 'Potential false signal risk from stale holdings and P&L data.',
      invalidation: 'Load a fresh portfolio export and rerun the alert engine.',
      confirmationMinutes: 0,
      immediate: true,
      threadId: 'portfolio:data-quality',
      worseningValue: portfolio.dataQuality.ageMinutes || 0,
      metadata: {
        dataQuality: portfolio.dataQuality,
      },
    }];
  }
  const candidates = [];
  candidates.push(...buildPortfolioRiskAlerts(portfolio, state, config));
  candidates.push(...buildDecisionAlerts(scoredHoldings, scoredExternal, decisionReport, config));
  for (const holding of scoredHoldings) {
    candidates.push(...buildEarningsAlerts(holding, holding.earnings, config));
  }
  candidates.push(
    ...buildRotationAlerts(
      {
        items: scoredHoldings,
        portfolioSummary: portfolio.summary,
      },
      scoresByTicker,
      config,
    ),
  );
  return candidates;
}

function shouldSendDailySummary(config, sessionClock, state, now) {
  if (state.dailySummary?.lastSentDayKey === sessionClock.marketDayKey) {
    return false;
  }
  if (!(sessionClock.bucket === 'POST_MARKET' || sessionClock.bucket === 'CLOSED')) {
    return false;
  }
  const [hour, minute] = config.dailySummaryTimeEt.split(':').map((part) => Number(part));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.marketTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const currentHour = Number(parts.find((item) => item.type === 'hour')?.value || 0);
  const currentMinute = Number(parts.find((item) => item.type === 'minute')?.value || 0);
  return currentHour > hour || (currentHour === hour && currentMinute >= minute);
}

export function createPortfolioAlertRuntime(options = {}) {
  const config = buildPortfolioAlertConfig(options.env || process.env);
  let timer = null;
  let running = false;
  let stopping = false;
  const status = {
    enabled: config.enabled,
    lastRunAt: null,
    lastError: null,
    lastSummary: null,
    lastDecisionReport: null,
    lastSession: null,
    lastPollingIntervalMs: null,
    nextScheduledRunAt: null,
  };

  async function runCycle(runOptions = {}) {
    if (running) {
      return { ok: false, skipped: true, reason: 'run already in progress' };
    }
    running = true;
    try {
      await ensureAlertStateFiles(config);
      const now = new Date();
      const sessionClock = getSessionClock(now, config.marketTimezone);
      const pollingIntervalMs = getUsPortfolioPollIntervalMs(sessionClock, config);
      status.lastSession = sessionClock.bucket;
      status.lastPollingIntervalMs = pollingIntervalMs;
      let state = resetDailyStateIfNeeded(await readAlertState(config), sessionClock.marketDayKey);

      const portfolioStore = runOptions.portfolioOverride || (await loadPortfolioSnapshot(config));
      const marketState = await gatherMarketState(config, sessionClock, portfolioStore);
      const portfolio = await buildLivePortfolio(config, sessionClock, portfolioStore, marketState);
      const sectorIntelligence = await loadSectorIntelligenceSnapshot(config);
      state = updateIntradayState(state, portfolio);

      const portfolioContext = buildPortfolioContext(portfolio, marketState, config);
      const { scoredHoldings: initialScoredHoldings, scoredExternal: initialScoredExternal, scoresByTicker: initialScoresByTicker } = await scorePortfolioAndWatchlist(
        config,
        portfolio,
        marketState,
        sessionClock,
        portfolioContext,
        sectorIntelligence,
      );
      const decisionReport = buildDecisionReport({
        portfolio,
        holdings: initialScoredHoldings,
        watchlist: initialScoredExternal,
        marketState,
        sectorIntelligence,
        portfolioContext,
        config,
      });
      const scoredHoldings = attachDecisionData(initialScoredHoldings, decisionReport.holdings);
      const scoredExternal = attachDecisionData(initialScoredExternal, decisionReport.watchlist);
      const scoresByTicker = {
        ...initialScoresByTicker,
        all: Object.fromEntries(scoredHoldings.map((holding) => [holding.ticker, holding])),
        externalTargets: scoredExternal,
        decisionReport,
      };
      const candidates = collectCandidates(config, sessionClock, portfolio, scoredHoldings, scoredExternal, scoresByTicker, state, portfolioContext, decisionReport);
      const { confirmed, nextState } = reconcileCandidates(candidates, state, sessionClock, config);
      state = nextState;

      const timestampIst = formatTimestampInZone(now, config.userTimezone);
      const delivered = [];
      for (const alert of confirmed) {
        const message = formatAlertMessage(alert, portfolioContext, timestampIst);
        const threadRef = getThreadRef(state, alert.threadId);
        const response = await sendWhatsappAlert(config, message, {
          threadId: config.whatsapp.threadReplies ? alert.threadId : null,
          quotedMessage: threadRef?.messageRef || null,
        });
        state = applyAlertDeliveryState(state, alert, sessionClock, config, response?.messageRef || null);
        if (alert.threadId && response?.messageRef) {
          state = setThreadRef(state, alert.threadId, {
            updatedAt: new Date().toISOString(),
            messageRef: response.messageRef,
          });
        }
        delivered.push(alert.triggerId);
        await appendAlertEvent(config, {
          type: 'alert',
          triggerId: alert.triggerId,
          severity: alert.severity,
          action: alert.action,
          ticker: alert.ticker,
          dryRun: config.dryRun,
        });
      }

      if (shouldSendDailySummary(config, sessionClock, state, now)) {
        const summary = formatDailySummary(portfolio, scoredHoldings, portfolioContext, timestampIst, decisionReport);
        const response = await sendWhatsappAlert(config, summary, {
          threadId: config.whatsapp.threadReplies ? 'summary:daily' : null,
          quotedMessage: getThreadRef(state, 'summary:daily')?.messageRef || null,
        });
        state = markDailySummarySent(state, sessionClock.marketDayKey);
        if (response?.messageRef) {
          state = setThreadRef(state, 'summary:daily', {
            updatedAt: new Date().toISOString(),
            messageRef: response.messageRef,
          });
        }
        await appendAlertEvent(config, {
          type: 'daily_summary',
          dryRun: config.dryRun,
        });
      }

      await writeAlertState(config, state);
      status.lastRunAt = new Date().toISOString();
      status.lastError = null;
      status.lastSummary = {
        deliveredCount: delivered.length,
        candidates: candidates.length,
        session: sessionClock.bucket,
        portfolioValueUsd: portfolio.summary.portfolioValueUsd,
        unrealizedProfitUsd: portfolio.summary.unrealizedProfitUsd,
        marketRegime: decisionReport.marketRegime,
        cashDecision: decisionReport.cash.decision,
      };
      status.lastDecisionReport = decisionReport;
      return {
        ok: true,
        deliveredCount: delivered.length,
        session: sessionClock.bucket,
        dryRun: config.dryRun,
        decisionReport,
      };
    } catch (error) {
      status.lastError = error.message;
      logger.error('Alert cycle failed', { error: error.message });
      return { ok: false, error: error.message };
    } finally {
      running = false;
    }
  }

  function scheduleNextRun(date = new Date()) {
    if (stopping || !config.enabled) {
      return;
    }
    const sessionClock = getSessionClock(date, config.marketTimezone);
    const nextIntervalMs = getUsPortfolioPollIntervalMs(sessionClock, config);
    status.lastSession = sessionClock.bucket;
    status.lastPollingIntervalMs = nextIntervalMs;
    status.nextScheduledRunAt = new Date(Date.now() + nextIntervalMs).toISOString();
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      timer = null;
      if (stopping || !config.enabled) {
        return;
      }
      try {
        await runCycle();
      } catch (error) {
        logger.error('Scheduled alert cycle failed', { error: error.message });
      }
      scheduleNextRun();
    }, nextIntervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function start() {
    if (!config.enabled) {
      logger.info('Portfolio alert runtime is disabled by config');
      return;
    }
    if (timer) {
      return;
    }
    stopping = false;
    runCycle().catch((error) => {
      logger.error('Initial alert cycle failed', { error: error.message });
    });
    scheduleNextRun();
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stopping = true;
    status.nextScheduledRunAt = null;
  }

  return {
    config,
    status,
    start,
    stop,
    runCycle,
    getStatus() {
      return {
        ...status,
        config: {
          enabled: config.enabled,
          dryRun: config.dryRun,
          recipientConfigured: Boolean(config.whatsapp.recipient),
          threadReplies: config.whatsapp.threadReplies,
        pollingIntervalMs: config.pollingIntervalMs,
        pollingIntervalMsPreMarket: config.pollingIntervalMsPreMarket,
        pollingIntervalMsRegular: config.pollingIntervalMsRegular,
        pollingIntervalMsPostMarket: config.pollingIntervalMsPostMarket,
        pollingIntervalMsClosed: config.pollingIntervalMsClosed,
        statePath: config.statePath,
        indmoneyMcpEnabled: Boolean(config.providers.indmoneyMcpEnabled),
        indmoneyMcpCacheSeconds: config.providers.indmoneyMcpCacheSeconds,
      },
      lastSession: status.lastSession,
      lastPollingIntervalMs: status.lastPollingIntervalMs,
      nextScheduledRunAt: status.nextScheduledRunAt,
    };
  },
  };
}
