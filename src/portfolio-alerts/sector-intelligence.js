import { clamp, compactWhitespace, computePercentChange, round, toNumber } from './utils.js';

const CAPEX_TAKER_BUCKETS = new Set(['capex_taker']);
const CAPEX_SPENDER_BUCKETS = new Set(['capex_spender']);

const NEGATIVE_NEWS_RULES = [
  { pattern: /\bdilution|secondary offering|equity raise|stock offering\b/i, score: -3, tag: 'dilution' },
  { pattern: /\bguidance cut|cuts guidance|lowered guidance\b/i, score: -3, tag: 'guidance_cut' },
  { pattern: /\baccounting|probe|investigation|fraud\b/i, score: -3, tag: 'accounting_risk' },
  { pattern: /\bearnings miss|misses earnings|missed earnings\b/i, score: -2, tag: 'earnings_miss' },
  { pattern: /\bdowngrade|sell rating|price target cut\b/i, score: -1, tag: 'downgrade' },
  { pattern: /\bmargin pressure|demand slowdown|weak demand\b/i, score: -1, tag: 'demand_risk' },
];

const POSITIVE_NEWS_RULES = [
  { pattern: /\bbeat and raise|beats and raises|beat earnings\b/i, score: 3, tag: 'beat_raise' },
  { pattern: /\bmajor ai order|ai deal|large ai contract|hbm demand\b/i, score: 2, tag: 'ai_order' },
  { pattern: /\bupgrade|price target raised|outperform\b/i, score: 1, tag: 'upgrade' },
  { pattern: /\bpartnership|expands|wins|award\b/i, score: 1, tag: 'positive_execution' },
];

function average(values = []) {
  const numeric = values.map((value) => toNumber(value)).filter((value) => value !== null);
  if (!numeric.length) {
    return null;
  }
  return round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length, 2);
}

function median(values = []) {
  const numeric = values.map((value) => toNumber(value)).filter((value) => value !== null).sort((a, b) => a - b);
  if (!numeric.length) {
    return null;
  }
  const middle = Math.floor(numeric.length / 2);
  if (numeric.length % 2 === 0) {
    return round((numeric[middle - 1] + numeric[middle]) / 2, 2);
  }
  return round(numeric[middle], 2);
}

function normalizeTrendPoint(point = {}) {
  return {
    date: point.date || '',
    open: toNumber(point.open),
    high: toNumber(point.high),
    low: toNumber(point.low),
    close: toNumber(point.close),
    volume: toNumber(point.volume),
  };
}

function sortTrendAscending(points = []) {
  const normalized = (Array.isArray(points) ? points : [])
    .map(normalizeTrendPoint)
    .filter((item) => item.close !== null);
  if (normalized.length <= 1) {
    return normalized;
  }
  const timestamped = normalized.map((item, index) => ({
    ...item,
    _time: item.date ? Date.parse(item.date) : index,
    _index: index,
  }));
  const monotonicAscending = timestamped.every((item, index) => index === 0 || item._time >= timestamped[index - 1]._time);
  if (monotonicAscending) {
    return normalized;
  }
  return timestamped
    .sort((a, b) => (a._time - b._time) || (a._index - b._index))
    .map(({ _time, _index, ...item }) => item);
}

function computeMovingAverage(points = [], period = 20) {
  const closes = sortTrendAscending(points).map((item) => item.close).filter((value) => value !== null);
  if (closes.length < period) {
    return null;
  }
  const window = closes.slice(-period);
  return average(window);
}

function computePerformance(points = [], sessions = 5, currentPrice = null) {
  const trend = sortTrendAscending(points);
  if (!trend.length) {
    return null;
  }
  const reference = sessions <= 1 ? trend.at(-1)?.close : trend.at(-(sessions + 1))?.close;
  const current = toNumber(currentPrice) ?? trend.at(-1)?.close ?? null;
  return computePercentChange(current, reference);
}

