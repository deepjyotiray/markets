import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  fetchTruthSocialFeed,
  formatTruthSocialPostMessage,
  parseTruthSocialFeed,
} from '../src/truth-social-alerts/feed.js';
import {
  fetchOpenAiSemanticPrediction,
  normalizeOpenAiUsage,
  persistGoldPredictionOutcome,
} from '../src/truth-social-alerts/predictor.js';
import {
  classifyGoldImpactPct,
  createTruthSocialAlertRuntime,
  formatGoldImpactMessage,
} from '../src/truth-social-alerts/runtime.js';
import { buildTruthSocialAlertConfig } from '../src/truth-social-alerts/config.js';
import { buildTruthSocialPostFingerprint } from '../src/truth-social-alerts/state-store.js';
import { sendWhatsappAlert } from '../src/portfolio-alerts/whatsapp.js';

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:truth="https://truthsocial.com/ns">
  <channel>
    <title><![CDATA[Trump's Truth - Latest Posts]]></title>
    <pubDate>Thu, 11 Jun 2026 18:00:34 +0000</pubDate>
    <item>
      <title><![CDATA[First post]]></title>
      <link>https://trumpstruth.org/statuses/101</link>
      <description><![CDATA[<p>First post</p>]]></description>
      <guid>https://trumpstruth.org/statuses/101</guid>
      <pubDate>Thu, 11 Jun 2026 17:28:48 +0000</pubDate>
      <truth:originalUrl>https://truthsocial.com/@realDonaldTrump/111</truth:originalUrl>
      <truth:originalId>111</truth:originalId>
    </item>
    <item>
      <title><![CDATA[RT @realDonaldTrump]]></title>
      <link>https://trumpstruth.org/statuses/102</link>
      <description><![CDATA[<p>RT <span class="h-card"><a href="https://truthsocial.com/@realDonaldTrump">@realDonaldTrump</a></span></p>]]></description>
      <guid>https://trumpstruth.org/statuses/102</guid>
      <pubDate>Thu, 11 Jun 2026 16:28:48 +0000</pubDate>
      <truth:originalUrl>https://truthsocial.com/@realDonaldTrump/112</truth:originalUrl>
      <truth:originalId>112</truth:originalId>
    </item>
    <item>
      <title><![CDATA[[No Title] - Post from June 11, 2026]]></title>
      <link>https://trumpstruth.org/statuses/103</link>
      <description><![CDATA[<p></p>]]></description>
      <guid>https://trumpstruth.org/statuses/103</guid>
      <pubDate>Thu, 11 Jun 2026 15:28:48 +0000</pubDate>
      <truth:originalUrl>https://truthsocial.com/@realDonaldTrump/113</truth:originalUrl>
      <truth:originalId>113</truth:originalId>
    </item>
    <item>
      <title><![CDATA[Fallback guid item]]></title>
      <link>https://trumpstruth.org/statuses/104</link>
      <description><![CDATA[<p>Fallback guid item</p>]]></description>
      <guid>https://trumpstruth.org/statuses/104</guid>
      <pubDate>Thu, 11 Jun 2026 14:28:48 +0000</pubDate>
    </item>
  </channel>
</rss>`;

function buildFeed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:truth="https://truthsocial.com/ns">
  <channel>
    <title><![CDATA[Trump's Truth - Latest Posts]]></title>
    <pubDate>Thu, 11 Jun 2026 18:00:34 +0000</pubDate>
    ${items.join('\n')}
  </channel>
</rss>`;
}

function buildItem({ title, description, guid, pubDate, originalUrl, originalId }) {
  return `<item>
    <title><![CDATA[${title}]]></title>
    <link>${guid}</link>
    <description><![CDATA[${description}]]></description>
    <guid>${guid}</guid>
    <pubDate>${pubDate}</pubDate>
    ${originalUrl ? `<truth:originalUrl>${originalUrl}</truth:originalUrl>` : ''}
    ${originalId ? `<truth:originalId>${originalId}</truth:originalId>` : ''}
  </item>`;
}

async function createTempPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'truth-social-alerts-'));
  return {
    root,
    statePath: path.join(root, 'state.json'),
    eventsPath: path.join(root, 'events.json'),
  };
}

function isFeedRequest(url) {
  return String(url).startsWith('https://example.test/feed.xml');
}

