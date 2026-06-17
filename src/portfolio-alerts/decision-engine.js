import { calculateDynamicLevels } from './dynamic-levels.js';
import { clamp, compactWhitespace, computePercentChange, round, toNumber } from './utils.js';

const CATEGORY_PROFILES = {
  ai_compute_leader: { relevance: 20, exposure: 14, role: 'Core compounder', risk: -2 },
  ai_custom_silicon_networking: { relevance: 19, exposure: 13, role: 'Core compounder', risk: -2 },
  ai_memory_hbm: { relevance: 18, exposure: 13, role: 'Profit engine', risk: -4 },
  ai_foundry_manufacturing: { relevance: 17, exposure: 12, role: 'Core compounder', risk: -3 },
  ai_power_cooling_datacenter: { relevance: 17, exposure: 11, role: 'Tactical momentum', risk: -3 },
  ai_servers: { relevance: 15, exposure: 10, role: 'Tactical momentum', risk: -6 },
  ai_cloud_hyperscaler: { relevance: 15, exposure: 8, role: 'Core compounder', risk: -3 },
  ai_software_enterprise: { relevance: 14, exposure: 7, role: 'Tactical momentum', risk: -5 },
  speculative_ai_cloud_compute: { relevance: 13, exposure: 6, role: 'Speculative satellite', risk: -12 },
  ai_optical_connectivity: { relevance: 15, exposure: 9, role: 'Tactical momentum', risk: -5 },
  other: { relevance: 5, exposure: 2, role: 'Watchlist candidate', risk: -8 },
  benchmark: { relevance: 0, exposure: 0, role: 'Benchmark', risk: 0 },
};

const TICKER_CATEGORY = {
  NVDA: 'ai_compute_leader',
  AMD: 'ai_compute_leader',
  AVGO: 'ai_custom_silicon_networking',
  MRVL: 'ai_custom_silicon_networking',
  ANET: 'ai_custom_silicon_networking',
  MU: 'ai_memory_hbm',
  TSM: 'ai_foundry_manufacturing',
  ASML: 'ai_foundry_manufacturing',
  VRT: 'ai_power_cooling_datacenter',
  ETN: 'ai_power_cooling_datacenter',
  CEG: 'ai_power_cooling_datacenter',
  VST: 'ai_power_cooling_datacenter',
  AAON: 'ai_power_cooling_datacenter',
  PWR: 'ai_power_cooling_datacenter',
  FIX: 'ai_power_cooling_datacenter',
  DELL: 'ai_servers',
  HPE: 'ai_servers',
  SMCI: 'ai_servers',
  MSFT: 'ai_cloud_hyperscaler',
  GOOGL: 'ai_cloud_hyperscaler',
  AMZN: 'ai_cloud_hyperscaler',
  META: 'ai_cloud_hyperscaler',
  ORCL: 'ai_cloud_hyperscaler',
  PLTR: 'ai_software_enterprise',
  CRM: 'ai_software_enterprise',
  NOW: 'ai_software_enterprise',
  SNOW: 'ai_software_enterprise',
  MDB: 'ai_software_enterprise',
  ADBE: 'ai_software_enterprise',
  DDOG: 'ai_software_enterprise',
  NET: 'ai_software_enterprise',
  CRWV: 'speculative_ai_cloud_compute',
  NBIS: 'speculative_ai_cloud_compute',
  IREN: 'speculative_ai_cloud_compute',
  WULF: 'speculative_ai_cloud_compute',
  SOUN: 'speculative_ai_cloud_compute',
  BBAI: 'speculative_ai_cloud_compute',
  AI: 'speculative_ai_cloud_compute',
  COHR: 'ai_optical_connectivity',
  LITE: 'ai_optical_connectivity',
  CIEN: 'ai_optical_connectivity',
  GLW: 'ai_optical_connectivity',
  NOK: 'ai_optical_connectivity',
  ERIC: 'ai_optical_connectivity',
  QQQ: 'benchmark',
  SMH: 'benchmark',
};

function resolveCategory(entity = {}) {
  return entity.profile?.aiCategory || TICKER_CATEGORY[entity.ticker] || 'other';
}

