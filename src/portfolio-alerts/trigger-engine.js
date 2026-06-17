import {
  clearOpenTrigger,
  getTickerSessionCount,
  setCooldown,
  setLastAlertByKey,
  setOpenTrigger,
} from './state-store.js';
import { formatInr, formatPct, formatUsd, nowIso, round, toNumber } from './utils.js';

const SEVERITY_PRIORITY = { L1: 1, L2: 2, L3: 3, L4: 4 };

function buildResearchMetadata(holding = {}, extras = {}) {
  return {
    sectorContext: holding.sectorContext?.summary || null,
    technicalContext: holding.technicalSnapshot?.summary || null,
    fundamentalContext: holding.fundamentalSnapshot?.summary || null,
    latestHeadline: holding.newsDigest?.latestHeadline || holding.newsSummary || null,
    ...extras,
  };
}

function attachResearchMetadata(alert, holding = {}, extras = {}) {
  return {
    ...alert,
    metadata: {
      ...(alert.metadata || {}),
      ...buildResearchMetadata(holding, extras),
    },
  };
}

export function buildTickerRuleAlerts(holding, profile, score, sessionClock, portfolioContext, config) {
  const alerts = [];
  const price = toNumber(holding.livePrice);
  const profit = toNumber(holding.totalPnlUsd);

  if (holding.dataStale) {
    if (sessionClock.bucket === 'CLOSED') {
      return alerts;
    }
    alerts.push(makeAlert({
      severity: 'L2',
      action: 'DATA_WARNING',
      ticker: holding.ticker,
      title: `${holding.ticker} Data Warning`,
      triggerId: `${holding.ticker}:stale-data`,
      trigger: 'Market data is stale beyond the allowed freshness threshold',
      suggestedAction: 'Wait for fresh market data before making a trading decision.',
      reason: 'Action alerts are suppressed when the quote timestamp is too old.',
      invalidation: 'Fresh quote arrives within the allowed threshold.',
      confirmationMinutes: 0,
      immediate: true,
      threadId: `ticker:${holding.ticker}`,
      price,
      portfolioImpact: 'Potential false signal risk',
      worseningValue: 1,
    }));
    return alerts;
  }

  if (holding.ticker === 'MU') {
    if (profit !== null && profit < 600) {
      alerts.push(makeAlert({
        severity: profit < 500 ? 'L3' : 'L2',
        action: profit < 500 ? 'TRIM' : 'THINK',
        ticker: 'MU',
        title: 'MU Profit Protection',
        triggerId: `MU:profit:${profit < 500 ? '500' : '600'}`,
        trigger: `MU profit dropped to ${formatUsd(profit)}`,
        suggestedAction: profit < 500 ? 'Trim 20%-30% if weakness persists.' : 'Review MU closely for profit protection.',
        reason: 'MU is the main profit engine, so protecting gains matters more than squeezing for a little more.',
        invalidation: 'Profit recovers above the next protection band and MU reclaims support.',
        confirmationMinutes: profit < 500 ? config.thresholds.actionConfirmationMinutes : config.thresholds.watchConfirmationMinutes,
        immediate: false,
        threadId: 'ticker:MU',
        price,
        portfolioImpact: 'Largest contribution to portfolio P&L',
        worseningValue: 600 - profit,
      }));
    }
    if (price !== null && price < 1018) {
      alerts.push(makeAlert({
        severity: 'L3',
        action: 'TRIM',
        ticker: 'MU',
        title: 'MU Support Loss',
        triggerId: 'MU:lose-1018',
        trigger: 'Lost the $1018 support band',
        suggestedAction: 'Trim 20%-30% if MU stays below $1018 after confirmation.',
        reason: 'MU is the main profit engine and the system is biased toward profit protection.',
        invalidation: 'Reclaim $1025 with stability.',
        confirmationMinutes: config.thresholds.actionConfirmationMinutes,
        immediate: false,
        threadId: 'ticker:MU',
        price,
        portfolioImpact: 'High profit giveback risk',
        worseningValue: 1018 - price,
      }));
    }
  }

  if (holding.ticker === 'GOOGL') {
    if (price !== null && price < 365) {
      alerts.push(makeAlert({
        severity: price < 360 ? 'L3' : 'L1',
        action: price < 360 ? 'EXIT' : 'WATCH',
        ticker: 'GOOGL',
        title: price < 360 ? 'GOOGL Weakness' : 'GOOGL Warning',
        triggerId: price < 350 ? 'GOOGL:below-350' : price < 360 ? 'GOOGL:below-360' : 'GOOGL:below-365',
        trigger: price < 360 ? 'Broke the $360 decision area' : 'Slipped below the $365 hold level',
        suggestedAction: price < 350 ? 'Full exit candidate.' : price < 360 ? 'Sell 25%-50% after confirmation.' : 'Monitor for reclaim or further weakness.',
        reason: 'GOOGL is a laggard and a likely rotation source when buying power is constrained.',
        invalidation: price < 360 ? 'Reclaim $365 with stability.' : 'Recover above $365.',
        confirmationMinutes: price < 360 ? config.thresholds.actionConfirmationMinutes : config.thresholds.watchConfirmationMinutes,
        immediate: false,
        threadId: 'ticker:GOOGL',
        price,
        portfolioImpact: 'Large position and current drag',
        worseningValue: 365 - price,
      }));
    }
  }

  if (holding.ticker === 'PLTR' && price !== null && price < 150) {
    alerts.push(makeAlert({
      severity: 'L3',
      action: price < 149 ? 'EXIT' : 'THINK',
      ticker: 'PLTR',
      title: 'PLTR Exit Candidate',
      triggerId: price < 149 ? 'PLTR:below-149' : 'PLTR:below-150',
      trigger: price < 149 ? 'Below $149 without a reclaim' : 'Broke the $150 hold level',
      suggestedAction: price < 149 ? 'Exit 50%-100%.' : 'Exit 50%-100% if weakness persists.',
      reason: 'PLTR is speculative software, low conviction here, and a preferred rotation source.',
      invalidation: 'Reclaim $150.50 and hold.',
      confirmationMinutes: config.thresholds.actionConfirmationMinutes,
      immediate: false,
      threadId: 'ticker:PLTR',
      price,
      portfolioImpact: 'Speculative capital at risk',
      worseningValue: 150 - price,
    }));
  }

  if (holding.ticker === 'NVDA' && price !== null && price < 223) {
    alerts.push(makeAlert({
      severity: price < 220 ? 'L3' : 'L2',
      action: price < 220 ? 'TRIM' : 'THINK',
      ticker: 'NVDA',
      title: 'NVDA Support Test',
      triggerId: price < 220 ? 'NVDA:below-220' : 'NVDA:below-223',
      trigger: price < 220 ? 'Broke below $220' : 'Lost the $223 hold level',
      suggestedAction: price < 220 ? 'Consider trimming only if broad semis stay weak.' : 'Review if market and semis remain weak.',
      reason: 'NVDA is core and normal chop should not trigger selling, but support breaks deserve attention.',
      invalidation: 'Recover above $223.',
      confirmationMinutes: price < 220 ? config.thresholds.actionConfirmationMinutes : config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: 'ticker:NVDA',
      price,
      portfolioImpact: 'Core portfolio anchor',
      worseningValue: 223 - price,
    }));
  }

  if (holding.ticker === 'AVGO') {
    if (price !== null && price < 475) {
      alerts.push(makeAlert({
        severity: price < 470 ? 'L3' : 'L1',
        action: price < 470 ? 'TRIM' : 'WATCH',
        ticker: 'AVGO',
        title: price < 470 ? 'AVGO Trim Review' : 'AVGO Warning',
        triggerId: price < 470 ? 'AVGO:below-470' : 'AVGO:below-475',
        trigger: price < 470 ? 'Dropped below $470' : 'Fell below the $475 hold zone',
        suggestedAction: price < 470 ? 'Trim after confirmation if weakness persists.' : 'Watch for reclaim above $475.',
        reason: 'AVGO is high quality, so only real support failure should prompt risk reduction.',
        invalidation: 'Recover above $475.',
        confirmationMinutes: price < 470 ? config.thresholds.actionConfirmationMinutes : config.thresholds.watchConfirmationMinutes,
        immediate: false,
        threadId: 'ticker:AVGO',
        price,
        portfolioImpact: 'High-quality AI winner',
        worseningValue: 475 - price,
      }));
    }
    if (price !== null && price >= 490 && sessionClock.bucket !== 'CLOSED') {
      alerts.push(makeAlert({
        severity: 'L2',
        action: 'THINK',
        ticker: 'AVGO',
        title: 'AVGO Optional Risk Trim',
        triggerId: 'AVGO:optional-trim-near-490',
        trigger: 'Approaching the pre-earnings risk trim zone near $490-$495',
        suggestedAction: 'Optional 20% trim for risk reduction.',
        reason: 'This is a quality winner, so the alert is optional rather than defensive.',
        invalidation: 'Momentum remains strong and no event risk is near.',
        confirmationMinutes: config.thresholds.watchConfirmationMinutes,
        immediate: false,
        threadId: 'ticker:AVGO',
        price,
        portfolioImpact: 'Optional de-risking',
        worseningValue: price - 490,
      }));
    }
  }

  if (holding.ticker === 'AMZN' && price !== null && price < 254) {
    alerts.push(makeAlert({
      severity: 'L3',
      action: 'TRIM',
      ticker: 'AMZN',
      title: 'AMZN Weakness',
      triggerId: 'AMZN:below-254',
      trigger: 'Broke below the $254-$255 hold zone',
      suggestedAction: 'Trim or exit 25%-50% after confirmation.',
      reason: 'AMZN is a non-leading capex spender and a valid rotation source when weak.',
      invalidation: 'Reclaim above $255.',
      confirmationMinutes: config.thresholds.actionConfirmationMinutes,
      immediate: false,
      threadId: 'ticker:AMZN',
      price,
      portfolioImpact: 'Rotation source candidate',
      worseningValue: 254 - price,
    }));
  }

  if (holding.ticker === 'TSM' && price !== null && price < 436) {
    alerts.push(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: 'TSM',
      title: 'TSM Support Watch',
      triggerId: 'TSM:below-436',
      trigger: 'Slipped below $436',
      suggestedAction: 'Review only if semiconductors broadly weaken.',
      reason: 'TSM is a stabilizer, so weakness matters more in the context of broad semi selling.',
      invalidation: 'Recover above $438.',
      confirmationMinutes: config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: 'ticker:TSM',
      price,
      portfolioImpact: 'Quality stabilizer at risk',
      worseningValue: 436 - price,
    }));
  }

  if (holding.ticker === 'SMCI' && price !== null && price < 48) {
    alerts.push(makeAlert({
      severity: price < 47 ? 'L3' : 'L1',
      action: price < 47 ? 'TRIM' : 'WATCH',
      ticker: 'SMCI',
      title: price < 47 ? 'SMCI Trim Review' : 'SMCI Warning',
      triggerId: price < 47 ? 'SMCI:below-47' : 'SMCI:below-48',
      trigger: price < 47 ? 'Dropped below $47' : 'Lost the $48 hold line',
      suggestedAction: price < 47 ? 'Trim or exit 25%-50%.' : 'Watch support carefully.',
      reason: 'SMCI is high beta and should not be allowed to weaken unchecked in protection mode.',
      invalidation: 'Recover above $48.',
      confirmationMinutes: price < 47 ? config.thresholds.actionConfirmationMinutes : config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: 'ticker:SMCI',
      price,
      portfolioImpact: 'High-beta exposure',
      worseningValue: 48 - price,
    }));
  }

  if (holding.ticker === 'AMD' && score.finalScore <= -3) {
    alerts.push(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: 'AMD',
      title: 'AMD Underperformance',
      triggerId: 'AMD:underperforming',
      trigger: 'Semis are weakening and AMD is lagging',
      suggestedAction: 'Low-priority trim review.',
      reason: 'AMD is secondary exposure and not a core profit driver.',
      invalidation: 'AMD regains relative strength versus semis.',
      confirmationMinutes: config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: 'ticker:AMD',
      price,
      portfolioImpact: 'Secondary semi exposure',
      worseningValue: Math.abs(score.finalScore),
    }));
  }

  if (
    holding.shiftAlignment?.alignment === 'lagging' &&
    (toNumber(holding.sectorContext?.groupMovePct) || 0) > 0.4 &&
    (toNumber(holding.technicalSnapshot?.performance1D) || 0) <= -1
  ) {
    alerts.push(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: holding.ticker,
      title: `${holding.ticker} Weak Vs Sector`,
      triggerId: `${holding.ticker}:weak-vs-sector`,
      trigger: 'The stock is lagging while its sector cohort is still holding up',
      suggestedAction: 'Review whether this is still the right capital allocation inside the AI basket.',
      reason: 'Relative weakness against the same cohort is a rotation warning even when the broad tape is not broken.',
      invalidation: 'The stock regains relative strength versus its cohort.',
      confirmationMinutes: config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: `ticker:${holding.ticker}`,
      price,
      portfolioImpact: 'Relative weakness versus sector peers',
      worseningValue: Math.abs(toNumber(holding.shiftAlignment?.relativeToGroupPct) || 0),
    }));
  }

  if (holding.technicalSnapshot?.breakout && holding.fundamentalSnapshot?.qualityLabel === 'fragile') {
    alerts.push(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: holding.ticker,
      title: `${holding.ticker} Strong But Fragile`,
      triggerId: `${holding.ticker}:strong-fragile`,
      trigger: 'Price is breaking higher but the fundamental base looks fragile',
      suggestedAction: 'Avoid chasing strength until fundamentals or headline quality improve.',
      reason: 'When technical momentum outruns fundamentals, follow-through risk rises.',
      invalidation: 'The breakout holds and either earnings or headline quality improve.',
      confirmationMinutes: config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: `ticker:${holding.ticker}`,
      price,
      portfolioImpact: 'Higher false-breakout risk',
      worseningValue: Math.abs(toNumber(holding.technicalSnapshot?.range20PositionPct) || 0),
    }));
  }

  if (
    (holding.technicalSnapshot?.breakdown && holding.newsDigest?.sentiment === 'bearish') ||
    (holding.technicalSnapshot?.breakout && holding.newsDigest?.sentiment === 'bullish')
  ) {
    alerts.push(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: holding.ticker,
      title: `${holding.ticker} Headline Confirmation`,
      triggerId: `${holding.ticker}:headline-confirms-${holding.technicalSnapshot?.breakdown ? 'breakdown' : 'breakout'}`,
      trigger: holding.technicalSnapshot?.breakdown ? 'Breakdown is being confirmed by negative headline flow' : 'Breakout is being confirmed by supportive headline flow',
      suggestedAction: holding.technicalSnapshot?.breakdown ? 'Respect the weakness if support does not recover.' : 'Only add or hold if price continues to confirm.',
      reason: 'Technical moves are more meaningful when the news flow confirms them.',
      invalidation: 'Price action decouples from the current headline tone.',
      confirmationMinutes: config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: `ticker:${holding.ticker}`,
      price,
      portfolioImpact: 'Higher conviction due to price/news alignment',
      worseningValue: Math.abs(toNumber(holding.technicalSnapshot?.performance1D) || 0),
    }));
  }

  return alerts.map((alert) => attachResearchMetadata(alert, holding));
}

