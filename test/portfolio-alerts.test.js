import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildPortfolioContext, mapScoreToAction, scoreHolding } from '../src/portfolio-alerts/scoring-engine.js';
import { buildLivePortfolio, buildPortfolioDataQuality, selectLatestPortfolioSnapshot } from '../src/portfolio-alerts/runtime.js';
import { createPortfolioAlertRuntime } from '../src/portfolio-alerts/runtime.js';
import { buildPortfolioRiskAlerts, buildRotationAlerts, buildTickerRuleAlerts, formatAlertMessage, formatDailySummary, reconcileCandidates } from '../src/portfolio-alerts/trigger-engine.js';
import { getUsPortfolioPollIntervalMs } from '../src/portfolio-alerts/runtime.js';

const config = {
  thresholds: {
    actionConfirmationMinutes: 15,
    watchConfirmationMinutes: 5,
    sameTriggerCooldownMinutes: 30,
    l1CooldownMinutes: 60,
    l2MaxPerSession: 2,
    dailyAlertCap: 12,
    rotationEnabled: true,
    targetInrNetProfit: 500000,
    taxRate: 0.3,
    preMarketEnabled: true,
    postMarketEnabled: true,
  },
  whatsapp: { threadReplies: true },
  dryRun: true,
};

const fixtureRaw = JSON.parse(fs.readFileSync(new URL('./fixtures/us-portfolio-2026-06-04.json', import.meta.url), 'utf8'));

test('score mapping follows configured action bands', () => {
  assert.equal(mapScoreToAction(8), 'STRONG_HOLD');
  assert.equal(mapScoreToAction(5), 'HOLD');
  assert.equal(mapScoreToAction(2), 'WATCH');
  assert.equal(mapScoreToAction(-1), 'THINK');
  assert.equal(mapScoreToAction(-4), 'TRIM');
  assert.equal(mapScoreToAction(-8), 'EXIT_CANDIDATE');
});

test('portfolio giveback trigger escalates correctly', () => {
  const portfolio = { summary: { unrealizedProfitUsd: 510 } };
  const state = { intraday: { highestUnrealizedProfitUsd: 760 } };
  const alerts = buildPortfolioRiskAlerts(portfolio, state, config);
  assert.equal(alerts[0].severity, 'L3');
  assert.match(alerts[0].trigger, /Gave back/);
});

test('MU profit protection trigger appears below protection band', () => {
  const alerts = buildTickerRuleAlerts(
    { ticker: 'MU', livePrice: 1022, totalPnlUsd: 560, movePct: -1, dataStale: false },
    { category: 'profit_engine', support: { holdAbove: 1025, trimBelow: 1018 } },
    { finalScore: -1 },
    { bucket: 'REGULAR_MARKET' },
    { targetProgress: 30, afterTaxProfitInr: 200000 },
    config,
  );
  assert(alerts.some((item) => item.title === 'MU Profit Protection'));
});

test('GOOGL breakdown trigger appears below 360', () => {
  const alerts = buildTickerRuleAlerts(
    { ticker: 'GOOGL', livePrice: 359, totalPnlUsd: -120, movePct: -2, dataStale: false },
    { category: 'laggard', support: { holdAbove: 365 } },
    { finalScore: -4 },
    { bucket: 'REGULAR_MARKET' },
    { targetProgress: 20, afterTaxProfitInr: 100000 },
    config,
  );
  assert(alerts.some((item) => item.triggerId === 'GOOGL:below-360'));
});

test('PLTR below 150 exit logic triggers', () => {
  const alerts = buildTickerRuleAlerts(
    { ticker: 'PLTR', livePrice: 149.5, totalPnlUsd: -10, movePct: -1.5, dataStale: false },
    { category: 'speculative', support: { holdAbove: 150, hardExitBelow: 149 } },
    { finalScore: -6 },
    { bucket: 'REGULAR_MARKET' },
    { targetProgress: 25, afterTaxProfitInr: 100000 },
    config,
  );
  assert(alerts.some((item) => item.triggerId === 'PLTR:below-150'));
});

