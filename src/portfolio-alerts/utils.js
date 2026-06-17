import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function parseNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseStringList(value, fallback = []) {
  if (!value) {
    return fallback;
  }
  const items = String(value)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return items.length ? items : fallback;
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/%/g, '')
    .replace(/\$/g, '')
    .replace(/\u2212/g, '-')
    .trim();
  if (!cleaned || cleaned === '-' || cleaned === '--' || cleaned === 'N/A') {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, decimals = 2) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(numeric * factor) / factor;
}

export function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·');
}

export function computePercentChange(current, previous) {
  const a = toNumber(current);
  const b = toNumber(previous);
  if (a === null || b === null || b === 0) {
    return null;
  }
  return round(((a - b) / b) * 100, 2);
}

export function computeAbsoluteChange(current, previous) {
  const a = toNumber(current);
  const b = toNumber(previous);
  if (a === null || b === null) {
    return null;
  }
  return round(a - b, 2);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getTimePartsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

export function formatTimestampInZone(date, timeZone, withSeconds = true) {
  const parts = getTimePartsInZone(date, timeZone);
  const base = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return `${withSeconds ? `${base}:${String(parts.second).padStart(2, '0')}` : base} ${timeZone === 'Asia/Kolkata' ? 'IST' : 'ET'}`;
}

export function zoneDateKey(date, timeZone) {
  const parts = getTimePartsInZone(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureJsonFile(filePath, defaultValue) {
  if (fs.existsSync(filePath)) {
    return;
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  await fsp.writeFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`, 'utf8');
}

export async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function appendJsonEvent(filePath, event, maxItems = 500) {
  const current = await readJsonFile(filePath, []);
  const next = Array.isArray(current) ? current.concat(event).slice(-maxItems) : [event];
  await writeJsonFile(filePath, next);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchTextWithRetry(url, options = {}, config = {}) {
  const maxRetries = config.maxRetries ?? 3;
  const retryBackoffMs = config.retryBackoffMs ?? 1250;
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(config.timeoutMs ?? 20000),
        headers: {
          'User-Agent': config.userAgent || 'Mozilla/5.0',
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(options.headers || {}),
        },
      });
      if (response.ok) {
        return await response.text();
      }
      if ([403, 429].includes(response.status) || response.status >= 500) {
        await sleep(retryBackoffMs * attempt);
        continue;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      await sleep(retryBackoffMs * attempt);
    }
  }
  throw new Error(`Fetch failed for ${url}: ${lastError?.message || 'unknown error'}`);
}

export function formatUsd(value, digits = 2) {
  const numeric = toNumber(value);
  return numeric === null ? 'n/a' : `$${numeric.toFixed(digits)}`;
}

export function formatInr(value) {
  const numeric = toNumber(value);
  return numeric === null ? 'n/a' : `₹${Math.round(numeric).toLocaleString('en-IN')}`;
}

export function formatPct(value, digits = 2) {
  const numeric = toNumber(value);
  return numeric === null ? 'n/a' : `${numeric.toFixed(digits)}%`;
}

export function createLogger(scope) {
  return {
    info(message, meta) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.log(`[portfolio-alerts:${scope}] ${message}${suffix}`);
    },
    warn(message, meta) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.warn(`[portfolio-alerts:${scope}] ${message}${suffix}`);
    },
    error(message, meta) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.error(`[portfolio-alerts:${scope}] ${message}${suffix}`);
    },
  };
}
