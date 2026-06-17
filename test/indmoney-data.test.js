import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFundamentalSnapshotFromIndMoney, parseIndMoneyStockPage } from '../src/portfolio-alerts/indmoney-data.js';

test('INDmoney parser extracts ANET fundamentals from page text', () => {
  const html = `
    <h1>Arista Networks</h1>
    <div>Market Cap</div><div>$214.9B</div>
    <div>EPS (TTM)</div><div>3.6294</div>
    <div>PE Ratio (TTM)</div><div>58.86</div>
    <div>PEG Ratio</div><div>2.195</div>
    <div>Revenue (TTM)</div><div>9.7B</div>
    <div>Profit Margin</div><div>38.32%</div>
    <div>Return On Equity TTM</div><div>31.52%</div>
    <h2>## Arista Networks Quarterly Profit & Loss</h2>
    <div>Total Revenue</div><div>2,004</div><div>2,204</div><div>2,308</div><div>2,487</div><div>2,709</div>
    <div>Gross Profit</div>
    <div>Operating Income</div><div>858</div><div>986</div><div>978</div><div>1,032</div><div>1,157</div>
    <div>EBITDA</div>
    <h2>## Arista Networks Annual Profit & Loss</h2>
    <div>Total Revenue</div><div>7,003</div><div>9,005</div>
    <div>Gross Profit</div>
    <p>Average target price of $188.2</p>
  `;
  const parsed = parseIndMoneyStockPage(html, 'ANET');
  const snapshot = buildFundamentalSnapshotFromIndMoney(parsed);

  assert.equal(parsed.peTTM, 58.86);
  assert.equal(parsed.revenueGrowthTTMYoy, 28.59);
  assert.equal(parsed.quarterlyRevenueGrowthYoY, 35.18);
  assert.equal(parsed.operatingMargin, 42.71);
  assert.equal(snapshot.qualityLabel, 'strong');
  assert.match(snapshot.summary, /INDmoney fundamentals supportive/);
});
