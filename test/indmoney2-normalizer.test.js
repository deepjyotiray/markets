import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  appendLivePortfolioSnapshot,
  buildMinuteRepricedSeries,
  canonicalizeHoldings,
  computeEffectiveRate,
  fillSessionMinuteGaps,
  normalizeFreshAccountHoldings,
  primeIndMoney2HoldingsCache,
  resolveIndMoney2HoldingsCachePath,
  resolveInvestedUsd,
  sliceDailySessionEndRows,
  sliceCurrentMarketDayRows,
  sliceCurrentMarketWeekRows,
  sliceHourlySnapshotRows,
  sliceLatestContinuousSessionRows,
  sliceLatestSessionRows,
  sliceLatestTradingSessionRows,
  sliceRecentCalendarRows,
} from '../src/portfolio-alerts/indmoney2-normalizer.js';

test('computeEffectiveRate derives INR per USD using manual invested amount', () => {
  assert.equal(computeEffectiveRate(305000, 3500), 87.142857);
  assert.equal(computeEffectiveRate(null, 3500), null);
  assert.equal(computeEffectiveRate(305000, 0), null);
});

test('resolveInvestedUsd prefers manual per-holding override over FX normalization', () => {
  const warnings = [];
  const investedUsd = resolveInvestedUsd(
    { ticker: 'NVDA', invested: 120000, currency: 'INR' },
    {
      effectiveUsdInrRate: 87.5,
      manualHoldingInvestedUsd: { NVDA: 3612.24 },
    },
    warnings,
  );
  assert.equal(investedUsd, 3612.24);
  assert.deepEqual(warnings, []);
});

test('canonicalizeHoldings produces USD-only holdings using current quotes', () => {
  const warnings = [];
  const holdings = canonicalizeHoldings(
    [
      {
        ticker: 'MU',
        name: 'Micron Technology',
        units: 10,
        invested: 17500,
        currency: 'INR',
      },
    ],
    {
      MU: {
        currentPriceUsd: 140,
        previousCloseUsd: 136,
        priceSession: 'regular',
        priceSource: 'Yahoo Finance',
        updatedAt: '2026-06-11T10:00:00.000Z',
      },
    },
    {
      effectiveUsdInrRate: 87.5,
      manualHoldingInvestedUsd: {},
    },
    warnings,
  );

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].investedUsd, 200);
  assert.equal(holdings[0].avgPriceUsd, 20);
  assert.equal(holdings[0].currentHoldingValueUsd, 1400);
  assert.equal(holdings[0].oneDayPnlUsd, 40);
  assert.equal(holdings[0].actualPnlUsd, 1200);
  assert.deepEqual(warnings, []);
});

test('canonicalizeHoldings keeps MCP current value when no live quote is available', () => {
  const warnings = [];
  const holdings = canonicalizeHoldings(
    [
      {
        ticker: 'PGF',
        name: 'Private Growth Fund',
        units: 3,
        invested: 17500,
        currentValue: 21000,
        currency: 'INR',
      },
    ],
    {},
    {
      effectiveUsdInrRate: 87.5,
      manualHoldingInvestedUsd: {},
    },
    warnings,
  );

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].ticker, 'PGF');
  assert.equal(holdings[0].investedUsd, 200);
  assert.equal(holdings[0].currentHoldingValueUsd, 240);
  assert.equal(holdings[0].actualPnlUsd, 40);
  assert.equal(holdings[0].updatedAt, null);
});

test('canonicalizeHoldings aggregates duplicate ticker rows into one canonical USD row', () => {
  const warnings = [];
  const holdings = canonicalizeHoldings(
    [
      {
        ticker: 'NVDA',
        name: 'NVIDIA',
        units: 2,
        invested: 1000,
        currency: 'USD',
      },
      {
        ticker: 'NVDA',
        name: 'NVIDIA Corp',
        units: 3,
        invested: 1500,
        currency: 'USD',
      },
    ],
    {
      NVDA: {
        currentPriceUsd: 600,
        previousCloseUsd: 590,
        priceSession: 'regular',
        priceSource: 'Yahoo Finance',
        updatedAt: '2026-06-11T10:00:00.000Z',
      },
    },
    {
      effectiveUsdInrRate: 87.5,
      manualHoldingInvestedUsd: {},
    },
    warnings,
  );

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].ticker, 'NVDA');
  assert.equal(holdings[0].name, 'NVIDIA');
  assert.equal(holdings[0].quantity, 5);
  assert.equal(holdings[0].investedUsd, 2500);
  assert.equal(holdings[0].avgPriceUsd, 500);
  assert.equal(holdings[0].currentHoldingValueUsd, 3000);
  assert.equal(holdings[0].oneDayPnlUsd, 50);
  assert.equal(holdings[0].actualPnlUsd, 500);
  assert.deepEqual(warnings, []);
});