export function buildPortfolioRiskAlerts(portfolio, state, config) {
  const currentProfit = toNumber(portfolio.summary.unrealizedProfitUsd) || 0;
  const peakProfit = toNumber(state.intraday?.highestUnrealizedProfitUsd) || currentProfit;
  const giveback = round(peakProfit - currentProfit, 2) || 0;
  const givebackPct = peakProfit > 0 ? round((giveback / peakProfit) * 100, 2) : 0;
  const alerts = [];

  if (giveback >= 150 || givebackPct >= 25) {
    alerts.push(makeAlert({
      severity: giveback >= 0.35 * peakProfit || giveback >= 250 ? 'L3' : 'L2',
      action: giveback >= 0.35 * peakProfit || giveback >= 250 ? 'ACT' : 'THINK',
      ticker: null,
      title: 'Portfolio Profit Giveback',
      triggerId: giveback >= 0.35 * peakProfit || giveback >= 250 ? 'PORTFOLIO:giveback-35' : 'PORTFOLIO:giveback-25',
      trigger: `Gave back ${formatUsd(giveback)} from today’s peak profit of ${formatUsd(peakProfit)}`,
      suggestedAction:
        giveback >= 0.35 * peakProfit || giveback >= 250
          ? 'Trim the weakest position first: PLTR / AMZN / GOOGL partial.'
          : 'Review weakest positions and protect gains if weakness spreads.',
      reason: 'Protect unrealized profit and avoid target regression.',
      invalidation: 'Portfolio profit stabilizes and weakest holdings improve.',
      confirmationMinutes: 0,
      immediate: true,
      threadId: 'portfolio:risk',
      price: null,
      portfolioImpact: `Current profit ${formatUsd(currentProfit)} | Giveback ${formatPct(givebackPct)}`,
      worseningValue: giveback,
    }));
  }

  for (const level of [600, 500, 400]) {
    if (currentProfit < level) {
      alerts.push(makeAlert({
        severity: level === 400 ? 'L4' : 'L3',
        action: level === 400 ? 'CRISIS' : 'THINK',
        ticker: null,
        title: 'Portfolio Protection Mode',
        triggerId: `PORTFOLIO:profit-below-${level}`,
        trigger: `Portfolio unrealized profit fell below ${formatUsd(level)}`,
        suggestedAction:
          level === 400
            ? 'Capital preservation mode. Reduce weakest positions and avoid adding.'
            : level === 500
              ? 'Defensive mode. Tighten risk on laggards and speculative names.'
              : 'Risk warning. Review weak positions early.',
        reason: 'The target path is narrowing and protecting current gains matters more.',
        invalidation: 'Profit rebuilds above the next band.',
        confirmationMinutes: 0,
        immediate: true,
        threadId: 'portfolio:risk',
        price: null,
        portfolioImpact: `Current unrealized profit ${formatUsd(currentProfit)}`,
        worseningValue: level - currentProfit,
      }));
      break;
    }
  }

  return alerts;
}

