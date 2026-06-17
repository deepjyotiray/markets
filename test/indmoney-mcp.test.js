import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFundamentalSnapshotFromMcpUsDetails,
  createIndMoneyMcpProvider,
  normalizeMcpUsHoldingsForAlertEngine,
  normalizeMcpUsStockDetails,
  normalizeMcpWatchlists,
  parseMcpToolResult,
  validateIndMoneyAssetType,
  validateIndMoneyBreakdownType,
} from '../src/portfolio-alerts/indmoney-mcp.js';

test('MCP tool result parser unwraps JSON string results', () => {
  assert.deepEqual(parseMcpToolResult({ result: '{"ok":true,"items":[1]}' }), { ok: true, items: [1] });
  assert.equal(parseMcpToolResult({ result: 'plain text' }), 'plain text');
});

test('MCP tool result parser unwraps streamable HTTP structuredContent envelopes', () => {
  assert.deepEqual(
    parseMcpToolResult({
      content: [{ type: 'text', text: '{"ok":false}' }],
      structuredContent: { result: '{"ok":true,"total_networth":100}' },
      isError: false,
    }),
    { ok: true, total_networth: 100 },
  );
});

test('MCP provider supports function-based clients', async () => {
  const provider = createIndMoneyMcpProvider({
    client: {
      networth_snapshot() {
        return { result: '{"total_networth":100}' };
      },
    },
  });
  assert.equal(provider.isAvailable(), true);
  assert.deepEqual(await provider.networthSnapshot(), { total_networth: 100 });
});

test('watchlist normalization removes empty instrument rows', () => {
  const normalized = normalizeMcpWatchlists({
    watchlists: [{
      name: 'Top Picks',
      stocks: [
        { ind_key: 'NVDA', ticker: 'NVDA' },
        { ind_key: '', ticker: null },
        { ind_key: 'INDI00012', ticker: null },
      ],
    }],
  });
  assert.deepEqual(normalized.watchlists[0].stocks, [
    { ind_key: 'NVDA', ticker: 'NVDA' },
    { ind_key: 'INDI00012', ticker: null },
  ]);
});

test('US stock details normalize quote, analyst, and news fields', () => {
  const details = normalizeMcpUsStockDetails({
    NVDA: {
      entity_basic: { name: 'NVIDIA Corporation', market_cap_in_currency: 5200, mycroft_id: '115382' },
      entity_stats: {
        live_price: 205.1,
        prev_close: 218.66,
        day_change: -13.56,
        day_change_percentage: -6.2,
        last_updated: '2026-06-06 08:45:53',
        volume: 229350610,
      },
      analyst_forecast: {
        consensus: { sentiment: 'BUY' },
        target_price: { mean: 298.07, upside_per: 31.19 },
      },
      news: [{ title: 'AI demand', sentiment: 'positive' }],
    },
  });
  assert.equal(details.NVDA.price, 205.1);
  assert.equal(details.NVDA.analystTargetPrice, 298.07);
  assert.equal(details.NVDA.news[0].sentiment, 'positive');

  const snapshot = buildFundamentalSnapshotFromMcpUsDetails('NVDA', details.NVDA);
  assert.equal(snapshot.source, 'INDmoney MCP');
  assert.match(snapshot.summary, /analyst BUY/);
});

test('US holdings normalize INR MCP rows into USD alert-engine snapshots', () => {
  const snapshot = normalizeMcpUsHoldingsForAlertEngine({
    usdInrRate: 80,
    stockProfiles: {
      NVDA: { name: 'NVIDIA Corporation' },
      MU: { name: 'Micron Technology Inc' },
          },
    detailsPayload: {
      NVDA: {
        entity_basic: { name: 'NVIDIA Corporation', mycroft_id: '115382' },
        entity_stats: { live_price: 200, prev_close: 190, day_change_percentage: 5.26 },
        },
    },
    holdingsPayload: {
      holdings: [
        {
          investment_code: '115382',
          investment: 'NVIDIA Corporation Common Stock',
          invested_amount: 8000,
          market_value: 10000,
          total_pnl: 2000,
          total_units: 2,
          unit_price: 5000,
        },
        {
          investment_code: '114846',
          investment: 'Micron Technology, Inc. Common Stock',
          invested_amount: 4000,
          market_value: 3600,
          total_pnl: -400,
          total_units: 1,
          unit_price: 3600,
        },
        {
          ticker: 'ORCL',
          investment: 'Oracle Corporation',
          invested_amount: 1600,
          market_value: 400,
          total_pnl: -1200,
          total_units: 10,
          unit_price: 40,
        },
      ],
    },
  });

  assert.equal(snapshot.source, 'INDmoney MCP');
  assert.equal(snapshot.summary.portfolioValue, 175);
  assert.equal(snapshot.summary.investedValue, 170);
  assert.equal(snapshot.summary.totalReturns, 5);
  const byTicker = Object.fromEntries(snapshot.holdings.map((holding) => [holding.ticker, holding]));
  assert.equal(byTicker.NVDA.currentValueUsd, 125);
  assert.equal(byTicker.NVDA.livePrice, 200);
  assert.equal(byTicker.MU.totalActualReturnUsd, -5);
  assert.equal(byTicker.ORCL.name, 'Oracle Corporation');
});

test('US holdings keep name-only MCP rows and map SpaceX to SPCX', () => {
  const snapshot = normalizeMcpUsHoldingsForAlertEngine({
    usdInrRate: 80,
    holdingsPayload: {
      holdings: [
        {
          investment_code: '203532',
          investment: 'SpaceX',
          invested_amount: 8000,
          market_value: 10000,
          total_pnl: 2000,
          total_units: 2,
          unit_price: 5000,
        },
        {
          investment_code: '998877',
          investment: 'Private Growth Fund',
          invested_amount: 4000,
          market_value: 3600,
          total_pnl: -400,
          total_units: 1,
          unit_price: 3600,
        },
      ],
    },
  });

  const byTicker = Object.fromEntries(snapshot.holdings.map((holding) => [holding.ticker, holding]));
  assert.equal(byTicker.SPCX.name, 'SpaceX');
  assert.equal(byTicker.SPCX.currentValueUsd, 125);
  assert.equal(byTicker.PGF.name, 'Private Growth Fund');
  assert.equal(byTicker.PGF.totalActualReturnUsd, -5);
});

test('INDmoney enum validation accepts expected endpoint values', () => {
  assert.equal(validateIndMoneyAssetType('us_stock'), 'US_STOCK');
  assert.equal(validateIndMoneyAssetType('bad'), null);
  assert.equal(validateIndMoneyBreakdownType('market_cap'), 'market_cap');
  assert.equal(validateIndMoneyBreakdownType('bad'), null);
});