function computeRangePosition(points = [], currentPrice = null, period = 20) {
  const trend = sortTrendAscending(points).slice(-period);
  const lows = trend.map((item) => item.low).filter((value) => value !== null);
  const highs = trend.map((item) => item.high).filter((value) => value !== null);
  const current = toNumber(currentPrice) ?? trend.at(-1)?.close ?? null;
  if (!lows.length || !highs.length || current === null) {
    return { low: null, high: null, positionPct: null, label: 'unknown' };
  }
  const low = Math.min(...lows);
  const high = Math.max(...highs);
  if (high <= low) {
    return { low: round(low, 2), high: round(high, 2), positionPct: null, label: 'compressed' };
  }
  const positionPct = round(((current - low) / (high - low)) * 100, 2);
  const clampedPosition = clamp(positionPct, 0, 100);
  return {
    low: round(low, 2),
    high: round(high, 2),
    positionPct: clampedPosition,
    label:
      clampedPosition >= 80 ? 'upper_range' :
      clampedPosition <= 20 ? 'lower_range' :
      'mid_range',
  };
}

function estimateSupportResistance(points = [], currentPrice = null) {
  const trend = sortTrendAscending(points);
  if (!trend.length) {
    const numericPrice = toNumber(currentPrice);
    return { support: numericPrice, resistance: numericPrice };
  }
  const recent = trend.slice(-12);
  const supportCandidates = recent.map((item) => item.low).filter((value) => value !== null);
  const resistanceCandidates = recent.map((item) => item.high).filter((value) => value !== null);
  return {
    support: supportCandidates.length ? round(Math.min(...supportCandidates), 2) : toNumber(currentPrice),
    resistance: resistanceCandidates.length ? round(Math.max(...resistanceCandidates), 2) : toNumber(currentPrice),
  };
}

function computeMaAlignment(price, ma20, ma50, ma200) {
  const numericPrice = toNumber(price);
  if (numericPrice === null) {
    return 'unknown';
  }
  if ([ma20, ma50, ma200].every((value) => value !== null) && numericPrice > ma20 && ma20 > ma50 && ma50 > ma200) {
    return 'bullish_stack';
  }
  if ([ma20, ma50, ma200].every((value) => value !== null) && numericPrice < ma20 && ma20 < ma50 && ma50 < ma200) {
    return 'bearish_stack';
  }
  if (ma20 !== null && ma50 !== null && numericPrice > ma20 && ma20 >= ma50) {
    return 'constructive';
  }
  if (ma20 !== null && ma50 !== null && numericPrice < ma20 && ma20 <= ma50) {
    return 'deteriorating';
  }
  return 'mixed';
}

function formatTechnicalSummary(snapshot) {
  const parts = [];
  if (snapshot.maAlignment === 'bullish_stack') {
    parts.push('bullish trend stack');
  } else if (snapshot.maAlignment === 'bearish_stack') {
    parts.push('bearish trend stack');
  } else if (snapshot.maAlignment === 'constructive') {
    parts.push('constructive trend');
  } else if (snapshot.maAlignment === 'deteriorating') {
    parts.push('deteriorating trend');
  }
  if (snapshot.rsi14 !== null) {
    if (snapshot.rsi14 >= 70) parts.push(`RSI ${snapshot.rsi14} overbought`);
    else if (snapshot.rsi14 <= 35) parts.push(`RSI ${snapshot.rsi14} washed out`);
    else parts.push(`RSI ${snapshot.rsi14} neutral`);
  }
  if (snapshot.range20PositionPct !== null) {
    parts.push(`20D range ${snapshot.range20PositionPct}%`);
  }
  if (snapshot.relativeStrengthVsQqq !== null || snapshot.relativeStrengthVsSmh !== null) {
    const rsQ = snapshot.relativeStrengthVsQqq !== null ? `vs QQQ ${snapshot.relativeStrengthVsQqq > 0 ? '+' : ''}${snapshot.relativeStrengthVsQqq}%` : null;
    const rsS = snapshot.relativeStrengthVsSmh !== null ? `vs SMH ${snapshot.relativeStrengthVsSmh > 0 ? '+' : ''}${snapshot.relativeStrengthVsSmh}%` : null;
    parts.push([rsQ, rsS].filter(Boolean).join(', '));
  }
  if (snapshot.breakout) {
    parts.push('breakout pressure');
  } else if (snapshot.breakdown) {
    parts.push('breakdown pressure');
  }
  return compactWhitespace(parts.join(' | ')) || 'Technicals incomplete.';
}