function scoreFinancialQuality(fundamental = {}) {
  fundamental = fundamental || {};
  let score = 7;
  const qualityScore = toNumber(fundamental.qualityScore);
  if (qualityScore !== null) {
    score += qualityScore * 2;
  }
  if ((toNumber(fundamental.revenueGrowthYoY) || 0) >= 20) score += 2;
  if ((toNumber(fundamental.epsGrowthYoY) || 0) >= 15) score += 2;
  if ((toNumber(fundamental.operatingMargin) || 0) >= 20) score += 2;
  if ((toNumber(fundamental.debtToEquity) || 0) > 1.5) score -= 3;
  return clamp(score, 0, 15);
}

function scoreGrowthQuality(fundamental = {}) {
  fundamental = fundamental || {};
  let score = 7;
  const revenueGrowth = toNumber(fundamental.revenueGrowthYoY);
  const epsGrowth = toNumber(fundamental.epsGrowthYoY);
  if (revenueGrowth !== null) score += revenueGrowth >= 25 ? 4 : revenueGrowth >= 12 ? 2 : revenueGrowth < 0 ? -3 : 0;
  if (epsGrowth !== null) score += epsGrowth >= 20 ? 4 : epsGrowth >= 10 ? 2 : epsGrowth < 0 ? -3 : 0;
  if (revenueGrowth === null && epsGrowth === null) score -= 2;
  return clamp(score, 0, 15);
}

function scoreValuationSanity(fundamental = {}, category) {
  fundamental = fundamental || {};
  const pe = toNumber(fundamental.pe);
  if (pe === null) {
    return category === 'speculative_ai_cloud_compute' ? 3 : 5;
  }
  if (pe <= 0) return 2;
  if (pe <= 30) return 9;
  if (pe <= 45) return 7;
  if (pe <= 70) return 5;
  return 2;
}

function scoreMomentum(technical = {}, movePct = null) {
  technical = technical || {};
  let score = 5;
  if (technical.maAlignment === 'bullish_stack') score += 3;
  else if (technical.maAlignment === 'constructive') score += 2;
  else if (technical.maAlignment === 'deteriorating') score -= 2;
  else if (technical.maAlignment === 'bearish_stack') score -= 3;
  if (technical.breakout) score += 2;
  if (technical.breakdown) score -= 3;
  const move = toNumber(movePct) ?? toNumber(technical.performance1D);
  if (move !== null) {
    if (move >= 2) score += 2;
    else if (move <= -2) score -= 2;
  }
  return clamp(score, 0, 10);
}

function scoreRelativeStrength(technical = {}) {
  technical = technical || {};
  let score = 5;
  const qqq = toNumber(technical.relativeStrengthVsQqq);
  const smh = toNumber(technical.relativeStrengthVsSmh);
  if (qqq !== null) score += qqq >= 1 ? 3 : qqq >= 0.3 ? 1 : qqq <= -1 ? -3 : qqq <= -0.3 ? -1 : 0;
  if (smh !== null) score += smh >= 1 ? 2 : smh >= 0.3 ? 1 : smh <= -1 ? -2 : smh <= -0.3 ? -1 : 0;
  return clamp(score, 0, 10);
}

function scoreNewsQuality(newsDigest = {}) {
  newsDigest = newsDigest || {};
  const average = toNumber(newsDigest.averageScore);
  const tagged = new Set(newsDigest.tags || []);
  let score = average !== null ? average * 2 : 0;
  if (newsDigest.sentiment === 'bullish') score += 3;
  if (newsDigest.sentiment === 'bearish') score -= 4;
  if (tagged.has('dilution') || tagged.has('guidance_cut') || tagged.has('accounting_risk')) score -= 5;
  if (tagged.has('beat_raise') || tagged.has('ai_order')) score += 3;
  return clamp(score, -10, 10);
}

function scoreRiskPenalty(entity = {}, category, portfolioContext = {}) {
  let penalty = CATEGORY_PROFILES[category]?.risk ?? -6;
  if (entity.profile?.riskPenalty) penalty += entity.profile.riskPenalty * 4;
  if (portfolioContext.protectionMode && ['speculative_ai_cloud_compute', 'ai_servers', 'ai_software_enterprise'].includes(category)) {
    penalty -= 4;
  }
  if (entity.fundamentalSnapshot?.nextEarningsDate) {
    const hours = (Date.parse(`${entity.fundamentalSnapshot.nextEarningsDate}T00:00:00Z`) - Date.now()) / 36e5;
    if (hours >= 0 && hours <= 48) penalty -= 5;
  }
  return clamp(penalty, -20, 0);
}