test('rotation engine prefers weak PLTR into strong AVGO', () => {
  const alerts = buildRotationAlerts(
    {
      items: [
        { ticker: 'PLTR', rotationSourceRank: 1, livePrice: 149 },
        { ticker: 'AMZN', rotationSourceRank: 2, livePrice: 253 },
      ],
      portfolioSummary: { buyingPowerUsd: 0 },
    },
    {
      all: {
        PLTR: {
          ticker: 'PLTR',
          score: { finalScore: -5 },
          shiftAlignment: { scoreAdjustment: -1 },
          sectorContext: { summary: 'Software cohort weak.' },
          technicalSnapshot: { summary: 'Below support and lagging.' },
          fundamentalSnapshot: { summary: 'Speculative quality.' },
          newsDigest: { latestHeadline: 'Palantir downgrade on valuation concerns' },
        },
        AMZN: { ticker: 'AMZN', score: { finalScore: -2 } },
      },
      externalTargets: [
        {
          ticker: 'AVGO',
          rotationTargetRank: 2,
          score: { finalScore: 4 },
          shiftAlignment: { scoreAdjustment: 2 },
          sectorContext: { summary: 'AI infra breadth improving.' },
          technicalSnapshot: { summary: 'Bullish stack with positive relative strength.' },
          fundamentalSnapshot: { summary: 'High quality margins and growth.' },
          newsDigest: { latestHeadline: 'Broadcom raises AI networking outlook' },
        },
      ],
    },
    config,
  );
  assert.equal(alerts[0].metadata.targetTicker, 'AVGO');
});

test('rotation requires sector alignment and does not fire without it', () => {
  const alerts = buildRotationAlerts(
    {
      items: [
        { ticker: 'PLTR', rotationSourceRank: 1, livePrice: 149 },
      ],
      portfolioSummary: { buyingPowerUsd: 0 },
    },
    {
      all: {
        PLTR: { ticker: 'PLTR', score: { finalScore: -5 }, shiftAlignment: { scoreAdjustment: 0 } },
      },
      externalTargets: [
        { ticker: 'AVGO', rotationTargetRank: 2, score: { finalScore: 4 }, shiftAlignment: { scoreAdjustment: 0 } },
      ],
    },
    config,
  );
  assert.equal(alerts.length, 0);
});

test('cooldown dedupe suppresses repeated same trigger', () => {
  const candidate = {
    severity: 'L2',
    action: 'THINK',
    ticker: 'MU',
    triggerId: 'MU:profit:600',
    trigger: 'test',
    suggestedAction: 'test',
    reason: 'test',
    invalidation: 'test',
    confirmationMinutes: 0,
    immediate: true,
    threadId: 'ticker:MU',
    worseningValue: 1,
  };
  const state = {
    currentDayKey: '2026-06-02',
    cooldowns: {
      'MU:profit:600': { expiresAt: Date.now() + 10 * 60 * 1000 },
    },
    openTriggers: {},
    lastAlertByKey: {},
    tickerSessionCounts: {},
  };
  const result = reconcileCandidates([candidate], state, { bucket: 'REGULAR_MARKET', marketDayKey: '2026-06-02', allowWatchThink: true, allowActionAlerts: true }, config);
  assert.equal(result.confirmed.length, 0);
});

test('no buying power rule is preserved in rotation copy', () => {
  const alerts = buildRotationAlerts(
    {
      items: [{ ticker: 'PLTR', rotationSourceRank: 1, livePrice: 149 }],
      portfolioSummary: { buyingPowerUsd: 0 },
    },
    {
      all: {
        PLTR: {
          ticker: 'PLTR',
          score: { finalScore: -5 },
          shiftAlignment: { scoreAdjustment: -1 },
          sectorContext: { summary: 'Source remains weak vs peers.' },
          technicalSnapshot: { summary: 'Below support and lagging.' },
          fundamentalSnapshot: { summary: 'Speculative quality.' },
          newsDigest: { latestHeadline: 'Palantir downgraded on valuation concerns' },
        },
      },
      externalTargets: [{
        ticker: 'AVGO',
        rotationTargetRank: 2,
        score: { finalScore: 4 },
        shiftAlignment: { scoreAdjustment: 2 },
        sectorContext: { summary: 'AI infra strength is broadening.' },
        technicalSnapshot: { summary: 'Bullish stack with positive relative strength.' },
        fundamentalSnapshot: { summary: 'High quality margins and growth.' },
        newsDigest: { latestHeadline: 'Broadcom raises AI networking outlook' },
      }],
    },
    { ...config, thresholds: { ...config.thresholds, buyPowerFloorUsd: 25 } },
  );
  assert.match(alerts[0].suggestedAction, /rotate proceeds/);
});

