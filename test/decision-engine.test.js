import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDecisionReport, scoreAiThesis } from '../src/portfolio-alerts/decision-engine.js';
import { calculateDynamicLevels } from '../src/portfolio-alerts/dynamic-levels.js';
import { buildRotationAlerts } from '../src/portfolio-alerts/trigger-engine.js';

const config = {
  thresholds: {
    targetInrNetProfit: 500000,
    taxRate: 0.3,
    usdInrRate: 86,
    buyPowerFloorUsd: 25,
    targetHorizonDays: 60,
    maxDailyDeploymentPct: 0.25,
    opportunityRiskOffThreshold: 85,
    opportunityNeutralThreshold: 75,
    opportunityRiskOnThreshold: 65,
    cashReserveRiskOffPct: 0.5,
    cashReserveNeutralPct: 0.3,
    cashReserveRiskOnPct: 0.2,
    rotationEnabled: true,
    actionConfirmationMinutes: 15,
  },
};

function makeEntity(overrides = {}) {
  return {
    ticker: 'NVDA',
    livePrice: 120,
    movePct: 2.1,
    portfolioWeightPct: 10,
    currentValueUsd: 1000,
    totalPnlUsd: 100,
    profile: { aiCategory: 'ai_compute_leader', role: 'Core AI leader', riskPenalty: 0 },
    quote: { previousClose: 117, dayRange: '$116.00 - $122.00' },
    technicalSnapshot: {
      support: 116,
      resistance: 123,
      range20Low: 110,
      range20High: 125,
      ma20: 115,
      ma50: 108,
      ma200: 90,
      maAlignment: 'bullish_stack',
      relativeStrengthVsQqq: 1.2,
      relativeStrengthVsSmh: 0.8,
      breakout: false,
      breakdown: false,
      summary: 'bullish stack',
    },
    fundamentalSnapshot: {
      qualityScore: 3,
      revenueGrowthYoY: 30,
      epsGrowthYoY: 25,
      operatingMargin: 35,
      netMargin: 25,
      pe: 34,
      summary: 'fundamentals supportive',
    },
    newsDigest: { sentiment: 'bullish', averageScore: 1, tags: ['beat_raise'], latestHeadline: 'AI demand strong' },
    ...overrides,
  };
}

function makePortfolio(holding = makeEntity(), buyingPowerUsd = 1000) {
  return {
    holdings: [holding],
    summary: {
      portfolioValueUsd: 5000,
      unrealizedProfitUsd: 500,
      buyingPowerUsd,
    },
  };
}

test('AI thesis scoring rewards real AI leaders and caps unsupported AI exposure cautiously', () => {
  const strong = scoreAiThesis(makeEntity());
  const cautious = scoreAiThesis(makeEntity({
    ticker: 'CRWV',
    profile: { aiCategory: 'speculative_ai_cloud_compute', riskPenalty: -1 },
    fundamentalSnapshot: { qualityScore: 0, pe: null, summary: 'fundamentals incomplete' },
  }));

  assert.ok(strong.total > cautious.total);
  assert.ok(strong.components.aiRelevance >= 18);
  assert.ok(cautious.total <= 82);
});

test('dynamic levels are calculated from quote and technical context without static profile support', () => {
  const levels = calculateDynamicLevels(makeEntity({ profile: { aiCategory: 'ai_compute_leader' } }));

  assert.equal(levels.basis, 'dynamic_best_available');
  assert.equal(levels.support, 117);
  assert.ok(levels.trimLevel < 120);
  assert.ok(levels.addReclaimLevel > 120);
  assert.ok(levels.reasoning.includes('support'));
});

test('cash deployment blocks adds in risk-off and allows gradual deployment in risk-on', () => {
  const holding = makeEntity();
  const riskOff = buildDecisionReport({
    portfolio: makePortfolio(holding, 1000),
    holdings: [holding],
    watchlist: [makeEntity({ ticker: 'AVGO', portfolioWeightPct: 0 })],
    marketState: { benchmarkState: { qqqMovePct: -1.2, smhMovePct: -1.5 }, usdInrRate: 86, capexFear: true },
    sectorIntelligence: { sectorBreadth: { positivePercent: 20 } },
    portfolioContext: { protectionMode: false },
    config,
  });
  const riskOn = buildDecisionReport({
    portfolio: makePortfolio(holding, 1000),
    holdings: [holding],
    watchlist: [makeEntity({ ticker: 'AVGO', portfolioWeightPct: 0 })],
    marketState: { benchmarkState: { qqqMovePct: 1.1, smhMovePct: 1.4 }, usdInrRate: 86, capexFear: false },
    sectorIntelligence: { sectorBreadth: { positivePercent: 70 } },
    portfolioContext: { protectionMode: false },
    config,
  });

  assert.equal(riskOff.marketRegime, 'risk_off');
  assert.equal(riskOff.cash.decision, 'DEPLOY_0');
  assert.equal(riskOn.marketRegime, 'risk_on');
  assert.notEqual(riskOn.cash.decision, 'DEPLOY_0');
});

test('exit pressure rises for weak price action and damaged thesis', () => {
  const weak = makeEntity({
    ticker: 'PLTR',
    livePrice: 95,
    movePct: -3,
    portfolioWeightPct: 12,
    totalPnlUsd: -200,
    profile: { aiCategory: 'ai_software_enterprise', riskPenalty: -1 },
    quote: { previousClose: 100, dayRange: '$94.00 - $101.00' },
    technicalSnapshot: {
      support: 98,
      resistance: 106,
      maAlignment: 'bearish_stack',
      relativeStrengthVsQqq: -2,
      relativeStrengthVsSmh: -2,
      breakdown: true,
      summary: 'bearish breakdown',
    },
    fundamentalSnapshot: { qualityScore: -1, pe: 90, summary: 'fundamentals fragile' },
    newsDigest: { sentiment: 'bearish', averageScore: -2, tags: ['downgrade'], latestHeadline: 'valuation downgrade' },
  });
  const report = buildDecisionReport({
    portfolio: makePortfolio(weak, 100),
    holdings: [weak],
    watchlist: [],
    marketState: { benchmarkState: { qqqMovePct: 0, smhMovePct: 0 }, usdInrRate: 86 },
    sectorIntelligence: { sectorBreadth: { positivePercent: 45 } },
    portfolioContext: { protectionMode: true },
    config,
  });

  assert.ok(report.holdings[0].exitPressureScore >= 66);
  assert.match(report.holdings[0].decision, /TRIM|EXIT/);
});

test('decision-aware rotation requires weak source, strong target, and preserved thresholds', () => {
  const alerts = buildRotationAlerts(
    {
      items: [{ ticker: 'PLTR', rotationSourceRank: 1, livePrice: 95 }],
      portfolioSummary: { buyingPowerUsd: 0 },
    },
    {
      decisionReport: { marketRegime: 'neutral', thresholds: { neutral: 75 } },
      all: {
        PLTR: {
          ticker: 'PLTR',
          score: { finalScore: -5 },
          decisionReport: { exitPressureScore: 78 },
          shiftAlignment: { scoreAdjustment: -1 },
        },
      },
      externalTargets: [{
        ticker: 'AVGO',
        rotationTargetRank: 1,
        score: { finalScore: 5 },
        decisionReport: { opportunityScore: 92 },
        shiftAlignment: { scoreAdjustment: 2 },
      }],
    },
    config,
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].action, 'ROTATE');
});