export function scoreAiThesis(entity = {}, portfolioContext = {}) {
  const category = resolveCategory(entity);
  const profile = CATEGORY_PROFILES[category] || CATEGORY_PROFILES.other;
  const financialQuality = scoreFinancialQuality(entity.fundamentalSnapshot);
  const growthQuality = scoreGrowthQuality(entity.fundamentalSnapshot);
  const valuationSanity = scoreValuationSanity(entity.fundamentalSnapshot, category);
  const priceMomentum = scoreMomentum(entity.technicalSnapshot, entity.movePct);
  const relativeStrength = scoreRelativeStrength(entity.technicalSnapshot);
  const newsQuality = scoreNewsQuality(entity.newsDigest);
  const riskPenalty = scoreRiskPenalty(entity, category, portfolioContext);
  const total = clamp(
    profile.relevance +
      profile.exposure +
      financialQuality +
      growthQuality +
      valuationSanity +
      priceMomentum +
      relativeStrength +
      newsQuality +
      riskPenalty,
    0,
    100,
  );
  const cautious = !entity.fundamentalSnapshot?.revenueGrowthYoY && profile.exposure >= 10;
  return {
    total: round(cautious ? Math.min(total, 82) : total, 0),
    category,
    categoryLabel: category.replace(/_/g, ' '),
    portfolioRole: entity.profile?.roleType || profile.role,
    components: {
      aiRelevance: profile.relevance,
      aiRevenueExposure: cautious ? Math.max(profile.exposure - 3, 0) : profile.exposure,
      financialQuality,
      growthQuality,
      valuationSanity,
      priceMomentum,
      relativeStrength,
      newsQuality,
      riskPenalty,
    },
    explanation: compactWhitespace(
      `${entity.ticker} is classified as ${category.replace(/_/g, ' ')}. ` +
      `${entity.fundamentalSnapshot?.summary || 'Financial coverage is incomplete.'} ` +
      `${cautious ? 'AI revenue is not directly measurable, so the exposure score is capped.' : ''}`,
    ),
  };
}

function deriveMarketRegime(marketState = {}, sectorIntelligence = {}) {
  const qqq = toNumber(marketState.benchmarkState?.qqqMovePct ?? sectorIntelligence?.benchmarks?.QQQ?.movePct);
  const smh = toNumber(marketState.benchmarkState?.smhMovePct ?? sectorIntelligence?.benchmarks?.SMH?.movePct);
  const breadth = toNumber(sectorIntelligence?.sectorBreadth?.positivePercent);
  const riskOff = marketState.capexFear || (qqq !== null && smh !== null && qqq < -0.7 && smh < -0.7) || (breadth !== null && breadth < 35);
  const riskOn = !riskOff && qqq !== null && smh !== null && qqq > 0.4 && smh > 0.4 && (breadth === null || breadth >= 50);
  return riskOff ? 'risk_off' : riskOn ? 'risk_on' : 'neutral';
}

function analyzeConcentration(portfolio = {}) {
  const holdings = [...(portfolio.holdings || [])];
  const portfolioValue = toNumber(portfolio.summary?.portfolioValueUsd) || holdings.reduce((sum, item) => sum + (toNumber(item.currentValueUsd) || 0), 0);
  const totalProfit = Math.max(toNumber(portfolio.summary?.unrealizedProfitUsd) || 0, 0);
  const warnings = [];
  const byWeight = holdings
    .map((item) => ({ ticker: item.ticker, weight: toNumber(item.portfolioWeightPct) || 0 }))
    .sort((a, b) => b.weight - a.weight);
  const top3Weight = round(byWeight.slice(0, 3).reduce((sum, item) => sum + item.weight, 0), 2);
  if (top3Weight >= 65) warnings.push(`Top 3 holdings are ${top3Weight}% of portfolio.`);
  for (const item of holdings) {
    const profit = Math.max(toNumber(item.totalPnlUsd) || 0, 0);
    if (totalProfit > 0 && profit / totalProfit > 0.6) {
      warnings.push(`${item.ticker} contributes ${round((profit / totalProfit) * 100, 1)}% of total profit.`);
    }
    const weight = portfolioValue > 0 ? ((toNumber(item.currentValueUsd) || 0) / portfolioValue) * 100 : 0;
    if (weight >= 25) warnings.push(`${item.ticker} weight is ${round(weight, 1)}%.`);
  }
  return { top3Weight, warnings: [...new Set(warnings)] };
}