test('normalizeOpenAiUsage keeps normalized token totals', () => {
  assert.deepEqual(
    normalizeOpenAiUsage({
      input_tokens: 120,
      output_tokens: 30,
    }),
    {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      raw: {
        input_tokens: 120,
        output_tokens: 30,
      },
    },
  );
});

test('fetchOpenAiSemanticPrediction appends an openai usage event with normalized tokens', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  global.fetch = async () => new Response(JSON.stringify({
    usage: {
      input_tokens: 210,
      output_tokens: 45,
    },
    output: [{
      content: [{
        type: 'output_text',
        text: JSON.stringify({
          gold_relevance_score: 7.2,
          directional_tilt_pct: 0.08,
          confidence: 'medium',
          tags: ['macro'],
          summary: 'Test summary',
        }),
      }],
    }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  t.after(() => {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
  });

  const config = buildTruthSocialAlertConfig({
    OPENAI_API_KEY: 'test-key',
    TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
  });
  const prediction = await fetchOpenAiSemanticPrediction({
    dedupeId: 'post-123',
    originalUrl: 'https://truthsocial.com/@realDonaldTrump/post-123',
    body: 'Gold and tariffs',
  }, config);

  assert.equal(prediction.source, 'openai_fallback');
  const events = JSON.parse(await fs.readFile(paths.eventsPath, 'utf8'));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'openai_usage');
  assert.equal(events[0].status, 'ok');
  assert.equal(events[0].dedupeId, 'post-123');
  assert.equal(events[0].usage.inputTokens, 210);
  assert.equal(events[0].usage.outputTokens, 45);
  assert.equal(events[0].usage.totalTokens, 255);
  assert.equal(events[0].rawUsage.input_tokens, 210);
});

test('persistGoldPredictionOutcome merges horizon outcomes instead of overwriting', async (t) => {
  const paths = await createTempPaths();
  const predictionsPath = path.join(paths.root, 'predictions.json');
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  await fs.writeFile(predictionsPath, JSON.stringify([
    {
      dedupeId: 'post-merge',
      outcomes: {
        '5m': { direction: 'up', correct: true },
      },
    },
  ], null, 2));

  const config = buildTruthSocialAlertConfig({
    TRUTH_SOCIAL_GOLD_PREDICTIONS_PATH: predictionsPath,
  });
  await persistGoldPredictionOutcome(config, 'post-merge', {
    dedupeId: 'post-merge',
    outcomes: {
      '15m': { direction: 'down', correct: false },
    },
    outcome: { minutes: 15 },
  });

  const saved = JSON.parse(await fs.readFile(predictionsPath, 'utf8'));
  assert.deepEqual(saved[0].outcomes, {
    '5m': { direction: 'up', correct: true },
    '15m': { direction: 'down', correct: false },
  });
});

test('parseTruthSocialFeed parses standard, retruth, media-only, and guid-fallback items', () => {
  const parsed = parseTruthSocialFeed(SAMPLE_FEED);
  assert.equal(parsed.items.length, 4);

  assert.equal(parsed.items[0].body, 'First post');
  assert.equal(parsed.items[0].dedupeId, '111');

  assert.equal(parsed.items[1].isRetruth, true);
  assert.equal(parsed.items[1].dedupeId, '112');

  assert.equal(parsed.items[2].body, '[Media-only post]');
  assert.equal(parsed.items[2].dedupeId, '113');

  assert.equal(parsed.items[3].dedupeId, 'https://trumpstruth.org/statuses/104');
});

test('buildTruthSocialPostFingerprint strips retruth prefix so same text dedupes', () => {
  assert.equal(
    buildTruthSocialPostFingerprint({
      body: 'RT @realDonaldTrump Same message here',
    }),
    buildTruthSocialPostFingerprint({
      body: 'Same message here',
    }),
  );
  assert.equal(buildTruthSocialPostFingerprint({ body: '[Media-only post]' }), null);
});

test('runtime seeds on first boot without sending backfill', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(buildFeed([
      buildItem({
        title: 'Newest',
        description: '<p>Newest</p>',
        guid: 'https://trumpstruth.org/statuses/201',
        pubDate: 'Thu, 11 Jun 2026 18:00:34 +0000',
        originalUrl: 'https://truthsocial.com/@realDonaldTrump/201',
        originalId: '201',
      }),
      buildItem({
        title: 'Older',
        description: '<p>Older</p>',
        guid: 'https://trumpstruth.org/statuses/200',
        pubDate: 'Thu, 11 Jun 2026 17:00:34 +0000',
        originalUrl: 'https://truthsocial.com/@realDonaldTrump/200',
        originalId: '200',
      }),
    ]), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'seed_only',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      WHATSAPP_AGENT_SECRET: 'secret',
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result.ok, true);
  assert.equal(result.seeded, true);
  assert.equal(calls.length, 1);

  const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'));
  assert.equal(state.lastSeenId, '201');
  assert.deepEqual(state.deliveredIds, ['201', '200']);
  assert.equal(state.bootstrap.mode, 'seed_only');
  assert.match(state.bootstrap.completedAt, /T/);
  assert.equal(state.bootstrap.lastBootstrapSentId, null);
});

test('runtime status includes recent OpenAI usage events', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  await fs.writeFile(paths.eventsPath, JSON.stringify([
    {
      type: 'delivery',
      dedupeId: 'ignore-me',
      recordedAt: '2026-06-15T01:00:00.000Z',
    },
    {
      type: 'openai_usage',
      status: 'ok',
      dedupeId: 'post-456',
      originalUrl: 'https://truthsocial.com/@realDonaldTrump/post-456',
      model: 'gpt-5-mini',
      durationMs: 812,
      usage: {
        inputTokens: 90,
        outputTokens: 15,
        totalTokens: 105,
      },
      rawUsage: {
        input_tokens: 90,
        output_tokens: 15,
        total_tokens: 105,
      },
      recordedAt: '2026-06-15T01:05:00.000Z',
    },
  ], null, 2));

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
    },
  });

  const status = runtime.getStatus();
  assert.equal(Array.isArray(status.recentUsage), true);
  assert.equal(status.recentUsage.length, 1);
  assert.equal(status.recentUsage[0].dedupeId, 'post-456');
  assert.equal(status.recentUsage[0].usage.totalTokens, 105);
});

