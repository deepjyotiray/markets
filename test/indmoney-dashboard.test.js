import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustIndMoneySnapshotForStaleIndianData,
  applyLiveUsSessionPricing,
  appendIndMoneyHistoryPoint,
  appendUsPortfolioSeriesPoint,
  buildAssetClassPnl,
  buildCurrentHoldingsBaseline,
  buildCurrentHoldingsRepricedSeries,
  buildIndMoneyGrowthSeries,
  buildIndMoneyUsStockPnlSeries,
  buildUsPortfolioSeriesPayload,
  buildUsPortfolioSeriesPoint,
  buildUsStockCategoryPnl,
  buildUsHoldingMarketCapAllocations,
  buildUsHoldingSectorAllocations,
  filterUsPortfolioSeriesByRange,
  normalizeIndMoneyDashboardPayload,
  normalizeIndMoneyHistoryPoint,
  normalizeIndMoneyHoldings,
  reconstructUsPortfolioPositionsAt,
} from '../src/portfolio-alerts/indmoney-dashboard.js';

test('INDmoney dashboard adjustment zeros only Indian MF and stock buckets', () => {
    const adjusted = adjustIndMoneySnapshotForStaleIndianData({
      total_invested: 1000,
      total_current_value: 1200,
      total_networth: 1200,
      investments: [
        { asset_type: 'US_STOCK', invested_value: 400, current_value: 500 },
        { asset_type: 'MF', invested_value: 300, current_value: 350, percentage: 30 },
        { asset_type: 'STOCK', invested_value: 200, current_value: 250, percentage: 20 },
        { asset_type: 'US_STOCK_WALLET', invested_value: 100, current_value: 100 },
      ],
      assets: [
        { assetclass_l2: 'Global Equity', invested_value: 400, current_value: 500 },
        { assetclass_l2: 'Indian Equity', invested_value: 500, current_value: 600 },
        { assetclass_l2: 'Liquid', invested_value: 100, current_value: 100 },
      ],
      sector: [{ sector: 'Technology', current_value: 500 }],
      market_cap: [{ market_cap: 'Large Cap', current_value: 500 }],
    });

  const byType = Object.fromEntries(adjusted.investments.map((row) => [row.asset_type, row]));
  assert.equal(byType.US_STOCK.current_value, 500);
  assert.equal(byType.US_STOCK_WALLET.current_value, 100);
  assert.equal(byType.MF.current_value, 0);
  assert.equal(byType.STOCK.current_value, 0);
  assert.equal(byType.MF.percentage, 0);
    assert.equal(adjusted.total_invested, 500);
    assert.equal(adjusted.total_current_value, 600);
    assert.equal(adjusted.total_networth, 600);
    assert.equal(adjusted.dataAdjustments[0].topLineTotalsPreserved, false);
    assert.equal(adjusted.dataAdjustments[0].breakdownExcludedCurrentValue, 600);
    assert.equal(adjusted.dataAdjustments[0].breakdownExcludedInvestedValue, 500);
  assert.deepEqual(adjusted.sector, []);
  assert.deepEqual(adjusted.market_cap, []);
});

test('INDmoney dashboard adjustment does not zero an all-India connected portfolio summary', () => {
  const adjusted = adjustIndMoneySnapshotForStaleIndianData({
    total_invested: 100000,
    total_current_value: 125000,
    total_networth: 125000,
    investments: [{ asset_type: 'MF', invested_value: 100000, current_value: 125000, percentage: 100 }],
  });

  assert.equal(adjusted.total_invested, 0);
  assert.equal(adjusted.total_current_value, 0);
  assert.equal(adjusted.total_networth, 0);
  assert.equal(adjusted.total_return, 0);
  assert.equal(adjusted.total_return_pct, null);
  assert.equal(adjusted.investments[0].current_value, 0);
  assert.equal(adjusted.investments[0].percentage, 0);
  assert.equal(adjusted.dataAdjustments[0].breakdownExcludedCurrentValue, 125000);
});

test('INDmoney dashboard adjustment keeps US stock rows out of stale discounting', () => {
  const adjusted = adjustIndMoneySnapshotForStaleIndianData({
    total_invested: 1000,
    total_current_value: 1100,
    total_networth: 1100,
    investments: [
      { asset_type: 'STOCK', invested_value: 200, current_value: 250, currency: 'USD', label: 'US_STOCK' },
      { asset_type: 'MF', invested_value: 300, current_value: 350, percentage: 30 },
      { asset_type: 'STOCK', invested_value: 200, current_value: 300, currency: 'USD', type: 'US STOCK' },
      { asset_type: 'MF', invested_value: 100, current_value: 150, percentage: 10 },
    ],
    assets: [],
  });

  assert.equal(adjusted.total_invested, 600);
  assert.equal(adjusted.total_current_value, 600);
  assert.equal(adjusted.total_networth, 600);
  assert.equal(adjusted.dataAdjustments[0].breakdownExcludedInvestedValue, 400);
  assert.equal(adjusted.dataAdjustments[0].breakdownExcludedCurrentValue, 500);
  assert.equal(adjusted.investments[0].excludedFromDashboard, undefined);
  assert.equal(adjusted.investments[0].invested_value, 200);
  assert.equal(adjusted.investments[2].excludedFromDashboard, undefined);
  assert.equal(adjusted.investments[2].invested_value, 200);
});

