import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVER_NO_BOOTSTRAP = '1';

const {
  applyLiveQuotesToDashboardHoldings,
  buildCombinedSeries,
  combinePortfolioHoldings,
  getUsRefreshIntervalMs,
  getUsSessionLabel,
  parseYahooQuotePagePayload,
  partitionSnapshotsForRetention,
  pruneMapEntries,
  reconcileUsEquityQuoteSources,
  refillEmptyDashboardUsHoldings,
  refreshEmptyDashboardHoldingsResults,
  reconcileIndMoneyDashboardSummary,
  resolvePortfolioDefinition,
  toUsOnlyIndMoneyNetworth,
} = await import('../server.js');

function assertLiveSession(dateText, expectedLabel) {
  const date = new Date(dateText);
  const session = getUsSessionLabel(date);
  assert.equal(session, expectedLabel);
  assert.equal(getUsRefreshIntervalMs(date), 5_000);
}

test('getUsRefreshIntervalMs treats pre/regular/post as live-refresh windows', () => {
  assertLiveSession('2026-06-08T09:15:00-04:00', 'pre-market');
  assertLiveSession('2026-06-08T10:00:00-04:00', '60 min after open');
  assertLiveSession('2026-06-08T17:30:00-04:00', 'post-market');
});

test('getUsRefreshIntervalMs returns null outside watch windows', () => {
  assert.equal(getUsRefreshIntervalMs(new Date('2026-06-08T20:30:00-04:00')), null);
  const saturday = new Date('2026-06-06T10:00:00-04:00');
  assert.equal(getUsSessionLabel(saturday), 'post-close');
  assert.equal(getUsRefreshIntervalMs(saturday), null);
});

test('resolvePortfolioDefinition maps deep and mom to distinct files and routes', () => {
  const deep = resolvePortfolioDefinition('deep');
  const mom = resolvePortfolioDefinition('mom');

  assert.equal(deep.routePath, '/portfolios/deep');
  assert.equal(deep.apiBasePath, '/api/portfolios/deep');
  assert.match(deep.fxConfigPath, /indmoney2-fx-config\.json$/);

  assert.equal(mom.routePath, '/portfolios/mom');
  assert.equal(mom.apiBasePath, '/api/portfolios/mom');
  assert.match(mom.fxConfigPath, /mom-fx-config\.json$/);
  assert.match(mom.authPath, /indmoney-mcp-market-auth-mom\.json$/);
  assert.notEqual(deep.fxConfigPath, mom.fxConfigPath);
  assert.notEqual(deep.authPath, mom.authPath);
});

test('combinePortfolioHoldings aggregates overlapping tickers across portfolios', () => {
  const combined = combinePortfolioHoldings([
    {
      key: 'deep',
      dashboard: {
        holdings: [{
          ticker: 'NVDA',
          name: 'NVIDIA',
          quantity: 2,
          investedUsd: 1000,
          currentHoldingValueUsd: 1300,
          oneDayPnlUsd: 40,
          actualPnlUsd: 300,
          priceSession: 'regular',
          updatedAt: '2026-06-15T12:00:00.000Z',
          priceSource: 'Yahoo',
        }],
      },
    },
    {
      key: 'mom',
      dashboard: {
        holdings: [{
          ticker: 'NVDA',
          name: 'NVIDIA Corp',
          quantity: 1,
          investedUsd: 400,
          currentHoldingValueUsd: 700,
          oneDayPnlUsd: 20,
          actualPnlUsd: 300,
          priceSession: 'post-market',
          updatedAt: '2026-06-15T13:00:00.000Z',
          priceSource: 'IEX',
        }],
      },
    },
  ]);

  assert.equal(combined.length, 1);
  assert.equal(combined[0].ticker, 'NVDA');
  assert.equal(combined[0].quantity, 3);
  assert.equal(combined[0].investedUsd, 1400);
  assert.equal(combined[0].currentHoldingValueUsd, 2000);
  assert.equal(combined[0].oneDayPnlUsd, 60);
  assert.equal(combined[0].actualPnlUsd, 600);
  assert.equal(combined[0].actualPnlPct, 42.86);
  assert.equal(combined[0].oneDayPnlPct, 3.09);
  assert.equal(combined[0].updatedAt, '2026-06-15T13:00:00.000Z');
});

