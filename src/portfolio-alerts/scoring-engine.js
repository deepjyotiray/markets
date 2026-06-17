import { clamp, compactWhitespace, round, toNumber } from './utils.js';
import { computeResearchScoreAdjustments } from './sector-intelligence.js';

const NEGATIVE_NEWS_RULES = [
  { pattern: /\bdilution|secondary offering|equity raise|stock offering\b/i, score: -3, tag: 'dilution' },
  { pattern: /\bguidance cut|cuts guidance|lowered guidance\b/i, score: -3, tag: 'guidance_cut' },
  { pattern: /\baccounting|probe|investigation|fraud\b/i, score: -3, tag: 'accounting_risk' },
  { pattern: /\bearnings miss|misses earnings|missed earnings\b/i, score: -2, tag: 'earnings_miss' },
  { pattern: /\bdowngrade\b/i, score: -1, tag: 'downgrade' },
];

const POSITIVE_NEWS_RULES = [
  { pattern: /\bbeat and raise|beats and raises|beat earnings\b/i, score: 3, tag: 'beat_raise' },
  { pattern: /\bmajor ai order|ai deal|large ai contract|hbm demand\b/i, score: 2, tag: 'ai_order' },
  { pattern: /\bupgrade\b/i, score: 1, tag: 'upgrade' },
];

export function scoreNews(items = []) {
  let score = 0;
  const tags = new Set();
  const titles = items.map((item) => compactWhitespace(`${item.title || ''} ${item.description || ''}`)).filter(Boolean);
  for (const title of titles) {
    for (const rule of NEGATIVE_NEWS_RULES) {
      if (rule.pattern.test(title)) {
        score = Math.min(score, rule.score);
        tags.add(rule.tag);
      }
    }
    for (const rule of POSITIVE_NEWS_RULES) {
      if (rule.pattern.test(title)) {
        score = Math.max(score, rule.score);
        tags.add(rule.tag);
      }
    }
  }
  return { score: clamp(score, -3, 3), tags: [...tags], summary: titles[0] || 'No major catalyst detected.' };
}

function scoreRelativeStrength(displayMovePct, qqqMovePct, smhMovePct) {
  const move = toNumber(displayMovePct);
  if (move === null) {
    return 0;
  }
  const benchmarkValues = [toNumber(qqqMovePct), toNumber(smhMovePct)].filter((value) => value !== null);
  if (!benchmarkValues.length) {
    return 0;
  }
  const benchmark = benchmarkValues.reduce((sum, value) => sum + value, 0) / benchmarkValues.length;
  const diff = move - benchmark;
  if (diff >= 1) {
    return 2;
  }
  if (diff >= 0.3) {
    return 1;
  }
  if (diff <= -1) {
    return -2;
  }
  if (diff <= -0.3) {
    return -1;
  }
  return 0;
}

function scorePriceAction(profile, holding) {
  const price = toNumber(holding.livePrice);
  const movePct = toNumber(holding.movePct);
  if (price === null) {
    return 0;
  }
  let score = 0;
  if (profile.support?.hardExitBelow !== undefined && price < profile.support.hardExitBelow) {
    score -= 3;
  } else if (profile.support?.partialExitBelow !== undefined && price < profile.support.partialExitBelow) {
    score -= 2;
  } else if (profile.support?.trimBelow !== undefined && price < profile.support.trimBelow) {
    score -= 2;
  } else if (profile.support?.warnBelow !== undefined && price < profile.support.warnBelow) {
    score -= 1;
  } else if (profile.support?.holdAbove !== undefined && price >= profile.support.holdAbove) {
    score += 1;
  }

  if (movePct !== null) {
    if (movePct >= 2) {
      score += 2;
    } else if (movePct >= 0.5) {
      score += 1;
    } else if (movePct <= -2) {
      score -= 2;
    } else if (movePct <= -0.5) {
      score -= 1;
    }
  }
  return clamp(score, -3, 3);
}

