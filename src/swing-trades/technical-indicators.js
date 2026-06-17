import { clamp, computePercentChange, round, toNumber } from '../portfolio-alerts/utils.js';

export function normalizeCandles(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: row.date || '',
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      close: toNumber(row.close),
      volume: toNumber(row.volume),
    }))
    .filter((row) => row.date && row.close !== null)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export function movingAverage(candles = [], period = 20, key = 'close') {
  const clean = normalizeCandles(candles);
  if (clean.length < period) return null;
  const values = clean.slice(-period).map((item) => toNumber(item[key])).filter((value) => value !== null);
  return values.length === period ? round(values.reduce((sum, value) => sum + value, 0) / period, 2) : null;
}

export function emaSeries(candles = [], period = 20, key = 'close') {
  const clean = normalizeCandles(candles);
  const multiplier = 2 / (period + 1);
  let ema = null;
  return clean.map((candle, index) => {
    const value = toNumber(candle[key]);
    if (value === null) return { date: candle.date, value: null };
    if (ema === null) {
      const seed = clean.slice(Math.max(0, index - period + 1), index + 1).map((item) => toNumber(item[key])).filter((item) => item !== null);
      ema = seed.length >= period ? seed.reduce((sum, item) => sum + item, 0) / period : value;
    } else {
      ema = (value - ema) * multiplier + ema;
    }
    return { date: candle.date, value: index + 1 >= period ? round(ema, 4) : null };
  });
}

export function rsiSeries(candles = [], period = 14) {
  const clean = normalizeCandles(candles);
  const closes = clean.map((item) => item.close);
  const points = clean.map((item) => ({ date: item.date, value: null }));
  if (closes.length <= period) return points;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  points[period].value = round(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)), 2);
  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    points[index].value = round(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)), 2);
  }
  return points;
}

export function macdSnapshot(candles = []) {
  const clean = normalizeCandles(candles);
  const ema12 = emaSeries(clean, 12);
  const ema26 = emaSeries(clean, 26);
  const macdLine = clean.map((candle, index) => {
    const fast = toNumber(ema12[index]?.value);
    const slow = toNumber(ema26[index]?.value);
    return { date: candle.date, close: fast !== null && slow !== null ? fast - slow : null };
  });
  const signal = emaSeries(macdLine, 9);
  const latestMacd = toNumber(macdLine.at(-1)?.close);
  const latestSignal = toNumber(signal.at(-1)?.value);
  const previousMacd = toNumber(macdLine.at(-2)?.close);
  const previousSignal = toNumber(signal.at(-2)?.value);
  return {
    macd: latestMacd === null ? null : round(latestMacd, 4),
    signal: latestSignal === null ? null : round(latestSignal, 4),
    histogram: latestMacd !== null && latestSignal !== null ? round(latestMacd - latestSignal, 4) : null,
    crossedUp: previousMacd !== null && previousSignal !== null && latestMacd !== null && latestSignal !== null && previousMacd <= previousSignal && latestMacd > latestSignal,
    crossedDown: previousMacd !== null && previousSignal !== null && latestMacd !== null && latestSignal !== null && previousMacd >= previousSignal && latestMacd < latestSignal,
  };
}

export function bollingerSnapshot(candles = [], period = 20) {
  const clean = normalizeCandles(candles);
  const latest = clean.at(-1);
  if (!latest || clean.length < period) return { upper: null, middle: null, lower: null, widthPct: null, positionPct: null };
  const closes = clean.slice(-period).map((item) => item.close);
  const middle = closes.reduce((sum, value) => sum + value, 0) / period;
  const variance = closes.reduce((sum, value) => sum + ((value - middle) ** 2), 0) / period;
  const deviation = Math.sqrt(variance);
  const upper = middle + deviation * 2;
  const lower = middle - deviation * 2;
  return {
    upper: round(upper, 2),
    middle: round(middle, 2),
    lower: round(lower, 2),
    widthPct: middle ? round(((upper - lower) / middle) * 100, 2) : null,
    positionPct: upper > lower ? round(clamp(((latest.close - lower) / (upper - lower)) * 100, 0, 100), 2) : null,
  };
}