function analyzeTargetProgress(portfolio = {}, marketState = {}, config = {}) {
  const profitUsd = toNumber(portfolio.summary?.unrealizedProfitUsd) || 0;
  const realizedUsd = toNumber(portfolio.summary?.realizedProfitUsd) || 0;
  const usdInrRate = toNumber(marketState.usdInrRate) ?? config.thresholds.usdInrRate;
  const taxRate = toNumber(config.thresholds.taxRate) ?? 0.3;
  const targetInr = toNumber(config.thresholds.targetInrNetProfit) || 0;
  const days = Math.max(1, Math.round(toNumber(config.thresholds.targetHorizonDays) || 60));
  const afterTaxProfitInr = round((profitUsd + realizedUsd) * usdInrRate * (1 - taxRate), 0);
  const remainingInr = round(Math.max(targetInr - afterTaxProfitInr, 0), 0);
  const portfolioValueUsd = toNumber(portfolio.summary?.portfolioValueUsd) || 0;
  const requiredReturnPct = portfolioValueUsd > 0
    ? round((remainingInr / ((1 - taxRate) * usdInrRate) / portfolioValueUsd) * 100, 2)
    : null;
  const requiredDailyReturnPct = requiredReturnPct !== null ? round(requiredReturnPct / days, 2) : null;
  const realismScore =
    requiredDailyReturnPct === null ? 50 :
    requiredDailyReturnPct <= 0.25 ? 80 :
    requiredDailyReturnPct <= 0.6 ? 55 :
    requiredDailyReturnPct <= 1 ? 30 :
    15;
  return {
    afterTaxProfitInr,
    progressPct: targetInr > 0 ? round((afterTaxProfitInr / targetInr) * 100, 2) : 0,
    remainingInr,
    daysRemaining: days,
    requiredReturnPct,
    requiredDailyReturnPct,
    requiredWeeklyReturnPct: requiredDailyReturnPct !== null ? round(requiredDailyReturnPct * 5, 2) : null,
    realismScore,
    message: realismScore < 40
      ? 'Target requires aggressive returns; protect capital and use high-conviction entries only.'
      : 'Target path is plausible only if opportunity quality stays high.',
  };
}

function scoreOpportunity(entity, aiThesis, levels, marketRegime, portfolio, concentration) {
  let score = 0;
  score += aiThesis.total * 0.35;
  score += scoreFinancialQuality(entity.fundamentalSnapshot);
  score += scoreMomentum(entity.technicalSnapshot, entity.movePct);
  score += scoreRelativeStrength(entity.technicalSnapshot);
  score += clamp((toNumber(levels.riskReward) || 0) * 8, 0, 12);
  score += marketRegime === 'risk_on' ? 10 : marketRegime === 'neutral' ? 5 : -5;
  score += (toNumber(entity.portfolioWeightPct) || 0) > 18 ? -10 : 5;
  score += scoreNewsQuality(entity.newsDigest) * 0.5;
  if (concentration.warnings.some((warning) => warning.includes(entity.ticker))) score -= 8;
  if (entity.fundamentalSnapshot?.nextEarningsDate) score -= 4;
  return clamp(round(score, 0), 0, 100);
}

function scoreExitPressure(entity, aiThesis, levels, portfolioContext, concentration) {
  let score = 10;
  const price = toNumber(entity.livePrice);
  if (price !== null && levels.trimLevel !== null && price < levels.trimLevel) score += 20;
  if (price !== null && levels.stopLevel !== null && price < levels.stopLevel) score += 20;
  if (entity.technicalSnapshot?.breakdown) score += 15;
  if (entity.technicalSnapshot?.maAlignment === 'bearish_stack') score += 12;
  if (scoreRelativeStrength(entity.technicalSnapshot) <= 3) score += 10;
  if (aiThesis.total < 45) score += 15;
  if (scoreNewsQuality(entity.newsDigest) <= -4) score += 12;
  if (portfolioContext.protectionMode && ['Speculative satellite', 'Tactical momentum'].includes(aiThesis.portfolioRole)) score += 8;
  if (concentration.warnings.some((warning) => warning.includes(entity.ticker))) score += 8;
  if ((toNumber(entity.totalPnlUsd) || 0) < 0 && aiThesis.total < 60) score += 8;
  return clamp(round(score, 0), 0, 100);
}