test('INDmoney dashboard adjustment handles INDIAN_STOCK stale marker without double-subtracting Indian equity', () => {
  const adjusted = adjustIndMoneySnapshotForStaleIndianData({
    total_invested: 1000,
    total_current_value: 1000,
    total_networth: 1000,
    investments: [
      { asset_type: 'US_STOCK', invested_value: 200, current_value: 250 },
      { asset_type: 'MF', invested_value: 300, current_value: 350, percentage: 30 },
      { asset_type: 'INDIAN_STOCK', invested_value: 300, current_value: 250, percentage: 30 },
    ],
    assets: [{ assetclass_l2: 'Indian Equity', invested_value: 400, current_value: 500 }],
  });

  assert.equal(adjusted.total_invested, 400);
  assert.equal(adjusted.total_current_value, 400);
  assert.equal(adjusted.total_networth, 400);
  assert.equal(adjusted.dataAdjustments[0].breakdownExcludedCurrentValue, 600);
  assert.equal(adjusted.dataAdjustments[0].breakdownExcludedInvestedValue, 600);
  assert.equal(adjusted.assets[0].excludedFromDashboard, true);
});

test('INDmoney history points normalize net worth snapshot fields', () => {
  const point = normalizeIndMoneyHistoryPoint(
    {
      total_networth: 125000,
      total_invested: 100000,
      total_current_value: 121000,
      liabilities: 4000,
      investments: [{ asset_type: 'US_STOCK', market_value: 60000, percentage: 48 }],
      sector: [{ sector: 'Technology', value: 42000, percent: 34 }],
      market_cap: [{ market_cap: 'Large Cap', value: 70000 }],
    },
    { timestamp: '2026-06-06T09:00:00.000Z', timezone: 'Asia/Kolkata' },
  );

  assert.equal(point.date, '2026-06-06');
  assert.equal(point.totalNetworth, 125000);
  assert.equal(point.totalInvested, 100000);
  assert.equal(point.investments[0].label, 'US_STOCK');
  assert.equal(point.sector[0].label, 'Technology');
  assert.equal(point.marketCap[0].label, 'Large Cap');
});

test('INDmoney history append dedupes by day unless forced', () => {
  const first = normalizeIndMoneyHistoryPoint({ total_networth: 100 }, { timestamp: '2026-06-06T02:00:00.000Z' });
  const second = normalizeIndMoneyHistoryPoint({ total_networth: 120 }, { timestamp: '2026-06-06T08:00:00.000Z' });

  const appended = appendIndMoneyHistoryPoint([], first);
  assert.equal(appended.appended, true);

  const deduped = appendIndMoneyHistoryPoint(appended.history, second);
  assert.equal(deduped.appended, false);
  assert.equal(deduped.history[0].totalNetworth, 100);

  const forced = appendIndMoneyHistoryPoint(deduped.history, second, { force: true });
  assert.equal(forced.appended, true);
  assert.equal(forced.history[0].totalNetworth, 120);
});

test('INDmoney history can append intraday live portfolio value points', () => {
  const first = normalizeIndMoneyHistoryPoint({ total_current_value: 100 }, { timestamp: '2026-06-06T02:00:00.000Z' });
  const second = normalizeIndMoneyHistoryPoint({ total_current_value: 120 }, { timestamp: '2026-06-06T08:00:00.000Z' });

  const appended = appendIndMoneyHistoryPoint([], first, { force: true, allowMultiplePerDay: true });
  const intraday = appendIndMoneyHistoryPoint(appended.history, second, { force: true, allowMultiplePerDay: true });

  assert.equal(intraday.appended, true);
  assert.equal(intraday.reason, 'intraday_appended');
  assert.equal(intraday.history.length, 2);
  assert.equal(buildIndMoneyGrowthSeries(intraday.history).change, 20);
});

test('INDmoney growth series reports single-point and multi-point changes', () => {
  const one = buildIndMoneyGrowthSeries([
    { timestamp: '2026-06-06T00:00:00.000Z', date: '2026-06-06', totalNetworth: 100000 },
  ]);
  assert.equal(one.historyStatus, 'tracking_from_now');
  assert.equal(one.pointCount, 1);

  const two = buildIndMoneyGrowthSeries([
    { timestamp: '2026-06-06T00:00:00.000Z', date: '2026-06-06', totalNetworth: 100000 },
    { timestamp: '2026-06-07T00:00:00.000Z', date: '2026-06-07', totalNetworth: 110000 },
  ]);
  assert.equal(two.historyStatus, 'tracking');
  assert.equal(two.change, 10000);
  assert.equal(two.changePct, 10);
});

test('INDmoney growth series uses current value consistently when net worth changes basis', () => {
  const growth = buildIndMoneyGrowthSeries([
    {
      timestamp: '2026-06-06T00:00:00.000Z',
      date: '2026-06-06',
      totalNetworth: 1844542.55,
      totalCurrentValue: 1956850.4,
    },
    {
      timestamp: '2026-06-08T00:00:00.000Z',
      date: '2026-06-08',
      totalNetworth: 1956850.4,
      totalCurrentValue: 1956850.4,
    },
  ]);

  assert.equal(growth.change, 0);
  assert.equal(growth.changePct, 0);
  assert.equal(growth.points[0].value, 1956850.4);
  assert.equal(growth.points[1].value, 1956850.4);
});