export function buildRotationAlerts(holdings, scoresByTicker, config) {
  if (!config.thresholds.rotationEnabled) {
    return [];
  }
  const buyingPower = toNumber(holdings.portfolioSummary.buyingPowerUsd) || 0;
  const weakSources = holdings.items
    .filter((holding) => holding.rotationSourceRank)
    .sort((a, b) => a.rotationSourceRank - b.rotationSourceRank);
  const strongTargets = scoresByTicker.externalTargets
    .filter((item) => item.rotationTargetRank)
    .sort((a, b) => a.rotationTargetRank - b.rotationTargetRank);

  const alerts = [];
  for (const source of weakSources) {
    const sourceScore = scoresByTicker.all[source.ticker];
    if (!sourceScore) {
      continue;
    }
    for (const target of strongTargets) {
      if (source.ticker === target.ticker) {
        continue;
      }
      const sourceExitPressure = toNumber(sourceScore.decisionReport?.exitPressureScore);
      const targetOpportunity = toNumber(target.decisionReport?.opportunityScore);
      const threshold =
        target.decisionReport && scoresByTicker.decisionReport?.thresholds
          ? scoresByTicker.decisionReport.thresholds[scoresByTicker.decisionReport.marketRegime]
          : 75;
      const diff = target.decisionReport && sourceScore.decisionReport
        ? targetOpportunity - Math.max(0, 100 - sourceExitPressure)
        : target.score.finalScore - sourceScore.score.finalScore;
      const targetAlignment = toNumber(target.shiftAlignment?.scoreAdjustment) || 0;
      const sourceAlignment = toNumber(sourceScore.shiftAlignment?.scoreAdjustment) || 0;
      if (target.decisionReport && sourceScore.decisionReport) {
        if (
          sourceExitPressure < 65 ||
          targetOpportunity < threshold ||
          targetOpportunity - sourceExitPressure < 10 ||
          targetAlignment < 1 ||
          sourceAlignment > 0
        ) {
          continue;
        }
      } else if (
        diff < 5 ||
        target.score.finalScore <= 0 ||
        sourceScore.score.finalScore >= 0 ||
        targetAlignment < 1 ||
        sourceAlignment > 0
      ) {
        continue;
      }
      alerts.push(makeAlert({
        severity: 'L3',
        action: 'ROTATE',
        ticker: source.ticker,
        title: `${source.ticker} to ${target.ticker}`,
        triggerId: `ROTATE:${source.ticker}:${target.ticker}`,
        trigger: target.decisionReport && sourceScore.decisionReport
          ? `Source exit pressure ${sourceExitPressure}, target opportunity ${targetOpportunity}`
          : `Source score ${sourceScore.score.finalScore}, target score ${target.score.finalScore}`,
        suggestedAction:
          buyingPower <= config.thresholds.buyPowerFloorUsd
            ? `Sell ${source.ticker} and rotate proceeds into ${target.ticker} only if ${target.ticker} holds support.`
            : `Consider rotating a weak source into ${target.ticker} if strength holds.`,
        reason: `${source.ticker} is weaker while ${target.ticker} shows stronger AI infrastructure alignment.`,
        invalidation: `Cancel if ${target.ticker} loses strength or ${source.ticker} stabilizes.`,
        confirmationMinutes: config.thresholds.actionConfirmationMinutes,
        immediate: false,
        threadId: `rotation:${source.ticker}:${target.ticker}`,
        price: source.livePrice,
        portfolioImpact: `Score spread ${diff}`,
        worseningValue: diff,
        metadata: {
          sourceTicker: source.ticker,
          targetTicker: target.ticker,
          sourceScore: sourceScore.decisionReport?.exitPressureScore ?? sourceScore.score.finalScore,
          targetScore: target.decisionReport?.opportunityScore ?? target.score.finalScore,
          buyingPower,
          sectorContext: `Source: ${sourceScore.sectorContext?.summary || 'not available'} | Target: ${target.sectorContext?.summary || 'not available'}`,
          technicalContext: `Source: ${sourceScore.technicalSnapshot?.summary || 'not available'} | Target: ${target.technicalSnapshot?.summary || 'not available'}`,
          fundamentalContext: `Source: ${sourceScore.fundamentalSnapshot?.summary || 'not available'} | Target: ${target.fundamentalSnapshot?.summary || 'not available'}`,
          latestHeadline: target.newsDigest?.latestHeadline || sourceScore.newsDigest?.latestHeadline || null,
        },
      }));
      return alerts;
    }
  }
  return alerts;
}