test('canonicalizeHoldings preserves a source updatedAt from imported holdings when live quotes do not provide one', () => {
  const warnings = [];
  const holdings = canonicalizeHoldings(
    [
      {
        ticker: 'MSFT',
        name: 'Microsoft',
        units: 2,
        invested: 800,
        currency: 'USD',
        updatedAt: '2026-06-11T10:00:00.000Z',
      },
    ],
    {
      MSFT: {
        currentPriceUsd: 420,
        previousCloseUsd: 415,
        priceSession: 'regular',
        priceSource: 'Yahoo Finance',
        updatedAt: null,
      },
    },
    {
      effectiveUsdInrRate: 87.5,
      manualHoldingInvestedUsd: {},
    },
    warnings,
  );

  assert.equal(holdings[0].updatedAt, '2026-06-11T10:00:00.000Z');
});

test('normalizeFreshAccountHoldings keeps total return neutral for fresh accounts', () => {
  const holdings = normalizeFreshAccountHoldings([
    {
      ticker: 'NVDA',
      quantity: 2,
      currentPriceUsd: 150,
      currentHoldingValueUsd: 300,
      investedUsd: 2500,
      actualPnlUsd: -2200,
      actualPnlPct: -88,
    },
  ]);

  assert.equal(holdings[0].investedUsd, 300);
  assert.equal(holdings[0].avgPriceUsd, 150);
  assert.equal(holdings[0].actualPnlUsd, 0);
  assert.equal(holdings[0].actualPnlPct, 0);
});

test('buildMinuteRepricedSeries aggregates all holdings at minute granularity', () => {
  const warnings = [];
  const rows = buildMinuteRepricedSeries(
    [
      { ticker: 'AAPL', quantity: 2 },
      { ticker: 'MSFT', quantity: 1.5 },
    ],
    {
      AAPL: [
        { time: '2026-06-05 09:30', close: 200 },
        { time: '2026-06-05 09:31', close: 201 },
      ],
      MSFT: [
        { time: '2026-06-05 09:30', close: 400 },
        { time: '2026-06-05 09:31', close: 402 },
      ],
    },
    warnings,
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].time, '2026-06-05 09:30');
  assert.equal(rows[0].portfolioValueUsd, 1000);
  assert.equal(rows[1].portfolioValueUsd, 1005);
  assert.deepEqual(warnings, []);
});

test('buildMinuteRepricedSeries carries latest prices forward so each point represents the whole portfolio', () => {
  const warnings = [];
  const rows = buildMinuteRepricedSeries(
    [
      { ticker: 'AAPL', quantity: 2 },
      { ticker: 'MSFT', quantity: 1 },
    ],
    {
      AAPL: [
        { time: '2026-06-05 09:30', timestamp: Date.parse('2026-06-05T09:30:00-04:00'), close: 200 },
        { time: '2026-06-05 09:31', timestamp: Date.parse('2026-06-05T09:31:00-04:00'), close: 201 },
      ],
      MSFT: [
        { time: '2026-06-05 09:30', timestamp: Date.parse('2026-06-05T09:30:00-04:00'), close: 400 },
      ],
    },
    warnings,
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].portfolioValueUsd, 800);
  assert.equal(rows[1].portfolioValueUsd, 802);
  assert.deepEqual(warnings, []);
});