test('INDmoney US stock P&L series ignores non-US buckets and seeds June 5 baseline', () => {
  const growth = buildIndMoneyUsStockPnlSeries([
    {
      timestamp: '2026-06-06T00:00:00.000Z',
      date: '2026-06-06',
      investments: [
        { asset_type: 'US_STOCK', invested_value: 1000000, current_value: 997000 },
        { asset_type: 'EPF', invested_value: 500000, current_value: 550000 },
        { asset_type: 'US_STOCK_WALLET', invested_value: 10000, current_value: 10000 },
        { asset_type: 'MF', invested_value: 200000, current_value: 220000 },
      ],
    },
  ]);

  assert.equal(growth.trackedSince, '2026-06-05');
  assert.equal(growth.pointCount, 2);
  assert.equal(growth.points[0].date, '2026-06-05');
  assert.equal(growth.points[0].pnl, 0);
  assert.equal(growth.points[1].date, '2026-06-06');
  assert.equal(growth.points[1].invested, 1000000);
  assert.equal(growth.points[1].currentValue, 997000);
  assert.equal(growth.points[1].pnl, -3000);
  assert.equal(growth.points[1].pnlPct, -0.3);
  assert.equal(growth.summary.pnl, -3000);
});

test('INDmoney US stock category P&L groups only provided US holdings by sector', () => {
  const categories = buildUsStockCategoryPnl([
    { ticker: 'NVDA', sector: 'AI infra', invested: 100, currentValue: 90, currency: 'USD' },
    { ticker: 'MU', sector: 'AI infra', invested: 200, currentValue: 250, currency: 'USD' },
    { ticker: 'GOOGL', sector: 'AI spenders', invested: 300, currentValue: 270, currency: 'USD' },
  ]);
  const byLabel = Object.fromEntries(categories.map((row) => [row.label, row]));

  assert.equal(byLabel['AI infra'].invested, 300);
  assert.equal(byLabel['AI infra'].currentValue, 340);
  assert.equal(byLabel['AI infra'].pnl, 40);
  assert.equal(byLabel['AI spenders'].pnl, -30);
});

test('US portfolio positions reconstruct holdings before the June 5 AVGO buy', () => {
  const portfolio = {
    US: {
      holdings: [
        { ticker: 'AVGO', quantity: 3.005015, invested: 1276.14 },
        { ticker: 'NVDA', quantity: 16.403526116, invested: 3612.24 },
      ],
      orders: [
        {
          filledAt: '2026-06-05 01:02 IST',
          ticker: 'AVGO',
          side: 'BUY',
          quantity: 1,
          avgPrice: 420.46,
          orderValue: 420.46,
        },
      ],
    },
  };

  const positions = reconstructUsPortfolioPositionsAt(portfolio, '2026-06-05 00:00:00 IST');
  const byTicker = Object.fromEntries(positions.map((row) => [row.ticker, row]));

  assert.equal(byTicker.AVGO.quantity, 2.005015);
  assert.equal(byTicker.AVGO.invested, 855.68);
  assert.equal(byTicker.NVDA.quantity, 16.403526116);
});

test('US portfolio point calculates current value and P&L from aligned prices', () => {
  const point = buildUsPortfolioSeriesPoint({
    timestamp: '2026-06-05T15:00:00.000Z',
    positions: [
      { ticker: 'AAPL', quantity: 2, invested: 180 },
      { ticker: 'MSFT', quantity: 1, invested: 90 },
    ],
    prices: { AAPL: 100, MSFT: 80 },
    source: 'test',
  });

  assert.equal(point.currentValue, 280);
  assert.equal(point.invested, 270);
  assert.equal(point.pnl, 10);
  assert.equal(point.pnlPct, 3.7);
});

test('current holdings baseline reprices current quantities at the June 5 close', () => {
  const baseline = buildCurrentHoldingsBaseline([
    { ticker: 'NVDA', name: 'NVIDIA', units: 2, lastPrice: 120 },
    { ticker: 'MSFT', name: 'Microsoft', units: 1.5, currentValue: 330 },
  ], {
    NVDA: 100,
    MSFT: 200,
  });

  assert.equal(baseline.baselineDate, '2026-06-05');
  assert.equal(baseline.baselineMethod, 'current_holdings_repriced');
  assert.equal(baseline.baselineValueUsd, 500);
  assert.equal(baseline.latestValueUsd, 570);
  assert.equal(baseline.changeUsd, 70);
  assert.equal(baseline.changePct, 14);
  assert.equal(baseline.holdings[0].baselineValue, 200);
  assert.equal(baseline.holdings[1].latestValue, 330);
});

test('current holdings baseline tolerates missing baseline prices', () => {
  const baseline = buildCurrentHoldingsBaseline([
    { ticker: 'NVDA', units: 2, lastPrice: 120 },
    { ticker: 'AMD', units: 1, lastPrice: 80 },
  ], {
    NVDA: 100,
  });

  assert.deepEqual(baseline.missingBaselineTickers, ['AMD']);
  assert.equal(baseline.baselineValueUsd, 200);
  assert.equal(baseline.latestValueUsd, 320);
});

