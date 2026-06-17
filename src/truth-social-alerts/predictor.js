import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  clamp,
  computePercentChange,
  fetchTextWithRetry,
  formatTimestampInZone,
  readJsonFile,
  round,
  toNumber,
} from '../portfolio-alerts/utils.js';
import {
  appendTruthSocialAlertEvent,
  readTruthSocialGoldModelMetadata,
  readTruthSocialGoldPredictions,
  readTruthSocialHistory,
  updateTruthSocialGoldPrediction,
  writeTruthSocialGoldModelMetadata,
  writeTruthSocialGoldTrainingRows,
} from './state-store.js';

const YAHOO_GOLD_SYMBOLS = ['GC=F', 'MGC=F'];
const HISTORICAL_CACHE = new Map();
const MT5_CACHE = new Map();
const PREDICTION_LABELS = ['strong down', 'down', 'flat', 'up', 'strong up'];
const DEFAULT_DIRECTION_PROBABILITIES = [0.12, 0.18, 0.4, 0.18, 0.12];
const retrainState = {
  running: false,
  pending: false,
  timer: null,
};

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizePostText(post) {
  return compactWhitespace(post?.body || post?.title || post?.description || '');
}

function formatChartDate(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 16).replace('T', ' ');
}

function horizonKey(minutes) {
  return `${minutes}m`;
}

function buildYahooChartUrl(symbol, interval, days) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', String(period1));
  url.searchParams.set('period2', String(period2));
  url.searchParams.set('interval', interval);
  url.searchParams.set('events', 'history');
  url.searchParams.set('includeAdjustedClose', 'true');
  url.searchParams.set('includePrePost', 'true');
  return url.toString();
}

function parseMt5DateTime(value, offsetMinutes = 0) {
  const match = String(value || '').trim().match(
    /^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) - (offsetMinutes * 60_000);
}

function detectDelimiter(headerLine) {
  if (headerLine.includes('\t')) return '\t';
  return ',';
}

function normalizeMt5Header(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCandleDate(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 16).replace('T', ' ');
}

async function readMt5CsvCandles(filePath, offsetMinutes = 0) {
  const stats = await fs.stat(filePath);
  const cacheKey = `${filePath}:${offsetMinutes}`;
  const cached = MT5_CACHE.get(cacheKey);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.candles;
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    MT5_CACHE.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, candles: [] });
    return [];
  }
  const delimiter = detectDelimiter(lines[0]);
  const headers = lines[0].split(delimiter).map(normalizeMt5Header);
  const datetimeIndex = headers.findIndex((header) => ['datetime', 'time'].includes(header));
  const openIndex = headers.indexOf('open');
  const highIndex = headers.indexOf('high');
  const lowIndex = headers.indexOf('low');
  const closeIndex = headers.indexOf('close');
  const volumeIndex = headers.findIndex((header) => ['volume', 'tick_volume'].includes(header));
  const candles = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(delimiter);
    const timestampMs = parseMt5DateTime(parts[datetimeIndex], offsetMinutes);
    const close = toNumber(parts[closeIndex]);
    if (!timestampMs || close === null) {
      continue;
    }
    candles.push({
      date: normalizeCandleDate(timestampMs),
      timestampMs,
      open: toNumber(parts[openIndex]),
      high: toNumber(parts[highIndex]),
      low: toNumber(parts[lowIndex]),
      close,
      volume: volumeIndex >= 0 ? toNumber(parts[volumeIndex]) : null,
      source: 'mt5_csv',
      sourcePath: filePath,
    });
  }
  candles.sort((a, b) => a.timestampMs - b.timestampMs);
  MT5_CACHE.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, candles });
  return candles;
}