function mapDecisionSeverity(decision, exitPressure = 0, opportunityScore = 0) {
  if (decision === 'EXIT' || exitPressure >= 81) return 'L4';
  if (['TRIM', 'PROTECT_PROFIT'].includes(decision) || exitPressure >= 66) return 'L3';
  if (['HOLD_BUT_WATCH', 'STARTER_ENTRY', 'ADD_ON_CONFIRMATION', 'WAIT_FOR_PULLBACK'].includes(decision) || opportunityScore >= 75) return 'L2';
  return 'L1';
}

function decisionAction(decision) {
  if (decision === 'HOLD_BUT_WATCH') return 'WATCH';
  if (decision === 'ADD_ONLY_IF_CONFIRMED') return 'ADD';
  if (decision === 'STARTER_ENTRY') return 'BUY';
  if (decision === 'ADD_ON_CONFIRMATION') return 'ADD';
  if (decision === 'WAIT_FOR_PULLBACK') return 'THINK';
  if (decision === 'DO_NOT_CHASE' || decision === 'DO_NOT_ADD' || decision === 'AVOID') return 'THINK';
  return decision;
}

function buildDecisionMetadata(item, report) {
  const decision = item.decisionReport || {};
  const levels = decision.dynamicLevels || {};
  return {
    sectorContext: item.sectorContext?.summary || null,
    technicalContext: item.technicalSnapshot?.summary || null,
    fundamentalContext: item.fundamentalSnapshot?.summary || null,
    latestHeadline: item.newsDigest?.latestHeadline || item.newsSummary || null,
    aiThesisScore: decision.aiThesisScore?.total,
    opportunityScore: decision.opportunityScore,
    exitPressureScore: decision.exitPressureScore,
    cashDecision: report?.cash?.decision,
    marketRegime: report?.marketRegime,
    dynamicLevels: levels,
    blockingReasons: decision.blockingReasons || [],
    explanation: decision.explanation || null,
  };
}