test('buildCombinedSeries sums value points by timestamp across portfolios', () => {
  const combined = buildCombinedSeries([
    {
      key: 'deep',
      dashboard: {
        series: {
          all: {
            baselineAt: '2026-06-05',
            granularity: 'mixed',
            valuePoints: [
              { time: '2026-06-15 09:30', timestamp: 1, portfolioValueUsd: 1000, investedUsd: 700, actualPnlUsd: 300, previousClosePortfolioValueUsd: 980 },
              { time: '2026-06-15 09:31', timestamp: 2, portfolioValueUsd: 1020, investedUsd: 700, actualPnlUsd: 320, previousClosePortfolioValueUsd: 980 },
            ],
            pnlPoints: [
              { time: '2026-06-15 09:30', value: 300, currentValueUsd: 1000, investedUsd: 700 },
              { time: '2026-06-15 09:31', value: 320, currentValueUsd: 1020, investedUsd: 700 },
            ],
          },
        },
      },
    },
    {
      key: 'mom',
      dashboard: {
        series: {
          all: {
            baselineAt: '2026-06-05',
            granularity: 'mixed',
            valuePoints: [
              { time: '2026-06-15 09:30', timestamp: 1, portfolioValueUsd: 500, investedUsd: 400, actualPnlUsd: 100, previousClosePortfolioValueUsd: 490 },
              { time: '2026-06-15 09:31', timestamp: 2, portfolioValueUsd: 530, investedUsd: 400, actualPnlUsd: 130, previousClosePortfolioValueUsd: 490 },
            ],
            pnlPoints: [
              { time: '2026-06-15 09:30', value: 100, currentValueUsd: 500, investedUsd: 400 },
              { time: '2026-06-15 09:31', value: 130, currentValueUsd: 530, investedUsd: 400 },
            ],
          },
        },
      },
    },
  ]);

  assert.equal(combined.all.valuePoints.length, 2);
  assert.equal(combined.all.valuePoints[0].portfolioValueUsd, 1500);
  assert.equal(combined.all.valuePoints[0].actualPnlUsd, 400);
  assert.equal(combined.all.valuePoints[0].oneDayPnlUsd, 30);
  assert.equal(combined.all.valuePoints[1].portfolioValueUsd, 1550);
  assert.equal(combined.all.summary.currentPortfolioValueUsd, 1550);
  assert.equal(combined.all.summary.investedValueUsd, 1100);
});

test('partitionSnapshotsForRetention archives older snapshots per market', () => {
  const snapshots = [
    { market: 'IND', timestamp: '1' },
    { market: 'US', timestamp: '2' },
    { market: 'IND', timestamp: '3' },
    { market: 'US', timestamp: '4' },
    { market: 'IND', timestamp: '5' },
    { market: 'US', timestamp: '6' },
  ];

  const { hot, archived } = partitionSnapshotsForRetention(snapshots, 2);

  assert.deepEqual(
    archived.map((item) => `${item.market}:${item.timestamp}`),
    ['IND:1', 'US:2'],
  );
  assert.deepEqual(
    hot.map((item) => `${item.market}:${item.timestamp}`),
    ['IND:3', 'US:4', 'IND:5', 'US:6'],
  );
});

test('pruneMapEntries drops expired rows and oldest overflow rows', () => {
  const now = 1_000;
  const cache = new Map([
    ['expired', { expiresAt: 900, fetchedAt: 10 }],
    ['older', { expiresAt: 1_500, fetchedAt: 20 }],
    ['newer', { expiresAt: 1_500, fetchedAt: 30 }],
  ]);

  const removed = pruneMapEntries(cache, {
    now,
    maxEntries: 1,
    isExpired: (entry, currentNow) => entry.expiresAt <= currentNow,
    sortValue: (entry) => entry.fetchedAt,
  });

  assert.equal(removed, 2);
  assert.deepEqual([...cache.keys()], ['newer']);
});

