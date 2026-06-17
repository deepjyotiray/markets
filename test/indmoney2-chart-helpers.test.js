import test from 'node:test';
import assert from 'node:assert/strict';

import {
  currentMarketDayEnvelope,
  currentMarketWeekEnvelope,
  formatRangeAxisTick,
  shiftLogicalRangeToLatest,
} from '../public/indmoney2-chart-helpers.js';

test('1D axis emits hour labels by default', () => {
  assert.equal(
    formatRangeAxisTick({
      range: '1d',
      time: Date.parse('2026-06-12T10:00:00-04:00') / 1000,
      tickMarkType: 3,
      spanSeconds: 16 * 60 * 60,
    }),
    '10:00',
  );
});

test('1W default view suppresses duplicate intraday date labels', () => {
  assert.equal(
    formatRangeAxisTick({
      range: '1w',
      time: Date.parse('2026-06-10T11:00:00-04:00') / 1000,
      tickMarkType: 3,
      spanSeconds: 5 * 86400,
    }),
    '',
  );
  assert.equal(
    formatRangeAxisTick({
      range: '1w',
      time: Date.parse('2026-06-10T04:00:00-04:00') / 1000,
      tickMarkType: 1,
      spanSeconds: 5 * 86400,
    }),
    'Jun 10',
  );
});

test('multi-day views switch to intraday labels after zooming in', () => {
  assert.equal(
    formatRangeAxisTick({
      range: '1w',
      time: Date.parse('2026-06-10T11:00:00-04:00') / 1000,
      tickMarkType: 3,
      spanSeconds: 36 * 60 * 60,
    }),
    '11:00',
  );
});

test('1D session envelope maps to pre, regular, and post market ET boundaries', () => {
  const envelope = currentMarketDayEnvelope(Date.parse('2026-06-12T13:30:00Z'));
  assert.equal(new Date(envelope.startMs).toISOString(), '2026-06-12T08:00:00.000Z');
  assert.equal(new Date(envelope.regularStartMs).toISOString(), '2026-06-12T13:30:00.000Z');
  assert.equal(new Date(envelope.regularEndMs).toISOString(), '2026-06-12T20:00:00.000Z');
  assert.equal(new Date(envelope.endMs).toISOString(), '2026-06-13T00:00:00.000Z');
});

test('current market week envelope spans Monday pre-market to Friday post-market in ET', () => {
  const envelope = currentMarketWeekEnvelope(Date.parse('2026-06-11T15:00:00Z'));
  assert.equal(new Date(envelope.startMs).toISOString(), '2026-06-08T08:00:00.000Z');
  assert.equal(new Date(envelope.endMs).toISOString(), '2026-06-13T00:00:00.000Z');
});

test('logical viewport stays attached to the latest point when new data appends at the edge', () => {
  assert.deepEqual(
    shiftLogicalRangeToLatest({ from: 90, to: 99 }, 100, 103),
    { from: 93, to: 102 },
  );
});

test('logical viewport does not move when the user is scrolled away from the latest point', () => {
  assert.deepEqual(
    shiftLogicalRangeToLatest({ from: 40, to: 70 }, 100, 103),
    { from: 40, to: 70 },
  );
});