test('browser-scraped statuses with missing created_at do not fall back to 1970', async () => {
  const config = buildTruthSocialAlertConfig({
    TRUTH_SOCIAL_ALERT_SOURCE: 'chrome',
    TRUTH_SOCIAL_ALERT_USER_TIMEZONE: 'Asia/Kolkata',
  });
  const feed = await fetchTruthSocialFeed(config, {
    chromeClient: {
      async fetchStatuses() {
        return {
          account_id: null,
          statuses: [
            {
              id: '116738087808561603',
              created_at: null,
              url: 'https://truthsocial.com/@realDonaldTrump/posts/116738087808561603',
              content_text: 'Example post from Chrome scrape',
              content: 'Example post from Chrome scrape',
              media_urls: ['https://cdn.example.test/post-image.jpg'],
              reblog: null,
            },
          ],
        };
      },
    },
  });

  assert.equal(feed.items[0].publishedAt, null);
  assert.equal(feed.items[0].publishedAtDate, null);
  assert.deepEqual(feed.items[0].mediaUrls, ['https://cdn.example.test/post-image.jpg']);

  const message = formatTruthSocialPostMessage(feed.items[0], config, new Date('2026-06-12T17:03:37.000Z'));
  assert.match(message, /Published: Unknown time/);
  assert.doesNotMatch(message, /1970-01-01/);
});

test('chrome_api source uses chrome client statuses payload', async () => {
  const config = buildTruthSocialAlertConfig({
    TRUTH_SOCIAL_ALERT_SOURCE: 'chrome_api',
  });
  let chromeCalls = 0;
  const feed = await fetchTruthSocialFeed(config, {
    chromeClient: {
      async fetchStatuses() {
        chromeCalls += 1;
        return {
          account_id: 'acct-1',
          statuses: [
            {
              id: '116800000000000001',
              created_at: '2026-06-13T17:53:37.534Z',
              url: 'https://truthsocial.com/@realDonaldTrump/posts/116800000000000001',
              content: '<p>Chrome API post</p>',
              content_text: 'Chrome API post',
              media_urls: ['https://cdn.example.test/chrome-api.jpg'],
              media_attachments: [
                {
                  type: 'image',
                  url: 'https://cdn.example.test/chrome-api.jpg',
                  preview_url: 'https://cdn.example.test/chrome-api-preview.jpg',
                },
              ],
              reblog: null,
            },
          ],
        };
      },
    },
  });

  assert.equal(chromeCalls, 1);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].body, 'Chrome API post');
  assert.equal(feed.items[0].publishedAt, '2026-06-13T17:53:37.534Z');
  assert.deepEqual(feed.items[0].mediaUrls, ['https://cdn.example.test/chrome-api.jpg']);
  assert.deepEqual(feed.items[0].mediaAttachments, [
    {
      type: 'image',
      url: 'https://cdn.example.test/chrome-api.jpg',
      previewUrl: 'https://cdn.example.test/chrome-api-preview.jpg',
    },
  ]);
});