test('current holdings repriced series keeps the June 5 baseline invested constant', () => {
  const series = buildCurrentHoldingsRepricedSeries({
    rows: [
      { ticker: 'NVDA', units: 2, lastPrice: 120 },
      { ticker: 'MSFT', units: 1, lastPrice: 90 },
    ],
    baselineValueUsd: 280,
    snapshots: [
      { timestamp: '2026-06-10T00:00:00.000Z', prices: { NVDA: 110, MSFT: 85 } },
      { timestamp: '2026-06-11T00:00:00.000Z', prices: { NVDA: 115, MSFT: 87 } },
    ],
    fallbackLatestTimestamp: '2026-06-11T15:30:00.000Z',
  });

  assert.equal(series.length, 3);
  assert.equal(series[0].invested, 280);
  assert.equal(series[0].currentValue, 305);
  assert.equal(series[1].currentValue, 317);
  assert.equal(series[2].currentValue, 330);
  assert.equal(series[2].pnl, 50);
  assert.equal(series[2].pnlPct, 17.86);
});

test('US portfolio series appends by hour and filters dashboard ranges', () => {
  const first = appendUsPortfolioSeriesPoint([], {
    timestamp: '2026-06-05T15:05:00.000Z',
    currentValue: 100,
    invested: 100,
  });
  const replaced = appendUsPortfolioSeriesPoint(first.series, {
    timestamp: '2026-06-05T15:20:00.000Z',
    currentValue: 110,
    invested: 100,
  });
  const next = appendUsPortfolioSeriesPoint(replaced.series, {
    timestamp: '2026-06-11T15:00:00.000Z',
    currentValue: 130,
    invested: 100,
  });

  assert.equal(replaced.appended, false);
  assert.equal(replaced.series.length, 1);
  assert.equal(replaced.series[0].currentValue, 110);
  assert.equal(next.series.length, 2);
  assert.equal(filterUsPortfolioSeriesByRange(next.series, '1d', new Date('2026-06-11T16:00:00.000Z')).length, 1);
  assert.equal(filterUsPortfolioSeriesByRange(next.series, 'all', new Date('2026-06-11T15:00:00.000Z')).length, 2);

  const payload = buildUsPortfolioSeriesPayload(next.series, { range: 'all', currency: 'USD' });
  assert.equal(payload.valuePoints.length, 2);
  assert.equal(payload.pnlPoints.at(-1).value, 30);
});

test('INDmoney asset class P&L follows allocation rows', () => {
  const rows = buildAssetClassPnl([
    { label: 'US_STOCK', invested: 1128266.89, value: 1091157 },
    { label: 'EPF', invested: 572639, value: 572639 },
    { label: 'SA', invested: 157785.54, value: 157785.54 },
    { label: 'NPS', invested: 88553.2, value: 122069.93 },
    { label: 'US_STOCK_WALLET', invested: 13198.93, value: 13198.93 },
  ]);
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));

  assert.equal(rows.length, 5);
  assert.equal(byLabel.US_STOCK.pnl, -37109.89);
  assert.equal(byLabel.EPF.pnl, 0);
  assert.equal(byLabel.NPS.pnl, 33516.73);
  assert.equal(byLabel.US_STOCK_WALLET.currency, 'INR');
});

test('INDmoney US holding allocations fill sector and market-cap panels', () => {
  const rows = [
    { ticker: 'NVDA', sector: 'AI infra', currentValue: 3000, invested: 3200, marketCap: 4963420, currency: 'USD' },
    { ticker: 'MU', sector: 'AI infra', currentValue: 1000, invested: 900, marketCap: 974373.44, currency: 'USD' },
    { ticker: 'SMCI', sector: 'AI infra', currentValue: 500, invested: 700, marketCap: 25043128800, currency: 'USD' },
    { ticker: 'GOOGL', sector: 'AI spenders', currentValue: 2500, invested: 2600, marketCap: 2144844600000, currency: 'USD' },
  ];
  const sectorRows = buildUsHoldingSectorAllocations(rows);
  const marketCapRows = buildUsHoldingMarketCapAllocations(rows);
  const sectorByLabel = Object.fromEntries(sectorRows.map((row) => [row.label, row]));
  const capByLabel = Object.fromEntries(marketCapRows.map((row) => [row.label, row]));

  assert.equal(sectorByLabel['AI infra'].value, 4500);
  assert.equal(sectorByLabel['AI infra'].percent, 64.29);
  assert.equal(sectorByLabel['AI spenders'].value, 2500);
  assert.equal(capByLabel['Mega Cap'].value, 6500);
  assert.equal(capByLabel['Large Cap'].value, 500);
});