export function atr(candles = [], period = 14) {
  const clean = normalizeCandles(candles);
  if (clean.length <= period) return null;
  const ranges = [];
  for (let index = 1; index < clean.length; index += 1) {
    const current = clean[index];
    const previous = clean[index - 1];
    ranges.push(Math.max(
      (current.high ?? current.close) - (current.low ?? current.close),
      Math.abs((current.high ?? current.close) - previous.close),
      Math.abs((current.low ?? current.close) - previous.close),
    ));
  }
  const values = ranges.slice(-period);
  return values.length === period ? round(values.reduce((sum, value) => sum + value, 0) / period, 2) : null;
}

export function buildTechnicalProfile(candles = [], quote = {}, benchmarkMoves = {}) {
  const clean = normalizeCandles(candles);
  const latest = clean.at(-1) || {};
  const previous = clean.at(-2) || {};
  const price = toNumber(quote.price) ?? latest.close ?? null;
  const previousClose = toNumber(quote.previousClose) ?? previous.close ?? null;
  const movePct = toNumber(quote.pctChange) ?? computePercentChange(price, previousClose);
  const rsi = rsiSeries(clean).at(-1)?.value ?? null;
  const priorRsi = rsiSeries(clean).at(-2)?.value ?? null;
  const ma20 = movingAverage(clean, 20);
  const ma50 = movingAverage(clean, 50);
  const ma200 = movingAverage(clean, 200);
  const ema21 = emaSeries(clean, 21).at(-1)?.value ?? null;
  const macd = macdSnapshot(clean);
  const bollinger = bollingerSnapshot(clean);
  const atr14 = atr(clean, 14);
  const recent = clean.slice(-20);
  const support = recent.length ? round(Math.min(...recent.map((item) => item.low ?? item.close)), 2) : null;
  const resistance = recent.length ? round(Math.max(...recent.map((item) => item.high ?? item.close)), 2) : null;
  const avgVolume20 = movingAverage(clean, 20, 'volume');
  const volume = toNumber(latest.volume) ?? toNumber(quote.volume);
  const volumeRatio = avgVolume20 && volume ? round(volume / avgVolume20, 2) : null;
  const rangePositionPct = support !== null && resistance !== null && resistance > support && price !== null
    ? round(clamp(((price - support) / (resistance - support)) * 100, 0, 100), 2)
    : null;
  const relativeStrengthVsQqq = toNumber(benchmarkMoves.QQQ) !== null && movePct !== null ? round(movePct - benchmarkMoves.QQQ, 2) : null;
  const relativeStrengthVsSpy = toNumber(benchmarkMoves.SPY) !== null && movePct !== null ? round(movePct - benchmarkMoves.SPY, 2) : null;
  const relativeStrengthVsSmh = toNumber(benchmarkMoves.SMH) !== null && movePct !== null ? round(movePct - benchmarkMoves.SMH, 2) : null;
  const gapPct = latest.open !== null && previous.close !== null ? computePercentChange(latest.open, previous.close) : null;
  const breakout = price !== null && resistance !== null && price >= resistance * 0.995 && (volumeRatio ?? 1) >= 1.1;
  const breakdown = price !== null && support !== null && price <= support * 1.005 && (volumeRatio ?? 1) >= 1.1;

  return {
    price,
    previousClose,
    movePct,
    rsi14: rsi,
    rsiDirection: rsi !== null && priorRsi !== null ? round(rsi - priorRsi, 2) : null,
    ma20,
    ma50,
    ma200,
    ema21,
    maAlignment:
      price !== null && ma20 !== null && ma50 !== null && ma200 !== null && price > ma20 && ma20 > ma50 && ma50 > ma200 ? 'bullish_stack' :
      price !== null && ma20 !== null && ma50 !== null && ma200 !== null && price < ma20 && ma20 < ma50 && ma50 < ma200 ? 'bearish_stack' :
      price !== null && ma20 !== null && ma50 !== null && price > ma20 && ma20 >= ma50 ? 'constructive' :
      price !== null && ma20 !== null && ma50 !== null && price < ma20 && ma20 <= ma50 ? 'deteriorating' :
      'mixed',
    macd,
    bollinger,
    atr14,
    support,
    resistance,
    rangePositionPct,
    volume,
    avgVolume20,
    volumeRatio,
    gapPct,
    relativeStrengthVsQqq,
    relativeStrengthVsSpy,
    relativeStrengthVsSmh,
    breakout,
    breakdown,
  };
}
