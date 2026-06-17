import { buildPortfolioAlertConfig } from '../portfolio-alerts/config.js';
import { clamp, compactWhitespace, round, toNumber } from '../portfolio-alerts/utils.js';
import { DEFAULT_MAJOR_US_UNIVERSE, buildMajorUsUniverse } from './universe.js';
import { createSwingDataProvider } from './data-provider.js';
import { buildTechnicalProfile } from './technical-indicators.js';

const NEGATIVE_NEWS = [
  { pattern: /\bdilution|secondary offering|stock offering|equity raise\b/i, tag: 'dilution', score: -18 },
  { pattern: /\bguidance cut|cuts guidance|lowered guidance|weak guidance\b/i, tag: 'guidance_cut', score: -16 },
  { pattern: /\bprobe|investigation|fraud|accounting|sec charges?\b/i, tag: 'accounting_or_probe', score: -18 },
  { pattern: /\bdowngrade|price target cut|sell rating\b/i, tag: 'downgrade', score: -8 },
  { pattern: /\bmisses|earnings miss|missed estimates\b/i, tag: 'earnings_miss', score: -10 },
  { pattern: /\blayoffs|demand slowdown|margin pressure|weak demand\b/i, tag: 'demand_risk', score: -6 },
];

const POSITIVE_NEWS = [
  { pattern: /\bbeat and raise|beats and raises|raises guidance|strong guidance\b/i, tag: 'beat_raise', score: 14 },
  { pattern: /\bupgrade|price target raised|outperform|buy rating\b/i, tag: 'upgrade', score: 8 },
  { pattern: /\bcontract|partnership|wins|order|approval|launch\b/i, tag: 'catalyst', score: 6 },
  { pattern: /\bai|data center|semiconductor|cloud|accelerator|hbm\b/i, tag: 'theme', score: 4 },
];

function daysUntil(dateText) {
  if (!dateText) return null;
  const target = Date.parse(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(target)) return null;
  return Math.ceil((target - Date.now()) / 86400000);
}

function scoreNews(news = []) {
  let score = 0;
  const tags = new Set();
  const headlines = [];
  for (const item of news.slice(0, 8)) {
    const text = compactWhitespace(`${item.title || ''} ${item.description || ''}`);
    if (!text) continue;
    headlines.push(item.title || text);
    for (const rule of NEGATIVE_NEWS) {
      if (rule.pattern.test(text)) {
        score += rule.score;
        tags.add(rule.tag);
      }
    }
    for (const rule of POSITIVE_NEWS) {
      if (rule.pattern.test(text)) {
        score += rule.score;
        tags.add(rule.tag);
      }
    }
    if (item.sentiment === 'positive') score += 4;
    if (item.sentiment === 'negative') score -= 5;
  }
  return {
    score: clamp(score, -35, 30),
    tags: [...tags],
    latestHeadline: headlines[0] || '',
    sentiment: score >= 10 ? 'bullish' : score <= -10 ? 'bearish' : headlines.length ? 'mixed' : 'unclear',
  };
}

function scoreTechnical(technical = {}) {
  let score = 0;
  const rsi = toNumber(technical.rsi14);
  if (technical.maAlignment === 'bullish_stack') score += 16;
  else if (technical.maAlignment === 'constructive') score += 10;
  else if (technical.maAlignment === 'deteriorating') score -= 10;
  else if (technical.maAlignment === 'bearish_stack') score -= 18;

  if (rsi !== null) {
    if (rsi >= 45 && rsi <= 68) score += 14;
    else if (rsi > 68 && rsi <= 75) score += 4;
    else if (rsi > 75) score -= 14;
    else if (rsi >= 35 && rsi < 45 && (toNumber(technical.rsiDirection) || 0) > 0) score += 8;
    else if (rsi < 30) score -= 6;
  }
  if ((toNumber(technical.rsiDirection) || 0) > 1.5) score += 5;
  if (technical.macd?.crossedUp || (toNumber(technical.macd?.histogram) || 0) > 0) score += 8;
  if (technical.macd?.crossedDown) score -= 10;
  if ((toNumber(technical.volumeRatio) || 0) >= 1.5) score += 10;
  else if ((toNumber(technical.volumeRatio) || 0) >= 1.15) score += 5;
  if ((toNumber(technical.relativeStrengthVsQqq) || 0) >= 0.8) score += 8;
  if ((toNumber(technical.relativeStrengthVsSpy) || 0) >= 0.8) score += 6;
  if ((toNumber(technical.relativeStrengthVsSmh) || 0) >= 0.8) score += 5;
  if ((toNumber(technical.relativeStrengthVsQqq) || 0) <= -1) score -= 8;
  if (technical.breakout) score += 12;
  if (technical.breakdown) score -= 16;
  if ((toNumber(technical.rangePositionPct) || 0) > 92) score -= 8;
  if ((toNumber(technical.bollinger?.widthPct) || 999) <= 7 && (toNumber(technical.volumeRatio) || 0) >= 1.1) score += 5;
  return clamp(score, -50, 70);
}