test('refreshEmptyDashboardHoldingsResults refetches empty US holdings rows', async () => {
  let calls = 0;
  const holdingsResults = [{
    label: 'holdings:US_STOCK',
    value: { holdings: [] },
    error: null,
  }];
  const provider = {
    isAvailable() {
      return true;
    },
    async networthHoldings(assetType) {
      calls += 1;
      assert.equal(assetType, 'US_STOCK');
      return {
        holdings: [{
          investment: 'Amazon.com, Inc. Common Stock',
          invested_amount: 1000,
          market_value: 1200,
          total_units: 1,
          unit_price: 1200,
        }],
      };
    },
  };

  const refreshed = await refreshEmptyDashboardHoldingsResults(holdingsResults, { provider });

  assert.equal(calls, 1);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].value.holdings.length, 1);
});

test('applyLiveQuotesToDashboardHoldings keeps regular price intact while using latest extended price', () => {
  const merged = applyLiveQuotesToDashboardHoldings(
    {
      US_STOCK: [
        {
          ticker: 'SMCI',
          units: 2,
          invested: 100,
          currentValue: 90,
          pnl: -10,
          pnlPct: -10,
          regularPrice: 45,
          regularValue: 90,
          regularPnl: -10,
          regularPnlPct: -10,
          extendedPrice: null,
          moveBasis: 'regular',
          currency: 'USD',
        },
      ],
    },
    [
      {
        ticker: 'SMCI',
        regularPrice: 45,
        extendedPrice: 47,
        lastPrice: 47,
        previousClose: 44,
        movePct: 6.82,
        moveAbs: 3,
        moveBasis: 'pre-market',
      },
    ],
  );

  const row = merged.US_STOCK[0];
  assert.equal(row.lastPrice, 47);
  assert.equal(row.regularPrice, 45);
  assert.equal(row.extendedPrice, 47);
  assert.equal(row.currentValue, 94);
  assert.equal(row.regularValue, 90);
  assert.equal(row.oneDayReturn, 6);
  assert.equal(row.moveBasis, 'pre-market');
});

test('applyLiveQuotesToDashboardHoldings derives previous close from live move pct when quote omits it', () => {
  const merged = applyLiveQuotesToDashboardHoldings(
    {
      US_STOCK: [
        {
          ticker: 'AMD',
          units: 1,
          invested: 500,
          currentValue: 0,
          pnl: 0,
          pnlPct: 0,
          oneDayReturn: 0,
          oneDayReturnPct: 0,
          currency: 'USD',
        },
      ],
    },
    [
      {
        ticker: 'AMD',
        lastPrice: 452.4,
        movePct: -4.86,
        moveAbs: -23.11,
        moveBasis: 'regular',
      },
    ],
  );

  const row = merged.US_STOCK[0];
  assert.equal(row.previousClose, 475.5098);
  assert.equal(row.oneDayReturn, -23.11);
  assert.equal(row.oneDayReturnPct, -4.86);
});

test('applyLiveQuotesToDashboardHoldings prefers quote source timestamp over fetch time', () => {
  const merged = applyLiveQuotesToDashboardHoldings(
    {
      US_STOCK: [
        {
          ticker: 'AMD',
          units: 1,
          invested: 500,
          currentValue: 480,
          updatedAt: '2026-06-14T10:30:00.000Z',
          currency: 'USD',
        },
      ],
    },
    [
      {
        ticker: 'AMD',
        lastPrice: 452.4,
        previousClose: 475.5098,
        moveBasis: 'regular',
        updatedAt: '2026-06-14T13:37:00.000Z',
      },
    ],
  );

  assert.equal(merged.US_STOCK[0].updatedAt, '2026-06-14T13:37:00.000Z');
});