test('INDmoney dashboard payload normalizes holdings without NaN values', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 200000,
      total_invested: 150000,
      total_current_value: 190000,
      investments: [
        { asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 },
        { asset_type: 'EPF', invested_value: 50000, current_value: 50000 },
      ],
    },
    holdings: {
      US_STOCK: {
        holdings: [
          { investment: 'NVIDIA', ticker: 'NVDA', market_value: 50000, invested_amount: 42000, total_pnl: 8000 },
          { investment: 'Alphabet', ticker: 'GOOGL', market_value: 25000, invested_amount: 27000, sector: 'AI spenders', marketCap: 2144844600000, currency: 'USD' },
          { investment: 'Empty row' },
        ],
      },
    },
    watchlist: { watchlists: [{ stocks: [{ ticker: 'NVDA', ind_key: 'US123' }] }] },
    usWatchlist: { watchlists: [{ stocks: [{ ticker: 'AAPL' }] }] },
    history: [
      {
        timestamp: '2026-06-06T00:00:00.000Z',
        date: '2026-06-06',
        totalNetworth: 200000,
        investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
      },
    ],
  });

  assert.equal(payload.summary.totalNetworth, 97000);
  assert.equal(payload.summary.totalReturn, -3000);
  assert.equal(payload.holdings.US_STOCK.length, 2);
  assert.equal(payload.holdings.US_STOCK[0].currentValue, 50000);
  assert.equal(Number.isNaN(payload.holdings.US_STOCK[0].currentValue), false);
  assert.equal(payload.watchlist.watchlists[0].stocks[0].ticker, 'AAPL');
  assert.equal(payload.usWatchlist.watchlists[0].stocks[0].ticker, 'AAPL');
  assert.equal(payload.usStockPnl.summary.pnl, -3000);
  assert.equal(payload.usStockPnl.categories.length, 2);
  assert.equal(payload.assetClassPnl.length, 1);
  assert.equal(payload.assetClassPnl[0].label, 'US_STOCK');
  assert.equal(payload.assetClassPnl[0].pnl, -3000);
  assert.equal(payload.allocations.sector.some((row) => row.label === 'AI spenders'), true);
  assert.equal(payload.allocations.marketCap.some((row) => row.label === 'Mega Cap'), true);
});

test('INDmoney dashboard payload applies extended-hours prices to US stock P&L', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 147000,
      total_invested: 150000,
      total_current_value: 147000,
      investments: [
        { asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 },
        { asset_type: 'EPF', invested_value: 50000, current_value: 50000 },
      ],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          units: 10,
          invested: 1000,
          currentValue: 970,
          regularPrice: 97,
          extendedPrice: 99,
          previousClose: 95,
          moveBasis: 'pre-market',
          currency: 'USD',
        },
      ],
    },
    history: [
      {
        timestamp: '2026-06-06T00:00:00.000Z',
        date: '2026-06-06',
        investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
      },
    ],
    sessionMeta: { usSession: 'pre-market' },
  });

  const usStock = payload.assetClassPnl.find((row) => row.label === 'US_STOCK');
  assert.equal(payload.usSessionPnl.basis, 'pre-market');
  assert.equal(payload.usSessionPnl.overall.basis, 'pre-market');
  assert.equal(payload.usSessionPnl.overall.valueInr, 99000);
  assert.equal(payload.usSessionPnl.overall.pnlInr, -1000);
  assert.equal(payload.usSessionPnl.actual.basis, 'regular-close');
  assert.equal(payload.usSessionPnl.actual.valueInr, 97000);
  assert.equal(payload.usSessionPnl.actual.pnlInr, -3000);
  assert.equal(payload.usSessionPnl.oneDay.currentValueInr, 99000);
  assert.equal(payload.usSessionPnl.oneDay.previousCloseValueInr, 97000);
  assert.equal(payload.usSessionPnl.oneDay.pnlInr, 2000);
  assert.equal(payload.usSessionPnl.oneDay.pnlPct, 2.06);
  assert.equal(payload.holdings.US_STOCK[0].oneDayReturn, 20);
  assert.equal(payload.holdings.US_STOCK[0].oneDayReturnPct, 2.11);
  assert.equal(payload.usSessionPnl.oneDayPnlUsd, 20);
  assert.equal(payload.usSessionPnl.oneDayPnlPct, 2.11);
  assert.equal(payload.usSessionPnl.extendedValueInr, 99000);
  assert.equal(payload.usSessionPnl.officialCurrentValueInr, 97000);
  assert.equal(usStock.currentValue, 99000);
  assert.equal(usStock.invested, 100000);
  assert.equal(usStock.pnl, -1000);
  assert.equal(usStock.officialPnl, -3000);
  assert.equal(payload.summary.totalCurrentValue, 99000);
  assert.equal(payload.summary.totalInvested, 100000);
  assert.equal(payload.summary.totalReturn, -1000);
  assert.equal(payload.usStockPnl.summary.pnl, -1000);
});

test('INDmoney dashboard payload does not inflate invested capital when holdings stay INR and live prices are USD', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 97000,
      total_invested: 100000,
      total_current_value: 97000,
      investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          total_units: 10,
          invested_amount: 100000,
          market_value: 97000,
          regularPrice: 97,
          extendedPrice: 99,
          moveBasis: 'Pre-market',
          currency: 'INR',
          lastPriceCurrency: 'USD',
          regularPriceCurrency: 'USD',
        },
      ],
    },
    history: [
      {
        timestamp: '2026-06-06T00:00:00.000Z',
        date: '2026-06-06',
        investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
      },
    ],
    sessionMeta: { usSession: 'pre-market' },
  });

  assert.equal(payload.usSessionPnl.investedUsd, 1000);
  assert.equal(payload.usSessionPnl.investedInr, 100000);
  assert.equal(payload.usSessionPnl.extendedValueInr, 99000);
  assert.equal(payload.usSessionPnl.overall.valueInr, 99000);
  assert.equal(payload.usSessionPnl.actual.valueInr, 97000);
  assert.equal(payload.usSessionPnl.oneDay.previousCloseValueInr, 97000);
  assert.equal(payload.usSessionPnl.oneDay.pnlInr, 2000);
  assert.equal(payload.assetClassPnl[0].invested, 100000);
  assert.equal(payload.assetClassPnl[0].currentValue, 99000);
  assert.equal(payload.summary.totalInvested, 100000);
  assert.equal(payload.summary.totalCurrentValue, 99000);
  assert.equal(payload.summary.totalReturn, -1000);
  assert.equal(payload.summary.totalReturnPct, -1);
});