test('chrome-scraped relative timestamps are converted into approximate publish times', async () => {
  const config = buildTruthSocialAlertConfig({
    TRUTH_SOCIAL_ALERT_SOURCE: 'chrome',
    TRUTH_SOCIAL_ALERT_USER_TIMEZONE: 'Asia/Kolkata',
  });
  const beforeFetch = Date.now();
  const feed = await fetchTruthSocialFeed(config, {
    chromeClient: {
      async fetchStatuses() {
        return {
          account_id: null,
          statuses: [
            {
              id: '116743112402160988',
              created_at: '3h',
              url: 'https://truthsocial.com/@realDonaldTrump/posts/116743112402160988',
              content_text: 'Donald J. Trump @realDonaldTrump 3h Example post from Chrome scrape',
              content: 'Donald J. Trump @realDonaldTrump 3h Example post from Chrome scrape',
              media_urls: [],
              reblog: null,
            },
          ],
        };
      },
    },
  });
  const afterFetch = Date.now();

  assert.ok(feed.items[0].publishedAt);
  assert.ok(feed.items[0].publishedAtDate instanceof Date);

  const publishedTime = feed.items[0].publishedAtDate.getTime();
  assert.ok(publishedTime <= afterFetch - (2 * 60 * 60 * 1000));
  assert.ok(publishedTime >= beforeFetch - (4 * 60 * 60 * 1000));

  const message = formatTruthSocialPostMessage(feed.items[0], config, new Date('2026-06-13T17:23:13.000Z'));
  assert.doesNotMatch(message, /Published: Unknown time/);
});

test('truth social config defaults prefer larger fetch windows for bursty posting', () => {
  const config = buildTruthSocialAlertConfig({});
  assert.equal(config.browser.fetchLimit, 100);
  assert.equal(config.chrome.fetchLimit, 100);
});

test('truth social config accepts chrome_api as a switchable source', () => {
  const config = buildTruthSocialAlertConfig({
    TRUTH_SOCIAL_ALERT_SOURCE: 'chrome_api',
  });
  assert.equal(config.source, 'chrome_api');
});

test('gold impact helper classifies and formats short-term move direction', () => {
  assert.equal(classifyGoldImpactPct(0.12), 'up');
  assert.equal(classifyGoldImpactPct(-0.08), 'down');
  assert.equal(classifyGoldImpactPct(0.01), 'flat');

  const config = buildTruthSocialAlertConfig({
    TRUTH_SOCIAL_ALERT_USER_TIMEZONE: 'Asia/Kolkata',
  });
  const message = formatGoldImpactMessage({
    post: {
      originalUrl: 'https://truthsocial.com/@realDonaldTrump/posts/116749461889797645',
    },
    baselineQuote: { price: 3400 },
    followupQuote: { price: 3404.25 },
    config,
    checkedAt: new Date('2026-06-14T16:43:52.199Z'),
  });
  assert.match(message, /Gold next 5m bias after Trump Truth Social post: up/);
  assert.match(message, /Baseline: 3400.00/);
  assert.match(message, /Now: 3404.25/);
  assert.match(message, /Change: \+4.25 \(\+0.13%\)/);
});

