import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPortfolioAlertRuntime } from '../src/portfolio-alerts/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function loadEnvFile(filePath, options = {}) {
  const { overrideExisting = false } = options;
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      return;
    }
    const key = match[1];
    if (!overrideExisting && process.env[key] !== undefined) {
      return;
    }
    let value = match[2] || '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, '\n');
  });
}

loadEnvFile(path.join(projectRoot, '.env'));
loadEnvFile(path.join(projectRoot, '.env.local'), { overrideExisting: true });

const runtime = createPortfolioAlertRuntime({
  env: {
    ...process.env,
    PORTFOLIO_JSON_URL: '',
  },
});

runtime.start();

const shutdown = () => {
  runtime.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
