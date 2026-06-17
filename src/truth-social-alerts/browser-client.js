import { spawn } from 'node:child_process';

import { createLogger } from '../portfolio-alerts/utils.js';

const logger = createLogger('truth-social-browser');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createTruthSocialBrowserClient(config) {
  let child = null;
  let nextRequestId = 1;
  let readyDeferred = null;
  const pending = new Map();

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
    if (readyDeferred) {
      readyDeferred.reject(error);
      readyDeferred = null;
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'ready') {
      readyDeferred?.resolve(message);
      readyDeferred = null;
      return;
    }

    if (!message.id) {
      return;
    }

    const entry = pending.get(String(message.id));
    if (!entry) {
      return;
    }
    pending.delete(String(message.id));
    clearTimeout(entry.timeout);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    entry.reject(new Error(message.error || 'Truth Social browser bridge request failed'));
  }

  function startProcess() {
    if (child) {
      return;
    }

    readyDeferred = createDeferred();
    child = spawn(
      'python3',
      [config.browser.bridgeScriptPath],
      {
        cwd: config.projectRoot,
        env: {
          ...process.env,
          TRUTH_SOCIAL_BROWSER_BOOTSTRAP_URL: config.browser.bootstrapUrl,
          TRUTH_SOCIAL_BROWSER_HEADED: config.browser.headed ? 'true' : 'false',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch (error) {
            logger.error('Failed to parse Truth Social browser bridge message', { error: error.message });
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) {
        logger.warn('Truth Social browser bridge stderr', { message });
      }
    });

    child.on('exit', (code, signal) => {
      const error = new Error(
        `Truth Social browser bridge exited unexpectedly (${signal || code || 'unknown'})`,
      );
      child = null;
      rejectAll(error);
    });
  }

  async function ensureStarted() {
    if (child && !readyDeferred) {
      return;
    }
    startProcess();
    await readyDeferred.promise;
  }

  async function request(command, payload = {}) {
    await ensureStarted();
    const id = String(nextRequestId);
    nextRequestId += 1;
    const deferred = createDeferred();
    const timeout = setTimeout(() => {
      pending.delete(id);
      deferred.reject(new Error(`Truth Social browser bridge timed out for ${command}`));
    }, config.browser.requestTimeoutMs);
    pending.set(id, {
      ...deferred,
      timeout,
    });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    return deferred.promise;
  }

  return {
    async fetchStatuses() {
      return request('fetch_statuses', {
        acct: config.accountHandle,
        limit: config.browser.fetchLimit,
      });
    },
    async stop() {
      if (!child) {
        return;
      }
      try {
        child.stdin.end();
      } catch {
        // Best-effort shutdown only.
      }
      child.kill('SIGTERM');
      child = null;
      rejectAll(new Error('Truth Social browser bridge stopped'));
    },
  };
}