test('applyLiveQuotesToDashboardHoldings uses trade-aware 1D pnl for same-day buys', () => {
  const merged = applyLiveQuotesToDashboardHoldings(
    {
      US_STOCK: [
        {
          ticker: 'AVGO',
          units: 3,
          invested: 1270,
          currentValue: 1260,
          pnl: -10,
          pnlPct: -0.79,
          oneDayReturn: 999,
          oneDayReturnPct: 99,
          currency: 'USD',
        },
      ],
    },
    [
      {
        ticker: 'AVGO',
        lastPrice: 420,
        previousClose: 410,
        movePct: 2.44,
        moveBasis: 'regular',
      },
    ],
    {
      AVGO: {
        buys: [{ quantity: 1, price: 420 }],
        sold: 0,
      },
    },
  );

  const row = merged.US_STOCK[0];
  assert.equal(row.heldQuantityAtPreviousClose, 2);
  assert.equal(row.todayBoughtQuantity, 1);
  assert.equal(row.previousCloseValue, 820);
  assert.equal(row.oneDayReturn, 20);
  assert.equal(row.oneDayReturnPct, 1.61);
});

test('applyLiveQuotesToDashboardHoldings combines overnight and same-day-buy 1D pnl correctly', () => {
  const merged = applyLiveQuotesToDashboardHoldings(
    {
      US_STOCK: [
        {
          ticker: 'NVDA',
          units: 5,
          invested: 980,
          currentValue: 1050,
          pnl: 70,
          pnlPct: 7.14,
          currency: 'USD',
        },
      ],
    },
    [
      {
        ticker: 'NVDA',
        lastPrice: 210,
        previousClose: 200,
        movePct: 5,
        moveBasis: 'regular',
      },
    ],
    {
      NVDA: {
        buys: [{ quantity: 2, price: 205 }],
        sold: 0,
      },
    },
  );

  const row = merged.US_STOCK[0];
  assert.equal(row.heldQuantityAtPreviousClose, 3);
  assert.equal(row.todayBoughtQuantity, 2);
  assert.equal(row.previousCloseValue, 600);
  assert.equal(row.oneDayReturn, 40);
  assert.equal(row.oneDayReturnPct, 3.96);
});

test('applyLiveQuotesToDashboardHoldings preserves imported 1D pnl when trade lots are unavailable', () => {
  const merged = applyLiveQuotesToDashboardHoldings(
    {
      US_STOCK: [
        {
          ticker: 'AMD',
          units: 3,
          invested: 450,
          currentValue: 480,
          pnl: 30,
          pnlPct: 6.67,
          oneDayReturn: 8,
          oneDayReturnPct: 1.69,
          currency: 'USD',
        },
      ],
    },
    [
      {
        ticker: 'AMD',
        lastPrice: 160,
        previousClose: 150,
        movePct: 6.67,
        moveBasis: 'regular',
      },
    ],
  );

  const row = merged.US_STOCK[0];
  assert.equal(row.oneDayReturn, 8);
  assert.equal(row.oneDayReturnPct, 1.69);
});

test('reconcileUsEquityQuoteSources prefers the fresher quote for latest tradable price', () => {
  const merged = reconcileUsEquityQuoteSources(
    {
      symbol: 'SMCI',
      price: 31.5,
      previousClose: 32,
      pctChange: -1.56,
      absChange: -0.5,
      timestamp: 1718110800,
      source: 'INDmoney MCP',
    },
    {
      symbol: 'SMCI',
      price: 31.5,
      previousClose: 32,
      pctChange: -1.56,
      absChange: -0.5,
      timestamp: 1718110805,
      extended: {
        kind: 'Pre-market',
        price: 29.27,
        pctChange: -7.08,
        absChange: -2.23,
        timestamp: 1718111100,
      },
      source: 'Yahoo Finance',
    },
  );

  assert.equal(merged.price, 31.5);
  assert.equal(merged.previousClose, 32);
  assert.equal(merged.extended.price, 29.27);
  assert.equal(merged.timestamp, 1718110805);
  assert.equal(merged.source, 'Yahoo Finance');
});

