import { createLogger } from './utils.js';

const logger = createLogger('whatsapp');

export async function sendWhatsappAlert(config, message, options = {}) {
  const payload = {
    phone: config.whatsapp.recipient,
    message,
    threadId: options.threadId || null,
    quotedMessage: options.quotedMessage || null,
    mediaPath: options.mediaPath || null,
  };

  if (config.dryRun) {
    logger.info('Dry-run alert', { threadId: options.threadId, preview: message.split('\n')[0] });
    return { ok: true, dryRun: true, messageRef: null };
  }

  if (!config.whatsapp.recipient || !config.whatsapp.agentSecret) {
    throw new Error('WhatsApp recipient or agent secret is not configured');
  }

  const response = await fetch(config.whatsapp.agentUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-secret': config.whatsapp.agentSecret,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(parsed.error || `WhatsApp agent returned ${response.status}`);
  }
  return parsed;
}