function buildSuggestedAction(decision, item, report) {
  const levels = decision.dynamicLevels || {};
  const sizing = decision.positionSizing || {};
  if (['EXIT', 'TRIM', 'PROTECT_PROFIT', 'HOLD_BUT_WATCH'].includes(decision.decision)) {
    const sizeCopy = decision.decision === 'EXIT'
      ? 'Exit candidate after confirmation.'
      : decision.decision === 'TRIM'
        ? 'Trim 20%-35% after confirmation.'
        : decision.decision === 'PROTECT_PROFIT'
          ? 'Protect profit; avoid adding and trim only if dynamic trim level fails.'
          : 'Hold but watch for confirmation of weakness.';
    return `${sizeCopy} Dynamic trim ${formatUsd(levels.trimLevel)}, stop ${formatUsd(levels.stopLevel)}.`;
  }
  if (['ADD_ONLY_IF_CONFIRMED', 'STARTER_ENTRY', 'ADD_ON_CONFIRMATION'].includes(decision.decision)) {
    return `Consider up to ${formatUsd(sizing.suggestedUsd)} only on ${levels.entryType}; add/reclaim ${formatUsd(levels.addReclaimLevel)}, stop ${formatUsd(levels.stopLevel)}.`;
  }
  if (decision.decision === 'WAIT_FOR_PULLBACK') {
    return `Wait for pullback or better risk/reward; support ${formatUsd(levels.support)}, target ${formatUsd(levels.target1)}.`;
  }
  return 'No new capital; keep monitoring until score and price action improve.';
}

function buildDecisionAlert(item, report, kind, config) {
  const decision = item.decisionReport;
  if (!decision) {
    return null;
  }
  const shouldAlert =
    ['EXIT', 'TRIM', 'PROTECT_PROFIT', 'HOLD_BUT_WATCH', 'ADD_ONLY_IF_CONFIRMED', 'STARTER_ENTRY', 'ADD_ON_CONFIRMATION', 'WAIT_FOR_PULLBACK'].includes(decision.decision) ||
    decision.exitPressureScore >= 51 ||
    decision.opportunityScore >= (report.thresholds?.[report.marketRegime] || 75);
  if (!shouldAlert) {
    return null;
  }
  const severity = mapDecisionSeverity(decision.decision, decision.exitPressureScore, decision.opportunityScore);
  const levels = decision.dynamicLevels || {};
  return attachResearchMetadata(makeAlert({
    severity,
    action: decisionAction(decision.decision),
    ticker: item.ticker,
    title: `${decision.decision.replace(/_/g, ' ')}`,
    triggerId: `${kind.toUpperCase()}:${item.ticker}:${decision.decision}`,
    trigger: `AI thesis ${decision.aiThesisScore?.total}, opportunity ${decision.opportunityScore}, exit pressure ${decision.exitPressureScore}`,
    suggestedAction: buildSuggestedAction(decision, item, report),
    reason: decision.explanation || 'Dynamic decision engine score threshold was reached.',
    invalidation:
      ['EXIT', 'TRIM', 'PROTECT_PROFIT', 'HOLD_BUT_WATCH'].includes(decision.decision)
        ? `Reclaim above ${formatUsd(levels.addReclaimLevel)} with improved relative strength.`
        : `Cancel if price loses ${formatUsd(levels.invalidationLevel)} or opportunity score falls below threshold.`,
    confirmationMinutes:
      severity === 'L4' ? 0 :
      severity === 'L3' ? config.thresholds.actionConfirmationMinutes :
      config.thresholds.watchConfirmationMinutes,
    immediate: severity === 'L4',
    threadId: `ticker:${item.ticker}`,
    price: item.livePrice,
    portfolioImpact:
      kind === 'holding'
        ? `Position weight ${formatPct(item.portfolioWeightPct)} | Cash ${report.cash?.decision || 'n/a'}`
        : `Suggested size ${formatUsd(decision.positionSizing?.suggestedUsd)} | Cash ${report.cash?.decision || 'n/a'}`,
    worseningValue: Math.max(decision.exitPressureScore || 0, decision.opportunityScore || 0),
    metadata: buildDecisionMetadata(item, report),
  }), item, buildDecisionMetadata(item, report));
}

