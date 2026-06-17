import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLatestUsPortfolioSnapshot,
  buildLatestUsPortfolioSnapshotFromIndMoney2Dashboard,
  choosePreferredPortfolioStore,
} from '../src/portfolio-alerts/latest-portfolio.js';

test('preferred portfolio store chooses fresher latest snapshot', () => {
  const chosen = choosePreferredPortfolioStore(
    { US: { updatedAt: '2026-06-14 10:15 IST', holdings: [{ ticker: 'NVDA' }] } },
    { US: { updatedAt: '2026-06-05 01:02 IST', holdings: [{ ticker: 'NVDA' }] } },
  );
  assert.equal(chosen.US.updatedAt, '2026-06-14 10:15 IST');
});

test('latest US portfolio snapshot builds summary from dashboard-style rows', () => {
  const snapshot = buildLatestUsPortfolioSnapshot({
    updatedAt: '2026-06-14 10:15 IST',
    summary: { portfolioValue: 300, investedValue: 250, totalReturns: 50 },
    holdings: [
      { ticker: 'NVDA', name: 'NVIDIA', units: 1, avgPrice: 100, lastPrice: 120, invested: 100, currentValue: 120, pnl: 20, pnlPct: 20 },
      { ticker: 'MU', name: 'Micron', units: 2, avgPrice: 75, lastPrice: 90, invested: 150, currentValue: 180, pnl: 30, pnlPct: 20 },
    ],
  });
  assert.equal(snapshot.summary.holdingsCount, 2);
  assert.equal(snapshot.summary.portfolioValue, 300);
  assert.equal(snapshot.summary.totalReturnsPct, 20);
  assert.equal(snapshot.holdings[0].ticker, 'NVDA');
});

test('latest US portfolio snapshot prefers indmoney2 canonical holdings fields', () => {
  const snapshot = buildLatestUsPortfolioSnapshotFromIndMoney2Dashboard({
    updatedAt: '2026-06-14T09:20:32.994Z',
    summary: {
      currentPortfolioValueUsd: 11758.06,
      investedValueUsd: 12028.74,
      actualPnlUsd: -270.68,
      actualPnlPct: -2.25,
      oneDayPnlUsd: 52.9,
      oneDayPnlPct: 0.45,
    },
    holdings: [
      {
        ticker: 'SPCX',
        name: 'SpaceX',
        quantity: 2.1278,
        avgPriceUsd: 166.8437,
        currentPriceUsd: 166.8341,
        investedUsd: 355.01,
        currentHoldingValueUsd: 354.99,
        actualPnlUsd: -0.02,
        actualPnlPct: -0.01,
        oneDayPnlPct: 3.66,
      },
    ],
  });

  assert.equal(snapshot.summary.portfolioValue, 11758.06);
  assert.equal(snapshot.summary.oneDayReturn, 52.9);
  assert.equal(snapshot.holdings[0].currentValue, 354.99);
  assert.equal(snapshot.holdings[0].lastPrice, 166.8341);
});