function holdingDecision(exitPressure, opportunityScore, aiThesis, portfolioContext) {
  if (exitPressure >= 81) return 'EXIT';
  if (exitPressure >= 66) return 'TRIM';
  if (exitPressure >= 51) return 'HOLD_BUT_WATCH';
  if (portfolioContext.protectionMode && (toNumber(aiThesis.total) || 0) >= 65) return 'PROTECT_PROFIT';
  if (opportunityScore >= 75 && exitPressure <= 30) return 'ADD_ONLY_IF_CONFIRMED';
  if (opportunityScore < 45) return 'DO_NOT_ADD';
  return 'HOLD';
}

function watchlistDecision(opportunityScore, threshold, levels) {
  if (opportunityScore < 45) return 'AVOID';
  if (opportunityScore < threshold) return 'WATCH';
  if ((toNumber(levels.riskReward) || 0) < 1) return 'WAIT_FOR_PULLBACK';
  if (opportunityScore >= threshold + 10) return 'STARTER_ENTRY';
  return 'ADD_ON_CONFIRMATION';
}

function calculatePositionSizing(entity, opportunityScore, levels, marketRegime, portfolio = {}, config = {}) {
  const cash = toNumber(portfolio.summary?.buyingPowerUsd) || 0;
  const portfolioValue = toNumber(portfolio.summary?.portfolioValueUsd) || 0;
  const reservePct = marketRegime === 'risk_off'
    ? config.thresholds.cashReserveRiskOffPct
    : marketRegime === 'risk_on'
      ? config.thresholds.cashReserveRiskOnPct
      : config.thresholds.cashReserveNeutralPct;
  const reserve = cash * (toNumber(reservePct) ?? 0.3);
  const deployable = Math.max(cash - reserve, 0);
  const stopDistancePct = computePercentChange(toNumber(entity.livePrice), levels.stopLevel);
  const riskScale = Math.abs(stopDistancePct || 5) > 8 ? 0.5 : 1;
  const confidenceScale = clamp(opportunityScore / 100, 0, 1);
  const regimeScale = marketRegime === 'risk_off' ? 0.35 : marketRegime === 'neutral' ? 0.65 : 1;
  const maxDailyCap = Math.max(0, toNumber(config.thresholds.maxDailyDeploymentPct) ?? 0.25) * cash;
  const suggestedUsd = round(Math.min(deployable * confidenceScale * regimeScale * riskScale, maxDailyCap || deployable), 2);
  return {
    cashAvailableUsd: round(cash, 2),
    reserveUsd: round(reserve, 2),
    deployableUsd: round(deployable, 2),
    suggestedUsd,
    maxPositionValueUsd: round(portfolioValue * 0.18, 2),
    stopDistancePct: stopDistancePct === null ? null : Math.abs(stopDistancePct),
  };
}

function buildEntityDecision(entity, kind, context) {
  const levels = calculateDynamicLevels(entity);
  const aiThesis = scoreAiThesis(entity, context.portfolioContext);
  const opportunityScore = scoreOpportunity(entity, aiThesis, levels, context.marketRegime, context.portfolio, context.concentration);
  const exitPressureScore = kind === 'holding'
    ? scoreExitPressure(entity, aiThesis, levels, context.portfolioContext, context.concentration)
    : 0;
  const threshold = context.thresholds[context.marketRegime];
  const decision = kind === 'holding'
    ? holdingDecision(exitPressureScore, opportunityScore, aiThesis, context.portfolioContext)
    : watchlistDecision(opportunityScore, threshold, levels);
  const blockingReasons = [];
  if (opportunityScore < threshold && ['ADD_ONLY_IF_CONFIRMED', 'STARTER_ENTRY', 'ADD_ON_CONFIRMATION'].includes(decision)) {
    blockingReasons.push(`Opportunity score is below ${threshold} ${context.marketRegime.replace(/_/g, '-')} threshold.`);
  }
  if (context.portfolioContext.protectionMode && opportunityScore < 85) {
    blockingReasons.push('Portfolio is in profit-protection mode.');
  }
  if ((toNumber(levels.riskReward) || 0) < 1) {
    blockingReasons.push('Risk/reward is below 1:1.');
  }
  return {
    decision,
    aiThesisScore: aiThesis,
    opportunityScore,
    exitPressureScore,
    dynamicLevels: levels,
    positionSizing: calculatePositionSizing(entity, opportunityScore, levels, context.marketRegime, context.portfolio, context.config),
    explanation: compactWhitespace(`${aiThesis.explanation} ${levels.reasoning}`),
    blockingReasons,
  };
}