async function fetchMt5GoldCandles(config) {
  if (!config?.mt5?.enabled) {
    return [];
  }
  const rows = [];
  for (const filePath of config.mt5.goldCsvPaths || []) {
    try {
      const candles = await readMt5CsvCandles(filePath, config.mt5.timeOffsetMinutes || 0);
      rows.push(...candles);
    } catch {
      // Skip missing or unreadable MT5 exports; Yahoo remains the safety net.
    }
  }
  const deduped = new Map();
  for (const candle of rows) {
    deduped.set(candle.timestampMs, candle);
  }
  const merged = [...deduped.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  return merged.length >= (config.mt5.minRows || 1000) ? merged : [];
}

function mergeCandles(...groups) {
  const merged = new Map();
  for (const candles of groups) {
    for (const candle of candles || []) {
      if (!candle?.timestampMs) continue;
      merged.set(candle.timestampMs, candle);
    }
  }
  return [...merged.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

async function fetchYahooGoldCandles(interval = '5m', days = 60) {
  const cacheKey = `${interval}:${days}`;
  const cached = HISTORICAL_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const errors = [];
  for (const symbol of YAHOO_GOLD_SYMBOLS) {
    try {
      const text = await fetchTextWithRetry(
        buildYahooChartUrl(symbol, interval, days),
        { redirect: 'follow' },
        {
          timeoutMs: 20_000,
          maxRetries: 3,
          retryBackoffMs: 1_500,
          userAgent: 'Mozilla/5.0 (compatible; MarketTruthSocialGoldPredictor/2.0)',
        },
      );
      const payload = JSON.parse(text);
      const result = payload?.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0] || {};
      const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
      const candles = timestamps.map((timestamp, index) => ({
        date: formatChartDate(timestamp * 1000),
        timestampMs: timestamp * 1000,
        open: toNumber(quote.open?.[index]),
        high: toNumber(quote.high?.[index]),
        low: toNumber(quote.low?.[index]),
        close: toNumber(quote.close?.[index]),
        volume: toNumber(quote.volume?.[index]),
      })).filter((row) => row.close !== null);
      if (candles.length) {
        HISTORICAL_CACHE.set(cacheKey, {
          expiresAt: Date.now() + 60_000,
          value: candles,
        });
        return candles;
      }
      errors.push(`${symbol}: empty`);
    } catch (error) {
      errors.push(`${symbol}: ${error.message}`);
    }
  }
  throw new Error(`Gold candles unavailable. ${errors.join(' | ')}`);
}

async function loadGoldCandles(config, options = {}) {
  const {
    includeMt5 = true,
    includeYahoo = true,
    yahooInterval = '5m',
    yahooDays = 60,
  } = options;
  const mt5Candles = includeMt5 ? await fetchMt5GoldCandles(config) : [];
  let yahooCandles = [];
  if (includeYahoo) {
    try {
      yahooCandles = await fetchYahooGoldCandles(yahooInterval, yahooDays);
    } catch {
      yahooCandles = [];
    }
  }
  const merged = mergeCandles(mt5Candles, yahooCandles);
  if (merged.length) {
    return merged;
  }
  if (includeYahoo) {
    return fetchYahooGoldCandles(yahooInterval, yahooDays);
  }
  throw new Error('Gold candles unavailable from MT5 and Yahoo');
}

function bucketGoldDirection(pctChange) {
  const pct = toNumber(pctChange);
  if (pct === null) return 'flat';
  if (pct <= -0.12) return 'strong down';
  if (pct <= -0.04) return 'down';
  if (pct < 0.04) return 'flat';
  if (pct < 0.12) return 'up';
  return 'strong up';
}

function sessionFlags(date) {
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return {
    asia: hour >= 0 && hour < 8 ? 1 : 0,
    europe: hour >= 7 && hour < 13 ? 1 : 0,
    us: hour >= 13 && hour < 21 ? 1 : 0,
  };
}

function findNearestCandleAtOrBefore(candles, timestampMs) {
  let best = null;
  for (const candle of candles) {
    if (candle.timestampMs <= timestampMs) {
      best = candle;
      continue;
    }
    break;
  }
  return best;
}

function findNearestCandleAtOrAfter(candles, timestampMs) {
  for (const candle of candles) {
    if (candle.timestampMs >= timestampMs) {
      return candle;
    }
  }
  return null;
}

function pickWindow(candles, startMs, endMs) {
  return candles.filter((candle) => candle.timestampMs >= startMs && candle.timestampMs <= endMs);
}

function computePreMoveFeatures(candles, publishedAtMs) {
  const last15 = pickWindow(candles, publishedAtMs - 15 * 60_000, publishedAtMs);
  const last30 = pickWindow(candles, publishedAtMs - 30 * 60_000, publishedAtMs);
  const first15 = last15[0]?.close ?? null;
  const latest15 = last15.at(-1)?.close ?? null;
  const drift15Pct = computePercentChange(latest15, first15) ?? 0;
  const closes30 = last30.map((item) => item.close).filter((value) => value !== null);
  const avg = closes30.length ? closes30.reduce((sum, value) => sum + value, 0) / closes30.length : null;
  const variance = closes30.length > 1
    ? closes30.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / closes30.length
    : 0;
  const volatilityPct = avg ? round((Math.sqrt(variance) / avg) * 100, 4) : 0;
  return {
    drift15Pct: round(drift15Pct ?? 0, 4) ?? 0,
    volatility30Pct: round(volatilityPct ?? 0, 4) ?? 0,
  };
}

function countRecentPosts(events, publishedAtMs, windowMs) {
  return events.filter((event) => {
    const eventMs = Date.parse(event?.publishedAt || event?.recordedAt || 0);
    return eventMs && eventMs < publishedAtMs && eventMs >= publishedAtMs - windowMs;
  }).length;
}

function keywordCounts(text) {
  const lower = String(text || '').toLowerCase();
  const groups = {
    geopolitics: ['iran', 'israel', 'war', 'missile', 'attack', 'nuclear', 'bomb', 'ceasefire', 'military'],
    macro: ['fed', 'inflation', 'rates', 'interest', 'powell', 'recession', 'economy', 'debt'],
    trade: ['tariff', 'tariffs', 'trade', 'china', 'sanction', 'sanctions'],
    commodities: ['gold', 'oil', 'energy', 'crude'],
    dollar: ['dollar', 'usd', 'currency'],
    safeHaven: ['crisis', 'emergency', 'threat', 'chaos', 'uncertain'],
  };
  const counts = {};
  for (const [key, words] of Object.entries(groups)) {
    counts[key] = words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
  }
  return counts;
}

function heuristicSemanticPrediction(post) {
  const text = normalizePostText(post);
  const counts = keywordCounts(text);
  const letters = [...text].filter((char) => /[A-Za-z]/.test(char));
  const allCapsRatio = letters.length
    ? [...text].filter((char) => /[A-Z]/.test(char)).length / letters.length
    : 0;
  const hasVideo = (post?.mediaAttachments || []).some((item) => String(item?.type || '').toLowerCase() === 'video');
  const hasImage = (post?.mediaAttachments || []).some((item) => String(item?.type || '').toLowerCase() === 'image');
  const semanticScore = clamp(
    (counts.geopolitics * 2.8) +
    (counts.macro * 1.9) +
    (counts.trade * 1.7) +
    (counts.commodities * 2.2) +
    (counts.dollar * 1.1) +
    (counts.safeHaven * 1.3) +
    (text.length > 180 ? 0.8 : 0) +
    (allCapsRatio > 0.3 ? 0.7 : 0) +
    (hasVideo ? 0.2 : 0) +
    (hasImage ? 0.1 : 0),
    0,
    10,
  );
  const directionalTilt = round(
    (counts.geopolitics * 0.025) +
    (counts.trade * 0.015) +
    (counts.macro * 0.01) +
    (counts.commodities * 0.015) -
    (counts.dollar * 0.012),
    4,
  ) ?? 0;
  return {
    source: 'local_heuristic',
    goldRelevanceScore: round(semanticScore, 1) ?? 0,
    confidence: semanticScore >= 6 ? 'medium' : 'low',
    directionalTiltPct: directionalTilt,
    tags: Object.entries(counts).filter(([, value]) => value > 0).map(([key]) => key),
    summary: text ? text.slice(0, 140) : 'Media-only post',
  };
}

function extractOutputText(response) {
  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) {
        chunks.push(content.text);
      }
    }
  }
  if (chunks.length) return chunks.join('\n').trim();
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return '';
}