test('opening range suppresses non critical alerts', () => {
  const candidate = {
    severity: 'L3',
    action: 'TRIM',
    ticker: 'PLTR',
    triggerId: 'PLTR:below-150',
    trigger: 'test',
    suggestedAction: 'test',
    reason: 'test',
    invalidation: 'test',
    confirmationMinutes: 0,
    immediate: true,
    threadId: 'ticker:PLTR',
    worseningValue: 1,
  };
  const result = reconcileCandidates([candidate], { currentDayKey: '2026-06-02', cooldowns: {}, openTriggers: {}, lastAlertByKey: {}, tickerSessionCounts: {} }, { bucket: 'OPENING_RANGE', marketDayKey: '2026-06-02', allowWatchThink: false, allowActionAlerts: false }, config);
  assert.equal(result.confirmed.length, 0);
});

test('stale data emits data warning', () => {
  const alerts = buildTickerRuleAlerts(
    { ticker: 'NVDA', livePrice: 222, totalPnlUsd: 0, movePct: 0, dataStale: true },
    { category: 'core', support: { holdAbove: 223, trimBelow: 220 } },
    { finalScore: 1 },
    { bucket: 'REGULAR_MARKET' },
    { targetProgress: 10, afterTaxProfitInr: 30000 },
    config,
  );
  assert.equal(alerts[0].action, 'DATA_WARNING');
});

test('portfolio snapshot loader selects latest export by Updated At timestamp', () => {
  const latest = selectLatestPortfolioSnapshot(fixtureRaw);
  assert.equal(latest.updatedAt, '2026-06-04 08:45:15 IST');
  assert.equal(latest.holdings.length, 8);
});

test('runtime poll interval maps per-session configuration', () => {
  const config = {
    pollingIntervalMsPreMarket: 35_000,
    pollingIntervalMsRegular: 45_000,
    pollingIntervalMsPostMarket: 55_000,
    pollingIntervalMsClosed: 600_000,
  };
  assert.equal(getUsPortfolioPollIntervalMs({ bucket: 'PRE_MARKET' }, config), 35_000);
  assert.equal(getUsPortfolioPollIntervalMs({ bucket: 'OPENING_RANGE' }, config), 45_000);
  assert.equal(getUsPortfolioPollIntervalMs({ bucket: 'REGULAR_MARKET' }, config), 45_000);
  assert.equal(getUsPortfolioPollIntervalMs({ bucket: 'POWER_HOUR' }, config), 45_000);
  assert.equal(getUsPortfolioPollIntervalMs({ bucket: 'POST_MARKET' }, config), 55_000);
  assert.equal(getUsPortfolioPollIntervalMs({ bucket: 'CLOSED' }, config), 600_000);
});

test('runtime status exposes effective poll metadata fields', () => {
  const runtime = createPortfolioAlertRuntime({
    env: {
      PORTFOLIO_ALERTS_ENABLED: 'true',
      PORTFOLIO_ALERTS_DRY_RUN: 'true',
      PORTFOLIO_ALERTS_POLL_SECONDS: '75',
      PORTFOLIO_ALERTS_POLL_SECONDS_PRE_MARKET: '20',
      PORTFOLIO_ALERTS_POLL_SECONDS_REGULAR: '30',
      PORTFOLIO_ALERTS_POLL_SECONDS_POST_MARKET: '40',
      PORTFOLIO_ALERTS_POLL_SECONDS_CLOSED: '600',
      PORTFOLIO_ALERT_USER_TIMEZONE: 'Asia/Kolkata',
      PORTFOLIO_ALERT_DAILY_SUMMARY_ET: '17:15',
    },
  });
  const status = runtime.getStatus();
  assert.equal(status.config.pollingIntervalMsPreMarket, 20_000);
  assert.equal(status.config.pollingIntervalMsRegular, 30_000);
  assert.equal(status.config.pollingIntervalMsPostMarket, 40_000);
  assert.equal(status.config.pollingIntervalMsClosed, 600_000);
  assert.equal(status.lastSession, null);
  assert.equal(status.lastPollingIntervalMs, null);
  assert.equal(status.nextScheduledRunAt, null);
});