function decideCashDeployment(marketRegime, topOpportunity, portfolioContext, config, portfolio) {
  const score = toNumber(topOpportunity?.opportunityScore) || 0;
  const cash = toNumber(portfolio.summary?.buyingPowerUsd) || 0;
  if (cash <= (toNumber(config.thresholds.buyPowerFloorUsd) || 0) || portfolioContext.protectionMode || score <= 0) {
    return { decision: 'DEPLOY_0', deployPctRange: '0%', reason: 'Cash should stay idle while protection mode or opportunity quality blocks deployment.' };
  }
  if (marketRegime === 'risk_off') {
    return score >= 85
      ? { decision: 'DEPLOY_10_20', deployPctRange: '10%-20%', reason: 'Risk-off tape allows only small high-quality entries.' }
      : { decision: 'DEPLOY_0', deployPctRange: '0%', reason: 'Risk-off tape and opportunity score below 85.' };
  }
  if (marketRegime === 'neutral') {
    return score >= 75
      ? { decision: 'DEPLOY_25_35', deployPctRange: '25%-35%', reason: 'Neutral tape allows measured deployment into confirmed setups.' }
      : { decision: 'DEPLOY_0', deployPctRange: '0%', reason: 'Neutral tape requires opportunity score of at least 75.' };
  }
  return score >= 80
    ? { decision: 'DEPLOY_50_PLUS', deployPctRange: '50%+', reason: 'Risk-on tape and high-quality opportunity support larger deployment.' }
    : score >= 65
      ? { decision: 'DEPLOY_25_35', deployPctRange: '25%-35%', reason: 'Risk-on tape supports gradual deployment.' }
      : { decision: 'DEPLOY_0', deployPctRange: '0%', reason: 'Opportunity quality below risk-on threshold.' };
}

export function buildDecisionReport({
  portfolio = {},
  holdings = [],
  watchlist = [],
  marketState = {},
  sectorIntelligence = {},
  portfolioContext = {},
  config = {},
} = {}) {
  const marketRegime = deriveMarketRegime(marketState, sectorIntelligence);
  const concentration = analyzeConcentration(portfolio);
  const targetProgress = analyzeTargetProgress(portfolio, marketState, config);
  const thresholds = {
    risk_off: toNumber(config.thresholds.opportunityRiskOffThreshold) || 85,
    neutral: toNumber(config.thresholds.opportunityNeutralThreshold) || 75,
    risk_on: toNumber(config.thresholds.opportunityRiskOnThreshold) || 65,
  };
  const context = { marketRegime, concentration, targetProgress, thresholds, portfolioContext, portfolio, config };
  const holdingDecisions = holdings.map((entity) => ({
    ticker: entity.ticker,
    ...buildEntityDecision(entity, 'holding', context),
  }));
  const watchlistDecisions = watchlist.map((entity) => ({
    ticker: entity.ticker,
    ...buildEntityDecision(entity, 'watchlist', context),
  }));
  const topOpportunity = [...holdingDecisions, ...watchlistDecisions]
    .filter((item) => ['ADD_ONLY_IF_CONFIRMED', 'STARTER_ENTRY', 'ADD_ON_CONFIRMATION'].includes(item.decision))
    .sort((a, b) => b.opportunityScore - a.opportunityScore)[0] || null;
  const cash = decideCashDeployment(marketRegime, topOpportunity, portfolioContext, config, portfolio);
  return {
    marketRegime,
    thresholds,
    targetProgress,
    concentration,
    cash,
    holdings: holdingDecisions,
    watchlist: watchlistDecisions,
    ranked: {
      strongestOpportunities: [...holdingDecisions, ...watchlistDecisions].sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 5),
      weakestHoldings: [...holdingDecisions].sort((a, b) => b.exitPressureScore - a.exitPressureScore).slice(0, 5),
    },
  };
}