export function buildNewsDigest(newsItems = []) {
  const titles = (Array.isArray(newsItems) ? newsItems : [])
    .map((item) => {
      const title = compactWhitespace(item?.title || item?.headline || '');
      const description = compactWhitespace(item?.description || item?.summary || '');
      return {
        title,
        description,
        link: item?.link || item?.url || '',
        publishedAt: item?.publishedAt || item?.time_published || '',
      };
    })
    .filter((item) => item.title);

  let positiveCount = 0;
  let negativeCount = 0;
  const scores = [];
  const tags = new Set();

  for (const item of titles) {
    let headlineScore = 0;
    const combined = compactWhitespace(`${item.title} ${item.description}`);
    for (const rule of NEGATIVE_NEWS_RULES) {
      if (rule.pattern.test(combined)) {
        headlineScore = Math.min(headlineScore, rule.score);
        tags.add(rule.tag);
      }
    }
    for (const rule of POSITIVE_NEWS_RULES) {
      if (rule.pattern.test(combined)) {
        headlineScore = Math.max(headlineScore, rule.score);
        tags.add(rule.tag);
      }
    }
    if (headlineScore > 0) positiveCount += 1;
    if (headlineScore < 0) negativeCount += 1;
    scores.push(headlineScore);
  }

  const averageScore = scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length, 2) : null;
  const sentiment =
    averageScore !== null && averageScore >= 0.75 ? 'bullish' :
    averageScore !== null && averageScore <= -0.75 ? 'bearish' :
    scores.some((value) => value !== 0) ? 'mixed' :
    titles.length ? 'neutral' :
    'unclear';

  return {
    sentiment,
    averageScore,
    positiveCount,
    negativeCount,
    tags: [...tags],
    latestHeadline: titles[0]?.title || '',
    latestLink: titles[0]?.link || '',
    latestPublishedAt: titles[0]?.publishedAt || '',
    headlines: titles.slice(0, 5),
    material: Math.max(Math.abs(averageScore || 0), positiveCount, negativeCount) >= 1,
    summary:
      titles[0]?.title
        ? `${titles[0].title}${sentiment === 'bullish' ? ' (supportive)' : sentiment === 'bearish' ? ' (negative)' : ''}`
        : 'No major headlines captured.',
  };
}

function resolveLatestRsiValue(rsiSeries = []) {
  if (Array.isArray(rsiSeries)) {
    const direct = rsiSeries.find((item) => toNumber(item?.RSI) !== null);
    if (direct) {
      return round(toNumber(direct.RSI), 2);
    }
  }
  return null;
}

function computeRsiFromTrend(points = [], period = 14) {
  const closes = sortTrendAscending(points).map((item) => item.close).filter((value) => value !== null);
  if (closes.length <= period) {
    return null;
  }
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return round(100 - 100 / (1 + rs), 2);
}

function resolveDisplayMovePct(item = {}) {
  return toNumber(item.displayMovePct) ?? toNumber(item.movePct) ?? toNumber(item.quote?.pctChange) ?? null;
}

function resolveCurrentPrice(item = {}) {
  return (
    toNumber(item.displayPrice) ??
    toNumber(item.currentPrice) ??
    toNumber(item.livePrice) ??
    toNumber(item.quote?.extended?.price) ??
    toNumber(item.quote?.price) ??
    toNumber(sortTrendAscending(item.dailyTrend).at(-1)?.close)
  );
}