test('parseYahooQuotePagePayload extracts pre-market data from Yahoo quote page html', () => {
  const html = '<script data-url="https://query1.finance.yahoo.com/v7/finance/quote?symbols=SMCI" data-ttl="1">{"status":200,"statusText":"OK","headers":{},"body":"{\\"quoteResponse\\":{\\"result\\":[{\\"symbol\\":\\"SMCI\\",\\"longName\\":\\"Super Micro Computer, Inc.\\",\\"fullExchangeName\\":\\"NasdaqGS\\",\\"marketState\\":\\"PRE\\",\\"regularMarketPrice\\":{\\"raw\\":29.27,\\"fmt\\":\\"29.27\\"},\\"regularMarketPreviousClose\\":{\\"raw\\":40.64,\\"fmt\\":\\"40.64\\"},\\"regularMarketChange\\":{\\"raw\\":-11.37,\\"fmt\\":\\"-11.37\\"},\\"regularMarketChangePercent\\":{\\"raw\\":-27.9774,\\"fmt\\":\\"-27.98%\\"},\\"regularMarketTime\\":{\\"raw\\":1781121600,\\"fmt\\":\\"4:00PM EDT\\"},\\"preMarketPrice\\":{\\"raw\\":31.23,\\"fmt\\":\\"31.23\\"},\\"preMarketTime\\":{\\"raw\\":1781172957,\\"fmt\\":\\"6:15AM EDT\\"},\\"preMarketChange\\":{\\"raw\\":1.96,\\"fmt\\":\\"1.96\\"},\\"preMarketChangePercent\\":{\\"raw\\":6.696273,\\"fmt\\":\\"6.70%\\"}}],\\"error\\":null}}"}<\/script>';
  const quote = parseYahooQuotePagePayload(html, 'SMCI');

  assert.equal(quote.symbol, 'SMCI');
  assert.equal(quote.price, 29.27);
  assert.equal(quote.previousClose, 40.64);
  assert.equal(quote.extended.price, 31.23);
  assert.equal(quote.extended.kind, 'Pre-market');
  assert.equal(quote.timestamp, 1781172957);
});

test('refillEmptyDashboardUsHoldings falls back to baseline portfolio snapshot when MCP holdings are empty', async () => {
  const rows = await refillEmptyDashboardUsHoldings(
    { US_STOCK: [] },
    {
      portfolioStore: {
        US: {
          holdings: [
            {
              ticker: 'NVDA',
              name: 'NVIDIA Corporation',
              quantity: 2,
              invested: 200,
              currentValue: 220,
              totalReturn: 20,
              totalReturnPct: 10,
              lastPrice: 110,
              movePct: 1.5,
            },
          ],
        },
      },
    },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'NVDA');
  assert.equal(rows[0].units, 2);
  assert.equal(rows[0].invested, 200);
  assert.equal(rows[0].currentValue, 220);
  assert.equal(rows[0].moveBasis, 'Imported');
});

test('toUsOnlyIndMoneyNetworth ignores zero-only allocation rows when holdings have material values', () => {
  const summary = toUsOnlyIndMoneyNetworth(
    {
      investments: [
        {
          asset_type: 'US_STOCK',
          invested_value: 0,
          current_value: 0,
        },
      ],
    },
    [
      {
        ticker: 'NVDA',
        invested: 1000,
        currentValue: 1250,
      },
    ],
  );

  assert.equal(summary.total_invested, 1000);
  assert.equal(summary.total_current_value, 1250);
  assert.equal(summary.total_return, 250);
  assert.equal(summary.total_return_pct, 25);
});