function scoreRegime(benchmarkMoves = {}) {
  const spy = toNumber(benchmarkMoves.SPY) ?? 0;
  const qqq = toNumber(benchmarkMoves.QQQ) ?? 0;
  const smh = toNumber(benchmarkMoves.SMH) ?? 0;
  const avg = (spy + qqq + smh) / 3;
  if (avg >= 0.7 && qqq > 0 && smh > 0) return { score: 14, label: 'risk_on' };
  if (avg <= -0.7 && qqq < 0 && smh < 0) return { score: -18, label: 'risk_off' };
  if (avg >= 0.15) return { score: 6, label: 'constructive' };
  if (avg <= -0.15) return { score: -6, label: 'soft' };
  return { score: 0, label: 'neutral' };
}

function computeLevels(technical = {}, riskConfig = {}) {
  const price = toNumber(technical.price);
  if (!price || price <= 0) {
    return { entry: null, stop: null, target1: null, target2: null, riskReward: null, noChaseAbove: null };
  }
  const atr = toNumber(technical.atr14) || price * 0.025;
  const support = toNumber(technical.support) ?? price - atr;
  const resistance = toNumber(technical.resistance) ?? price + atr;
  const entry = round(price, 2);
  const stop = round(Math.min(price * 0.995, Math.max(support * 0.985, price - atr * 1.25)), 2);
  const target1 = round(Math.max(resistance, price + atr * 1.2), 2);
  const target2 = round(Math.max(target1 * 1.015, price + atr * 2), 2);
  const risk = Math.max(price - stop, 0.01);
  const reward = Math.max(target1 - price, 0);
  return {
    entry,
    stop,
    target1,
    target2,
    riskReward: round(reward / risk, 2),
    noChaseAbove: round(price * (1 + (riskConfig.noChaseGapPct ?? 3) / 100), 2),
    support: round(support, 2),
    resistance: round(resistance, 2),
  };
}

function positionSize(levels = {}, portfolio = {}, riskConfig = {}) {
  const equity = toNumber(portfolio.equityUsd) || toNumber(riskConfig.defaultEquityUsd) || 10000;
  const entry = toNumber(levels.entry);
  const stop = toNumber(levels.stop);
  if (!entry || !stop || entry <= stop) {
    return { equityUsd: round(equity, 2), maxRiskUsd: round(equity * 0.02, 2), shares: 0, notionalUsd: 0 };
  }
  const maxRiskUsd = equity * (riskConfig.riskPerTradePct ?? 0.02);
  const maxCapitalUsd = equity * (riskConfig.maxCapitalPct ?? 0.35);
  const riskPerShare = entry - stop;
  const riskShares = Math.floor(maxRiskUsd / riskPerShare);
  const capitalShares = Math.floor(maxCapitalUsd / entry);
  const shares = Math.max(0, Math.min(riskShares, capitalShares));
  return {
    equityUsd: round(equity, 2),
    maxRiskUsd: round(maxRiskUsd, 2),
    maxCapitalUsd: round(maxCapitalUsd, 2),
    riskPerShare: round(riskPerShare, 2),
    shares,
    notionalUsd: round(shares * entry, 2),
  };
}