export function buildTechnicalSnapshot(item = {}, benchmarkMoves = {}) {
  const trend = sortTrendAscending(item.dailyTrend);
  const currentPrice = resolveCurrentPrice(item);
  const oneDayPct =
    resolveDisplayMovePct(item) ??
    computePercentChange(currentPrice, toNumber(item.quote?.previousClose) ?? trend.at(-2)?.close ?? null);
  const performance5D = computePerformance(trend, 5, currentPrice);
  const performance20D = computePerformance(trend, 20, currentPrice);
  const rsi14 = resolveLatestRsiValue(item.rsi) ?? computeRsiFromTrend(trend, 14);
  const ma20 = computeMovingAverage(trend, 20);
  const ma50 = computeMovingAverage(trend, 50);
  const ma200 = computeMovingAverage(trend, 200);
  const range20 = computeRangePosition(trend, currentPrice, 20);
  const levels = estimateSupportResistance(trend, currentPrice);
  const relativeStrengthVsQqq =
    oneDayPct !== null && toNumber(benchmarkMoves.QQQ) !== null ? round(oneDayPct - toNumber(benchmarkMoves.QQQ), 2) : null;
  const relativeStrengthVsSmh =
    oneDayPct !== null && toNumber(benchmarkMoves.SMH) !== null ? round(oneDayPct - toNumber(benchmarkMoves.SMH), 2) : null;
  const gapPct =
    item.displayBasis && item.displayBasis !== 'regular' && oneDayPct !== null ? round(oneDayPct, 2) : null;
  const breakout = currentPrice !== null && levels.resistance !== null ? currentPrice >= levels.resistance * 1.005 : false;
  const breakdown = currentPrice !== null && levels.support !== null ? currentPrice <= levels.support * 0.995 : false;
  const flags = [
    breakout ? 'BREAKOUT' : null,
    breakdown ? 'BREAKDOWN' : null,
    gapPct !== null && Math.abs(gapPct) >= 3 ? 'LARGE_GAP' : null,
    range20.label === 'upper_range' ? 'UPPER_RANGE' : null,
    range20.label === 'lower_range' ? 'LOWER_RANGE' : null,
    rsi14 !== null && rsi14 >= 70 ? 'OVERBOUGHT' : null,
    rsi14 !== null && rsi14 <= 35 ? 'OVERSOLD' : null,
  ].filter(Boolean);

  const snapshot = {
    currentPrice: currentPrice !== null ? round(currentPrice, 2) : null,
    performance1D: oneDayPct,
    performance5D,
    performance20D,
    relativeStrengthVsQqq,
    relativeStrengthVsSmh,
    rsi14,
    ma20,
    ma50,
    ma200,
    vsMa20Pct: ma20 !== null && currentPrice !== null ? computePercentChange(currentPrice, ma20) : null,
    vsMa50Pct: ma50 !== null && currentPrice !== null ? computePercentChange(currentPrice, ma50) : null,
    vsMa200Pct: ma200 !== null && currentPrice !== null ? computePercentChange(currentPrice, ma200) : null,
    maAlignment: computeMaAlignment(currentPrice, ma20, ma50, ma200),
    range20Low: range20.low,
    range20High: range20.high,
    range20PositionPct: range20.positionPct,
    range20Label: range20.label,
    support: levels.support,
    resistance: levels.resistance,
    gapPct,
    breakout,
    breakdown,
    flags,
  };
  snapshot.summary = formatTechnicalSummary(snapshot);
  return snapshot;
}

function deriveFundamentalQuality(snapshot) {
  let score = 0;
  if ((toNumber(snapshot.revenueGrowthYoY) || 0) >= 15) score += 1;
  if ((toNumber(snapshot.epsGrowthYoY) || 0) >= 10) score += 1;
  if ((toNumber(snapshot.operatingMargin) || 0) >= 15) score += 1;
  if ((toNumber(snapshot.netMargin) || 0) >= 10) score += 1;
  if ((toNumber(snapshot.debtToEquity) || 0) > 1.5) score -= 1;
  if ((toNumber(snapshot.pe) || 0) >= 60 && (toNumber(snapshot.epsGrowthYoY) || 0) < 15) score -= 1;
  return clamp(score, -2, 3);
}

function formatFundamentalSummary(snapshot) {
  const parts = [];
  if (snapshot.qualityLabel === 'strong') parts.push('fundamentals supportive');
  else if (snapshot.qualityLabel === 'fragile') parts.push('fundamentals fragile');
  else if (snapshot.qualityLabel === 'mixed') parts.push('fundamentals mixed');
  if (snapshot.revenueGrowthYoY !== null) parts.push(`rev ${snapshot.revenueGrowthYoY}% YoY`);
  if (snapshot.epsGrowthYoY !== null) parts.push(`EPS ${snapshot.epsGrowthYoY}% YoY`);
  if (snapshot.operatingMargin !== null) parts.push(`op margin ${snapshot.operatingMargin}%`);
  if (snapshot.nextEarningsDate) parts.push(`earnings ${snapshot.nextEarningsDate}`);
  return compactWhitespace(parts.join(' | ')) || 'Fundamentals incomplete.';
}