export function buildDecisionAlerts(holdings = [], watchlist = [], report = {}, config = {}) {
  const alerts = [];
  for (const holding of holdings) {
    const alert = buildDecisionAlert(holding, report, 'holding', config);
    if (alert) alerts.push(alert);
  }
  for (const candidate of watchlist) {
    const alert = buildDecisionAlert(candidate, report, 'watchlist', config);
    if (alert) alerts.push(alert);
  }
  if (report.cash?.decision && report.cash.decision !== 'DEPLOY_0') {
    alerts.push(makeAlert({
      severity: report.cash.decision === 'DEPLOY_50_PLUS' ? 'L3' : 'L2',
      action: 'CASH',
      ticker: null,
      title: 'Cash Deployment Decision',
      triggerId: `CASH:${report.cash.decision}`,
      trigger: `${report.marketRegime} regime with ${report.cash.deployPctRange} deployment band`,
      suggestedAction: `Deploy ${report.cash.deployPctRange} of available cash only into confirmed opportunities.`,
      reason: report.cash.reason,
      invalidation: 'Opportunity scores fall below regime threshold or portfolio enters protection mode.',
      confirmationMinutes: config.thresholds.watchConfirmationMinutes,
      immediate: false,
      threadId: 'portfolio:cash',
      price: null,
      portfolioImpact: report.targetProgress?.message || null,
      worseningValue: report.ranked?.strongestOpportunities?.[0]?.opportunityScore || 1,
      metadata: {
        marketRegime: report.marketRegime,
        cashDecision: report.cash.decision,
        opportunityScore: report.ranked?.strongestOpportunities?.[0]?.opportunityScore || null,
      },
    }));
  }
  return alerts;
}

export function buildEarningsAlerts(holding, earnings, config) {
  if (!earnings?.date) {
    return [];
  }
  const eventTime = new Date(`${earnings.date}T00:00:00Z`);
  const hoursUntil = (eventTime.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil < 0 || hoursUntil > 48) {
    return [];
  }
  const alerts = [
    attachResearchMetadata(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: holding.ticker,
      title: `${holding.ticker} Earnings Risk`,
      triggerId: `${holding.ticker}:earnings-within-48h`,
      trigger: `Earnings within ${Math.max(1, Math.round(hoursUntil))} hours`,
      suggestedAction: holding.portfolioWeightPct > 10 ? 'Review position risk before earnings.' : 'Review event risk before earnings.',
      reason: 'Earnings inside 48 hours can invalidate short-term price signals quickly.',
      invalidation: 'Earnings pass and price confirms the thesis.',
      confirmationMinutes: 0,
      immediate: true,
      threadId: `ticker:${holding.ticker}`,
      price: holding.livePrice,
      portfolioImpact: `Position weight ${formatPct(holding.portfolioWeightPct)}`,
      worseningValue: 48 - Math.max(0, hoursUntil),
    }), holding),
  ];
  if ((toNumber(holding.movePct) || 0) >= 5) {
    alerts.push(attachResearchMetadata(makeAlert({
      severity: 'L2',
      action: 'THINK',
      ticker: holding.ticker,
      title: `${holding.ticker} Up Into Earnings`,
      triggerId: `${holding.ticker}:up-into-earnings`,
      trigger: 'Stock is up 5%+ into earnings',
      suggestedAction: 'Optional 20%-25% trim for event-risk control.',
      reason: 'Locking some gains before an earnings binary event can reduce regret.',
      invalidation: 'Event risk is intentionally accepted.',
      confirmationMinutes: 0,
      immediate: true,
      threadId: `ticker:${holding.ticker}`,
      price: holding.livePrice,
      portfolioImpact: 'Short-term event risk elevated',
      worseningValue: Math.abs(holding.movePct),
    }), holding));
  }
  return alerts;
}

function makeAlert(alert) {
  return {
    ...alert,
    createdAt: nowIso(),
  };
}

function sessionSuppressed(alert, sessionClock, config) {
  if (sessionClock.bucket === 'CLOSED') {
    return true;
  }
  if (alert.action === 'DATA_WARNING') {
    return false;
  }
  if (sessionClock.bucket === 'PRE_MARKET' && !config.thresholds.preMarketEnabled) {
    return true;
  }
  if (sessionClock.bucket === 'POST_MARKET' && !config.thresholds.postMarketEnabled) {
    return true;
  }
  if (sessionClock.bucket === 'OPENING_RANGE') {
    return alert.severity !== 'L4';
  }
  if (!sessionClock.allowWatchThink && ['L1', 'L2'].includes(alert.severity)) {
    return true;
  }
  if (!sessionClock.allowActionAlerts && ['L3'].includes(alert.severity)) {
    return true;
  }
  return false;
}

function isOverDailyCap(state, config, alert) {
  if (alert.severity === 'L4' || alert.action === 'DATA_WARNING') {
    return false;
  }
  const values = Object.values(state.lastAlertByKey || {}).filter((item) => item?.marketDayKey === state.currentDayKey);
  return values.length >= config.thresholds.dailyAlertCap;
}

