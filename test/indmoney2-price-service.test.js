import test from 'node:test';
import assert from 'node:assert/strict';

import { getLivePrices } from '../src/portfolio-alerts/indmoney2-price-service.js';

test('getLivePrices uses the source market timestamp for updatedAt', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 451.2,
              previousClose: 448,
              regularMarketTime: 1781444220,
              marketState: 'REGULAR',
            },
            timestamp: [1781444160, 1781444220],
            indicators: {
              quote: [{
                close: [450.5, 451.2],
                open: [449.8, 450.7],
              }],
            },
          }],
        },
      });
    },
  });

  try {
    const prices = await getLivePrices(['TSTSRC']);
    assert.equal(prices.TSTSRC.updatedAt, '2026-06-14T13:37:00.000Z');
  } finally {
    global.fetch = originalFetch;
  }
});

test('getLivePrices leaves updatedAt empty when the source omits a market timestamp', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 451.2,
              previousClose: 448,
              marketState: 'REGULAR',
            },
            timestamp: [],
            indicators: {
              quote: [{
                close: [450.5, 451.2],
                open: [449.8, 450.7],
              }],
            },
          }],
        },
      });
    },
  });

  try {
    const prices = await getLivePrices(['TSTNULL']);
    assert.equal(prices.TSTNULL.updatedAt, null);
  } finally {
    global.fetch = originalFetch;
  }
});