function recommend({ symbol, quote, technical, newsDigest, earnings, levels, totalScore, dataWarnings }) {
  const earningsDays = daysUntil(earnings?.date);
  const riskReward = toNumber(levels.riskReward) || 0;
  const gapPct = toNumber(technical.gapPct) || 0;
  const hardBlocks = [];
  if (earningsDays !== null && earningsDays >= 0 && earningsDays <= 2) hardBlocks.push(`earnings in ${earningsDays} day(s)`);
  if (newsDigest.tags.some((tag) => ['dilution', 'guidance_cut', 'accounting_or_probe'].includes(tag))) hardBlocks.push('major negative headline');
  if (dataWarnings.length) hardBlocks.push('partial or stale data');

  let action = 'AVOID';
  let entryWindow = 'No entry';
  if (hardBlocks.length) {
    action = totalScore <= 35 ? 'AVOID' : 'HOLD_FOR_NEXT_SESSION';
    entryWindow = 'Blocked until event/data risk clears';
  } else if (technical.breakdown || totalScore < 35) {
    action = totalScore < 25 ? 'SELL_NEXT_SESSION' : 'AVOID';
    entryWindow = 'No new entry';
  } else if (totalScore >= 78 && riskReward >= 1.15 && gapPct <= 3.5) {
    action = technical.breakout ? 'BUY_ON_BREAKOUT_CONFIRMATION' : 'BUY_TODAY';
    entryWindow = 'Today during regular session if price stays below no-chase level';
  } else if (totalScore >= 64 && riskReward >= 0.9) {
    action = 'BUY_ON_PULLBACK';
    entryWindow = 'Today only on pullback toward entry/support';
  } else if (totalScore >= 50) {
    action = 'HOLD_FOR_NEXT_SESSION';
    entryWindow = 'Wait for next-session confirmation';
  }
  if (gapPct > 5 && action.startsWith('BUY')) {
    action = 'BUY_ON_PULLBACK';
    entryWindow = 'Avoid chasing the gap; only buy a controlled pullback';
  }
  const sellBy = action.startsWith('BUY') || action === 'HOLD_FOR_NEXT_SESSION'
    ? new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
    : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return {
    action,
    entryWindow,
    sellBy,
    timeStop: `Exit by ${sellBy} if target or confirmation does not arrive.`,
    hardBlocks,
    confidence: totalScore >= 82 ? 'high' : totalScore >= 65 ? 'medium' : 'low',
    summary: compactWhitespace(`${symbol} ${action.replace(/_/g, ' ').toLowerCase()} at ${quote.price ?? 'n/a'}; score ${totalScore}. ${newsDigest.latestHeadline || ''}`),
  };
}

export function scoreSwingBundle(bundle, options = {}) {
  const technical = buildTechnicalProfile(bundle.candles, bundle.quote, bundle.benchmarkMoves);
  const newsDigest = scoreNews(bundle.news);
  const regime = scoreRegime(bundle.benchmarkMoves);
  const levels = computeLevels(technical, options.risk);
  const dataWarnings = [];
  if ((bundle.candles || []).length < 60) dataWarnings.push('less_than_60_daily_candles');
  if (!bundle.quote?.price) dataWarnings.push('missing_live_quote');
  if (toNumber(levels.riskReward) !== null && levels.riskReward < 0.8) dataWarnings.push('weak_risk_reward');
  const technicalScore = scoreTechnical(technical);
  let totalScore = clamp(
    35 + technicalScore + newsDigest.score + regime.score + clamp((toNumber(levels.riskReward) || 0) * 5, 0, 12),
    0,
    100,
  );
  if (newsDigest.sentiment === 'bearish') totalScore -= 8;
  if (daysUntil(bundle.earnings?.date) !== null && daysUntil(bundle.earnings?.date) <= 2) totalScore -= 18;
  totalScore = clamp(round(totalScore, 0), 0, 100);
  const position = positionSize(levels, options.portfolio, options.risk);
  const decision = recommend({
    symbol: bundle.symbol,
    quote: bundle.quote,
    technical,
    newsDigest,
    earnings: bundle.earnings,
    levels,
    totalScore,
    dataWarnings,
  });
  return {
    symbol: bundle.symbol,
    name: bundle.quote?.name || bundle.symbol,
    action: decision.action,
    score: totalScore,
    confidence: decision.confidence,
    entryWindow: decision.entryWindow,
    sellBy: decision.sellBy,
    timeStop: decision.timeStop,
    price: bundle.quote?.price ?? technical.price,
    movePct: bundle.quote?.pctChange ?? technical.movePct,
    levels,
    position,
    technical,
    newsDigest,
    earnings: bundle.earnings || null,
    dataQuality: {
      candleSource: bundle.candleSource,
      warnings: dataWarnings,
      fetchedAt: bundle.fetchedAt,
    },
    hardBlocks: decision.hardBlocks,
    summary: decision.summary,
    components: {
      technicalScore,
      newsScore: newsDigest.score,
      regimeScore: regime.score,
      regime: regime.label,
    },
  };
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      results.push(await mapper(current));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}