export function reconcileCandidates(candidates, state, sessionClock, config, now = Date.now()) {
  let nextState = state;
  const confirmed = [];
  const activeKeys = new Set(candidates.map((candidate) => candidate.triggerId));

  for (const candidate of candidates.sort((a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity])) {
    if (sessionSuppressed(candidate, sessionClock, config)) {
      nextState = clearOpenTrigger(nextState, candidate.triggerId);
      continue;
    }
    const existing = state.openTriggers?.[candidate.triggerId];
    const confirmationMinutes = candidate.immediate ? 0 : candidate.confirmationMinutes;
    if (!existing) {
      nextState = setOpenTrigger(nextState, candidate.triggerId, {
        firstSeenAt: now,
        latestSeenAt: now,
        candidate,
      });
      if (confirmationMinutes > 0) {
        continue;
      }
    } else {
      nextState = setOpenTrigger(nextState, candidate.triggerId, {
        ...existing,
        latestSeenAt: now,
        candidate,
      });
      if (confirmationMinutes > 0 && now - existing.firstSeenAt < confirmationMinutes * 60 * 1000) {
        continue;
      }
    }

    const cooldown = state.cooldowns?.[candidate.triggerId];
    if (cooldown?.expiresAt && now < cooldown.expiresAt) {
      continue;
    }

    if (candidate.severity === 'L1') {
      const existingL1 = state.cooldowns?.[`${candidate.ticker}:L1`] || null;
      if (existingL1?.expiresAt && now < existingL1.expiresAt) {
        continue;
      }
    }

    if (candidate.severity === 'L2' && candidate.ticker) {
      const count = getTickerSessionCount(state, sessionClock.marketDayKey, candidate.ticker, 'L2');
      if (count >= config.thresholds.l2MaxPerSession) {
        continue;
      }
    }

    if (candidate.severity === 'L3') {
      const previous = state.lastAlertByKey?.[candidate.triggerId];
      if (previous && previous.worseningValue !== undefined && candidate.worseningValue <= previous.worseningValue) {
        continue;
      }
    }

    if (isOverDailyCap(state, config, candidate)) {
      continue;
    }

    confirmed.push(candidate);
  }

  for (const openKey of Object.keys(state.openTriggers || {})) {
    if (!activeKeys.has(openKey)) {
      nextState = clearOpenTrigger(nextState, openKey);
    }
  }

  return { confirmed, nextState };
}

export function applyAlertDeliveryState(state, alert, sessionClock, config, deliveryRef = null) {
  let nextState = state;
  nextState = setCooldown(nextState, alert.triggerId, {
    expiresAt: Date.now() + config.thresholds.sameTriggerCooldownMinutes * 60 * 1000,
  });
  if (alert.severity === 'L1' && alert.ticker) {
    nextState = setCooldown(nextState, `${alert.ticker}:L1`, {
      expiresAt: Date.now() + config.thresholds.l1CooldownMinutes * 60 * 1000,
    });
  }
  nextState = setLastAlertByKey(nextState, alert.triggerId, {
    deliveredAt: nowIso(),
    ticker: alert.ticker,
    severity: alert.severity,
    marketDayKey: sessionClock.marketDayKey,
    worseningValue: alert.worseningValue,
    deliveryRef,
  });
  if (alert.ticker && alert.severity === 'L2') {
    nextState = {
      ...nextState,
      tickerSessionCounts: {
        ...(nextState.tickerSessionCounts || {}),
        [`${sessionClock.marketDayKey}:${alert.ticker}:L2`]:
          (nextState.tickerSessionCounts?.[`${sessionClock.marketDayKey}:${alert.ticker}:L2`] || 0) + 1,
      },
    };
  }
  return clearOpenTrigger(nextState, alert.triggerId);
}

export function formatAlertMessage(alert, portfolioContext, timestampIst) {
  const icon = alert.severity === 'L4' || alert.severity === 'L3' ? '🚨' : alert.action === 'ROTATE' ? '🔁' : '⚠️';
  const title = alert.ticker ? `${alert.ticker} ${alert.title}` : alert.title;
  const dataQuality = alert.metadata?.dataQuality || portfolioContext.dataQuality || {};
  const lines = [
    `${icon} ${alert.severity} ${alert.action}: ${title}`,
    '',
  ];

  if (alert.ticker) {
    lines.push(`Ticker: ${alert.ticker}`);
  }
  if (alert.metadata?.sourceTicker && alert.metadata?.targetTicker) {
    lines.push(`Source: ${alert.metadata.sourceTicker} score ${alert.metadata.sourceScore}`);
    lines.push(`Target: ${alert.metadata.targetTicker} score ${alert.metadata.targetScore}`);
  }
  if (alert.price !== null && alert.price !== undefined) {
    lines.push(`Price: ${formatUsd(alert.price)}`);
  }
  if (
    alert.metadata?.aiThesisScore !== undefined ||
    alert.metadata?.opportunityScore !== undefined ||
    alert.metadata?.exitPressureScore !== undefined
  ) {
    lines.push(
      `Scores: thesis ${alert.metadata.aiThesisScore ?? 'n/a'} | opportunity ${alert.metadata.opportunityScore ?? 'n/a'} | exit pressure ${alert.metadata.exitPressureScore ?? 'n/a'}`,
    );
  }
  if (alert.metadata?.marketRegime || alert.metadata?.cashDecision) {
    lines.push(`Regime/cash: ${alert.metadata.marketRegime || 'n/a'} | ${alert.metadata.cashDecision || 'n/a'}`);
  }
  lines.push(`Trigger: ${alert.trigger}`);
  lines.push(`Suggested action: ${alert.suggestedAction}`);
  lines.push(`Reason: ${alert.reason}`);
  if (alert.metadata?.dynamicLevels?.basis) {
    const levels = alert.metadata.dynamicLevels;
    lines.push(
      `Dynamic levels: trim ${formatUsd(levels.trimLevel)} | stop ${formatUsd(levels.stopLevel)} | add/reclaim ${formatUsd(levels.addReclaimLevel)} | target ${formatUsd(levels.target1)} | R/R ${levels.riskReward ?? 'n/a'} | confidence ${formatPct(levels.confidence, 0)}`,
    );
  }
  if (alert.metadata?.blockingReasons?.length) {
    lines.push(`Blocking reasons: ${alert.metadata.blockingReasons.join('; ')}`);
  }
  if (alert.portfolioImpact) {
    lines.push(`Portfolio impact: ${alert.portfolioImpact}`);
  }
  if (alert.metadata?.sectorContext) {
    lines.push(`Sector context: ${alert.metadata.sectorContext}`);
  }
  if (alert.metadata?.technicalContext) {
    lines.push(`Technical context: ${alert.metadata.technicalContext}`);
  }
  if (alert.metadata?.fundamentalContext) {
    lines.push(`Fundamental context: ${alert.metadata.fundamentalContext}`);
  }
  if (alert.metadata?.latestHeadline) {
    lines.push(`Latest headline: ${alert.metadata.latestHeadline}`);
  }
  lines.push(`Invalidation: ${alert.invalidation}`);
  lines.push('Cooldown: Standard alert cooldowns applied after delivery.');
  lines.push(`Target progress: ${formatPct(portfolioContext.targetProgress)}`);
  lines.push(`Estimated after-tax INR profit: ${formatInr(portfolioContext.afterTaxProfitInr)}`);
  if (dataQuality.sourceTimestamp || dataQuality.freshnessStatus) {
    lines.push(`Data source timestamp: ${dataQuality.sourceTimestamp || 'unknown'}`);
    lines.push(`Alert generation timestamp: ${dataQuality.alertGenerationTimestamp || timestampIst}`);
    lines.push(`Data freshness status: ${dataQuality.freshnessStatus || 'unknown'}`);
    lines.push(`Reconciliation checks: ${dataQuality.reconciliationPassed ? 'PASSED' : 'FAILED'}`);
    if (dataQuality.warnings?.length) {
      lines.push(`Reconciliation warnings: ${dataQuality.warnings.join(', ')}`);
    }
  }
  lines.push(`Time: ${timestampIst}`);
  lines.push('Suggested action only. User confirmation required. No trade executed.');
  return lines.join('\n');
}

