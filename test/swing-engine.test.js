import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTechnicalProfile } from '../src/swing-trades/technical-indicators.js';
import { scoreSwingBundle } from '../src/swing-trades/swing-engine.js';

function makeCandles({ start = 100, step = 1, days = 260, volumeBase = 1000000, lastVolumeMultiplier = 1 } = {}) {
  return Array.from({ length: days }, (_, index) => {
    const close = start + step * index;
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    return {
      date,
      open: close - 0.8,
      high: close + 1.5,
      low: close - 1.5,
      close,
      volume: index === days - 1 ? volumeBase * lastVolumeMultiplier : volumeBase + index * 500,
    };
  });
}

test('technical profile computes swing indicators and relative strength', () => {
  const candles = makeCandles({ step: 1.2, lastVolumeMultiplier: 2 });
  const latest = candles.at(-1);
  const profile = buildTechnicalProfile(candles, {
    price: latest.close,
    previousClose: candles.at(-2).close,
  }, { SPY: 0.1, QQQ: 0.1, SMH: 0.1 });

  assert.equal(profile.maAlignment, 'bullish_stack');
  assert.ok(profile.rsi14 !== null);
  assert.ok(profile.volumeRatio > 1.5);
  assert.ok(profile.relativeStrengthVsQqq > 0);
});

test('strong setup with catalyst creates buy recommendation and respects aggressive risk caps', () => {
  const candles = makeCandles({ start: 80, step: 0.45, lastVolumeMultiplier: 1.8 });
  const latest = candles.at(-1);
  const result = scoreSwingBundle({
    symbol: 'NVDA',
    quote: { price: latest.close, previousClose: candles.at(-2).close, name: 'NVIDIA' },
    candles,
    news: [{ title: 'NVIDIA price target raised after major AI order' }],
    earnings: null,
    benchmarkMoves: { SPY: 0.2, QQQ: 0.25, SMH: 0.3 },
    candleSource: 'fixture',
    fetchedAt: '2026-06-06T00:00:00.000Z',
  }, {
    risk: { riskPerTradePct: 0.02, maxCapitalPct: 0.35, defaultEquityUsd: 10000 },
    portfolio: { equityUsd: 10000 },
  });

  assert.match(result.action, /BUY_/);
  assert.ok(result.position.notionalUsd <= 3500);
  assert.ok(result.position.maxRiskUsd <= 200);
});

test('near earnings blocks new buys even when technical score is strong', () => {
  const candles = makeCandles({ start: 80, step: 0.45, lastVolumeMultiplier: 1.8 });
  const latest = candles.at(-1);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const result = scoreSwingBundle({
    symbol: 'AVGO',
    quote: { price: latest.close, previousClose: candles.at(-2).close, name: 'Broadcom' },
    candles,
    news: [{ title: 'Broadcom raises AI outlook' }],
    earnings: { date: tomorrow },
    benchmarkMoves: { SPY: 0.2, QQQ: 0.25, SMH: 0.3 },
    candleSource: 'fixture',
    fetchedAt: '2026-06-06T00:00:00.000Z',
  }, {
    risk: { riskPerTradePct: 0.02, maxCapitalPct: 0.35, defaultEquityUsd: 10000 },
    portfolio: { equityUsd: 10000 },
  });

  assert.doesNotMatch(result.action, /^BUY/);
  assert.ok(result.hardBlocks.some((item) => item.includes('earnings')));
});

test('negative catalyst and breakdown create sell or avoid decision', () => {
  const candles = makeCandles({ start: 220, step: -0.8, lastVolumeMultiplier: 1.7 });
  const latest = candles.at(-1);
  const result = scoreSwingBundle({
    symbol: 'PLTR',
    quote: { price: latest.close, previousClose: candles.at(-2).close, name: 'Palantir' },
    candles,
    news: [{ title: 'Palantir downgraded after weak guidance and demand slowdown' }],
    earnings: null,
    benchmarkMoves: { SPY: 0.4, QQQ: 0.5, SMH: 0.3 },
    candleSource: 'fixture',
    fetchedAt: '2026-06-06T00:00:00.000Z',
  }, {
    risk: { riskPerTradePct: 0.02, maxCapitalPct: 0.35, defaultEquityUsd: 10000 },
    portfolio: { equityUsd: 10000 },
  });

  assert.match(result.action, /SELL_NEXT_SESSION|AVOID/);
  assert.equal(result.newsDigest.sentiment, 'bearish');
});
