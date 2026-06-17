import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTruthSocialChromeClient } from '../src/truth-social-alerts/chrome-client.js';
import { buildTruthSocialAlertConfig } from '../src/truth-social-alerts/config.js';
import { normalizeHistoryPost, runTruthSocialGoldBackfill } from '../src/truth-social-alerts/predictor.js';
import { ensureTruthSocialAlertStateFiles, upsertTruthSocialHistoryPosts } from '../src/truth-social-alerts/state-store.js';
import { readJsonFile } from '../src/portfolio-alerts/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

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

loadEnvFile(path.join(projectRoot, '.env'));
loadEnvFile(path.join(projectRoot, '.env.local'), { overrideExisting: true });

const config = buildTruthSocialAlertConfig(process.env);
const chromeClient = createTruthSocialChromeClient(config);

await ensureTruthSocialAlertStateFiles(config);
const posts = await runTruthSocialGoldBackfill(config, chromeClient);
const events = await readJsonFile(config.eventsPath, []);
const seededIds = [...new Set((Array.isArray(events) ? events : [])
  .filter((item) => item?.type === 'delivery' && item?.dedupeId)
  .map((item) => String(item.dedupeId)))];
const hydrated = [];
for (const statusId of seededIds) {
  if (posts.some((post) => post?.dedupeId === statusId)) {
    continue;
  }
  try {
    const status = await chromeClient.fetchStatusById(statusId);
    if (!status?.id) continue;
    hydrated.push(normalizeHistoryPost({
      dedupeId: String(status.id),
      originalId: status.id ? String(status.id) : '',
      originalUrl: status.url || '',
      link: status.url || '',
      publishedAt: status.created_at || null,
      body: status.content_text || '',
      description: status.content || '',
      isRetruth: Boolean(status.reblog),
      mediaAttachments: Array.isArray(status.media_attachments)
        ? status.media_attachments.map((media) => ({
            type: String(media?.type || ''),
            url: String(media?.url || ''),
            previewUrl: String(media?.preview_url || ''),
          }))
        : [],
    }, {
      source: 'chrome_api_status_lookup',
      fetchedAt: new Date().toISOString(),
    }));
  } catch {
    // Keep going; some historical posts may no longer resolve cleanly.
  }
}
const merged = await upsertTruthSocialHistoryPosts(config, posts.concat(hydrated));
console.log(JSON.stringify({
  fetched: posts.length,
  hydrated: hydrated.length,
  stored: merged.length,
  historyPath: config.historyPath,
}, null, 2));