export function buildFundamentalSnapshot(fundamentals = {}, earnings = null, profile = {}) {
  const snapshot = {
    marketCap: toNumber(fundamentals.marketCapitalization) ?? toNumber(profile.marketCapitalization) ?? null,
    pe: toNumber(fundamentals.peTTM),
    epsTTM: toNumber(fundamentals.epsTTM),
    revenueGrowthYoY: toNumber(fundamentals.revenueGrowthTTMYoy),
    epsGrowthYoY: toNumber(fundamentals.epsGrowthTTMYoy),
    operatingMargin: toNumber(fundamentals.operatingMargin),
    netMargin: toNumber(fundamentals.netMargin),
    debtToEquity: toNumber(fundamentals.debtToEquityQuarterly),
    beta: toNumber(fundamentals.beta),
    week52High: toNumber(fundamentals.week52High),
    week52Low: toNumber(fundamentals.week52Low),
    nextEarningsDate: earnings?.next?.date || null,
    nextEarningsHour: earnings?.next?.hour || null,
    source: fundamentals.source || profile.source || null,
  };
  snapshot.qualityScore = deriveFundamentalQuality(snapshot);
  snapshot.qualityLabel =
    snapshot.qualityScore >= 2 ? 'strong' :
    snapshot.qualityScore <= -1 ? 'fragile' :
    snapshot.qualityScore === 1 ? 'supportive' :
    'mixed';
  snapshot.summary = formatFundamentalSummary(snapshot);
  return snapshot;
}

export function buildResearchQuality(item = {}, stock = null) {
  const coverage = {
    quote: resolveCurrentPrice(item) !== null || toNumber(stock?.technicalSnapshot?.currentPrice) !== null,
    trend: Array.isArray(item.dailyTrend) && item.dailyTrend.length >= 20,
    news: Array.isArray(item.news) && item.news.length > 0,
    fundamentals:
      item.fundamentals &&
      Object.values(item.fundamentals).some((value) => value !== null && value !== undefined && value !== ''),
    earnings: Boolean(item.earnings?.next?.date || item.earnings?.recent?.length),
  };
  const score = round((Object.values(coverage).filter(Boolean).length / Object.keys(coverage).length) * 100, 0);
  return {
    score,
    coverage,
    isPartial: score < 80,
    summary:
      score >= 80 ? 'Research coverage is solid.' :
      score >= 60 ? 'Research coverage is usable but partial.' :
      'Research coverage is thin; treat conclusions carefully.',
  };
}

function summarizeSectorBreadth(items = []) {
  const moves = items.map((item) => toNumber(item.technicalSnapshot?.performance1D)).filter((value) => value !== null);
  const advancers = moves.filter((value) => value > 0.2).length;
  const decliners = moves.filter((value) => value < -0.2).length;
  const unchanged = Math.max(moves.length - advancers - decliners, 0);
  const positivePercent = moves.length ? round((advancers / moves.length) * 100, 2) : null;
  return {
    advancers,
    decliners,
    unchanged,
    positivePercent,
    negativePercent: moves.length ? round((decliners / moves.length) * 100, 2) : null,
    breadthLabel:
      positivePercent === null ? 'unknown' :
      positivePercent >= 65 ? 'strong' :
      positivePercent >= 50 ? 'improving' :
      positivePercent >= 35 ? 'mixed' :
      'weak',
    avgMovePct: average(moves),
    medianMovePct: median(moves),
  };
}

function summarizeGroup(items = []) {
  const breadth = summarizeSectorBreadth(items);
  return {
    tickers: items.map((item) => item.ticker),
    count: items.length,
    breadthPercent: breadth.positivePercent,
    avgMovePct: breadth.avgMovePct,
    leaders: items
      .slice()
      .sort((a, b) => (toNumber(b.technicalSnapshot?.performance1D) || -999) - (toNumber(a.technicalSnapshot?.performance1D) || -999))
      .slice(0, 3)
      .map((item) => item.ticker),
    laggards: items
      .slice()
      .sort((a, b) => (toNumber(a.technicalSnapshot?.performance1D) || 999) - (toNumber(b.technicalSnapshot?.performance1D) || 999))
      .slice(0, 3)
      .map((item) => item.ticker),
    ...breadth,
  };
}

