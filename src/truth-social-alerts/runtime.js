import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildTruthSocialAlertConfig } from './config.js';
import { createTruthSocialBrowserClient } from './browser-client.js';
import { createTruthSocialChromeClient } from './chrome-client.js';
import { fetchTruthSocialFeed, formatTruthSocialPostMessage } from './feed.js';
import {
  appendTruthSocialAlertEvent,
  buildTruthSocialPostFingerprint,
  appendTruthSocialGoldPrediction,
  ensureTruthSocialAlertStateFiles,
  markTruthSocialAlertBootstrapLatestSent,
  markTruthSocialAlertDelivered,
  readTruthSocialRecentUsageEventsSync,
  readTruthSocialAlertState,
  upsertTruthSocialHistoryPosts,
  updateTruthSocialGoldPrediction,
  seedTruthSocialAlertState,
  updateTruthSocialAlertHead,
  writeTruthSocialAlertState,
} from './state-store.js';
import {
  applyGoldPredictionOutcome,
  computeGoldPredictionOutcomeFromCandles,
  createGoldPredictionRecord,
  formatGoldOutcomeMessage,
  formatGoldPredictionMessage,
  normalizeHistoryPost,
  persistGoldPredictionOutcome,
  queueTruthSocialGoldRetrain,
} from './predictor.js';
import { fetchGoogleFinanceQuote } from '../portfolio-alerts/market-data.js';
import { sendWhatsappAlert } from '../portfolio-alerts/whatsapp.js';
import { computePercentChange, createLogger, formatTimestampInZone, round, toNumber } from '../portfolio-alerts/utils.js';

const logger = createLogger('truth-social');
const GOLD_SYMBOL = 'GCW00:COMEX';

function pickMediaExtension(url, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mp4')) return '.mp4';
  if (type.includes('quicktime')) return '.mov';
  if (type.includes('mpeg')) return '.mpg';
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = path.extname(pathname);
    if (ext && ext.length <= 5) {
      return ext;
    }
  } catch {
    // Ignore URL parsing failure and fall back to jpg.
  }
  return '.jpg';
}

function pickPrimaryMedia(post) {
  const attachments = Array.isArray(post?.mediaAttachments) ? post.mediaAttachments : [];
  const first = attachments.find((attachment) => {
    const type = String(attachment?.type || '').toLowerCase();
    return (type === 'video' || type === 'gifv' || type === 'image') && attachment.url;
  });
  if (first) {
    return {
      url: first.url,
      type: first.type,
    };
  }
  const fallbackUrl = Array.isArray(post?.mediaUrls) ? post.mediaUrls.find(Boolean) : null;
  return fallbackUrl ? { url: fallbackUrl, type: '' } : null;
}

