import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNewsDigest,
  buildResearchQuality,
  buildSectorIntelligenceSnapshot,
  buildTechnicalSnapshot,
} from '../src/portfolio-alerts/sector-intelligence.js';

function makeTrend(start = 100, step = 2, days = 60) {
  return Array.from({ length: days }, (_, index) => {
    const close = start + step * index;
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    return {
      date,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100000 + index * 1000,
    };
  });
}

test('technical snapshot computes moving averages, RSI, relative strength, and range position', () => {
  const trend = makeTrend(100, 2, 260);
  const currentPrice = trend.at(-1).close;
  const previousClose = trend.at(-2).close;
  const snapshot = buildTechnicalSnapshot(
    {
      dailyTrend: trend,
      quote: { price: currentPrice, previousClose, pctChange: 1.18 },
      displayPrice: currentPrice,
      displayMovePct: 1.18,
    },
    { QQQ: 0.4, SMH: 0.7 },
  );

  assert.equal(snapshot.currentPrice, currentPrice);
  assert.ok(snapshot.ma20 !== null);
  assert.ok(snapshot.ma50 !== null);
  assert.ok(snapshot.rsi14 !== null);
  assert.equal(snapshot.maAlignment, 'bullish_stack');
  assert.ok(snapshot.relativeStrengthVsQqq > 0);
  assert.ok(snapshot.range20PositionPct >= 80);
});

test('news digest buckets sentiment and preserves latest headline', () => {
  const digest = buildNewsDigest([
    { title: 'Broadcom beats and raises on AI demand' },
    { title: 'Analyst upgrade after major AI deal' },
  ]);
  assert.equal(digest.sentiment, 'bullish');
  assert.equal(digest.latestHeadline, 'Broadcom beats and raises on AI demand');
  assert.ok(digest.positiveCount >= 1);
});

test('research quality flags partial coverage when fundamentals are missing', () => {
  const quality = buildResearchQuality({
    dailyTrend: makeTrend(50, 1, 10),
    news: [],
    fundamentals: {},
    earnings: null,
    quote: { price: 60 },
  });
  assert.equal(quality.isPartial, true);
  assert.equal(quality.coverage.fundamentals, false);
});

test('sector snapshot detects shift tags only when current state changes materially', () => {
  const prior = {
    sectorBreadth: { positivePercent: 38, avgMovePct: 0.1 },
    capexTakers: { avgMovePct: 0.2, breadthPercent: 45 },
    capexSpenders: { avgMovePct: 0.1, breadthPercent: 42 },
    leaders: [{ ticker: 'NVDA' }],
    laggards: [{ ticker: 'META' }],
    benchmarks: { QQQ: { movePct: 0.2 }, SMH: { movePct: 0.3 } },
  };
  const snapshot = buildSectorIntelligenceSnapshot({
    priorSnapshot: prior,
    items: [
      {
        ticker: 'NVDA',
        name: 'NVIDIA',
        profile: { thesisBucket: 'capex_taker', category: 'core', role: 'AI leader' },
        dailyTrend: makeTrend(100, 3, 80),
        quote: { price: 340, previousClose: 330, pctChange: 3.03 },
        displayPrice: 340,
        displayMovePct: 3.03,
        news: [{ title: 'NVIDIA beats and raises on AI demand' }],
        fundamentals: { revenueGrowthTTMYoy: 40, epsGrowthTTMYoy: 35, operatingMargin: 30, netMargin: 25 },
      },
      {
        ticker: 'AVGO',
        name: 'Broadcom',
        profile: { thesisBucket: 'capex_taker', category: 'quality', role: 'AI infra' },
        dailyTrend: makeTrend(150, 2, 80),
        quote: { price: 312, previousClose: 307, pctChange: 1.63 },
        displayPrice: 312,
        displayMovePct: 1.63,
        news: [{ title: 'Broadcom raises AI networking outlook' }],
        fundamentals: { revenueGrowthTTMYoy: 18, epsGrowthTTMYoy: 16, operatingMargin: 25, netMargin: 18 },
      },
      {
        ticker: 'META',
        name: 'Meta',
        profile: { thesisBucket: 'capex_spender', category: 'quality', role: 'AI spender' },
        dailyTrend: makeTrend(200, -1, 80),
        quote: { price: 122, previousClose: 126, pctChange: -3.17 },
        displayPrice: 122,
        displayMovePct: -3.17,
        news: [{ title: 'Meta price target cut on capex worries' }],
        fundamentals: { revenueGrowthTTMYoy: 10, epsGrowthTTMYoy: 8, operatingMargin: 12, netMargin: 8 },
      },
      {
        ticker: 'QQQ',
        name: 'QQQ',
        profile: { thesisBucket: 'benchmark', category: 'benchmark' },
        dailyTrend: makeTrend(100, 1, 80),
        quote: { price: 180, previousClose: 179, pctChange: 0.56 },
        displayPrice: 180,
        displayMovePct: 0.56,
      },
      {
        ticker: 'SMH',
        name: 'SMH',
        profile: { thesisBucket: 'benchmark', category: 'benchmark' },
        dailyTrend: makeTrend(100, 1, 80),
        quote: { price: 181, previousClose: 180, pctChange: 0.56 },
        displayPrice: 181,
        displayMovePct: 0.56,
      },
    ],
  });

  assert.ok(snapshot.shiftSignals.includes('AI_INFRA_LEADING'));
  assert.ok(snapshot.shiftSignals.includes('AI_SPENDERS_WEAKENING'));
  assert.ok(snapshot.stocks.find((stock) => stock.ticker === 'NVDA').shiftAlignment.scoreAdjustment > 0);
  assert.equal(
    buildSectorIntelligenceSnapshot({ items: snapshot.stocks.map((stock) => ({
      ticker: stock.ticker,
      name: stock.name,
      profile: { thesisBucket: stock.thesisBucket, category: stock.category, role: stock.role },
      displayPrice: stock.technicalSnapshot.currentPrice,
      displayMovePct: stock.technicalSnapshot.performance1D,
      dailyTrend: [],
      quote: { price: stock.technicalSnapshot.currentPrice, previousClose: null, pctChange: stock.technicalSnapshot.performance1D },
      news: stock.newsDigest.headlines,
      fundamentals: {},
    })) }).shiftSignals.length,
    0,
  );
});