test('portfolio calculations are recomputed from latest raw holdings fixture', async () => {
  const latest = selectLatestPortfolioSnapshot(fixtureRaw);
  const portfolio = await buildLivePortfolio(
    {
      ...config,
      userTimezone: 'Asia/Kolkata',
      thresholds: {
        ...config.thresholds,
        portfolioSnapshotFreshnessMinutes: 360,
        portfolioReconciliationToleranceUsd: 2,
      },
      stockProfiles: {},
    },
    { isRegular: true },
    latest,
    { quoteMap: {} },
  );

  assert.equal(portfolio.summary.portfolioValueUsd, 12011.04);
  assert.equal(portfolio.summary.investedValueUsd, 11454.07);
  assert.equal(portfolio.summary.unrealizedProfitUsd, 556.97);
  assert.equal(portfolio.summary.oneDayPnlUsd, -160.85);
  assert.equal(portfolio.dataQuality.reconciliationPassed, true);
  assert.equal(portfolio.dataQuality.top3ConcentrationPct, 71.51);

  const byTicker = Object.fromEntries(portfolio.holdings.map((holding) => [holding.ticker, holding]));
  assert.equal(byTicker.NVDA.portfolioWeightPct, 29.31);
  assert.equal(byTicker.MU.profitContributionPct, 133.55);

  const winners = [...portfolio.holdings]
    .sort((a, b) => b.totalActualReturnUsd - a.totalActualReturnUsd)
    .slice(0, 4)
    .map((holding) => [holding.ticker, holding.totalActualReturnUsd]);
  assert.deepEqual(winners, [
    ['MU', 743.83],
    ['AVGO', 105.18],
    ['TSM', 40.68],
    ['AMD', 34.69],
  ]);

  const drags = [...portfolio.holdings]
    .sort((a, b) => a.totalActualReturnUsd - b.totalActualReturnUsd)
    .slice(0, 3)
    .map((holding) => [holding.ticker, holding.totalActualReturnUsd]);
  assert.deepEqual(drags, [
    ['GOOGL', -210.32],
    ['NVDA', -89.58],
    ['AMZN', -62.44],
  ]);
});

test('1D P&L does not mix stale export holdings with live quote previous-close math', async () => {
  const portfolio = await buildLivePortfolio(
    {
      ...config,
      userTimezone: 'Asia/Kolkata',
      thresholds: {
        ...config.thresholds,
        portfolioSnapshotFreshnessMinutes: 360,
        portfolioReconciliationToleranceUsd: 2,
      },
      stockProfiles: {},
    },
    { isRegular: true },
    {
      updatedAt: '2026-06-04 08:45:15 IST',
      summary: {
        portfolioValue: 120,
        investedValue: 100,
        totalReturns: 20,
        oneDayReturn: -169,
      },
      holdings: [
        { ticker: 'AAA', quantity: 10, lastPrice: 12, invested: 100, currentValue: 120, totalReturn: 20 },
      ],
    },
    {
      quoteMap: {
        AAA: {
          price: 9,
          previousClose: 20,
          pctChange: -55,
          timestamp: null,
        },
      },
    },
  );

  assert.equal(portfolio.summary.oneDayPnlUsd, -169);
  assert.equal(portfolio.summary.oneDayPnlSource, 'portfolio_summary_fallback');
  assert.deepEqual(portfolio.dataQuality.warnings, ['WARNING_1D_PNL_HOLDINGS_MISSING']);
});

test('snapshot freshness validation marks old portfolio data stale', () => {
  const latest = selectLatestPortfolioSnapshot(fixtureRaw);
  const quality = buildPortfolioDataQuality(
    latest,
    { portfolioValueUsd: 12011.04, unrealizedProfitUsd: 556.97 },
    [],
    {
      userTimezone: 'Asia/Kolkata',
      thresholds: {
        portfolioSnapshotFreshnessMinutes: 60,
        portfolioReconciliationToleranceUsd: 2,
      },
    },
    new Date('2026-06-04T05:30:15.000Z'),
  );
  assert.equal(quality.sourceTimestamp, '2026-06-04 08:45:15 IST');
  assert.equal(quality.alertGenerationTimestamp, '2026-06-04 11:00:15 IST');
  assert.equal(quality.freshnessStatus, 'STALE_DATA');
});