test('INDmoney dashboard holdings P&L keeps INDmoney accounting values during extended-hours', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 97000,
      total_invested: 100000,
      total_current_value: 97000,
      investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          units: 10,
          invested: 1000,
          currentValue: 970,
          pnl: -30,
          pnlPct: -3,
          regularPrice: 97,
          extendedPrice: 99,
          moveBasis: 'Pre-market',
          currency: 'USD',
        },
      ],
    },
    history: [
      {
        timestamp: '2026-06-06T00:00:00.000Z',
        date: '2026-06-06',
        investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
      },
    ],
  });

  const holding = payload.holdings.US_STOCK[0];
  assert.equal(holding.currentValue, 970);
  assert.equal(holding.pnl, -30);
  assert.equal(holding.pnlPct, -3);
  assert.equal(holding.regularValue, 970);
  assert.equal(holding.regularPnl, -30);
  assert.equal(holding.extendedValue, 990);
  assert.equal(holding.extendedReturn, -10);
});

test('INDmoney dashboard payload uses regular-market live prices for overall and close snapshot for actual', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 97000,
      total_invested: 100000,
      total_current_value: 97000,
      investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          units: 10,
          invested: 1000,
          currentValue: 970,
          regularPrice: 97,
          previousClose: 95,
          moveBasis: 'regular',
          currency: 'USD',
        },
      ],
    },
    history: [],
    sessionMeta: { usSession: 'live' },
  });

  assert.equal(payload.usSessionPnl.overall.basis, 'regular');
  assert.equal(payload.usSessionPnl.overall.valueInr, 97000);
  assert.equal(payload.usSessionPnl.actual.valueInr, 97000);
  assert.equal(payload.usSessionPnl.overall.pnlInr, -3000);
  assert.equal(payload.usSessionPnl.actual.pnlInr, -3000);
  assert.equal(payload.usSessionPnl.oneDay.pnlInr, 0);
});

test('INDmoney dashboard payload falls back to regular for overall when extended price is unavailable', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 97000,
      total_invested: 100000,
      total_current_value: 97000,
      investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          units: 10,
          invested: 1000,
          currentValue: 970,
          regularPrice: 97,
          previousClose: 95,
          moveBasis: 'pre-market',
          currency: 'USD',
        },
      ],
    },
    history: [],
    sessionMeta: { usSession: 'pre-market' },
  });

  assert.equal(payload.usSessionPnl.overall.basis, 'pre-market');
  assert.equal(payload.usSessionPnl.overall.valueInr, 97000);
  assert.equal(payload.usSessionPnl.actual.valueInr, 97000);
  assert.equal(payload.usSessionPnl.oneDay.pnlInr, 0);
});

test('INDmoney dashboard payload computes headline 1D P&L from official close even without holdings day data', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 97000,
      total_invested: 100000,
      total_current_value: 97000,
      investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          units: 10,
          invested: 1000,
          currentValue: 970,
          regularPrice: 97,
          extendedPrice: 99,
          moveBasis: 'post-market',
          currency: 'USD',
        },
      ],
    },
    history: [],
    sessionMeta: { usSession: 'post-market' },
  });

  assert.equal(payload.usSessionPnl.oneDayPnlUsd, null);
  assert.equal(payload.usSessionPnl.oneDay.previousCloseValueInr, 97000);
  assert.equal(payload.usSessionPnl.oneDay.currentValueInr, 99000);
  assert.equal(payload.usSessionPnl.oneDay.pnlInr, 2000);
  assert.equal(payload.usSessionPnl.oneDay.pnlPct, 2.06);
});

test('applyLiveUsSessionPricing reconciles inconsistent USD session values from INR basis', () => {
  const payload = applyLiveUsSessionPricing({
    fxRate: 95.37,
    sessionMeta: { usSession: 'pre-market' },
    summary: {},
    assetClassPnl: [{ label: 'US_STOCK', invested: 1128267, currentValue: 1101117, pnl: -27150, pnlPct: -1.52 }],
    usSessionPnl: {
      basis: 'pre-market',
      fxRate: 95.37,
      investedInr: 1128267,
      investedUsd: 11830.54,
      extendedValueInr: 1101117,
      extendedValueUsd: 11545.86,
      extendedPnlInr: -27150,
      extendedPnlUsd: -174.86,
      extendedPnlPct: -1.52,
      officialCurrentValueInr: 1092157,
      officialPnlInr: -37110,
      officialPnlUsd: -285.12,
      officialPnlPct: -3.29,
      reference: {
        investedInr: 1128267,
        investedUsd: 11830.54,
        officialCloseValueInr: 1092157,
        officialCloseValueUsd: 11451.91,
      },
    },
  });

  assert.equal(payload.usSessionPnl.overall.valueUsd, 11545.86);
  assert.equal(payload.usSessionPnl.overall.pnlUsd, -284.68);
  assert.equal(payload.usSessionPnl.actual.valueUsd, 11451.91);
  assert.equal(payload.usSessionPnl.actual.pnlUsd, -389.12);
  assert.equal(payload.usSessionPnl.oneDay.pnlUsd, 93.95);
  assert.equal(payload.assetClassPnl[0].pnl, -27150);
  assert.equal(payload.summary.totalReturn, -27150);
});

