import {
  compactWhitespace,
  decodeHtmlEntities,
  fetchTextWithRetry,
  formatTimestampInZone,
} from '../portfolio-alerts/utils.js';

function decodeXmlValue(value) {
  const text = String(value || '').trim();
  const cdataMatch = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeHtmlEntities(cdataMatch ? cdataMatch[1] : text);
}

function stripTags(value) {
  return compactWhitespace(
    decodeXmlValue(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' '),
  );
}

function getTagValue(block, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? match[1] : '';
}

function normalizeBody(title, description) {
  const cleanTitle = compactWhitespace(title);
  const cleanDescription = compactWhitespace(description);
  const titleIsPlaceholder = /^\[No Title\]/i.test(cleanTitle);
  if (cleanTitle && !titleIsPlaceholder) {
    return cleanTitle;
  }
  if (cleanDescription) {
    return cleanDescription;
  }
  if (cleanTitle && !titleIsPlaceholder) {
    return cleanTitle;
  }
  return '[Media-only post]';
}

function parsePublishedAt(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = compactWhitespace(String(value));
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const relativeMatch = text.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const multipliers = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    const deltaMs = amount * multipliers[unit];
    const relativeDate = new Date(Date.now() - deltaMs);
    return Number.isNaN(relativeDate.getTime()) ? null : relativeDate;
  }

  const monthDayMatch = text.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i,
  );
  if (monthDayMatch) {
    const [, monthToken, dayToken, yearToken] = monthDayMatch;
    const monthLookup = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      sept: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const year = yearToken ? Number(yearToken) : new Date().getFullYear();
    const month = monthLookup[monthToken.toLowerCase()];
    const day = Number(dayToken);
    const calendarDate = new Date(Date.UTC(year, month, day));
    return Number.isNaN(calendarDate.getTime()) ? null : calendarDate;
  }

  return null;
}

export function parseTruthSocialFeed(xmlText = '') {
  const channelPubDate = parsePublishedAt(stripTags(getTagValue(xmlText, 'pubDate')));
  const itemBlocks = [...String(xmlText).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);

  const items = itemBlocks.map((block, index) => {
    const title = stripTags(getTagValue(block, 'title'));
    const description = stripTags(getTagValue(block, 'description'));
    const guid = stripTags(getTagValue(block, 'guid'));
    const link = stripTags(getTagValue(block, 'link'));
    const originalUrl = stripTags(getTagValue(block, 'truth:originalUrl'));
    const originalId = stripTags(getTagValue(block, 'truth:originalId'));
    const pubDateRaw = stripTags(getTagValue(block, 'pubDate'));
    const publishedAtDate = parsePublishedAt(pubDateRaw);
    const body = normalizeBody(title, description);
    const dedupeId = originalId || guid || originalUrl || link || `item:${index}`;
    const isRetruth = /^RT\s+@/i.test(title);
    return {
      title,
      description,
      body,
      guid,
      link,
      originalUrl,
      originalId,
      dedupeId,
      isRetruth,
      pubDateRaw,
      publishedAt: publishedAtDate ? publishedAtDate.toISOString() : null,
      publishedAtDate,
    };
  });

  return {
    channel: {
      pubDate: channelPubDate ? channelPubDate.toISOString() : null,
    },
    items,
  };
}

function normalizeTruthSocialStatuses(statuses = []) {
  return {
    channel: {
      pubDate: null,
    },
    items: statuses.map((item, index) => {
      const publishedAtDate = parsePublishedAt(item.created_at);
      const body = compactWhitespace(item.content_text || stripTags(item.content || ''));
      const dedupeId = String(item.id || item.url || `status:${index}`);
      return {
        title: body,
        description: item.content || '',
        body: body || '[Media-only post]',
        guid: item.url || dedupeId,
        link: item.url || '',
        originalUrl: item.url || '',
        originalId: item.id ? String(item.id) : dedupeId,
        dedupeId,
        isRetruth: Boolean(item.reblog),
        pubDateRaw: item.created_at || '',
        publishedAt: publishedAtDate ? publishedAtDate.toISOString() : null,
        publishedAtDate,
        mediaUrls: Array.isArray(item.media_urls) ? item.media_urls.filter(Boolean) : [],
        mediaAttachments: Array.isArray(item.media_attachments)
          ? item.media_attachments
              .map((attachment) => ({
                type: String(attachment?.type || '').toLowerCase(),
                url: String(attachment?.url || ''),
                previewUrl: String(attachment?.preview_url || ''),
              }))
              .filter((attachment) => attachment.url || attachment.previewUrl)
          : [],
      };
    }),
  };
}

export async function fetchTruthSocialFeed(config, services = {}) {
  if (config.source === 'browser' || config.source === 'chrome' || config.source === 'chrome_api') {
    const client = (config.source === 'chrome' || config.source === 'chrome_api')
      ? services.chromeClient
      : services.browserClient;
    const statusesPayload = await client?.fetchStatuses();
    if (!statusesPayload || !Array.isArray(statusesPayload.statuses)) {
      throw new Error(`Truth Social ${config.source} client returned no statuses`);
    }
    return normalizeTruthSocialStatuses(statusesPayload.statuses);
  }

  const requestUrl = new URL(config.rssUrl);
  requestUrl.searchParams.set('_ts', String(Date.now()));
  const xml = await fetchTextWithRetry(
    requestUrl,
    {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      },
    },
    {
      timeoutMs: config.fetch.timeoutMs,
      maxRetries: config.fetch.maxRetries,
      retryBackoffMs: config.fetch.retryBackoffMs,
      userAgent: 'Mozilla/5.0 (compatible; MarketTruthSocialAlerts/1.0; +https://markets.healthymealspot.com)',
    },
  );
  return parseTruthSocialFeed(xml);
}

export function formatTruthSocialPostMessage(post, config, now = new Date()) {
  const publishedAt = post.publishedAtDate || (post.publishedAt ? new Date(post.publishedAt) : null);
  const publishedLabel = publishedAt
    ? formatTimestampInZone(publishedAt, config.userTimezone)
    : 'Unknown time';
  const fetchedLabel = formatTimestampInZone(now, config.userTimezone);
  const lines = [
    'Trump posted on Truth Social',
    '',
    `Published: ${publishedLabel}`,
    `Fetched: ${fetchedLabel}`,
    '',
    post.body || '[Media-only post]',
  ];
  const originalUrl = post.originalUrl || post.link || '';
  if (originalUrl) {
    lines.push('', `Original: ${originalUrl}`);
  }
  return lines.join('\n');
}