export function normalizeOpenAiUsage(usage) {
  const value = usage && typeof usage === 'object' ? usage : null;
  const inputTokens = toNumber(value?.input_tokens ?? value?.prompt_tokens);
  const outputTokens = toNumber(value?.output_tokens ?? value?.completion_tokens);
  const totalTokens = toNumber(value?.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? ((inputTokens !== null || outputTokens !== null)
      ? (inputTokens || 0) + (outputTokens || 0)
      : null),
    raw: value,
  };
}

async function fetchOpenAiSemanticPrediction(post, config) {
  const apiKey = config?.goldPrediction?.openaiApiKey || '';
  if (!apiKey) {
    return null;
  }
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();
  const body = normalizePostText(post) || '[Media-only post]';
  const payload = {
    model: config.goldPrediction.openaiModel,
    instructions: 'You estimate whether a Trump Truth Social post should move spot gold in the next 5 minutes. Return JSON only. Score gold relevance, not general importance. Geopolitical escalation and safe-haven demand usually bias gold up. Stronger-dollar framing can bias gold down. Lower confidence when text is vague or missing.',
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: JSON.stringify({
          objective: 'Predict gold relevance and directional tilt for the next 5 minutes.',
          post: {
            text: body,
            isRetruth: Boolean(post?.isRetruth),
            mediaTypes: Array.isArray(post?.mediaAttachments) ? post.mediaAttachments.map((item) => item?.type || '') : [],
            publishedAt: post?.publishedAt || null,
          },
        }),
      }],
    }],
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'truth_social_gold_semantic_signal',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            gold_relevance_score: { type: 'number' },
            directional_tilt_pct: { type: 'number' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            tags: { type: 'array', items: { type: 'string' }, maxItems: 6 },
            summary: { type: 'string' },
          },
          required: ['gold_relevance_score', 'directional_tilt_pct', 'confidence', 'tags', 'summary'],
        },
      },
    },
    reasoning: { effort: 'minimal' },
    max_output_tokens: 300,
      store: false,
  };
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const json = await response.json();
    const usage = normalizeOpenAiUsage(json?.usage);
    const outputText = extractOutputText(json);
    if (!outputText) throw new Error('OpenAI returned no text');
    const parsed = JSON.parse(outputText);
    await appendTruthSocialAlertEvent(config, {
      type: 'openai_usage',
      status: 'ok',
      requestedAt,
      dedupeId: post?.dedupeId || null,
      originalUrl: post?.originalUrl || post?.link || null,
      model: payload.model,
      durationMs: Date.now() - startedAt,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      rawUsage: usage.raw,
    });
    return {
      source: 'openai_fallback',
      goldRelevanceScore: clamp(round(parsed.gold_relevance_score, 1) ?? 0, 0, 10),
      directionalTiltPct: clamp(round(parsed.directional_tilt_pct, 4) ?? 0, -0.25, 0.25),
      confidence: parsed.confidence,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      summary: compactWhitespace(parsed.summary || ''),
    };
  } catch (error) {
    await appendTruthSocialAlertEvent(config, {
      type: 'openai_usage',
      status: 'error',
      requestedAt,
      dedupeId: post?.dedupeId || null,
      originalUrl: post?.originalUrl || post?.link || null,
      model: payload.model,
      durationMs: Date.now() - startedAt,
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      rawUsage: null,
      error: error.message,
    }).catch(() => {});
    throw error;
  }
}