test('applyLiveUsSessionPricing recomputes carried-over session pnl pct from final invested values', () => {
  const payload = applyLiveUsSessionPricing({
    fxRate: 95.3685,
    sessionMeta: { usSession: 'pre-market' },
    summary: {},
    assetClassPnl: [{ label: 'US_STOCK', invested: 1146223, currentValue: 1149792, pnl: 3570, pnlPct: 3.76 }],
    usSessionPnl: {
      basis: 'pre-market',
      fxRate: 95.3685,
      investedInr: 1146223,
      investedUsd: 12018.82,
      regularValueInr: 1108522.55,
      regularValueUsd: 11623.51,
      regularPnlInr: -37700.45,
      regularPnlUsd: -395.31,
      regularPnlPct: -3.29,
      extendedValueInr: 1149792.21,
      extendedValueUsd: 12056.25,
      extendedPnlInr: 3569.21,
      extendedPnlUsd: 37.43,
      extendedPnlPct: 3.76,
      officialCurrentValueInr: 1108522.55,
      officialPnlInr: -37700.45,
      officialPnlUsd: -395.31,
      officialPnlPct: -3.29,
      reference: {
        investedInr: 1146223,
        investedUsd: 12018.82,
        officialCloseValueInr: 1108522.55,
        officialCloseValueUsd: 11623.51,
      },
    },
  });

  assert.equal(payload.usSessionPnl.overall.pnlInr, 3569.21);
  assert.equal(payload.usSessionPnl.overall.pnlUsd, 37.43);
  assert.equal(payload.usSessionPnl.overall.pnlPct, 0.31);
  assert.equal(payload.assetClassPnl[0].pnlPct, 0.31);
  assert.equal(payload.summary.totalReturnPct, 0.31);
  assert.equal(payload.usSessionPnl.oneDay.pnlInr, 41269.66);
  assert.equal(payload.usSessionPnl.oneDay.pnlPct, 3.72);
  assert.equal(payload.usSessionPnl.actual.pnlPct, -3.29);
});

test('applyLiveUsSessionPricing keeps explicit usd values on reconciled asset class rows', () => {
  const payload = applyLiveUsSessionPricing({
    fxRate: 95.37,
    sessionMeta: { usSession: 'pre-market' },
    summary: {},
    assetClassPnl: [{ label: 'US_STOCK', invested: 1128267, currentValue: 1095475, pnl: -32792, pnlPct: -2.91 }],
    usSessionPnl: {
      basis: 'pre-market',
      fxRate: 95.37,
      investedInr: 1128267,
      investedUsd: 11830.54,
      extendedValueInr: 1095475,
      extendedValueUsd: 11390.37,
      extendedPnlInr: -32792,
      extendedPnlUsd: -340.96,
      extendedPnlPct: -2.91,
      officialCurrentValueInr: 1091157,
      officialPnlInr: -37110,
      officialPnlUsd: -385.86,
      officialPnlPct: -3.29,
      reference: {
        investedInr: 1128267,
        investedUsd: 11830.54,
        officialCloseValueInr: 1091157,
        officialCloseValueUsd: 11435.48,
      },
    },
  });

  assert.equal(payload.assetClassPnl[0].investedUsd, 11830.54);
  assert.equal(payload.assetClassPnl[0].currentValueUsd, 11390.37);
  assert.equal(payload.assetClassPnl[0].pnlUsd, -340.96);
});

test('INDmoney holdings dedupe merges malformed duplicate rows by canonical US ticker', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'Amazon.com Inc',
      ticker: 'AMZN',
      invested: 40000,
      units: 3.768249908,
      current_value: 39000,
    },
    {
      name: 'Amazon.com, Inc. Common Stock',
      ticker: '2',
      investment: 'Amazon.com, Inc. Common Stock',
      invested: 40000,
      units: 3.768249908,
      value: 39000,
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].ticker, 'AMZN');
});

test('INDmoney holdings resolves known US tickers from broker company names', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      investment_code: '113321',
      investment: 'Taiwan Semiconductor Manufacturing Company Ltd.',
      asset_type: 'US_STOCK',
      invested_amount: 60887.31,
      market_value: 63462.5,
      total_units: 1.556758458,
      unit_price: 40765.8,
      broker: '2',
    },
    {
      investment_code: '120138',
      investment: 'Broadcom Inc. Common Stock',
      asset_type: 'US_STOCK',
      invested_amount: 121572,
      market_value: 112264.72,
      total_units: 3.005015021,
      unit_price: 37359.12,
      broker: '2',
    },
  ]);

  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'TSM');
  assert.equal(holdings[1].ticker, 'AVGO');
});