test('reconcileIndMoneyDashboardSummary keeps holdings-derived pnl when usOnly summary is zero', () => {
  const payload = {
    summary: {
      totalInvested: 0,
      totalCurrentValue: 0,
      totalNetworth: 0,
      totalReturn: 0,
      totalReturnPct: 0,
      liabilities: null,
    },
    assetClassPnl: [
      {
        label: 'US_STOCK',
        invested: 0,
        currentValue: 0,
        pnl: 0,
        pnlPct: 0,
      },
    ],
  };

  reconcileIndMoneyDashboardSummary(payload, {
    usOnlyNetworth: {
      total_invested: 0,
      total_current_value: 0,
      total_networth: 0,
      total_return: 0,
      total_return_pct: 0,
    },
    holdings: [
      { ticker: 'MU', invested: 2000, currentValue: 2600 },
      { ticker: 'AMD', invested: 1000, currentValue: 900 },
    ],
    hasStaleAdjustment: false,
  });

  assert.equal(payload.summary.totalInvested, 3000);
  assert.equal(payload.summary.totalCurrentValue, 3500);
  assert.equal(payload.summary.totalReturn, 500);
  assert.equal(payload.summary.totalReturnPct, 16.67);
});

test('reconcileIndMoneyDashboardSummary keeps trustworthy usOnly summary when holdings are empty', () => {
  const payload = {
    summary: {
      totalInvested: null,
      totalCurrentValue: null,
      totalNetworth: null,
      totalReturn: null,
      totalReturnPct: null,
      liabilities: null,
    },
    assetClassPnl: [],
  };

  reconcileIndMoneyDashboardSummary(payload, {
    usOnlyNetworth: {
      total_invested: 4000,
      total_current_value: 4600,
      total_networth: 4600,
      total_return: 600,
      total_return_pct: 15,
    },
    holdings: [],
    hasStaleAdjustment: false,
  });

  assert.equal(payload.summary.totalInvested, 4000);
  assert.equal(payload.summary.totalCurrentValue, 4600);
  assert.equal(payload.summary.totalReturn, 600);
  assert.equal(payload.summary.totalReturnPct, 15);
});

test('reconcileIndMoneyDashboardSummary keeps USD summary fields aligned with rewritten INR totals', () => {
  const payload = {
    fxRate: 95.37,
    summary: {
      totalInvested: 1128267,
      totalCurrentValue: 12320.43,
      totalNetworth: 12320.43,
      totalReturn: 38.25,
      totalReturnPct: 0.31,
      totalInvestedUsd: 11874.53,
      totalCurrentValueUsd: 12320.43,
      totalReturnUsd: 38.25,
      liabilities: null,
      priceBasis: 'pre-market',
    },
    assetClassPnl: [
      {
        label: 'US_STOCK',
        invested: 1128267,
        currentValue: 1131781,
        pnl: 3514,
        pnlPct: 0.31,
      },
    ],
    usSessionPnl: {
      overall: {
        basis: 'pre-market',
        valueInr: 1131781,
        valueUsd: 11867.38,
        pnlInr: 3514,
        pnlUsd: 38.25,
        pnlPct: 0.31,
      },
      actual: {
        basis: 'regular-close',
        valueInr: 1091157,
        valueUsd: 11441.39,
        pnlInr: -37110,
        pnlUsd: -403.97,
        pnlPct: -3.29,
      },
      reference: {
        investedInr: 1128267,
        investedUsd: 11830.54,
        officialCloseValueInr: 1091157,
        officialCloseValueUsd: 11441.39,
      },
    },
  };

  reconcileIndMoneyDashboardSummary(payload, {
    usOnlyNetworth: {
      total_invested: 1128267,
      total_current_value: 1131781,
      total_networth: 1131781,
      total_return: 3514,
      total_return_pct: 0.31,
    },
    holdings: [],
    hasStaleAdjustment: false,
  });

  assert.equal(payload.summary.totalInvested, 1128267);
  assert.equal(payload.summary.totalCurrentValue, 1131781);
  assert.equal(payload.summary.totalReturn, 3514);
  assert.equal(payload.summary.totalInvestedUsd, 11830.54);
  assert.equal(payload.summary.totalCurrentValueUsd, 11867.38);
  assert.equal(payload.summary.totalReturnUsd, 38.25);
});
