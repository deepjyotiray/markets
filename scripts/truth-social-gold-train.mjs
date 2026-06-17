import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTruthSocialAlertConfig } from '../src/truth-social-alerts/config.js';
import { rebuildTruthSocialGoldTrainingData, runTruthSocialGoldRetrain } from '../src/truth-social-alerts/predictor.js';
import { ensureTruthSocialAlertStateFiles } from '../src/truth-social-alerts/state-store.js';

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
await ensureTruthSocialAlertStateFiles(config);
const rows = await rebuildTruthSocialGoldTrainingData(config);
const metadata = await runTruthSocialGoldRetrain(config);
console.log(JSON.stringify({
  rows: rows.length,
  metadata,
}, null, 2));