test('INDmoney holdings map SpaceX to SPCX and keep future name-only rows visible', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      investment_code: '203532',
      investment: 'SpaceX',
      invested_amount: 33722.39,
      market_value: 4442.58,
      total_units: 2.127795825,
      unit_price: 2087.88,
      broker: '2',
    },
    {
      investment_code: '998877',
      investment: 'Private Growth Fund',
      invested_amount: 1200,
      market_value: 1000,
      total_units: 3,
      unit_price: 333.33,
      broker: '2',
    },
  ]);

  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'SPCX');
  assert.equal(holdings[0].name, 'SpaceX');
  assert.equal(holdings[1].ticker, 'PGF');
  assert.equal(holdings[1].name, 'Private Growth Fund');
});

test('INDmoney holdings default to INR when currency is missing', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'NVIDIA',
      ticker: 'NVDA',
      invested: 1000,
      currentValue: 950,
      pnl: -50,
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].currency, 'INR');
});

test('INDmoney holdings prefers source/normalized currency metadata over explicit currency', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'NVIDIA',
      ticker: 'NVDA',
      invested: 1000,
      currentValue: 950,
      currency: 'USD',
      sourceCurrency: 'INR',
      normalizedCurrency: 'USD',
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].currency, 'INR');
});

test('INDmoney holdings keeps broker unit price as same-currency fallback without live quote', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'Taiwan Semiconductor Manufacturing',
      ticker: 'TSM',
      invested_amount: 39712,
      market_value: 40796,
      total_units: 1,
      unit_price: 427.92,
      currency: 'INR',
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].currency, 'INR');
  assert.equal(holdings[0].currentValue, 40796);
  assert.equal(holdings[0].lastPrice, 427.92);
  assert.equal(holdings[0].lastPriceCurrency, 'INR');
});

test('INDmoney holdings uses live USD quote for last price while preserving INR value', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'Taiwan Semiconductor Manufacturing',
      ticker: 'TSM',
      invested_amount: 39712,
      market_value: 40796,
      total_units: 1,
      unit_price: 427.92,
      lastPrice: 409,
      lastPriceCurrency: 'USD',
      currency: 'INR',
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].currency, 'INR');
  assert.equal(holdings[0].currentValue, 40796);
  assert.equal(holdings[0].lastPrice, 409);
  assert.equal(holdings[0].lastPriceCurrency, 'USD');
});

test('INDmoney holdings recompute 1D return from USD quotes for INR-backed rows', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'Micron Technology',
      ticker: 'MU',
      invested_amount: 154823,
      market_value: 186512,
      total_units: 2.192765859,
      lastPrice: 891.88,
      lastPriceCurrency: 'USD',
      previousClose: 988.58,
      oneDayReturn: 0,
      oneDayReturnPct: 0,
      currency: 'INR',
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].currency, 'INR');
  assert.equal(holdings[0].lastPriceCurrency, 'USD');
  assert.equal(holdings[0].oneDayReturn, -212.04);
  assert.equal(holdings[0].oneDayReturnPct, -9.78);
});

test('INDmoney holdings keeps INR average price when live USD quote is merged', () => {
  const holdings = normalizeIndMoneyHoldings([
    {
      name: 'Taiwan Semiconductor Manufacturing Company Ltd.',
      ticker: 'TSM',
      invested_amount: 60887.31,
      market_value: 63462.5,
      total_units: 1.556758458,
      avgPrice: 39111.5972,
      lastPrice: 408.75,
      lastPriceCurrency: 'USD',
      currency: 'INR',
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].avgPrice, 39111.5972);
  assert.equal(holdings[0].avgPriceCurrency, 'INR');
  assert.equal(holdings[0].lastPrice, 408.75);
  assert.equal(holdings[0].lastPriceCurrency, 'USD');
});

test('INDmoney dashboard holdings P&L prefers INDmoney imported value over live regular price', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_networth: 97000,
      total_invested: 100000,
      total_current_value: 97000,
      investments: [{ asset_type: 'US_STOCK', invested_value: 100000, current_value: 97000 }],
    },
    holdings: {
      US_STOCK: [
        {
          name: 'NVIDIA',
          ticker: 'NVDA',
          units: 16.403526116,
          invested: 3612.91,
          currentValue: 3364,
          pnl: -248,
          pnlPct: -6.86,
          lastPrice: 208.28,
          moveBasis: 'regular',
          currency: 'USD',
        },
      ],
    },
    history: [],
  });

  const holding = payload.holdings.US_STOCK[0];
  assert.equal(holding.currentValue, 3364);
  assert.equal(holding.pnl, -248);
  assert.equal(holding.pnlPct, -6.86);
  assert.equal(holding.regularValue, 3364);
  assert.equal(holding.regularPnl, -248);
  assert.equal(holding.lastPrice, 208.28);
  assert.equal(holding.lastPriceCurrency, 'USD');
});

test('INDmoney dashboard payload falls back to latest saved asset classes when live snapshot is sparse', () => {
  const payload = normalizeIndMoneyDashboardPayload({
    networth: {
      total_invested: 11874.53,
      total_current_value: 11489.48,
    },
    holdings: {},
    history: [
      {
        timestamp: '2026-06-08T00:00:00.000Z',
        date: '2026-06-08',
        investments: [
          { asset_type: 'US_STOCK', invested_value: 1128266.89, current_value: 1091157 },
          { asset_type: 'EPF', invested_value: 572639, current_value: 572639 },
        ],
      },
    ],
  });

  assert.equal(payload.assetClassPnl[0].label, 'US_STOCK');
  assert.equal(payload.assetClassPnl[0].pnl, -37109.89);
});