test('fillSessionMinuteGaps fills missing minutes inside a session using the latest portfolio value', () => {
  const rows = fillSessionMinuteGaps([
    { time: '2026-06-05 09:30', timestamp: Date.parse('2026-06-05T09:30:00-04:00'), portfolioValueUsd: 800 },
    { time: '2026-06-05 09:32', timestamp: Date.parse('2026-06-05T09:32:00-04:00'), portfolioValueUsd: 806 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-05 09:30',
    '2026-06-05 09:31',
    '2026-06-05 09:32',
  ]);
  assert.equal(rows[1].portfolioValueUsd, 800);
  assert.equal(rows[2].portfolioValueUsd, 806);
});

test('fillSessionMinuteGaps does not synthesize overnight rows between trading days', () => {
  const rows = fillSessionMinuteGaps([
    { time: '2026-06-05 19:59', timestamp: Date.parse('2026-06-05T19:59:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-08 04:00', timestamp: Date.parse('2026-06-08T04:00:00-04:00'), portfolioValueUsd: 1002 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-05 19:59',
    '2026-06-08 04:00',
  ]);
});

test('appendLivePortfolioSnapshot replaces the current minute instead of duplicating it', () => {
  const rows = appendLivePortfolioSnapshot(
    [
      { time: '2026-06-11 09:30', timestamp: Date.parse('2026-06-11T09:30:00-04:00'), portfolioValueUsd: 1000 },
    ],
    1012.34,
    '2026-06-11T13:30:22.000Z',
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, '2026-06-11 09:30');
  assert.equal(rows[0].portfolioValueUsd, 1012.34);
});

test('appendLivePortfolioSnapshot keeps overnight refreshes on the last trading session instead of creating a new single-point day', () => {
  const rows = appendLivePortfolioSnapshot(
    [
      { time: '2026-06-11 19:58', timestamp: Date.parse('2026-06-11T19:58:00-04:00'), portfolioValueUsd: 11790.11 },
      { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 11796.33 },
    ],
    11796.34,
    '2026-06-12T04:51:12.592Z',
  );

  assert.equal(rows.length, 2);
  assert.equal(rows.at(-1).time, '2026-06-11 19:59');
  assert.equal(rows.at(-1).portfolioValueUsd, 11796.34);
});

test('sliceLatestSessionRows keeps only the most recent trading day', () => {
  const rows = sliceLatestSessionRows([
    { time: '2026-06-10 15:59', timestamp: Date.parse('2026-06-10T15:59:00-04:00'), portfolioValueUsd: 999 },
    { time: '2026-06-11 09:30', timestamp: Date.parse('2026-06-11T09:30:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-11 09:31', timestamp: Date.parse('2026-06-11T09:31:00-04:00'), portfolioValueUsd: 1001 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), ['2026-06-11 09:30', '2026-06-11 09:31']);
});

test('sliceLatestContinuousSessionRows includes the prior session while the current session is partial', () => {
  const rows = sliceLatestContinuousSessionRows([
    { time: '2026-06-11 04:00', timestamp: Date.parse('2026-06-11T04:00:00-04:00'), portfolioValueUsd: 990 },
    { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-12 04:00', timestamp: Date.parse('2026-06-12T04:00:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-12 04:01', timestamp: Date.parse('2026-06-12T04:01:00-04:00'), portfolioValueUsd: 1002 },
  ]);

  assert.deepEqual([...new Set(rows.map((row) => row.time.slice(0, 10)))], ['2026-06-11', '2026-06-12']);
});

test('sliceLatestContinuousSessionRows uses only the latest session once it has completed post-market', () => {
  const rows = sliceLatestContinuousSessionRows([
    { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-12 04:00', timestamp: Date.parse('2026-06-12T04:00:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-12 19:59', timestamp: Date.parse('2026-06-12T19:59:00-04:00'), portfolioValueUsd: 1010 },
  ]);

  assert.deepEqual([...new Set(rows.map((row) => row.time.slice(0, 10)))], ['2026-06-12']);
});

test('sliceLatestTradingSessionRows keeps the latest seven distinct trading sessions and skips non-trading gaps', () => {
  const rows = sliceLatestTradingSessionRows([
    { time: '2026-06-01 19:59', timestamp: Date.parse('2026-06-01T19:59:00-04:00'), portfolioValueUsd: 991 },
    { time: '2026-06-02 19:59', timestamp: Date.parse('2026-06-02T19:59:00-04:00'), portfolioValueUsd: 993 },
    { time: '2026-06-03 19:59', timestamp: Date.parse('2026-06-03T19:59:00-04:00'), portfolioValueUsd: 995 },
    { time: '2026-06-04 19:59', timestamp: Date.parse('2026-06-04T19:59:00-04:00'), portfolioValueUsd: 997 },
    { time: '2026-06-05 04:00', timestamp: Date.parse('2026-06-05T04:00:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-08 04:00', timestamp: Date.parse('2026-06-08T04:00:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-09 04:00', timestamp: Date.parse('2026-06-09T04:00:00-04:00'), portfolioValueUsd: 1002 },
    { time: '2026-06-10 04:00', timestamp: Date.parse('2026-06-10T04:00:00-04:00'), portfolioValueUsd: 1003 },
    { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 1004 },
  ], 7);

  assert.deepEqual([...new Set(rows.map((row) => row.time.slice(0, 10)))], [
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
    '2026-06-11',
  ]);
});

test('sliceCurrentMarketDayRows prepends the prior post-market block when the latest session is still pre-market', () => {
  const rows = sliceCurrentMarketDayRows([
    { time: '2026-06-11 15:59', timestamp: Date.parse('2026-06-11T15:59:00-04:00'), portfolioValueUsd: 999 },
    { time: '2026-06-11 16:00', timestamp: Date.parse('2026-06-11T16:00:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-12 04:00', timestamp: Date.parse('2026-06-12T04:00:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-12 08:15', timestamp: Date.parse('2026-06-12T08:15:00-04:00'), portfolioValueUsd: 1005 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-11 16:00',
    '2026-06-11 19:59',
    '2026-06-12 04:00',
    '2026-06-12 08:15',
  ]);
});

test('sliceCurrentMarketDayRows uses only the latest day once regular trading has started', () => {
  const rows = sliceCurrentMarketDayRows([
    { time: '2026-06-11 16:00', timestamp: Date.parse('2026-06-11T16:00:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-12 04:00', timestamp: Date.parse('2026-06-12T04:00:00-04:00'), portfolioValueUsd: 1002 },
    { time: '2026-06-12 09:30', timestamp: Date.parse('2026-06-12T09:30:00-04:00'), portfolioValueUsd: 1005 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-12 04:00',
    '2026-06-12 09:30',
  ]);
});

test('sliceCurrentMarketDayRows keeps the latest day when it has completed post-market', () => {
  const rows = sliceCurrentMarketDayRows([
    { time: '2026-06-11 19:59', timestamp: Date.parse('2026-06-11T19:59:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-12 04:00', timestamp: Date.parse('2026-06-12T04:00:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-12 19:59', timestamp: Date.parse('2026-06-12T19:59:00-04:00'), portfolioValueUsd: 1005 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-12 04:00',
    '2026-06-12 19:59',
  ]);
});

test('sliceCurrentMarketWeekRows keeps only rows from the current ET market week', () => {
  const rows = sliceCurrentMarketWeekRows([
    { time: '2026-06-05 19:59', timestamp: Date.parse('2026-06-05T19:59:00-04:00'), portfolioValueUsd: 990 },
    { time: '2026-06-08 04:00', timestamp: Date.parse('2026-06-08T04:00:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-09 04:00', timestamp: Date.parse('2026-06-09T04:00:00-04:00'), portfolioValueUsd: 1001 },
    { time: '2026-06-10 04:00', timestamp: Date.parse('2026-06-10T04:00:00-04:00'), portfolioValueUsd: 1002 },
    { time: '2026-06-11 04:00', timestamp: Date.parse('2026-06-11T04:00:00-04:00'), portfolioValueUsd: 1003 },
    { time: '2026-06-12 19:59', timestamp: Date.parse('2026-06-12T19:59:00-04:00'), portfolioValueUsd: 1004 },
  ]);

  assert.deepEqual([...new Set(rows.map((row) => row.time.slice(0, 10)))], [
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
    '2026-06-11',
    '2026-06-12',
  ]);
});

test('sliceCurrentMarketWeekRows keeps daily rows without explicit timestamps', () => {
  const rows = sliceCurrentMarketWeekRows([
    { time: '2026-06-05', portfolioValueUsd: 990 },
    { time: '2026-06-08', portfolioValueUsd: 1000 },
    { time: '2026-06-09', portfolioValueUsd: 1001 },
    { time: '2026-06-10 04:00', timestamp: Date.parse('2026-06-10T04:00:00-04:00'), portfolioValueUsd: 1002 },
    { time: '2026-06-12 19:59', timestamp: Date.parse('2026-06-12T19:59:00-04:00'), portfolioValueUsd: 1004 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-08',
    '2026-06-09',
    '2026-06-10 04:00',
    '2026-06-12 19:59',
  ]);
});

test('sliceRecentCalendarRows keeps the requested calendar lookback', () => {
  const rows = sliceRecentCalendarRows([
    { time: '2026-05-01', portfolioValueUsd: 900 },
    { time: '2026-05-20', portfolioValueUsd: 950 },
    { time: '2026-06-05', portfolioValueUsd: 1000 },
    { time: '2026-06-12 19:59', timestamp: Date.parse('2026-06-12T19:59:00-04:00'), portfolioValueUsd: 1010 },
  ], 30);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-05-20',
    '2026-06-05',
    '2026-06-12 19:59',
  ]);
});

test('sliceDailySessionEndRows keeps one latest point per available trading date', () => {
  const rows = sliceDailySessionEndRows([
    { time: '2026-06-05 04:00', timestamp: Date.parse('2026-06-05T04:00:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-05 19:59', timestamp: Date.parse('2026-06-05T19:59:00-04:00'), portfolioValueUsd: 1010 },
    { time: '2026-06-08 04:00', timestamp: Date.parse('2026-06-08T04:00:00-04:00'), portfolioValueUsd: 1020 },
    { time: '2026-06-08 19:59', timestamp: Date.parse('2026-06-08T19:59:00-04:00'), portfolioValueUsd: 1030 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), ['2026-06-05 19:59', '2026-06-08 19:59']);
  assert.deepEqual(rows.map((row) => row.portfolioValueUsd), [1010, 1030]);
});

test('sliceHourlySnapshotRows keeps one latest point per available hour', () => {
  const rows = sliceHourlySnapshotRows([
    { time: '2026-06-05 04:00', timestamp: Date.parse('2026-06-05T04:00:00-04:00'), portfolioValueUsd: 1000 },
    { time: '2026-06-05 04:59', timestamp: Date.parse('2026-06-05T04:59:00-04:00'), portfolioValueUsd: 1009 },
    { time: '2026-06-05 05:00', timestamp: Date.parse('2026-06-05T05:00:00-04:00'), portfolioValueUsd: 1010 },
    { time: '2026-06-05 05:30', timestamp: Date.parse('2026-06-05T05:30:00-04:00'), portfolioValueUsd: 1015 },
    { time: '2026-06-08 04:00', timestamp: Date.parse('2026-06-08T04:00:00-04:00'), portfolioValueUsd: 1020 },
  ]);

  assert.deepEqual(rows.map((row) => row.time), [
    '2026-06-05 04:59',
    '2026-06-05 05:30',
    '2026-06-08 04:00',
  ]);
});

test('primeIndMoney2HoldingsCache seeds cache when MCP returns holdings', async () => {
  process.env.INDMONEY_MCP_BEARER_TOKEN = 'test-token';
  const provider = {
    isAvailable() {
      return true;
    },
    async networthHoldings(assetType) {
      assert.equal(assetType, 'US_STOCK');
      return {
        holdings: [
          {
            ticker: 'NVDA',
            investment: 'NVIDIA Corporation',
            invested_amount: 1000,
            market_value: 1100,
            total_units: 1,
            unit_price: 1100,
          },
        ],
      };
    },
  };

  await assert.doesNotReject(() => primeIndMoney2HoldingsCache({ provider }));
  assert.equal(await primeIndMoney2HoldingsCache({ provider }), true);

  delete process.env.INDMONEY_MCP_BEARER_TOKEN;
});

test('resolveIndMoney2HoldingsCachePath points at the data cache file', () => {
  assert.equal(
    resolveIndMoney2HoldingsCachePath('/tmp/market'),
    '/tmp/market/data/indmoney2-holdings-cache.json',
  );
});

test('primeIndMoney2HoldingsCache persists holdings for later cold-start fallback', async () => {
  process.env.INDMONEY_MCP_BEARER_TOKEN = 'test-token';
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'indmoney2-cache-'));
  const cachePath = path.join(tmpDir, 'indmoney2-holdings-cache.json');
  const provider = {
    isAvailable() {
      return true;
    },
    async networthHoldings() {
      return {
        holdings: [
          {
            ticker: 'MU',
            investment: 'Micron Technology',
            invested_amount: 500,
            market_value: 550,
            total_units: 1,
            unit_price: 550,
          },
        ],
      };
    },
  };

  assert.equal(await primeIndMoney2HoldingsCache({ provider, holdingsCachePath: cachePath }), true);

  const persisted = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
  assert.equal(Array.isArray(persisted.payload.holdings), true);
  assert.equal(persisted.payload.holdings.length > 0, true);

  delete process.env.INDMONEY_MCP_BEARER_TOKEN;
});

test('primeIndMoney2HoldingsCache skips portfolios without live fetch enabled', async () => {
  let checked = false;
  const ok = await primeIndMoney2HoldingsCache({
    allowLiveFetch: false,
    provider: {
      isAvailable() {
        checked = true;
        return true;
      },
    },
  });

  assert.equal(ok, false);
  assert.equal(checked, false);
});