async function downloadPostMedia(url) {
  const response = await fetch(url, {
    headers: {
      Accept: '*/*',
      'User-Agent': 'Mozilla/5.0 (compatible; MarketTruthSocialAlerts/1.0; +https://markets.healthymealspot.com)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Media download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'truth-social-media-'));
  const mediaPath = path.join(
    tempDir,
    `truth-social${pickMediaExtension(url, response.headers.get('content-type'))}`,
  );
  await fs.writeFile(mediaPath, bytes);
  return mediaPath;
}

async function sendTruthSocialAlertToRecipients(config, message, post = null) {
  const recipients = Array.isArray(config.whatsapp?.recipients) && config.whatsapp.recipients.length
    ? config.whatsapp.recipients
    : [config.whatsapp?.recipient].filter(Boolean);
  let mediaPath = null;
  const primaryMedia = pickPrimaryMedia(post);
  if (primaryMedia?.url && !config.dryRun) {
    try {
      mediaPath = await downloadPostMedia(primaryMedia.url);
    } catch (error) {
      logger.warn('Failed to download Truth Social media; falling back to text-only alert', {
        url: primaryMedia.url,
        error: error.message,
      });
    }
  }
  const results = [];
  try {
    for (const recipient of recipients) {
      const response = await sendWhatsappAlert({
        ...config,
        whatsapp: {
          ...config.whatsapp,
          recipient,
        },
      }, message, {
        mediaPath,
      });
      results.push({
        recipient,
        messageRef: response?.messageRef || null,
      });
    }
  } finally {
    if (mediaPath) {
      await fs.rm(path.dirname(mediaPath), { recursive: true, force: true }).catch(() => {});
    }
  }
  return results;
}

async function fetchGoldProxyQuote() {
  return fetchGoogleFinanceQuote(GOLD_SYMBOL, {
    userAgent: 'Mozilla/5.0 (compatible; MarketTruthSocialAlerts/1.0; +https://markets.healthymealspot.com)',
  });
}

export function classifyGoldImpactPct(pctChange) {
  const pct = toNumber(pctChange);
  if (pct === null) return 'flat';
  if (pct <= -0.04) return 'down';
  if (pct < 0.04) return 'flat';
  return 'up';
}

export function formatGoldImpactMessage({ post, baselineQuote, followupQuote, config, checkedAt = new Date() }) {
  const baseline = toNumber(baselineQuote?.price);
  const followup = toNumber(followupQuote?.price);
  const realizedPct = computePercentChange(followup, baseline);
  const change = baseline !== null && followup !== null ? round(followup - baseline, 2) : null;
  const checkedLabel = formatTimestampInZone(new Date(checkedAt), config.userTimezone);
  return [
    `Gold next 5m bias after Trump Truth Social post: ${classifyGoldImpactPct(realizedPct)}`,
    '',
    `Baseline: ${baseline !== null ? baseline.toFixed(2) : 'n/a'}`,
    `Now: ${followup !== null ? followup.toFixed(2) : 'n/a'}`,
    `Change: ${change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}` : 'n/a'}${realizedPct !== null ? ` (${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%)` : ''}`,
    `Checked: ${checkedLabel}`,
    post?.originalUrl ? `Original: ${post.originalUrl}` : '',
  ].filter(Boolean).join('\n');
}

function sortChronologically(items) {
  return [...items].sort((a, b) => {
    const aTime = a.publishedAtDate?.getTime() || 0;
    const bTime = b.publishedAtDate?.getTime() || 0;
    return aTime - bTime;
  });
}

function collectUnseenItems(items, state) {
  const delivered = new Set(state.deliveredIds || []);
  const deliveredFingerprints = new Set(state.deliveredFingerprints || []);
  const seenFingerprints = new Set();
  return sortChronologically(items).filter((item) => {
    if (!item?.dedupeId || delivered.has(item.dedupeId)) {
      return false;
    }
    const fingerprint = buildTruthSocialPostFingerprint(item);
    if (fingerprint && (deliveredFingerprints.has(fingerprint) || seenFingerprints.has(fingerprint))) {
      return false;
    }
    if (fingerprint) {
      seenFingerprints.add(fingerprint);
    }
    return true;
  });
}

async function handleBootstrapMode({ config, state, newestItem, items, deliverPost }) {
  if (config.bootstrapMode === 'send_latest_once') {
    const deliveryResults = await deliverPost(newestItem);
    const nextState = markTruthSocialAlertBootstrapLatestSent(state, newestItem, config, items);
    return {
      nextState,
      result: {
        ok: true,
        deliveredCount: 1,
        recipientCount: deliveryResults.length,
        seeded: true,
        bootstrapMode: config.bootstrapMode,
        deliveredIds: newestItem?.dedupeId ? [newestItem.dedupeId] : [],
        lastSeenId: nextState.lastSeenId,
      },
      event: {
        type: 'bootstrap_send_latest',
        dryRun: config.dryRun,
        itemCount: items.length,
        lastSeenId: nextState.lastSeenId,
        dedupeId: newestItem?.dedupeId || null,
        originalId: newestItem?.originalId || null,
        originalUrl: newestItem?.originalUrl || newestItem?.link || null,
        recipients: deliveryResults.map((item) => item.recipient),
      },
      summary: {
        action: 'bootstrap_send_latest',
        itemCount: items.length,
        deliveredCount: 1,
        recipientCount: deliveryResults.length,
        lastSeenId: nextState.lastSeenId,
      },
    };
  }

  if (config.bootstrapMode === 'replay_unseen') {
    const unseenItems = sortChronologically(items.filter((item) => item?.dedupeId));
    let nextState = state;
    const deliveredIds = [];
    for (const item of unseenItems) {
      const deliveryResults = await deliverPost(item);
      nextState = markTruthSocialAlertDelivered(nextState, item, config);
      deliveredIds.push(item.dedupeId);
      await appendTruthSocialAlertEvent(config, {
        type: 'delivery',
        dryRun: config.dryRun,
        dedupeId: item.dedupeId,
        originalId: item.originalId || null,
        originalUrl: item.originalUrl || item.link || null,
        publishedAt: item.publishedAt,
        isRetruth: item.isRetruth,
        recipients: deliveryResults.map((entry) => entry.recipient),
      });
    }
    nextState = {
      ...nextState,
      bootstrap: {
        ...(nextState.bootstrap || {}),
        mode: config.bootstrapMode,
        completedAt: new Date().toISOString(),
        sentLatestAt: newestItem?.dedupeId ? new Date().toISOString() : null,
        lastBootstrapSentId: newestItem?.dedupeId || null,
      },
    };
    return {
      nextState,
      result: {
        ok: true,
        deliveredCount: deliveredIds.length,
        seeded: true,
        bootstrapMode: config.bootstrapMode,
        deliveredIds,
        lastSeenId: nextState.lastSeenId,
      },
      event: {
        type: 'bootstrap_replay_unseen',
        dryRun: config.dryRun,
        itemCount: items.length,
        deliveredCount: deliveredIds.length,
        lastSeenId: nextState.lastSeenId,
      },
      summary: {
        action: 'bootstrap_replay_unseen',
        itemCount: items.length,
        deliveredCount: deliveredIds.length,
        lastSeenId: nextState.lastSeenId,
      },
    };
  }

  const nextState = seedTruthSocialAlertState(state, newestItem, config, items);
  return {
    nextState,
    result: {
      ok: true,
      deliveredCount: 0,
      seeded: true,
      bootstrapMode: config.bootstrapMode,
      lastSeenId: nextState.lastSeenId,
    },
    event: {
      type: 'bootstrap_seed',
      dryRun: config.dryRun,
      itemCount: items.length,
      lastSeenId: nextState.lastSeenId,
    },
    summary: {
      action: 'seeded',
      itemCount: items.length,
      deliveredCount: 0,
      lastSeenId: nextState.lastSeenId,
    },
  };
}

export function createTruthSocialAlertRuntime(options = {}) {
  const config = buildTruthSocialAlertConfig(options.env || process.env);
  let timer = null;
  let running = false;
  let stopping = false;
  let browserClient = null;
  let chromeClient = null;
  const goldImpactTimers = new Map();
  const status = {
    enabled: config.enabled,
    lastRunAt: null,
    lastError: null,
    lastSummary: null,
    lastPollItemCount: 0,
    lastSeededAt: null,
    lastBootstrapMode: config.bootstrapMode,
    lastBootstrapCompletedAt: null,
    lastPageReloadAt: null,
    nextScheduledRunAt: null,
    lastPollingIntervalMs: null,
  };

  async function ensureBrowserClient() {
    if (config.source !== 'browser') {
      return null;
    }
    if (!browserClient) {
      browserClient = createTruthSocialBrowserClient(config);
    }
    return browserClient;
  }

  async function ensureChromeClient() {
    if (config.source !== 'chrome' && config.source !== 'chrome_api') {
      return null;
    }
    if (!chromeClient) {
      chromeClient = createTruthSocialChromeClient(config);
    }
    return chromeClient;
  }

  async function sendRecipientReply(message, deliveryResults = []) {
    const recipients = deliveryResults.length
      ? deliveryResults
      : (config.whatsapp?.recipients || []).map((recipient) => ({ recipient, messageRef: null }));
    const results = [];
    for (const recipient of recipients) {
      const response = await sendWhatsappAlert({
        ...config,
        whatsapp: {
          ...config.whatsapp,
          recipient: recipient.recipient,
        },
      }, message, {
        quotedMessage: recipient.messageRef || null,
      });
      results.push({
        recipient: recipient.recipient,
        messageRef: response?.messageRef || null,
      });
    }
    return results;
  }

  function scheduleGoldImpactCheck(post, predictionRecord, minutes, deliveryResults = []) {
    const timerKey = `${post?.dedupeId || 'unknown'}:${minutes}`;
    if (!post?.dedupeId || goldImpactTimers.has(timerKey) || !predictionRecord) {
      return;
    }

    const timer = setTimeout(async () => {
      goldImpactTimers.delete(timerKey);
      try {
        const persistedRecord = await updateTruthSocialGoldPrediction(config, post.dedupeId, (current) => current);
        const baseRecord = persistedRecord || predictionRecord;
        const completedRecord = await computeGoldPredictionOutcomeFromCandles(config, baseRecord, minutes);
        if (!completedRecord) {
          throw new Error(`No ${minutes}m candle outcome available`);
        }
        let replyResults = [];
        if (minutes === 5) {
          const message = formatGoldOutcomeMessage({
            post,
            record: completedRecord,
            config,
            minutes,
          });
          replyResults = await sendRecipientReply(message, deliveryResults);
        }
        await persistGoldPredictionOutcome(config, post.dedupeId, completedRecord);
        await appendTruthSocialAlertEvent(config, {
          type: `gold_prediction_outcome_${minutes}m`,
          dryRun: config.dryRun,
          dedupeId: post.dedupeId,
          originalUrl: post.originalUrl || post.link || null,
          baselineGold: toNumber(completedRecord?.baselineGold),
          followupGold: toNumber(completedRecord?.outcomes?.[`${minutes}m`]?.followupGold),
          direction: completedRecord?.outcomes?.[`${minutes}m`]?.direction || null,
          predictedDirection: completedRecord?.prediction?.direction || null,
          correct: Boolean(completedRecord?.outcomes?.[`${minutes}m`]?.correct),
          recipients: replyResults.map((item) => item.recipient),
        });
        queueTruthSocialGoldRetrain(config);
      } catch (error) {
        logger.warn('Failed to compute gold prediction outcome after Truth Social post', {
          dedupeId: post.dedupeId,
          minutes,
          error: error.message,
        });
      }
    }, Math.max(60_000, minutes * 60_000));
    // ponytail: in-process timer only; persist jobs if restart-safe follow-ups matter.
    goldImpactTimers.set(timerKey, timer);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  async function deliverPostAndPrediction(item) {
    const message = formatTruthSocialPostMessage(item, config);
    const deliveryResults = await sendTruthSocialAlertToRecipients(config, message, item);
    try {
      await upsertTruthSocialHistoryPosts(config, [
        normalizeHistoryPost(item, {
          source: 'live_delivery',
          fetchedAt: new Date().toISOString(),
        }),
      ]);
      const baselineQuote = await fetchGoldProxyQuote();
      const predictionRecord = await createGoldPredictionRecord({
        post: item,
        config,
        baselineQuote,
      });
      const predictionMessage = formatGoldPredictionMessage({
        post: item,
        record: predictionRecord,
        config,
      });
      const predictionReplies = await sendRecipientReply(predictionMessage, deliveryResults);
      await appendTruthSocialGoldPrediction(config, predictionRecord);
      await appendTruthSocialAlertEvent(config, {
        type: 'gold_prediction',
        dryRun: config.dryRun,
        dedupeId: item.dedupeId,
        originalUrl: item.originalUrl || item.link || null,
        publishedAt: item.publishedAt,
        impactScore: predictionRecord?.prediction?.impactScore ?? null,
        predictedDirection: predictionRecord?.prediction?.direction || null,
        confidence: predictionRecord?.prediction?.confidence || null,
        baselineGold: predictionRecord?.baselineGold ?? null,
        recipients: predictionReplies.map((entry) => entry.recipient),
      });
      for (const minutes of config.goldPrediction.horizonsMinutes || [5]) {
        scheduleGoldImpactCheck(item, predictionRecord, minutes, predictionReplies);
      }
    } catch (error) {
      logger.warn('Failed to build gold prediction after Truth Social post', {
        dedupeId: item?.dedupeId,
        error: error.message,
      });
    }
    return deliveryResults;
  }

  async function runCycle() {
    if (running) {
      return { ok: false, skipped: true, reason: 'run already in progress' };
    }
    running = true;
    try {
      await ensureTruthSocialAlertStateFiles(config);
      let state = await readTruthSocialAlertState(config);
      const ensuredBrowserClient = await ensureBrowserClient();
      const ensuredChromeClient = await ensureChromeClient();
      const feed = await fetchTruthSocialFeed(config, {
        browserClient: ensuredBrowserClient,
        chromeClient: ensuredChromeClient,
      });
      if (ensuredChromeClient?.getStatus) {
        status.lastPageReloadAt = ensuredChromeClient.getStatus()?.lastReloadAt || status.lastPageReloadAt;
      }
      const items = Array.isArray(feed.items) ? feed.items : [];
      status.lastPollItemCount = items.length;

      if (!items.length) {
        status.lastRunAt = new Date().toISOString();
        status.lastError = null;
        status.lastSummary = {
          action: 'empty_feed',
          itemCount: 0,
          deliveredCount: 0,
        };
        return { ok: true, deliveredCount: 0, seeded: false, empty: true };
      }

      const newestItem = items[0];
      if (!state.lastSeenId && !(state.deliveredIds || []).length) {
        const bootstrap = await handleBootstrapMode({ config, state, newestItem, items, deliverPost: deliverPostAndPrediction });
        state = bootstrap.nextState;
        await writeTruthSocialAlertState(config, state);
        await appendTruthSocialAlertEvent(config, bootstrap.event);
        status.lastRunAt = new Date().toISOString();
        status.lastError = null;
        status.lastSeededAt = state.seededAt;
        status.lastBootstrapCompletedAt = state.bootstrap?.completedAt || null;
        status.lastSummary = bootstrap.summary;
        return bootstrap.result;
      }

      const unseenItems = collectUnseenItems(items, state);
      const deliveredIds = [];
      for (const item of unseenItems) {
        const deliveryResults = await deliverPostAndPrediction(item);
        state = markTruthSocialAlertDelivered(state, item, config);
        deliveredIds.push(item.dedupeId);
        await appendTruthSocialAlertEvent(config, {
          type: 'delivery',
          dryRun: config.dryRun,
          dedupeId: item.dedupeId,
          originalId: item.originalId || null,
          originalUrl: item.originalUrl || item.link || null,
          publishedAt: item.publishedAt,
          isRetruth: item.isRetruth,
          recipients: deliveryResults.map((entry) => entry.recipient),
        });
      }

      state = updateTruthSocialAlertHead(state, newestItem);
      await writeTruthSocialAlertState(config, state);
      status.lastRunAt = new Date().toISOString();
      status.lastError = null;
      status.lastSeededAt = state.seededAt;
      status.lastBootstrapCompletedAt = state.bootstrap?.completedAt || null;
      status.lastSummary = {
        action: deliveredIds.length ? 'delivered' : 'no_change',
        itemCount: items.length,
        deliveredCount: deliveredIds.length,
        lastSeenId: state.lastSeenId,
      };
      return {
        ok: true,
        dryRun: config.dryRun,
        deliveredCount: deliveredIds.length,
        deliveredIds,
        lastSeenId: state.lastSeenId,
      };
    } catch (error) {
      if (chromeClient?.getStatus) {
        status.lastPageReloadAt = chromeClient.getStatus()?.lastReloadAt || status.lastPageReloadAt;
      }
      status.lastRunAt = new Date().toISOString();
      status.lastError = error.message;
      status.lastSummary = null;
      logger.error('Truth Social alert cycle failed', { error: error.message });
      try {
        await appendTruthSocialAlertEvent(config, {
          type: 'error',
          dryRun: config.dryRun,
          error: error.message,
        });
      } catch {
        // Best-effort event logging should not hide the original failure.
      }
      return { ok: false, error: error.message };
    } finally {
      running = false;
    }
  }

  function scheduleNextRun(anchorTime = Date.now()) {
    if (stopping || !config.enabled) {
      return;
    }
    const now = Date.now();
    const nextRunAtMs = Math.max(anchorTime + config.pollingIntervalMs, now);
    status.lastPollingIntervalMs = config.pollingIntervalMs;
    status.nextScheduledRunAt = new Date(nextRunAtMs).toISOString();
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      timer = null;
      if (stopping || !config.enabled) {
        return;
      }
      const cycleStartedAt = Date.now();
      try {
        await runCycle();
      } catch (error) {
        logger.error('Scheduled Truth Social alert cycle failed', { error: error.message });
      }
      scheduleNextRun(cycleStartedAt);
    }, Math.max(0, nextRunAtMs - now));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function start() {
    if (!config.enabled) {
      logger.info('Truth Social alert runtime is disabled by config');
      return;
    }
    if (timer) {
      return;
    }
    stopping = false;
    runCycle().catch((error) => {
      logger.error('Initial Truth Social alert cycle failed', { error: error.message });
    });
    scheduleNextRun(Date.now());
  }

  function stop() {
    stopping = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const pending of goldImpactTimers.values()) {
      clearTimeout(pending);
    }
    goldImpactTimers.clear();
    status.nextScheduledRunAt = null;
    if (browserClient) {
      browserClient.stop().catch((error) => {
        logger.error('Truth Social browser client stop failed', { error: error.message });
      });
      browserClient = null;
    }
    chromeClient = null;
  }

  return {
    config,
    status,
    start,
    stop,
    runCycle,
    getStatus() {
      const chromeStatus = chromeClient?.getStatus ? chromeClient.getStatus() : null;
      return {
        ...status,
        lastScrapeAt: status.lastRunAt,
        lastPageReloadAt: status.lastPageReloadAt || chromeStatus?.lastReloadAt || null,
        config: {
          enabled: config.enabled,
          dryRun: config.dryRun,
          recipientConfigured: Boolean(config.whatsapp.recipient),
          recipientCount: Array.isArray(config.whatsapp.recipients) ? config.whatsapp.recipients.length : 0,
          source: config.source,
          accountHandle: config.accountHandle,
          pollingIntervalMs: config.pollingIntervalMs,
          rssUrl: config.rssUrl,
          bootstrapMode: config.bootstrapMode,
          statePath: config.statePath,
          eventsPath: config.eventsPath,
        },
        bootstrap: {
          mode: config.bootstrapMode,
          completedAt: status.lastBootstrapCompletedAt,
        },
        recentUsage: readTruthSocialRecentUsageEventsSync(config, 20),
      };
    },
  };
}
