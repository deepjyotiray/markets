import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildPortfolioEarningsPayload } from '../src/portfolio-alerts/portfolio-earnings.js';

const portfolio = JSON.parse(fs.readFileSync(new URL('../data/latest-portfolio.json', import.meta.url), 'utf8'));
const research = JSON.parse(fs.readFileSync(new URL('../data/portfolio-earnings-research.json', import.meta.url), 'utf8'));

test('portfolio earnings payload keeps concentration and flags intact', () => {
  const payload = buildPortfolioEarningsPayload(portfolio, research, { asOfDate: '2026-06-14' });
  assert.equal(payload.ok, true);
  assert.equal(payload.rows[0].ticker, 'NVDA');
  assert.equal(payload.upcomingCatalysts[0].ticker, 'MU');
  assert.equal(payload.upcomingCatalysts[0].date, '2026-06-24');
  assert.equal(payload.epsQualityFlags.map((item) => item.ticker).join(','), 'GOOGL,AMZN');
  assert.equal(payload.rows.length >= 8, true);
  assert.equal(payload.portfolio.top4WeightPct > 60, true);
});