export async function buildSwingTradeReport(options = {}) {
  const env = options.env || process.env;
  const alertConfig = buildPortfolioAlertConfig(env);
  const provider = options.provider || createSwingDataProvider({
    finnhubApiKey: env.FINNHUB_API_KEY || alertConfig.providers.finnhubApiKey,
    indmoneyMcpCacheSeconds: alertConfig.providers.indmoneyMcpCacheSeconds,
    userAgent: alertConfig.userAgent,
    days: Number(env.SWING_TRADE_CANDLE_DAYS || 365),
  });
  const extraSymbols = [
    ...(options.symbols || []),
    ...(await provider.getHoldingsAndWatchlistSymbols().catch(() => [])),
  ];
  const requestedSymbols = (options.symbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
  const universe = requestedSymbols.length
    ? buildMajorUsUniverse(requestedSymbols).filter((symbol) => requestedSymbols.includes(symbol))
    : buildMajorUsUniverse(extraSymbols);
  const maxScanSymbols = Math.max(1, Math.min(Number(options.maxScanSymbols || env.SWING_TRADE_MAX_SCAN_SYMBOLS || 140), universe.length));
  const scanSymbols = universe.slice(0, maxScanSymbols);
  const benchmarkMoves = await provider.getBenchmarkMoves();
  const details = {};
  for (let i = 0; i < scanSymbols.length; i += 40) {
    Object.assign(details, await provider.getMcpDetails(scanSymbols.slice(i, i + 40)));
  }
  const errors = [];
  const scored = await mapLimit(scanSymbols, Number(env.SWING_TRADE_CONCURRENCY || 5), async (symbol) => {
    try {
      const bundle = await provider.getSymbolBundle(symbol, details, benchmarkMoves);
      return scoreSwingBundle(bundle, {
        risk: {
          riskPerTradePct: Number(env.SWING_TRADE_RISK_PER_TRADE_PCT || 0.02),
          maxCapitalPct: Number(env.SWING_TRADE_MAX_CAPITAL_PCT || 0.35),
          defaultEquityUsd: Number(env.SWING_TRADE_DEFAULT_EQUITY_USD || 10000),
        },
        portfolio: { equityUsd: Number(env.SWING_TRADE_DEFAULT_EQUITY_USD || 10000) },
      });
    } catch (error) {
      errors.push({ symbol, error: error.message });
      return null;
    }
  });
  const recommendations = scored.filter(Boolean).sort((a, b) => b.score - a.score);
  const includeRejected = Boolean(options.includeRejected);
  const limit = Math.max(1, Number(options.limit || 30));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    universe: {
      name: 'S&P 500 + Nasdaq 100 liquid major universe',
      totalAvailable: DEFAULT_MAJOR_US_UNIVERSE.length,
      scanned: scanSymbols.length,
      maxScanSymbols,
    },
    risk: {
      mode: 'controlled_aggressive',
      riskPerTradePct: Number(env.SWING_TRADE_RISK_PER_TRADE_PCT || 0.02),
      maxCapitalPct: Number(env.SWING_TRADE_MAX_CAPITAL_PCT || 0.35),
      recommendationOnly: true,
    },
    benchmarkMoves,
    topBuys: recommendations.filter((item) => item.action.startsWith('BUY')).slice(0, limit),
    sellOrTrim: recommendations.filter((item) => ['SELL_NEXT_SESSION', 'TRIM_TODAY'].includes(item.action)).slice(0, limit),
    watch: recommendations.filter((item) => item.action === 'HOLD_FOR_NEXT_SESSION').slice(0, limit),
    avoid: recommendations.filter((item) => item.action === 'AVOID').slice(0, includeRejected ? limit : 10),
    ranked: includeRejected ? recommendations.slice(0, limit) : recommendations.filter((item) => item.action !== 'AVOID').slice(0, limit),
    errors: errors.slice(0, 25),
    disclaimer: 'Research and decision-support only. No recommendation is guaranteed and no order is placed.',
  };
}