function createFeatureVector({ post, semantic, publishedAtMs, recentEventCount, preMove }) {
  const text = normalizePostText(post);
  const counts = keywordCounts(text);
  const letters = [...text].filter((char) => /[A-Za-z]/.test(char));
  const upperLetters = letters.filter((char) => /[A-Z]/.test(char)).length;
  const session = sessionFlags(new Date(publishedAtMs));
  const hasVideo = (post?.mediaAttachments || []).some((item) => String(item?.type || '').toLowerCase() === 'video') ? 1 : 0;
  const hasImage = (post?.mediaAttachments || []).some((item) => String(item?.type || '').toLowerCase() === 'image') ? 1 : 0;
  const isMediaOnly = text === '[Media-only post]' || !text ? 1 : 0;
  return {
    text_length_norm: round(Math.min(text.length, 400) / 400, 4) ?? 0,
    uppercase_ratio: round(upperLetters / Math.max(1, letters.length), 4) ?? 0,
    exclamation_count_norm: round(Math.min((text.match(/!/g) || []).length, 8) / 8, 4) ?? 0,
    geopolitics_hits: counts.geopolitics,
    macro_hits: counts.macro,
    trade_hits: counts.trade,
    commodities_hits: counts.commodities,
    dollar_hits: counts.dollar,
    safe_haven_hits: counts.safeHaven,
    heuristic_score_norm: round((semantic.goldRelevanceScore || 0) / 10, 4) ?? 0,
    heuristic_tilt_pct: round(semantic.directionalTiltPct || 0, 4) ?? 0,
    is_retruth: post?.isRetruth ? 1 : 0,
    has_video: hasVideo,
    has_image: hasImage,
    is_media_only: isMediaOnly,
    recent_post_burst: recentEventCount,
    pre_move_15m_pct: round(preMove.drift15Pct || 0, 4) ?? 0,
    pre_volatility_30m_pct: round(preMove.volatility30Pct || 0, 4) ?? 0,
    session_asia: session.asia,
    session_europe: session.europe,
    session_us: session.us,
    hour_utc_norm: round((new Date(publishedAtMs).getUTCHours() + 1) / 24, 4) ?? 0,
    weekday_norm: round((new Date(publishedAtMs).getUTCDay() + 1) / 7, 4) ?? 0,
  };
}