function buildShiftSignals(current, prior = null) {
  if (!prior) {
    return [];
  }
  const signals = [];
  const priorBreadth = toNumber(prior?.sectorBreadth?.positivePercent);
  const currentBreadth = toNumber(current?.sectorBreadth?.positivePercent);
  const priorTakerMove = toNumber(prior?.capexTakers?.avgMovePct);
  const currentTakerMove = toNumber(current?.capexTakers?.avgMovePct);
  const priorSpenderMove = toNumber(prior?.capexSpenders?.avgMovePct);
  const currentSpenderMove = toNumber(current?.capexSpenders?.avgMovePct);
  const currentLeaderSpread =
    toNumber(currentTakerMove) !== null && toNumber(currentSpenderMove) !== null ? currentTakerMove - currentSpenderMove : null;
  const priorLeaderSpread =
    toNumber(priorTakerMove) !== null && toNumber(priorSpenderMove) !== null ? priorTakerMove - priorSpenderMove : null;

  if (currentLeaderSpread !== null && priorLeaderSpread !== null && currentLeaderSpread - priorLeaderSpread >= 0.8) {
    signals.push('AI_INFRA_LEADING');
  }
  if (currentSpenderMove !== null && priorSpenderMove !== null && currentSpenderMove - priorSpenderMove <= -0.75) {
    signals.push('AI_SPENDERS_WEAKENING');
  }
  if (currentBreadth !== null && priorBreadth !== null && currentBreadth - priorBreadth >= 12) {
    signals.push('SEMIS_BREADTH_IMPROVING');
  }
  if (
    currentBreadth !== null &&
    currentBreadth < 45 &&
    current?.leaders?.length >= 3 &&
    current?.laggards?.length >= 3 &&
    currentLeaderSpread !== null &&
    currentLeaderSpread >= 1
  ) {
    signals.push('LEADERSHIP_NARROWING');
  }
  const qqqMove = toNumber(current?.benchmarks?.QQQ?.movePct);
  const smhMove = toNumber(current?.benchmarks?.SMH?.movePct);
  if (qqqMove !== null && smhMove !== null && qqqMove < -1 && smhMove < -1 && currentBreadth !== null && currentBreadth < 35) {
    signals.push('RISK_OFF_DEFENSIVE');
  }
  return [...new Set(signals)];
}

function buildCurrentStateTags(snapshot) {
  const tags = [];
  const takerAvg = toNumber(snapshot?.capexTakers?.avgMovePct);
  const spenderAvg = toNumber(snapshot?.capexSpenders?.avgMovePct);
  const breadth = toNumber(snapshot?.sectorBreadth?.positivePercent);
  if (takerAvg !== null && spenderAvg !== null && takerAvg - spenderAvg >= 0.8) {
    tags.push('AI_INFRA_LEADING');
  }
  if (spenderAvg !== null && spenderAvg <= -0.75) {
    tags.push('AI_SPENDERS_WEAKENING');
  }
  if (breadth !== null && breadth < 35) {
    tags.push('RISK_OFF_DEFENSIVE');
  }
  return [...new Set(tags)];
}

export function computeShiftAlignment(stock = {}, snapshot = {}) {
  const movePct = toNumber(stock.technicalSnapshot?.performance1D);
  const groupAvg = stock.group === 'capex_spender'
    ? toNumber(snapshot.capexSpenders?.avgMovePct)
    : stock.group === 'capex_taker'
      ? toNumber(snapshot.capexTakers?.avgMovePct)
      : toNumber(snapshot.sectorBreadth?.avgMovePct);
  const diff = movePct !== null && groupAvg !== null ? round(movePct - groupAvg, 2) : null;
  let alignment = 'neutral';
  if (diff !== null && diff >= 1) alignment = 'leading';
  else if (diff !== null && diff <= -1) alignment = 'lagging';
  else if (movePct !== null && groupAvg !== null && movePct > 0 && groupAvg > 0) alignment = 'aligned_positive';
  else if (movePct !== null && groupAvg !== null && movePct < 0 && groupAvg < 0) alignment = 'aligned_negative';

  const currentStateTags = Array.isArray(snapshot.currentStateTags) ? snapshot.currentStateTags : [];
  const shiftSignals = Array.isArray(snapshot.shiftSignals) ? snapshot.shiftSignals : [];
  const relevantShiftTags = [...currentStateTags, ...shiftSignals].filter((tag) => {
    if (tag === 'AI_INFRA_LEADING') return stock.group === 'capex_taker';
    if (tag === 'AI_SPENDERS_WEAKENING') return stock.group === 'capex_spender';
    return true;
  });

  const scoreAdjustment =
    alignment === 'leading' ? 2 :
    alignment === 'lagging' ? -2 :
    alignment === 'aligned_positive' ? 1 :
    alignment === 'aligned_negative' ? -1 :
    0;

  return {
    alignment,
    groupAverageMovePct: groupAvg,
    relativeToGroupPct: diff,
    scoreAdjustment,
    tags: relevantShiftTags,
    summary:
      alignment === 'leading' ? 'Stock is stronger than its cohort.' :
      alignment === 'lagging' ? 'Stock is lagging its cohort.' :
      alignment === 'aligned_positive' ? 'Stock is moving with sector strength.' :
      alignment === 'aligned_negative' ? 'Stock is moving with sector weakness.' :
      'No strong sector alignment signal.',
  };
}