export function formatDailySummary(portfolio, scoredHoldings, portfolioContext, timestampIst, decisionReport = null) {
  const winners = [...scoredHoldings]
    .sort((a, b) => (toNumber(b.totalActualReturnUsd ?? b.totalPnlUsd) || 0) - (toNumber(a.totalActualReturnUsd ?? a.totalPnlUsd) || 0))
    .slice(0, 4);
  const drags = [...scoredHoldings]
    .sort((a, b) => (toNumber(a.totalActualReturnUsd ?? a.totalPnlUsd) || 0) - (toNumber(b.totalActualReturnUsd ?? b.totalPnlUsd) || 0))
    .slice(0, 3);
  const dataQuality = portfolio.dataQuality || portfolioContext.dataQuality || {};
  const stalePortfolioData = dataQuality.freshnessStatus === 'STALE_DATA';
  const tomorrowPlan = stalePortfolioData
    ? ['STALE_DATA: normal action recommendations suppressed until a fresh portfolio export is loaded.']
    : decisionReport
    ? [
        ...(decisionReport.ranked?.weakestHoldings || []).slice(0, 3).map((item) =>
          `${item.ticker}: ${item.decision.replace(/_/g, ' ')} | exit pressure ${item.exitPressureScore}`,
        ),
        ...(decisionReport.ranked?.strongestOpportunities || []).slice(0, 2).map((item) =>
          `${item.ticker}: opportunity ${item.opportunityScore} | ${item.dynamicLevels?.entryType || 'confirmation entry'}`,
        ),
      ]
    : [
        'Hold core positions unless dynamic support fails.',
        'Protect profits if portfolio giveback accelerates.',
        'Avoid new adds without confirmed opportunity quality.',
      ];
  return [
    '📊 US Portfolio Daily Summary',
    '',
    `Portfolio value: ${formatUsd(portfolio.summary.portfolioValueUsd)}`,
    `Invested value: ${formatUsd(portfolio.summary.investedValueUsd)}`,
    `Total P&L: ${formatUsd(portfolio.summary.unrealizedProfitUsd)}`,
    `Total return: ${formatPct(portfolio.summary.totalReturnPct)}`,
    `Day P&L: ${formatUsd(portfolio.summary.oneDayPnlUsd)}`,
    `Data source timestamp: ${dataQuality.sourceTimestamp || portfolio.importedUpdatedAt || 'unknown'}`,
    `Alert generation timestamp: ${dataQuality.alertGenerationTimestamp || timestampIst}`,
    `Data freshness status: ${dataQuality.freshnessStatus || 'unknown'}`,
    `Reconciliation checks: ${dataQuality.reconciliationPassed ? 'PASSED' : 'FAILED'}`,
    ...(dataQuality.warnings?.length ? [`Reconciliation warnings: ${dataQuality.warnings.join(', ')}`] : []),
    `Top 3 concentration: ${formatPct(dataQuality.top3ConcentrationPct)}`,
    `Estimated after-tax INR profit: ${formatInr(portfolioContext.afterTaxProfitInr)}`,
    `Target progress: ${formatPct(portfolioContext.targetProgress)}`,
    ...(decisionReport ? [
      `Market regime: ${decisionReport.marketRegime}`,
      `Cash decision: ${decisionReport.cash.decision} (${decisionReport.cash.deployPctRange})`,
      `Target realism: ${decisionReport.targetProgress.realismScore}/100`,
      `Target note: ${decisionReport.targetProgress.message}`,
      ...(decisionReport.concentration.warnings.length ? [`Concentration: ${decisionReport.concentration.warnings.join(' | ')}`] : []),
    ] : []),
    '',
    'Top winners:',
    ...winners.map((item, index) => `${index + 1}. ${item.ticker} ${formatUsd(item.totalActualReturnUsd ?? item.totalPnlUsd)}`),
    '',
    'Top drags:',
    ...drags.map((item, index) => `${index + 1}. ${item.ticker} ${formatUsd(item.totalActualReturnUsd ?? item.totalPnlUsd)}`),
    '',
    'Tomorrow plan:',
    ...(tomorrowPlan.length ? tomorrowPlan.map((line) => `- ${line}`) : ['- No major dynamic action for tomorrow.']),
    '',
    `Time: ${timestampIst}`,
    'Suggested action only. User confirmation required. No trade executed.',
  ].join('\n');
}