function computeOutcomeForHorizon(candles, publishedAtMs, minutes) {
  const baseline = findNearestCandleAtOrBefore(candles, publishedAtMs);
  const followup = findNearestCandleAtOrAfter(candles, publishedAtMs + minutes * 60_000);
  const available = Boolean(baseline?.close !== null && baseline?.close !== undefined && followup?.close !== null && followup?.close !== undefined);
  if (!available) {
    return {
      available: false,
      minutes,
      baselineGold: baseline?.close ?? null,
      followupGold: followup?.close ?? null,
      realizedPct: null,
      direction: null,
    };
  }
  const realizedPct = computePercentChange(followup.close, baseline.close);
  return {
    available: true,
    minutes,
    baselineGold: baseline.close,
    followupGold: followup.close,
    realizedPct,
    direction: bucketGoldDirection(realizedPct),
  };
}

function normalizeHistoryPost(post, provenance = {}) {
  const body = normalizePostText(post) || '[Media-only post]';
  const attachments = Array.isArray(post?.mediaAttachments)
    ? post.mediaAttachments.map((attachment) => ({
        type: String(attachment?.type || '').toLowerCase(),
        url: String(attachment?.url || ''),
        previewUrl: String(attachment?.previewUrl || attachment?.preview_url || ''),
      })).filter((attachment) => attachment.url || attachment.previewUrl)
    : [];
  return {
    dedupeId: String(post?.dedupeId || post?.originalId || post?.id || post?.originalUrl || ''),
    originalId: post?.originalId || post?.id || null,
    originalUrl: post?.originalUrl || post?.link || post?.url || null,
    publishedAt: post?.publishedAt || null,
    body,
    description: post?.description || '',
    isRetruth: Boolean(post?.isRetruth || post?.reblog),
    mediaAttachments: attachments,
    mediaUrls: attachments.map((attachment) => attachment.url).filter(Boolean),
    provenance,
  };
}