test('whatsapp sender includes mediaPath when attachment is provided', async (t) => {
  const sendPayloads = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url) === 'http://127.0.0.1:3001/send') {
      const payload = JSON.parse(options.body);
      sendPayloads.push(payload);
      return new Response(JSON.stringify({ ok: true, messageRef: { id: 'media-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await sendWhatsappAlert({
    dryRun: false,
    whatsapp: {
      recipient: '+10000000000',
      agentUrl: 'http://127.0.0.1:3001/send',
      agentSecret: 'secret',
    },
  }, 'test message', { mediaPath: '/tmp/example.jpg' });

  assert.equal(sendPayloads.length, 1);
  assert.equal(sendPayloads[0].mediaPath, '/tmp/example.jpg');
  assert.equal(sendPayloads[0].message, 'test message');
});

test('runtime send_latest_once bootstrap sends exactly newest item once', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (isFeedRequest(url)) {
      return new Response(buildFeed([
        buildItem({
          title: 'Newest bootstrap post',
          description: '<p>Newest bootstrap post</p>',
          guid: 'https://trumpstruth.org/statuses/211',
          pubDate: 'Thu, 11 Jun 2026 18:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/211',
          originalId: '211',
        }),
        buildItem({
          title: 'Older bootstrap post',
          description: '<p>Older bootstrap post</p>',
          guid: 'https://trumpstruth.org/statuses/210',
          pubDate: 'Thu, 11 Jun 2026 17:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/210',
          originalId: '210',
        }),
      ]), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (String(url) === 'http://127.0.0.1:3001/send') {
      const payload = JSON.parse(options.body);
      sentMessages.push(payload.message);
      return new Response(JSON.stringify({ ok: true, messageRef: { id: 'bootstrap-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'send_latest_once',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000,+10000000001',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
      WHATSAPP_AGENT_SECRET: 'secret',
    },
  });

  const firstRun = await runtime.runCycle();
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.deliveredCount, 1);
  assert.equal(firstRun.recipientCount, 2);
  assert.equal(firstRun.bootstrapMode, 'send_latest_once');
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[0], /Newest bootstrap post/);
  assert.match(sentMessages[1], /Newest bootstrap post/);

  const secondRun = await runtime.runCycle();
  assert.equal(secondRun.ok, true);
  assert.equal(secondRun.deliveredCount, 0);
  assert.equal(sentMessages.length, 2);

  const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'));
  assert.equal(state.lastSeenId, '211');
  assert.equal(state.bootstrap.mode, 'send_latest_once');
  assert.equal(state.bootstrap.lastBootstrapSentId, '211');
  assert.match(state.bootstrap.completedAt, /T/);
  assert.match(state.bootstrap.sentLatestAt, /T/);
});

test('runtime replay_unseen bootstrap sends all initial feed items in chronological order', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (isFeedRequest(url)) {
      return new Response(buildFeed([
        buildItem({
          title: 'Newest replay post',
          description: '<p>Newest replay post</p>',
          guid: 'https://trumpstruth.org/statuses/223',
          pubDate: 'Thu, 11 Jun 2026 19:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/223',
          originalId: '223',
        }),
        buildItem({
          title: 'Middle replay post',
          description: '<p>Middle replay post</p>',
          guid: 'https://trumpstruth.org/statuses/222',
          pubDate: 'Thu, 11 Jun 2026 18:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/222',
          originalId: '222',
        }),
        buildItem({
          title: 'Oldest replay post',
          description: '<p>Oldest replay post</p>',
          guid: 'https://trumpstruth.org/statuses/221',
          pubDate: 'Thu, 11 Jun 2026 17:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/221',
          originalId: '221',
        }),
      ]), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (String(url) === 'http://127.0.0.1:3001/send') {
      const payload = JSON.parse(options.body);
      sentMessages.push(payload.message);
      return new Response(JSON.stringify({ ok: true, messageRef: { id: `replay-${sentMessages.length}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'replay_unseen',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000,+10000000001',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
      WHATSAPP_AGENT_SECRET: 'secret',
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result.ok, true);
  assert.equal(result.deliveredCount, 3);
  assert.equal(result.bootstrapMode, 'replay_unseen');
  assert.equal(sentMessages.length, 6);
  assert.match(sentMessages[0], /Oldest replay post/);
  assert.match(sentMessages[2], /Middle replay post/);
  assert.match(sentMessages[4], /Newest replay post/);
});

test('runtime delivers new items once and in chronological order', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (isFeedRequest(url)) {
      return new Response(buildFeed([
        buildItem({
          title: 'Newest',
          description: '<p>Newest</p>',
          guid: 'https://trumpstruth.org/statuses/303',
          pubDate: 'Thu, 11 Jun 2026 19:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/303',
          originalId: '303',
        }),
        buildItem({
          title: 'Middle',
          description: '<p>Middle</p>',
          guid: 'https://trumpstruth.org/statuses/302',
          pubDate: 'Thu, 11 Jun 2026 18:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/302',
          originalId: '302',
        }),
        buildItem({
          title: 'Seen before',
          description: '<p>Seen before</p>',
          guid: 'https://trumpstruth.org/statuses/301',
          pubDate: 'Thu, 11 Jun 2026 17:00:34 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/301',
          originalId: '301',
        }),
      ]), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (String(url) === 'http://127.0.0.1:3001/send') {
      const payload = JSON.parse(options.body);
      sentMessages.push(payload.message);
      return new Response(JSON.stringify({ ok: true, messageRef: { id: `m-${sentMessages.length}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await fs.writeFile(paths.statePath, JSON.stringify({
    version: 1,
    updatedAt: null,
    seededAt: '2026-06-11T17:00:40.000Z',
    lastSeenId: '301',
    lastSeenPublishedAt: '2026-06-11T17:00:34.000Z',
    deliveredIds: ['301'],
    lastDeliveryAt: null,
    bootstrap: {
      mode: 'send_latest_once',
      completedAt: '2026-06-11T17:00:40.000Z',
      sentLatestAt: '2026-06-11T17:00:40.000Z',
      lastBootstrapSentId: '301',
    },
  }, null, 2));
  await fs.writeFile(paths.eventsPath, '[]');

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'send_latest_once',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000,+10000000001',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
      WHATSAPP_AGENT_SECRET: 'secret',
    },
  });

  const firstRun = await runtime.runCycle();
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.deliveredCount, 2);
  assert.equal(sentMessages.length, 4);
  assert.match(sentMessages[0], /Middle/);
  assert.match(sentMessages[2], /Newest/);

  const secondRun = await runtime.runCycle();
  assert.equal(secondRun.ok, true);
  assert.equal(secondRun.deliveredCount, 0);
  assert.equal(sentMessages.length, 4);
});

test('runtime delivers missed sibling posts that appear below an already-seen newest post', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (isFeedRequest(url)) {
      return new Response(buildFeed([
        buildItem({
          title: 'Already seen newest',
          description: '<p>Already seen newest</p>',
          guid: 'https://trumpstruth.org/statuses/403',
          pubDate: 'Fri, 12 Jun 2026 01:49:56 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/403',
          originalId: '403',
        }),
        buildItem({
          title: 'Missed sibling one',
          description: '<p>Missed sibling one</p>',
          guid: 'https://trumpstruth.org/statuses/402',
          pubDate: 'Fri, 12 Jun 2026 01:49:39 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/402',
          originalId: '402',
        }),
        buildItem({
          title: 'Missed sibling two',
          description: '<p>Missed sibling two</p>',
          guid: 'https://trumpstruth.org/statuses/401',
          pubDate: 'Fri, 12 Jun 2026 01:49:15 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/401',
          originalId: '401',
        }),
      ]), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (String(url) === 'http://127.0.0.1:3001/send') {
      const payload = JSON.parse(options.body);
      sentMessages.push(payload.message);
      return new Response(JSON.stringify({ ok: true, messageRef: { id: `missed-${sentMessages.length}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await fs.writeFile(paths.statePath, JSON.stringify({
    version: 1,
    updatedAt: null,
    seededAt: '2026-06-12T01:50:00.000Z',
    lastSeenId: '403',
    lastSeenPublishedAt: '2026-06-12T01:49:56.000Z',
    deliveredIds: ['403'],
    lastDeliveryAt: '2026-06-12T01:50:00.000Z',
    bootstrap: {
      mode: 'send_latest_once',
      completedAt: '2026-06-12T01:50:00.000Z',
      sentLatestAt: '2026-06-12T01:50:00.000Z',
      lastBootstrapSentId: '403',
    },
  }, null, 2));
  await fs.writeFile(paths.eventsPath, '[]');

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'send_latest_once',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
      WHATSAPP_AGENT_SECRET: 'secret',
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result.ok, true);
  assert.equal(result.deliveredCount, 2);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[0], /Missed sibling two/);
  assert.match(sentMessages[1], /Missed sibling one/);
});

test('runtime skips same-body retruth duplicates with new ids', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (isFeedRequest(url)) {
      return new Response(buildFeed([
        buildItem({
          title: 'Fresh unique post',
          description: '<p>Fresh unique post</p>',
          guid: 'https://trumpstruth.org/statuses/503',
          pubDate: 'Fri, 12 Jun 2026 01:50:56 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/503',
          originalId: '503',
        }),
        buildItem({
          title: 'RT @realDonaldTrump Already sent message',
          description: '<p>RT <span class="h-card"><a href="https://truthsocial.com/@realDonaldTrump">@realDonaldTrump</a></span> Already sent message</p>',
          guid: 'https://trumpstruth.org/statuses/502',
          pubDate: 'Fri, 12 Jun 2026 01:49:56 +0000',
          originalUrl: 'https://truthsocial.com/@realDonaldTrump/502',
          originalId: '502',
        }),
      ]), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (String(url) === 'http://127.0.0.1:3001/send') {
      const payload = JSON.parse(options.body);
      sentMessages.push(payload.message);
      return new Response(JSON.stringify({ ok: true, messageRef: { id: `dup-${sentMessages.length}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await fs.writeFile(paths.statePath, JSON.stringify({
    version: 1,
    updatedAt: null,
    seededAt: '2026-06-12T01:50:00.000Z',
    lastSeenId: '501',
    lastSeenPublishedAt: '2026-06-12T01:48:00.000Z',
    deliveredIds: ['501'],
    deliveredFingerprints: [buildTruthSocialPostFingerprint({ body: 'Already sent message' })],
    lastDeliveryAt: '2026-06-12T01:50:00.000Z',
    bootstrap: {
      mode: 'send_latest_once',
      completedAt: '2026-06-12T01:50:00.000Z',
      sentLatestAt: '2026-06-12T01:50:00.000Z',
      lastBootstrapSentId: '501',
    },
  }, null, 2));
  await fs.writeFile(paths.eventsPath, '[]');

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'send_latest_once',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
      WHATSAPP_AGENT_SECRET: 'secret',
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result.ok, true);
  assert.equal(result.deliveredCount, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Fresh unique post/);
});

test('runtime keeps state intact when feed fetch fails', async (t) => {
  const paths = await createTempPaths();
  t.after(async () => {
    await fs.rm(paths.root, { recursive: true, force: true });
  });

  const baselineState = {
    version: 1,
    updatedAt: null,
    seededAt: '2026-06-11T17:00:40.000Z',
    lastSeenId: '401',
    lastSeenPublishedAt: '2026-06-11T17:00:34.000Z',
    deliveredIds: ['401'],
    lastDeliveryAt: null,
    bootstrap: {
      mode: 'send_latest_once',
      completedAt: '2026-06-11T17:00:40.000Z',
      sentLatestAt: '2026-06-11T17:00:40.000Z',
      lastBootstrapSentId: '401',
    },
  };
  await fs.writeFile(paths.statePath, JSON.stringify(baselineState, null, 2));
  await fs.writeFile(paths.eventsPath, '[]');

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('feed down');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'true',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'send_latest_once',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000',
      TRUTH_SOCIAL_ALERT_STATE_PATH: paths.statePath,
      TRUTH_SOCIAL_ALERT_EVENTS_PATH: paths.eventsPath,
      TRUTH_SOCIAL_RSS_URL: 'https://example.test/feed.xml',
      TRUTH_SOCIAL_ALERT_FETCH_RETRIES: '1',
      TRUTH_SOCIAL_ALERT_FETCH_RETRY_BACKOFF_MS: '1',
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result.ok, false);
  assert.match(result.error, /feed down/);

  const stateAfter = JSON.parse(await fs.readFile(paths.statePath, 'utf8'));
  assert.equal(stateAfter.lastSeenId, baselineState.lastSeenId);
  assert.deepEqual(stateAfter.deliveredIds, baselineState.deliveredIds);
});

test('runtime status exposes bootstrap mode and completion metadata', async () => {
  const runtime = createTruthSocialAlertRuntime({
    env: {
      TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
      TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
      TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'send_latest_once',
      TRUTH_SOCIAL_ALERT_RECIPIENT: '+10000000000',
      WHATSAPP_AGENT_SECRET: 'secret',
    },
  });

  runtime.status.lastBootstrapCompletedAt = '2026-06-12T01:00:00.000Z';
  const status = runtime.getStatus();
  assert.equal(status.config.bootstrapMode, 'send_latest_once');
  assert.equal(status.bootstrap.mode, 'send_latest_once');
  assert.equal(status.bootstrap.completedAt, '2026-06-12T01:00:00.000Z');
  assert.equal(status.config.recipientCount, 1);
});