function buildSectorContext(stock = {}, snapshot = {}) {
  const breadth = snapshot.sectorBreadth?.breadthLabel || 'unknown';
  const groupSummary = stock.group === 'capex_spender'
    ? snapshot.capexSpenders
    : stock.group === 'capex_taker'
      ? snapshot.capexTakers
      : snapshot.sectorBreadth;
  const groupMove = toNumber(groupSummary?.avgMovePct);
  const breadthPct = toNumber(groupSummary?.breadthPercent ?? groupSummary?.positivePercent);
  const label =
    stock.group === 'capex_spender' ? 'AI spenders' :
    stock.group === 'capex_taker' ? 'AI infra' :
    'AI universe';
  return {
    label,
    breadth,
    groupMovePct: groupMove,
    breadthPct,
    summary:
      groupMove !== null
        ? `${label} avg move ${groupMove > 0 ? '+' : ''}${groupMove}% with ${breadthPct ?? 'n/a'}% breadth (${breadth}).`
        : `${label} breadth is ${breadth}.`,
  };
}

export function computeResearchScoreAdjustments(stock = {}) {
  const technical = stock.technicalSnapshot || {};
  const fundamental = stock.fundamentalSnapshot || {};
  const shiftAlignment = stock.shiftAlignment || {};

  let technicalScore = 0;
  if (technical.maAlignment === 'bullish_stack') technicalScore += 2;
  else if (technical.maAlignment === 'bearish_stack') technicalScore -= 2;
  else if (technical.maAlignment === 'constructive') technicalScore += 1;
  else if (technical.maAlignment === 'deteriorating') technicalScore -= 1;
  if ((toNumber(technical.rsi14) || 0) >= 72) technicalScore -= 1;
  else if ((toNumber(technical.rsi14) || 999) <= 32) technicalScore += 1;
  if ((toNumber(technical.range20PositionPct) || 0) >= 80) technicalScore += 1;
  else if ((toNumber(technical.range20PositionPct) || 999) <= 20) technicalScore -= 1;
  if ((toNumber(technical.relativeStrengthVsQqq) || 0) >= 1 || (toNumber(technical.relativeStrengthVsSmh) || 0) >= 1) technicalScore += 1;
  if ((toNumber(technical.relativeStrengthVsQqq) || 0) <= -1 && (toNumber(technical.relativeStrengthVsSmh) || 0) <= -1) technicalScore -= 1;
  if (technical.breakout) technicalScore += 1;
  if (technical.breakdown) technicalScore -= 1;

  const fundamentalScore =
    fundamental.qualityScore >= 2 ? 2 :
    fundamental.qualityScore === 1 ? 1 :
    fundamental.qualityScore <= -1 ? -2 :
    0;

  return {
    technicalScore: clamp(technicalScore, -4, 4),
    fundamentalScore: clamp(fundamentalScore, -2, 2),
    sectorShiftScore: clamp(toNumber(shiftAlignment.scoreAdjustment) || 0, -2, 2),
  };
}