async function runPythonModel(scriptPath, mode, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [scriptPath, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `python exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (error) {
        reject(new Error(`model JSON parse failed: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function loadArtifactPrediction(config, features, minutes = 5) {
  const metadata = await readTruthSocialGoldModelMetadata(config);
  const horizon = metadata?.horizons?.[horizonKey(minutes)];
  if (!horizon?.artifactPath || (toNumber(horizon.sampleCount) ?? 0) < config.goldPrediction.minTrainingRows) {
    return null;
  }
  try {
    const result = await runPythonModel(config.goldPrediction.modelScriptPath, 'predict', {
      artifactPath: horizon.artifactPath,
      features,
    });
    return {
      ...result,
      horizon,
    };
  } catch {
    return null;
  }
}

function fallbackModelPrediction(features, semantic) {
  const expectedMovePct = round(
    (features.heuristic_tilt_pct || 0) +
    ((features.pre_move_15m_pct || 0) * -0.25) +
    ((features.pre_volatility_30m_pct || 0) * 0.1),
    4,
  ) ?? 0;
  return {
    predictedDirection: bucketGoldDirection(expectedMovePct),
    expectedMovePct,
    directionProbabilities: DEFAULT_DIRECTION_PROBABILITIES,
    sampleCount: 0,
    source: 'fallback',
    semanticScore: semantic.goldRelevanceScore,
  };
}

function impactScoreFromPrediction(semanticScore, expectedMovePct) {
  const moveImpact = clamp((Math.abs(toNumber(expectedMovePct) ?? 0) / 0.01), 0, 10);
  return round(clamp((semanticScore * 0.75) + (moveImpact * 0.25), 0, 10), 1) ?? 0;
}

function confidenceFromPrediction({ topProbability, sampleCount, semanticSource, text }) {
  let score = topProbability >= 0.6 ? 2 : topProbability >= 0.42 ? 1 : 0;
  if (sampleCount >= 40) score += 1;
  if (!text || text === '[Media-only post]') score -= 1;
  if (semanticSource === 'openai_fallback') score -= 0.25;
  if (score >= 2.5) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function buildTrainingRow(post, allPosts, candles, horizonsMinutes, semanticOverride = null) {
  const publishedAtMs = Date.parse(post?.publishedAt || 0);
  if (!publishedAtMs) return null;
  const semantic = semanticOverride || heuristicSemanticPrediction(post);
  const preMove = computePreMoveFeatures(candles, publishedAtMs);
  const recentEventCount = countRecentPosts(allPosts, publishedAtMs, 30 * 60_000);
  const features = createFeatureVector({
    post,
    semantic,
    publishedAtMs,
    recentEventCount,
    preMove,
  });
  const outcomes = Object.fromEntries(
    horizonsMinutes.map((minutes) => [horizonKey(minutes), computeOutcomeForHorizon(candles, publishedAtMs, minutes)]),
  );
  return {
    dedupeId: post.dedupeId,
    publishedAt: post.publishedAt,
    originalUrl: post.originalUrl || null,
    body: normalizePostText(post) || '[Media-only post]',
    features,
    heuristicSemantic: semantic,
    outcomes,
  };
}

export async function rebuildTruthSocialGoldTrainingData(config) {
  const history = await readTruthSocialHistory(config);
  const storedPredictions = await readTruthSocialGoldPredictions(config);
  const historicalEvents = await readJsonFile(config.eventsPath, []);
  const historyPosts = (Array.isArray(history) ? history : [])
    .filter((item) => item?.dedupeId && item?.publishedAt)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const knownIds = new Set(historyPosts.map((item) => item.dedupeId));
  const eventPosts = (Array.isArray(historicalEvents) ? historicalEvents : [])
    .filter((item) => item?.type === 'delivery' && item?.dedupeId && item?.publishedAt && !knownIds.has(item.dedupeId))
    .map((item) => normalizeHistoryPost({
      dedupeId: item.dedupeId,
      originalId: item.originalId || item.dedupeId,
      originalUrl: item.originalUrl || '',
      publishedAt: item.publishedAt,
      body: '',
      description: '',
      isRetruth: Boolean(item.isRetruth),
      mediaAttachments: [],
    }, {
      source: 'delivery_event_fallback',
      fetchedAt: item.recordedAt || new Date().toISOString(),
    }));
  const posts = [...historyPosts, ...eventPosts]
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const candles = await loadGoldCandles(config, {
    includeMt5: true,
    includeYahoo: true,
    yahooInterval: '5m',
    yahooDays: 60,
  });
  const resolvedOpenAiSemantics = new Map(
    (Array.isArray(storedPredictions) ? storedPredictions : [])
      .filter((item) => {
        if (item?.semantic?.source !== 'openai_fallback' || !item?.dedupeId) {
          return false;
        }
        return Object.values(item?.outcomes || {}).some((outcome) => outcome?.correct === true);
      })
      .map((item) => [item.dedupeId, item.semantic]),
  );
  const rows = posts
    .map((post) => buildTrainingRow(
      post,
      posts,
      candles,
      config.goldPrediction.horizonsMinutes,
      resolvedOpenAiSemantics.get(post.dedupeId) || null,
    ))
    .filter(Boolean);
  await writeTruthSocialGoldTrainingRows(config, rows);
  return rows;
}

async function runGoldModelRetrain(config) {
  const rows = await rebuildTruthSocialGoldTrainingData(config);
  await fs.mkdir(config.modelArtifactDir, { recursive: true });
  const result = await runPythonModel(config.goldPrediction.modelScriptPath, 'train', {
    trainingRows: rows,
    artifactDir: config.modelArtifactDir,
    horizons: config.goldPrediction.horizonsMinutes,
    labels: PREDICTION_LABELS,
  });
  await writeTruthSocialGoldModelMetadata(config, result);
  return result;
}

export function queueTruthSocialGoldRetrain(config) {
  if (retrainState.timer) {
    clearTimeout(retrainState.timer);
  }
  retrainState.pending = true;
  retrainState.timer = setTimeout(async () => {
    retrainState.timer = null;
    if (retrainState.running) {
      retrainState.pending = true;
      return;
    }
    retrainState.running = true;
    retrainState.pending = false;
    try {
      await runGoldModelRetrain(config);
    } catch {
      // ponytail: best-effort retrain; live predictions keep running on old artifact or fallback.
    } finally {
      retrainState.running = false;
      if (retrainState.pending) {
        queueTruthSocialGoldRetrain(config);
      }
    }
  }, config.goldPrediction.retrainDebounceMs);
  if (typeof retrainState.timer.unref === 'function') {
    retrainState.timer.unref();
  }
}

export async function runTruthSocialGoldBackfill(config, chromeClient) {
  const payload = await chromeClient.fetchAccountHistory({
    maxPages: config.chrome.backfillPages,
    maxItems: config.chrome.backfillLimit,
    limit: config.chrome.fetchLimit,
  });
  const posts = (payload?.statuses || []).map((item) => normalizeHistoryPost({
    dedupeId: String(item?.id || ''),
    originalId: item?.id ? String(item.id) : '',
    originalUrl: item?.url || '',
    link: item?.url || '',
    publishedAt: item?.created_at || null,
    body: item?.content_text || '',
    description: item?.content || '',
    isRetruth: Boolean(item?.reblog),
    mediaAttachments: Array.isArray(item?.media_attachments)
      ? item.media_attachments.map((media) => ({
          type: String(media?.type || ''),
          url: String(media?.url || ''),
          previewUrl: String(media?.preview_url || ''),
        }))
      : [],
  }, {
    source: 'chrome_api_backfill',
    fetchedAt: new Date().toISOString(),
    pages: payload?.pages || [],
  }));
  return posts;
}

export async function createGoldPredictionRecord({ post, config, baselineQuote }) {
  const publishedAtMs = Date.parse(post?.publishedAt || new Date().toISOString());
  const history = await readTruthSocialHistory(config);
  const semantic = await fetchOpenAiSemanticPrediction(post, config);
  if (!semantic) {
    throw new Error('OpenAI semantic prediction unavailable');
  }
  const candles = await loadGoldCandles(config, {
    includeMt5: true,
    includeYahoo: true,
    yahooInterval: '5m',
    yahooDays: 60,
  });
  const recentEventCount = countRecentPosts(Array.isArray(history) ? history : [], publishedAtMs, 30 * 60_000);
  const preMove = computePreMoveFeatures(candles, publishedAtMs);
  const features = createFeatureVector({
    post,
    semantic,
    publishedAtMs,
    recentEventCount,
    preMove,
  });
  const modelSource = 'openai_only';
  const expectedMovePct = round(semantic.directionalTiltPct || 0, 4) ?? 0;
  const predictedDirection = bucketGoldDirection(expectedMovePct);
  const confidence = semantic.confidence || 'low';

  return {
    type: 'gold_prediction',
    dedupeId: post?.dedupeId || null,
    originalUrl: post?.originalUrl || post?.link || null,
    publishedAt: post?.publishedAt || null,
    signalAt: new Date().toISOString(),
    baselineGold: toNumber(baselineQuote?.price),
    postSnapshot: normalizeHistoryPost(post, { source: 'live_delivery', capturedAt: new Date().toISOString() }),
    semantic,
    features,
    model: {
      source: modelSource,
      sampleCount: 0,
      directionProbabilities: DEFAULT_DIRECTION_PROBABILITIES,
      expectedMovePct,
      modelVersion: null,
    },
    prediction: {
      impactScore: impactScoreFromPrediction(semantic.goldRelevanceScore, expectedMovePct),
      direction: predictedDirection,
      confidence,
      expectedMovePct,
      source: modelSource,
    },
    outcomes: {},
  };
}

export function applyGoldPredictionOutcome({ record, followupQuote, minutes }) {
  const baseline = toNumber(record?.baselineGold);
  const followup = toNumber(followupQuote?.price);
  const realizedPct = computePercentChange(followup, baseline);
  const outcome = {
    checkedAt: new Date().toISOString(),
    minutes,
    baselineGold: baseline,
    followupGold: followup,
    realizedPct,
    direction: bucketGoldDirection(realizedPct),
    correct: bucketGoldDirection(realizedPct) === record?.prediction?.direction,
  };
  return {
    ...record,
    outcomes: {
      ...(record?.outcomes || {}),
      [horizonKey(minutes)]: outcome,
    },
    outcome: minutes === 5 ? outcome : (record?.outcome || null),
  };
}

export async function persistGoldPredictionOutcome(config, dedupeId, record) {
  await updateTruthSocialGoldPrediction(config, dedupeId, (current) => ({
    ...(current || {}),
    ...record,
    outcomes: {
      ...((current && current.outcomes) || {}),
      ...((record && record.outcomes) || {}),
    },
    outcome: record?.outcome || current?.outcome || null,
  }));
}

export async function computeGoldPredictionOutcomeFromCandles(config, record, minutes) {
  const publishedAtMs = Date.parse(record?.publishedAt || record?.postSnapshot?.publishedAt || 0);
  if (!publishedAtMs) {
    return null;
  }
  const candles = await loadGoldCandles(config, {
    includeMt5: true,
    includeYahoo: true,
    yahooInterval: '5m',
    yahooDays: 60,
  });
  const outcome = computeOutcomeForHorizon(candles, publishedAtMs, minutes);
  if (!outcome?.available) {
    return null;
  }
  return applyGoldPredictionOutcome({
    record,
    followupQuote: { price: outcome.followupGold },
    minutes,
  });
}

export function formatGoldPredictionMessage({ post, record, config }) {
  const signalLabel = formatTimestampInZone(new Date(record.signalAt), config.userTimezone);
  const originalUrl = post?.originalUrl || post?.link || '';
  const lines = [
    'Gold 5m prediction after Trump Truth Social post',
    '',
    `Impact score: ${record.prediction.impactScore}/10`,
    `Bias: ${record.prediction.direction}`,
    `Confidence: ${record.prediction.confidence}`,
    `Signal time: ${signalLabel}`,
  ];
  if (record.semantic?.tags?.length) {
    lines.push(`Drivers: ${record.semantic.tags.slice(0, 3).join(', ')}`);
  }
  if (originalUrl) {
    lines.push(`Original: ${originalUrl}`);
  }
  return lines.join('\n');
}

export function formatGoldOutcomeMessage({ post, record, config, minutes = 5 }) {
  const outcome = record?.outcomes?.[horizonKey(minutes)] || record?.outcome || {};
  const baseline = toNumber(outcome?.baselineGold ?? record?.baselineGold);
  const followup = toNumber(outcome?.followupGold);
  const realizedPct = toNumber(outcome?.realizedPct);
  const change = baseline !== null && followup !== null ? round(followup - baseline, 2) : null;
  const checkedLabel = formatTimestampInZone(new Date(outcome?.checkedAt || Date.now()), config.userTimezone);
  const originalUrl = post?.originalUrl || post?.link || '';
  return [
    `Gold ${minutes}m fact check after Trump Truth Social post: ${outcome?.direction || 'unknown'}`,
    '',
    `Predicted: ${record?.prediction?.direction || 'n/a'} (${record?.prediction?.confidence || 'n/a'}, impact ${record?.prediction?.impactScore ?? 'n/a'}/10, source ${record?.prediction?.source || 'n/a'})`,
    `Outcome: ${outcome?.correct ? 'correct' : 'wrong'}`,
    `Baseline: ${baseline !== null ? baseline.toFixed(2) : 'n/a'}`,
    `After ${minutes}m: ${followup !== null ? followup.toFixed(2) : 'n/a'}`,
    `Change: ${change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}` : 'n/a'}${realizedPct !== null ? ` (${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%)` : ''}`,
    `Checked: ${checkedLabel}`,
    originalUrl ? `Original: ${originalUrl}` : '',
  ].filter(Boolean).join('\n');
}

export {
  bucketGoldDirection,
  confidenceFromPrediction,
  impactScoreFromPrediction,
  normalizeHistoryPost,
  fetchOpenAiSemanticPrediction,
  runGoldModelRetrain as runTruthSocialGoldRetrain,
};
