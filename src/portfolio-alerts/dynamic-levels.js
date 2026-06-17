import { clamp, compactWhitespace, formatUsd, round, toNumber } from './utils.js';

function parseDayRange(dayRange) {
  const values = String(dayRange || '').match(/[0-9,]+(?:\.\d+)?/g)?.map(toNumber).filter((value) => value !== null) || [];
  if (values.length < 2) {
    return { low: null, high: null };
  }
  return { low: Math.min(values[0], values[1]), high: Math.max(values[0], values[1]) };
}

function uniqueSorted(values, direction = 'asc') {
  const rounded = values
    .map((value) => round(value, 2))
    .filter((value) => value !== null && value > 0);
  return [...new Set(rounded)].sort((a, b) => direction === 'desc' ? b - a : a - b);
}

function nearestBelow(values, price) {
  const numericPrice = toNumber(price);
  if (numericPrice === null) {
    return null;
  }
  return uniqueSorted(values.filter((value) => toNumber(value) !== null && value <= numericPrice), 'desc')[0] ?? null;
}

function nearestAbove(values, price) {
  const numericPrice = toNumber(price);
  if (numericPrice === null) {
    return null;
  }
  return uniqueSorted(values.filter((value) => toNumber(value) !== null && value >= numericPrice))[0] ?? null;
}

function estimateAtrProxy(price, quote = {}, technical = {}) {
  const numericPrice = toNumber(price);
  if (numericPrice === null) {
    return null;
  }
  const dayRange = parseDayRange(quote.dayRange);
  if (dayRange.low !== null && dayRange.high !== null && dayRange.high > dayRange.low) {
    return round(dayRange.high - dayRange.low, 2);
  }
  const rangeLow = toNumber(technical.range20Low);
  const rangeHigh = toNumber(technical.range20High);
  if (rangeLow !== null && rangeHigh !== null && rangeHigh > rangeLow) {
    return round((rangeHigh - rangeLow) / 8, 2);
  }
  return round(Math.max(numericPrice * 0.025, 0.25), 2);
}

function labelEntryType(price, addReclaim, support, technical = {}) {
  const numericPrice = toNumber(price);
  if (technical.breakout) {
    return 'Previous day/range breakout';
  }
  if ((toNumber(technical.relativeStrengthVsQqq) || 0) >= 1 || (toNumber(technical.relativeStrengthVsSmh) || 0) >= 1) {
    return numericPrice !== null && addReclaim !== null && numericPrice >= addReclaim
      ? 'Relative strength breakout'
      : 'Relative strength reclaim';
  }
  if (numericPrice !== null && support !== null && numericPrice <= support * 1.015) {
    return 'Pullback-to-support entry';
  }
  if (addReclaim !== null) {
    return 'Breakout-retest entry';
  }
  return 'Confirmation entry';
}

export function calculateDynamicLevels(entity = {}) {
  const price = toNumber(entity.livePrice) ?? toNumber(entity.currentPrice) ?? toNumber(entity.displayQuote?.price);
  const quote = entity.quote || {};
  const technical = entity.technicalSnapshot || {};
  if (price === null || price <= 0) {
    return {
      basis: 'insufficient_data',
      confidence: 0,
      support: null,
      resistance: null,
      trimLevel: null,
      stopLevel: null,
      invalidationLevel: null,
      addReclaimLevel: null,
      target1: null,
      target2: null,
      riskReward: null,
      entryType: 'No valid entry',
      reasoning: 'Dynamic levels unavailable because current price is missing.',
    };
  }

  const dayRange = parseDayRange(quote.dayRange);
  const previousClose = toNumber(quote.previousClose) ?? toNumber(entity.displayQuote?.previousClose);
  const atrProxy = estimateAtrProxy(price, quote, technical);
  const supportCandidates = [
    technical.support,
    technical.range20Low,
    technical.ma20,
    technical.ma50,
    technical.ma200,
    previousClose,
    dayRange.low,
    atrProxy !== null ? price - atrProxy : null,
  ];
  const resistanceCandidates = [
    technical.resistance,
    technical.range20High,
    previousClose,
    dayRange.high,
    atrProxy !== null ? price + atrProxy : null,
  ];

  const support = nearestBelow(supportCandidates, price) ?? round(price * 0.975, 2);
  const resistance = nearestAbove(resistanceCandidates, price) ?? round(price * 1.025, 2);
  const trimLevel = round(Math.max(support * 0.995, price - (atrProxy || price * 0.025) * 0.8), 2);
  const stopLevel = round(Math.min(support * 0.985, price - (atrProxy || price * 0.025) * 1.25), 2);
  const invalidationLevel = round(Math.min(trimLevel, stopLevel), 2);
  const addReclaimLevel = round(Math.max(resistance, price * 1.005), 2);
  const target1 = round(Math.max(resistance, price + (atrProxy || price * 0.025)), 2);
  const target2 = round(Math.max(target1 * 1.015, price + (atrProxy || price * 0.025) * 2), 2);
  const risk = Math.max(price - stopLevel, 0.01);
  const reward = Math.max(target1 - price, 0);
  const riskReward = round(reward / risk, 2);
  const evidenceCount = [
    technical.support,
    technical.range20Low,
    technical.ma20,
    technical.ma50,
    previousClose,
    dayRange.low,
    dayRange.high,
    technical.resistance,
  ].filter((value) => toNumber(value) !== null).length;
  const confidence = clamp(35 + evidenceCount * 7 + (technical.maAlignment && technical.maAlignment !== 'unknown' ? 8 : 0), 20, 90);
  const entryType = labelEntryType(price, addReclaimLevel, support, technical);
  const reasons = [
    support !== null ? `support near ${formatUsd(support)}` : null,
    resistance !== null ? `resistance near ${formatUsd(resistance)}` : null,
    atrProxy !== null ? `ATR proxy ${formatUsd(atrProxy)}` : null,
    technical.maAlignment && technical.maAlignment !== 'unknown' ? technical.maAlignment.replace(/_/g, ' ') : null,
  ].filter(Boolean);

  return {
    basis: 'dynamic_best_available',
    confidence,
    support,
    resistance,
    trimLevel,
    stopLevel,
    invalidationLevel,
    addReclaimLevel,
    target1,
    target2,
    riskReward,
    entryType,
    reasoning: compactWhitespace(`Calculated from ${reasons.join(', ')}.`),
  };
}