test('daily summary prints recalculated values and data quality status', async () => {
  const latest = selectLatestPortfolioSnapshot(fixtureRaw);
  const portfolio = await buildLivePortfolio(
    {
      ...config,
      userTimezone: 'Asia/Kolkata',
      thresholds: {
        ...config.thresholds,
        portfolioSnapshotFreshnessMinutes: 5000,
        portfolioReconciliationToleranceUsd: 2,
      },
      stockProfiles: {},
    },
    { isRegular: true },
    latest,
    { quoteMap: {} },
  );
  portfolio.dataQuality.alertGenerationTimestamp = '2026-06-04 08:50:00 IST';
  portfolio.dataQuality.freshnessStatus = 'FRESH';
  const text = formatDailySummary(
    portfolio,
    portfolio.holdings,
    { targetProgress: 10, afterTaxProfitInr: 30000, dataQuality: portfolio.dataQuality },
    '2026-06-04 08:50:00 IST',
  );

  assert.match(text, /Portfolio value: \$12011\.04/);
  assert.match(text, /Invested value: \$11454\.07/);
  assert.match(text, /Total P&L: \$556\.97/);
  assert.match(text, /Day P&L: \$-160\.85/);
  assert.match(text, /Data source timestamp: 2026-06-04 08:45:15 IST/);
  assert.match(text, /Alert generation timestamp: 2026-06-04 08:50:00 IST/);
  assert.match(text, /Data freshness status: FRESH/);
  assert.match(text, /Reconciliation checks: PASSED/);
  assert.match(text, /1\. MU \$743\.83/);
  assert.match(text, /2\. AVGO \$105\.18/);
  assert.match(text, /3\. TSM \$40\.68/);
  assert.match(text, /4\. AMD \$34\.69/);
  assert.match(text, /1\. GOOGL \$-210\.32/);
});

test('message formatting includes user confirmation guardrail', () => {
  const portfolioContext = { targetProgress: 44.2, afterTaxProfitInr: 215000 };
  const text = formatAlertMessage(
    {
      severity: 'L3',
      action: 'EXIT',
      ticker: 'PLTR',
      title: 'Exit Candidate',
      trigger: 'Broke support',
      suggestedAction: 'Exit 50%-100%',
      reason: 'Speculative and weak',
      portfolioImpact: 'Small but weak',
      invalidation: 'Reclaim support',
      price: 149.8,
      metadata: {
        sectorContext: 'AI software peers are mixed while this stock lags.',
        technicalContext: 'Bearish stack, RSI 31, breakdown pressure.',
        fundamentalContext: 'Fundamentals fragile.',
        latestHeadline: 'Palantir downgraded on valuation concerns',
      },
    },
    portfolioContext,
    '2026-06-02 20:45 IST',
  );
  assert.match(text, /User confirmation required/);
  assert.match(text, /Sector context:/);
  assert.match(text, /Technical context:/);
  assert.match(text, /Fundamental context:/);
  assert.match(text, /Latest headline:/);
});

test('scoring combines components into a bearish trim result', () => {
  const context = buildPortfolioContext(
    { summary: { unrealizedProfitUsd: 480 } },
    { usdInrRate: 86, capexFear: true },
    {
      thresholds: { targetInrNetProfit: 500000, taxRate: 0.3 },
    },
  );
  const score = scoreHolding(
    { livePrice: 149, movePct: -2.1, totalPnlUsd: -10, portfolioWeightPct: 2 },
    { category: 'speculative', support: { holdAbove: 150 }, thesisBucket: 'software_spec', riskPenalty: -1 },
    { qqqMovePct: 0.5, smhMovePct: 0.6 },
    [{ title: 'Palantir downgrade on valuation' }],
    context,
  );
  assert.equal(score.action, 'EXIT_CANDIDATE');
});