function scorePortfolioRole(profile, holding, portfolioContext) {
  const profit = toNumber(holding.totalPnlUsd);
  if (profile.category === 'core' || profile.category === 'quality' || profile.category === 'stabilizer') {
    return holding.livePrice >= (profile.support?.holdAbove ?? -Infinity) ? 1 : 0;
  }
  if (profile.category === 'laggard' || profile.category === 'speculative') {
    return holding.livePrice < (profile.support?.holdAbove ?? Infinity) ? -1 : 0;
  }
  if (profile.category === 'profit_engine') {
    return profit !== null && profit >= 500 ? 1 : 0;
  }
  if (portfolioContext.protectionMode && ['high_beta', 'speculative', 'secondary'].includes(profile.category)) {
    return -1;
  }
  return 0;
}

function scoreRiskPenalty(profile, portfolioContext) {
  let penalty = profile.riskPenalty || 0;
  if (portfolioContext.capexFear && profile.thesisBucket === 'capex_spender') {
    penalty -= 1;
  }
  return clamp(penalty, -1, 0);
}

export function mapScoreToAction(score) {
  if (score >= 7) {
    return 'STRONG_HOLD';
  }
  if (score >= 4) {
    return 'HOLD';
  }
  if (score >= 1) {
    return 'WATCH';
  }
  if (score >= -2) {
    return 'THINK';
  }
  if (score >= -5) {
    return 'TRIM';
  }
  return 'EXIT_CANDIDATE';
}

export function scoreHolding(holding, profile, benchmarks, newsItems, portfolioContext, researchSnapshot = null) {
  const news = scoreNews(newsItems);
  const priceActionScore = scorePriceAction(profile, holding);
  const relativeStrengthScore = scoreRelativeStrength(holding.movePct, benchmarks.qqqMovePct, benchmarks.smhMovePct);
  const roleScore = scorePortfolioRole(profile, holding, portfolioContext);
  const riskPenalty = scoreRiskPenalty(profile, portfolioContext);
  const researchAdjustments = researchSnapshot ? computeResearchScoreAdjustments(researchSnapshot) : {
    technicalScore: 0,
    fundamentalScore: 0,
    sectorShiftScore: 0,
  };
  const finalScore = clamp(
    priceActionScore +
      relativeStrengthScore +
      news.score +
      roleScore +
      riskPenalty +
      researchAdjustments.technicalScore +
      researchAdjustments.fundamentalScore +
      researchAdjustments.sectorShiftScore,
    -10,
    10,
  );

  return {
    priceActionScore,
    relativeStrengthScore,
    newsScore: news.score,
    portfolioRoleScore: roleScore,
    riskPenalty,
    technicalScore: researchAdjustments.technicalScore,
    fundamentalScore: researchAdjustments.fundamentalScore,
    sectorShiftScore: researchAdjustments.sectorShiftScore,
    finalScore,
    action: mapScoreToAction(finalScore),
    newsSummary: news.summary,
    newsTags: news.tags,
  };
}

export function buildPortfolioContext(portfolio, marketContext, config) {
  const unrealizedProfitUsd = toNumber(portfolio.summary.unrealizedProfitUsd) || 0;
  const afterTaxProfitInr = unrealizedProfitUsd * marketContext.usdInrRate * (1 - config.thresholds.taxRate);
  const targetProgress = config.thresholds.targetInrNetProfit > 0
    ? afterTaxProfitInr / config.thresholds.targetInrNetProfit
    : 0;
  return {
    unrealizedProfitUsd,
    afterTaxProfitInr: round(afterTaxProfitInr, 0),
    targetProgress: round(targetProgress * 100, 2),
    protectionMode: unrealizedProfitUsd <= 500 || targetProgress >= 60,
    capitalProtectionMode: unrealizedProfitUsd <= 400 || targetProgress >= 80,
    capexFear: marketContext.capexFear,
    dataQuality: portfolio.dataQuality || null,
  };
}
