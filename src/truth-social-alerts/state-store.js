import fs from 'node:fs';
import {
  appendJsonEvent,
  compactWhitespace,
  ensureJsonFile,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from '../portfolio-alerts/utils.js';

function buildDefaultState() {
  return {
    version: 1,
    updatedAt: null,
    seededAt: null,
    lastSeenId: null,
    lastSeenPublishedAt: null,
    deliveredIds: [],
    deliveredFingerprints: [],
    lastDeliveryAt: null,
    bootstrap: {
      mode: null,
      completedAt: null,
      sentLatestAt: null,
      lastBootstrapSentId: null,
    },
  };
}

function collectDeliveredIds(items = [], historyLimit = 500) {
  return items
    .map((item) => item?.dedupeId || null)
    .filter(Boolean)
    .slice(0, historyLimit);
}

export function buildTruthSocialPostFingerprint(item) {
  const body = compactWhitespace(String(item?.body || item?.title || item?.description || ''));
  if (!body || body === '[Media-only post]') {
    return null;
  }
  return body
    .replace(/^rt\s*@\s*[\w.]+\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function collectDeliveredFingerprints(items = [], historyLimit = 500) {
  return [...new Set(
    items
      .map((item) => buildTruthSocialPostFingerprint(item))
      .filter(Boolean),
  )].slice(-historyLimit);
}

export async function ensureTruthSocialAlertStateFiles(config) {
  await ensureJsonFile(config.statePath, buildDefaultState());
  await ensureJsonFile(config.eventsPath, []);
  await ensureJsonFile(config.predictionsPath, []);
  await ensureJsonFile(config.historyPath, []);
  await ensureJsonFile(config.trainingDataPath, []);
  await ensureJsonFile(config.modelMetadataPath, {
    horizons: {},
    updatedAt: null,
  });
}

export async function readTruthSocialAlertState(config) {
  const state = await readJsonFile(config.statePath, buildDefaultState());
  if (!state || typeof state !== 'object') {
    return buildDefaultState();
  }
  const defaults = buildDefaultState();
  return {
    ...defaults,
    ...state,
    bootstrap: {
      ...defaults.bootstrap,
      ...(state.bootstrap || {}),
    },
  };
}

export async function writeTruthSocialAlertState(config, state) {
  const defaults = buildDefaultState();
  await writeJsonFile(config.statePath, {
    ...defaults,
    ...state,
    bootstrap: {
      ...defaults.bootstrap,
      ...(state.bootstrap || {}),
    },
    updatedAt: nowIso(),
  });
}

export async function appendTruthSocialAlertEvent(config, event) {
  await appendJsonEvent(config.eventsPath, { ...event, recordedAt: nowIso() });
}

export function readTruthSocialRecentUsageEventsSync(config, limit = 20) {
  try {
    const raw = fs.readFileSync(config.eventsPath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .filter((item) => item?.type === 'openai_usage')
      .slice(-Math.max(1, limit))
      .reverse();
  } catch {
    return [];
  }
}

export async function appendTruthSocialGoldPrediction(config, prediction) {
  await appendJsonEvent(config.predictionsPath, { ...prediction, recordedAt: nowIso() }, 1000);
}

export async function readTruthSocialGoldPredictions(config) {
  const items = await readJsonFile(config.predictionsPath, []);
  return Array.isArray(items) ? items : [];
}

export async function updateTruthSocialGoldPrediction(config, dedupeId, updater) {
  const current = await readTruthSocialGoldPredictions(config);
  let updatedItem = null;
  const next = current.map((item) => {
    if (item?.dedupeId !== dedupeId) {
      return item;
    }
    const patch = typeof updater === 'function' ? updater(item) : updater;
    updatedItem = {
      ...item,
      ...patch,
      updatedAt: nowIso(),
    };
    return updatedItem;
  });
  await writeJsonFile(config.predictionsPath, next);
  return updatedItem;
}

export async function readTruthSocialHistory(config) {
  const items = await readJsonFile(config.historyPath, []);
  return Array.isArray(items) ? items : [];
}

export async function upsertTruthSocialHistoryPosts(config, posts = []) {
  const current = await readTruthSocialHistory(config);
  const merged = new Map(current.filter((item) => item?.dedupeId).map((item) => [item.dedupeId, item]));
  for (const post of Array.isArray(posts) ? posts : []) {
    if (!post?.dedupeId) {
      continue;
    }
    merged.set(post.dedupeId, {
      ...(merged.get(post.dedupeId) || {}),
      ...post,
      updatedAt: nowIso(),
    });
  }
  const next = [...merged.values()]
    .sort((a, b) => Date.parse(a?.publishedAt || 0) - Date.parse(b?.publishedAt || 0));
  await writeJsonFile(config.historyPath, next);
  return next;
}

export async function readTruthSocialGoldTrainingRows(config) {
  const items = await readJsonFile(config.trainingDataPath, []);
  return Array.isArray(items) ? items : [];
}

export async function writeTruthSocialGoldTrainingRows(config, rows) {
  await writeJsonFile(config.trainingDataPath, Array.isArray(rows) ? rows : []);
}

export async function readTruthSocialGoldModelMetadata(config) {
  const value = await readJsonFile(config.modelMetadataPath, { horizons: {}, updatedAt: null });
  return value && typeof value === 'object'
    ? { horizons: {}, updatedAt: null, ...value }
    : { horizons: {}, updatedAt: null };
}

export async function writeTruthSocialGoldModelMetadata(config, metadata) {
  await writeJsonFile(config.modelMetadataPath, {
    horizons: {},
    updatedAt: nowIso(),
    ...(metadata || {}),
  });
}

export function seedTruthSocialAlertState(state, newestItem, config, items = []) {
  const dedupeId = newestItem?.dedupeId || null;
  const publishedAt = newestItem?.publishedAt || null;
  return {
    ...state,
    seededAt: nowIso(),
    lastSeenId: dedupeId,
    lastSeenPublishedAt: publishedAt,
    deliveredIds: collectDeliveredIds(items, config.historyLimit),
    deliveredFingerprints: collectDeliveredFingerprints(items, config.historyLimit),
    bootstrap: {
      ...(state.bootstrap || {}),
      mode: config.bootstrapMode,
      completedAt: nowIso(),
      sentLatestAt: null,
      lastBootstrapSentId: null,
    },
  };
}

export function markTruthSocialAlertBootstrapLatestSent(state, newestItem, config, items = []) {
  const dedupeId = newestItem?.dedupeId || null;
  const publishedAt = newestItem?.publishedAt || null;
  return {
    ...state,
    seededAt: nowIso(),
    lastSeenId: dedupeId,
    lastSeenPublishedAt: publishedAt,
    lastDeliveryAt: nowIso(),
    deliveredIds: collectDeliveredIds(items, config.historyLimit),
    deliveredFingerprints: collectDeliveredFingerprints(items, config.historyLimit),
    bootstrap: {
      ...(state.bootstrap || {}),
      mode: config.bootstrapMode,
      completedAt: nowIso(),
      sentLatestAt: nowIso(),
      lastBootstrapSentId: dedupeId,
    },
  };
}

export function markTruthSocialAlertDelivered(state, item, config) {
  const nextDelivered = [...(state.deliveredIds || []), item.dedupeId].filter(Boolean);
  const dedupedDelivered = [...new Set(nextDelivered)].slice(-config.historyLimit);
  const nextFingerprints = [
    ...(state.deliveredFingerprints || []),
    buildTruthSocialPostFingerprint(item),
  ].filter(Boolean);
  return {
    ...state,
    lastSeenId: item.dedupeId,
    lastSeenPublishedAt: item.publishedAt || null,
    lastDeliveryAt: nowIso(),
    deliveredIds: dedupedDelivered,
    deliveredFingerprints: [...new Set(nextFingerprints)].slice(-config.historyLimit),
  };
}

export function updateTruthSocialAlertHead(state, newestItem) {
  if (!newestItem?.dedupeId) {
    return state;
  }
  return {
    ...state,
    lastSeenId: newestItem.dedupeId,
    lastSeenPublishedAt: newestItem.publishedAt || null,
  };
}