export function buildSectorIntelligenceSnapshot({
  items = [],
  priorSnapshot = null,
  marketSession = 'regular',
  updatedAt = new Date().toISOString(),
} = {}) {
  const benchmarkMap = {};
  const prepared = (Array.isArray(items) ? items : []).map((item) => {
    const ticker = String(item?.ticker || '').toUpperCase();
    const movePct = resolveDisplayMovePct(item);
    if (ticker === 'QQQ' || ticker === 'SMH') {
      benchmarkMap[ticker] = movePct;
    }
    return {
      ticker,
      name: item?.name || ticker,
      profile: item?.profile || {},
      group: CAPEX_TAKER_BUCKETS.has(item?.profile?.thesisBucket) ? 'capex_taker' : CAPEX_SPENDER_BUCKETS.has(item?.profile?.thesisBucket) ? 'capex_spender' : 'other',
      dailyTrend: item?.dailyTrend || [],
      news: item?.news || [],
      fundamentals: item?.fundamentals || {},
      earnings: item?.earnings || null,
      quote: item?.quote || {},
      displayPrice: resolveCurrentPrice(item),
      displayMovePct: movePct,
      displayBasis: item?.displayBasis || item?.moveBasis || 'regular',
      source: item?.source || null,
    };
  });

  const stocks = prepared.map((item) => {
    const technicalSnapshot = buildTechnicalSnapshot(item, benchmarkMap);
    const fundamentalSnapshot = buildFundamentalSnapshot(item.fundamentals, item.earnings, item.profile);
    const newsDigest = buildNewsDigest(item.news);
    const stock = {
      ticker: item.ticker,
      name: item.name,
      group: item.group,
      role: item.profile?.role || '',
      thesisBucket: item.profile?.thesisBucket || '',
      category: item.profile?.category || '',
      technicalSnapshot,
      fundamentalSnapshot,
      newsDigest,
      researchQuality: buildResearchQuality(item),
    };
    return stock;
  });

  const investableStocks = stocks.filter((stock) => !['QQQ', 'SMH'].includes(stock.ticker));
  const capexTakers = summarizeGroup(investableStocks.filter((stock) => stock.group === 'capex_taker'));
  const capexSpenders = summarizeGroup(investableStocks.filter((stock) => stock.group === 'capex_spender'));
  const sectorBreadth = summarizeSectorBreadth(investableStocks);
  const leaders = investableStocks
    .slice()
    .sort((a, b) => (toNumber(b.technicalSnapshot?.performance1D) || -999) - (toNumber(a.technicalSnapshot?.performance1D) || -999))
    .slice(0, 3)
    .map((stock) => ({
      ticker: stock.ticker,
      movePct: stock.technicalSnapshot.performance1D,
      relativeStrengthVsQqq: stock.technicalSnapshot.relativeStrengthVsQqq,
      summary: stock.technicalSnapshot.summary,
    }));
  const laggards = investableStocks
    .slice()
    .sort((a, b) => (toNumber(a.technicalSnapshot?.performance1D) || 999) - (toNumber(b.technicalSnapshot?.performance1D) || 999))
    .slice(0, 3)
    .map((stock) => ({
      ticker: stock.ticker,
      movePct: stock.technicalSnapshot.performance1D,
      relativeStrengthVsQqq: stock.technicalSnapshot.relativeStrengthVsQqq,
      summary: stock.technicalSnapshot.summary,
    }));

  const snapshot = {
    updatedAt,
    marketSession,
    benchmarks: {
      QQQ: {
        ticker: 'QQQ',
        movePct: toNumber(benchmarkMap.QQQ),
      },
      SMH: {
        ticker: 'SMH',
        movePct: toNumber(benchmarkMap.SMH),
      },
    },
    sectorBreadth,
    leaders,
    laggards,
    capexTakers,
    capexSpenders,
    stocks: [],
    aiSummary: null,
  };
  snapshot.currentStateTags = buildCurrentStateTags(snapshot);
  snapshot.shiftSignals = buildShiftSignals(snapshot, priorSnapshot);
  snapshot.shiftSummary =
    snapshot.shiftSignals.length
      ? snapshot.shiftSignals.join(', ')
      : snapshot.currentStateTags.length
        ? snapshot.currentStateTags.join(', ')
        : 'No major sector shift detected.';

  snapshot.stocks = stocks.map((stock) => {
    const sectorContext = buildSectorContext(stock, snapshot);
    const shiftAlignment = computeShiftAlignment(stock, snapshot);
    const scoreAdjustments = computeResearchScoreAdjustments({ ...stock, sectorContext, shiftAlignment });
    return {
      ...stock,
      sectorContext,
      shiftAlignment,
      scoreAdjustments,
    };
  });

  return snapshot;
}
