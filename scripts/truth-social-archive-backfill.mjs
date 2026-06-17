import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTruthSocialAlertConfig } from '../src/truth-social-alerts/config.js';
import { normalizeHistoryPost } from '../src/truth-social-alerts/predictor.js';
import { ensureTruthSocialAlertStateFiles, upsertTruthSocialHistoryPosts } from '../src/truth-social-alerts/state-store.js';
import { compactWhitespace, decodeHtmlEntities, fetchTextWithRetry } from '../src/portfolio-alerts/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function loadEnvFile(filePath, options = {}) {
  const { overrideExisting = false } = options;
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    const key = match[1];
    if (!overrideExisting && process.env[key] !== undefined) return;
    let value = match[2] || '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, '\n');
  });
}

function stripHtml(html = '') {
  return compactWhitespace(
    decodeHtmlEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')),
  );
}

export function parseArchiveTimestamp(label) {
  const match = compactWhitespace(label).match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
  );
  if (!match) return null;
  const [, monthName, day, year, hourRaw, minute, meridiem] = match;
  let hour = Number(hourRaw) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  // ponytail: archive says America/New_York; last 3 months are all EDT, so a fixed +4h to UTC is enough here.
  const timestampMs = Date.UTC(Number(year), month, Number(day), hour + 4, Number(minute), 0);
  return new Date(timestampMs).toISOString();
}

export function parseArchivePage(html) {
  const statuses = [];
  const blocks = html.match(/<div class="status"[\s\S]*?<div class="status__footer">/g) || [];
  for (const block of blocks) {
    const originalUrl = decodeHtmlEntities(
      block.match(/<a href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/\d+)"[^>]*class="status__external-link"/)?.[1] || '',
    );
    const publishedLabel = stripHtml(
      block.match(/class="status-info__meta-item">([^<]+)<\/a>\s*<\/div>/)?.[1] || '',
    );
    const publishedAt = parseArchiveTimestamp(publishedLabel);
    const bodyHtml = block.match(/<div class="status__content">([\s\S]*?)<\/div>/)?.[1] || '';
    const body = stripHtml(bodyHtml) || '[Media-only post]';
    const imageUrl = decodeHtmlEntities(
      block.match(/status-attachment--image[\s\S]*?<a href="([^"]+)"/)?.[1] || '',
    );
    const videoUrl = decodeHtmlEntities(
      block.match(/status-attachment--video[\s\S]*?<a href="([^"]+)"/)?.[1] || '',
    );
    const mediaAttachments = [
      ...(imageUrl ? [{ type: 'image', url: imageUrl, previewUrl: imageUrl }] : []),
      ...(videoUrl ? [{ type: 'video', url: videoUrl, previewUrl: videoUrl }] : []),
    ];
    const dedupeId = originalUrl.match(/\/(\d+)(?:$|[/?#])/i)?.[1] || '';
    if (!dedupeId || !publishedAt) continue;
    statuses.push(normalizeHistoryPost({
      dedupeId,
      originalId: dedupeId,
      originalUrl,
      publishedAt,
      body,
      description: bodyHtml,
      isRetruth: body.startsWith('RT:'),
      mediaAttachments,
    }, {
      source: 'trumpstruth_archive',
      fetchedAt: new Date().toISOString(),
    }));
  }

  const nextHref = decodeHtmlEntities(
    html.match(/href="([^"]*cursor[^"]*)"[^>]*>\s*Next Page/i)?.[1] || '',
  ).replace(/^https:\/\/trumpstruth\.org/, '');

  return { statuses, nextHref };
}

async function fetchArchivePage(relativeUrl) {
  const url = relativeUrl.startsWith('http') ? relativeUrl : `https://trumpstruth.org${relativeUrl}`;
  const html = await fetchTextWithRetry(url, {}, {
    timeoutMs: 20_000,
    maxRetries: 3,
    retryBackoffMs: 1_500,
    userAgent: 'Mozilla/5.0 (compatible; MarketTruthSocialArchiveBackfill/1.0)',
  });
  return parseArchivePage(html);
}

export async function main() {
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.join(projectRoot, '.env.local'), { overrideExisting: true });

  const config = buildTruthSocialAlertConfig(process.env);
  const months = Math.max(1, Number(process.env.TRUTH_SOCIAL_ARCHIVE_BACKFILL_MONTHS || 3));
  const cutoffMs = Date.now() - (months * 31 * 24 * 60 * 60 * 1000);
  const perPage = Math.max(25, Number(process.env.TRUTH_SOCIAL_ARCHIVE_PER_PAGE || 100));
  const maxPages = Math.max(1, Number(process.env.TRUTH_SOCIAL_ARCHIVE_MAX_PAGES || 50));

  await ensureTruthSocialAlertStateFiles(config);

  let nextHref = `/?sort=desc&per_page=${perPage}&query=&start_date=&end_date=&removed=include`;
  const collected = [];
  for (let page = 1; page <= maxPages && nextHref; page += 1) {
    const payload = await fetchArchivePage(nextHref);
    if (!payload.statuses.length) break;
    collected.push(...payload.statuses);
    const oldestMs = Math.min(...payload.statuses.map((item) => Date.parse(item.publishedAt || 0)).filter(Boolean));
    if (oldestMs && oldestMs < cutoffMs) {
      break;
    }
    nextHref = payload.nextHref;
  }

  const filtered = collected.filter((item) => Date.parse(item.publishedAt || 0) >= cutoffMs);
  const merged = await upsertTruthSocialHistoryPosts(config, filtered);
  const publishedTimes = filtered.map((item) => Date.parse(item.publishedAt || 0)).filter(Boolean).sort((a, b) => a - b);

  console.log(JSON.stringify({
    months,
    fetched: filtered.length,
    stored: merged.length,
    earliest: publishedTimes[0] ? new Date(publishedTimes[0]).toISOString() : null,
    latest: publishedTimes.length ? new Date(publishedTimes.at(-1)).toISOString() : null,
    historyPath: config.historyPath,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
