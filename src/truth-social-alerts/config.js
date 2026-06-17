import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { compactWhitespace, parseBoolean, parseNumber } from '../portfolio-alerts/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const VALID_BOOTSTRAP_MODES = new Set(['seed_only', 'send_latest_once', 'replay_unseen']);
const VALID_SOURCES = new Set(['rss', 'browser', 'chrome', 'chrome_api']);

function parseBootstrapMode(value) {
  const normalized = compactWhitespace(String(value || '')).toLowerCase().replace(/-/g, '_');
  if (VALID_BOOTSTRAP_MODES.has(normalized)) {
    return normalized;
  }
  return 'seed_only';
}

function parseSource(value) {
  const normalized = compactWhitespace(String(value || '')).toLowerCase();
  if (VALID_SOURCES.has(normalized)) {
    return normalized;
  }
  return 'rss';
}

function parseRecipients(value) {
  return String(value || '')
    .split(',')
    .map((item) => compactWhitespace(item))
    .filter(Boolean);
}

function parsePathList(value, fallback = []) {
  if (!value) {
    return fallback;
  }
  return String(value)
    .split(',')
    .map((item) => compactWhitespace(item))
    .filter(Boolean);
}

export function buildTruthSocialAlertConfig(env = process.env) {
  const recipients = parseRecipients(env.TRUTH_SOCIAL_ALERT_RECIPIENT || '');
  const mt5FilesRoot = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'net.metaquotes.wine.metatrader5',
    'drive_c',
    'Program Files',
    'MetaTrader 5',
    'MQL5',
    'Files',
  );
  return {
    projectRoot: PROJECT_ROOT,
    enabled: parseBoolean(env.TRUTH_SOCIAL_ALERTS_ENABLED, false),
    dryRun: parseBoolean(env.TRUTH_SOCIAL_ALERTS_DRY_RUN, true),
    source: parseSource(env.TRUTH_SOCIAL_ALERT_SOURCE || 'rss'),
    pollingIntervalMs: Math.max(1_000, parseNumber(env.TRUTH_SOCIAL_ALERTS_POLL_SECONDS, 5) * 1000),
    rssUrl: env.TRUTH_SOCIAL_RSS_URL || 'https://trumpstruth.org/feed',
    accountHandle: compactWhitespace(env.TRUTH_SOCIAL_ACCOUNT_HANDLE || 'realDonaldTrump').replace(/^@/, ''),
    bootstrapMode: parseBootstrapMode(env.TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE || 'seed_only'),
    userTimezone: env.TRUTH_SOCIAL_ALERT_USER_TIMEZONE || 'Asia/Kolkata',
    statePath:
      env.TRUTH_SOCIAL_ALERT_STATE_PATH || path.join(PROJECT_ROOT, 'data', 'truth-social-alert-state.json'),
    eventsPath:
      env.TRUTH_SOCIAL_ALERT_EVENTS_PATH || path.join(PROJECT_ROOT, 'data', 'truth-social-alert-events.json'),
    predictionsPath:
      env.TRUTH_SOCIAL_GOLD_PREDICTIONS_PATH || path.join(PROJECT_ROOT, 'data', 'truth-social-gold-predictions.json'),
    historyPath:
      env.TRUTH_SOCIAL_HISTORY_PATH || path.join(PROJECT_ROOT, 'data', 'truth-social-history.json'),
    trainingDataPath:
      env.TRUTH_SOCIAL_GOLD_TRAINING_PATH || path.join(PROJECT_ROOT, 'data', 'truth-social-gold-training.json'),
    modelMetadataPath:
      env.TRUTH_SOCIAL_GOLD_MODEL_METADATA_PATH || path.join(PROJECT_ROOT, 'data', 'truth-social-gold-models.json'),
    modelArtifactDir:
      env.TRUTH_SOCIAL_GOLD_MODEL_ARTIFACT_DIR || path.join(PROJECT_ROOT, 'data', 'truth-social-gold-model-artifacts'),
    historyLimit: Math.max(25, Math.round(parseNumber(env.TRUTH_SOCIAL_ALERT_HISTORY_LIMIT, 500))),
    goldPrediction: {
      openaiApiKey: env.OPENAI_API_KEY || '',
      delayMs: Math.max(60_000, parseNumber(env.TRUTH_SOCIAL_GOLD_SIGNAL_SECONDS, 300) * 1000),
      modelScriptPath:
        env.TRUTH_SOCIAL_GOLD_MODEL_SCRIPT ||
        path.join(PROJECT_ROOT, 'scripts', 'truth-social-gold-model.py'),
      openaiModel: env.OPENAI_MODEL || 'gpt-5-mini',
      horizonsMinutes: [5, 15, 30],
      minTrainingRows: Math.max(8, Math.round(parseNumber(env.TRUTH_SOCIAL_GOLD_MIN_TRAINING_ROWS, 24))),
      retrainDebounceMs: Math.max(5_000, parseNumber(env.TRUTH_SOCIAL_GOLD_RETRAIN_DEBOUNCE_MS, 15_000)),
    },
    whatsapp: {
      recipient: recipients[0] || '',
      recipients,
      agentUrl: env.WHATSAPP_AGENT_URL || 'http://127.0.0.1:3001/send',
      agentSecret: env.WHATSAPP_AGENT_SECRET || '',
      threadReplies: false,
    },
    fetch: {
      timeoutMs: Math.max(5_000, parseNumber(env.TRUTH_SOCIAL_ALERT_FETCH_TIMEOUT_MS, 20_000)),
      maxRetries: Math.max(1, Math.round(parseNumber(env.TRUTH_SOCIAL_ALERT_FETCH_RETRIES, 3))),
      retryBackoffMs: Math.max(250, parseNumber(env.TRUTH_SOCIAL_ALERT_FETCH_RETRY_BACKOFF_MS, 1_250)),
    },
    browser: {
      bootstrapUrl: env.TRUTH_SOCIAL_BROWSER_BOOTSTRAP_URL || 'https://truthsocial.com/',
      bridgeScriptPath:
        env.TRUTH_SOCIAL_BROWSER_BRIDGE_SCRIPT ||
        path.join(PROJECT_ROOT, 'scripts', 'truth-social-browser-bridge.py'),
      requestTimeoutMs: Math.max(10_000, parseNumber(env.TRUTH_SOCIAL_BROWSER_REQUEST_TIMEOUT_MS, 45_000)),
      fetchLimit: Math.max(10, Math.round(parseNumber(env.TRUTH_SOCIAL_BROWSER_FETCH_LIMIT, 100))),
      headed: !parseBoolean(env.TRUTH_SOCIAL_BROWSER_HEADLESS, false),
    },
    chrome: {
      fetchLimit: Math.max(10, Math.round(parseNumber(env.TRUTH_SOCIAL_CHROME_FETCH_LIMIT, 100))),
      backfillPages: Math.max(1, Math.round(parseNumber(env.TRUTH_SOCIAL_CHROME_BACKFILL_PAGES, 12))),
      backfillLimit: Math.max(50, Math.round(parseNumber(env.TRUTH_SOCIAL_CHROME_BACKFILL_LIMIT, 1000))),
      reloadBeforeFetch: parseBoolean(env.TRUTH_SOCIAL_CHROME_RELOAD_BEFORE_FETCH, false),
      reloadMinIntervalMs: Math.max(
        15_000,
        parseNumber(env.TRUTH_SOCIAL_CHROME_RELOAD_MIN_SECONDS, 60) * 1000,
      ),
    },
    mt5: {
      enabled: parseBoolean(env.TRUTH_SOCIAL_GOLD_MT5_ENABLED, true),
      timeOffsetMinutes: Math.round(parseNumber(env.TRUTH_SOCIAL_GOLD_MT5_TIME_OFFSET_MINUTES, 0)),
      goldCsvPaths: parsePathList(env.TRUTH_SOCIAL_GOLD_MT5_CSV_PATHS, [
        path.join(mt5FilesRoot, 'XAUUSD_2years.csv'),
        path.join(mt5FilesRoot, 'ft_XAUUSD_M1.csv'),
      ]),
      minRows: Math.max(100, Math.round(parseNumber(env.TRUTH_SOCIAL_GOLD_MT5_MIN_ROWS, 1000))),
    },
  };
}
