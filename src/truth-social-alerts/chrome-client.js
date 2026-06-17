import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error((stderr || stdout || `osascript exited with ${code}`).trim()));
    });
    child.stdin.end(script);
  });
}

function normalizeAppleScriptError(error) {
  const message = String(error?.message || error || '');
  if (message.includes('Executing JavaScript through AppleScript is turned off')) {
    return new Error(
      'Chrome AppleScript JavaScript is disabled. Enable View > Developer > Allow JavaScript from Apple Events in Google Chrome.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function buildFindTabScript(handle) {
  return `
set targetPrefix to "https://truthsocial.com/@" & "${handle}"
tell application "Google Chrome"
  repeat with windowIndex from 1 to count of windows
    repeat with tabIndex from 1 to count of tabs of window windowIndex
      set tabRef to tab tabIndex of window windowIndex
      set tabUrl to URL of tabRef
      if tabUrl starts with targetPrefix then
        return (windowIndex as text) & (ASCII character 9) & (tabIndex as text) & (ASCII character 9) & tabUrl & (ASCII character 9) & (title of tabRef)
      end if
    end repeat
  end repeat
end tell
return ""
`;
}

function buildOpenTabScript(handle) {
  return `
set targetUrl to "https://truthsocial.com/@" & "${handle}"
tell application "Google Chrome"
  activate
  if (count of windows) is 0 then
    make new window
    delay 0.25
  end if
  set URL of active tab of front window to targetUrl
  set tabRef to active tab of front window
  repeat 120 times
    if loading of tabRef is false then
      exit repeat
    end if
    delay 0.25
  end repeat
  return URL of tabRef
end tell
`;
}

function buildReloadScript(windowIndex, tabIndex) {
  return `
tell application "Google Chrome"
  set tabRef to tab ${tabIndex} of window ${windowIndex}
  reload tabRef
  repeat 120 times
    if loading of tabRef is false then
      exit repeat
    end if
    delay 0.25
  end repeat
end tell
`;
}

function buildNavigateScript(windowIndex, tabIndex, handle) {
  return `
set targetUrl to "https://truthsocial.com/@" & "${handle}"
tell application "Google Chrome"
  set tabRef to tab ${tabIndex} of window ${windowIndex}
  set URL of tabRef to targetUrl
  repeat 120 times
    if loading of tabRef is false then
      exit repeat
    end if
    delay 0.25
  end repeat
  return URL of tabRef
end tell
`;
}

function buildExecuteScript(windowIndex, tabIndex, jsPath) {
  return `
set jsPath to "${jsPath}"
set jsCode to do shell script "cat " & quoted form of jsPath
tell application "Google Chrome"
  set tabRef to tab ${tabIndex} of window ${windowIndex}
  return execute tabRef javascript jsCode
end tell
`;
}

function buildExecuteExpressionScript(windowIndex, tabIndex, expression) {
  return `
tell application "Google Chrome"
  set tabRef to tab ${tabIndex} of window ${windowIndex}
  return execute tabRef javascript ${JSON.stringify(expression)}
end tell
`;
}

function normalizeContentText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim() || '[Media-only post]';
}

function buildFetchScript(handle, limit) {
  return `
(() => {
  const acct = ${JSON.stringify(handle)};
  const limit = ${JSON.stringify(Number(limit))};
  window.scrollTo(0, 0);
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();

  function asText(node) {
    return (node && node.innerText ? node.innerText : '').replace(/\\s+/g, ' ').trim();
  }

  function pickPostLinks() {
    return Array.from(document.querySelectorAll('a[href*="/@' + acct + '/posts/"], a[href*="/@' + acct + '/"]'))
      .filter((anchor) => {
        const href = anchor.getAttribute('href') || '';
        return /\\/@[^/]+\\/(posts\\/)?\\d+/.test(href);
      });
  }

  function extractIdFromHref(href) {
    const match = String(href || '').match(/\\/(?:posts\\/)?(\\d+)(?:$|[/?#])/);
    return match ? match[1] : '';
  }

  function findCard(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const text = asText(node);
      if (text && text.includes('@' + acct) && text.length > 40) {
        return node;
      }
      node = node.parentElement;
    }
    return anchor.parentElement || anchor;
  }

  function collectMediaUrls(card) {
    const urls = [];
    const seen = new Set();
    const candidates = Array.from(card.querySelectorAll('img[src], video[poster]'));
    for (const node of candidates) {
      const src = node.currentSrc || node.getAttribute('src') || node.getAttribute('poster') || '';
      if (!src || src.startsWith('data:') || seen.has(src)) {
        continue;
      }
      if (/\\/avatars\\//i.test(src)) {
        continue;
      }
      const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : { width: 0, height: 0 };
      const visibleWidth = Number(rect.width || 0);
      const visibleHeight = Number(rect.height || 0);
      const intrinsicWidth = Number(node.naturalWidth || node.videoWidth || 0);
      const intrinsicHeight = Number(node.naturalHeight || node.videoHeight || 0);
      const largeVisibleMedia = visibleWidth >= 140 || visibleHeight >= 140;
      const largeIntrinsicFallback = intrinsicWidth >= 240 || intrinsicHeight >= 240;
      if (!largeVisibleMedia && !largeIntrinsicFallback) {
        continue;
      }
      seen.add(src);
      urls.push(src);
    }
    return urls;
  }

  function findTimestampNode(card, anchor) {
    return (
      card.querySelector('time[datetime]') ||
      card.querySelector('time') ||
      anchor.closest('article, div')?.querySelector('time[datetime]') ||
      anchor.closest('article, div')?.querySelector('time') ||
      null
    );
  }

  function extractTimestamp(card, anchor) {
    const node = findTimestampNode(card, anchor);
    if (node) {
      const iso = (node.getAttribute('datetime') || '').trim();
      const label = asText(node);
      if (iso || label) {
        return { iso, label };
      }
    }

    const text = asText(card);
    const relative = text.match(/(?:^|\\s)(\\d+\\s*[smhdw])(?:\\s|$)/i);
    if (relative) {
      return { iso: '', label: relative[1].replace(/\\s+/g, '') };
    }
    const calendar = text.match(
      /(?:^|\\s)((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2}(?:,\\s*\\d{4})?)(?:\\s|$)/i,
    );
    if (calendar) {
      return { iso: '', label: calendar[1] };
    }
    return { iso: '', label: '' };
  }

  const rateLimited = bodyText.includes('You’re going too fast!') || bodyText.includes(\"You're going too fast!\");
  const emptyState = bodyText.includes('No Truths');
  const anchors = pickPostLinks();
  const seen = new Set();
  const statuses = [];

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const id = extractIdFromHref(href);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const card = findCard(anchor);
    const text = asText(card);
    const timestamp = extractTimestamp(card, anchor);
    if (!text || /\\bPinned Truth\\b/i.test(text)) {
      continue;
    }
    statuses.push({
      id,
      created_at: timestamp.iso || timestamp.label || null,
      url: href.startsWith('http') ? href : ('https://truthsocial.com' + href),
      content: text,
      content_text: text,
      media_urls: collectMediaUrls(card),
      reblog: null,
    });
    if (statuses.length >= limit) {
      break;
    }
  }

  return encodeURIComponent(JSON.stringify({
    accountId: null,
    rateLimited,
    emptyState,
    bodyText: bodyText.slice(0, 600),
    statuses,
  }));
})();
`;
}

function buildAuthStateScript() {
  return `
(() => {
  try {
    return JSON.stringify(JSON.parse(localStorage.getItem('truth:auth') || 'null'));
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
})()
`;
}

function buildApiFetchScript(handle, limit, resultKey, accountId = '', maxId = '') {
  return `
(() => {
  const acct = ${JSON.stringify(handle)};
  const limit = ${JSON.stringify(Number(limit))};
  const resultKey = ${JSON.stringify(resultKey)};
  let accountId = ${JSON.stringify(String(accountId || ''))};
  const maxId = ${JSON.stringify(String(maxId || ''))};

  function setResult(payload) {
    localStorage.setItem(resultKey, JSON.stringify(payload));
  }

  function getAccessToken() {
    const auth = JSON.parse(localStorage.getItem('truth:auth') || 'null');
    const me = auth && typeof auth.me === 'string' ? auth.me : '';
    const userToken = me && auth && auth.users && auth.users[me] ? auth.users[me].access_token : '';
    if (userToken) {
      return userToken;
    }
    const tokenMap = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
    const tokenKeys = tokenMap ? Object.keys(tokenMap).filter(Boolean) : [];
    return tokenKeys[0] || '';
  }

  function normalizeMediaAttachments(list) {
    return Array.isArray(list)
      ? list.map((item) => item && (item.url || item.preview_url || '')).filter(Boolean)
      : [];
  }

  setResult({ state: 'pending' });

  (async () => {
    try {
      const accessToken = getAccessToken();
      if (!accessToken) {
        throw new Error('No Truth Social access token found in Chrome session');
      }

      const headers = {
        accept: 'application/json',
        authorization: 'Bearer ' + accessToken,
      };

      if (!accountId) {
        const lookupResponse = await fetch('/api/v1/accounts/lookup?' + new URLSearchParams({ acct }).toString(), {
          headers,
          credentials: 'include',
        });
        const lookupJson = await lookupResponse.json();
        if (!lookupResponse.ok || !lookupJson || !lookupJson.id) {
          throw new Error('Chrome Truth Social account lookup failed with HTTP ' + lookupResponse.status);
        }
        accountId = lookupJson.id;
      }

      const statusParams = new URLSearchParams({
        exclude_replies: 'true',
        only_replies: 'false',
        with_muted: 'true',
        limit: String(limit),
      });
      if (maxId) {
        statusParams.set('max_id', maxId);
      }
      const statusesResponse = await fetch('/api/v1/accounts/' + accountId + '/statuses?' + statusParams.toString(), {
        headers,
        credentials: 'include',
      });
      const statusesJson = await statusesResponse.json();
      if (!statusesResponse.ok || !Array.isArray(statusesJson)) {
        throw new Error('Chrome Truth Social statuses returned HTTP ' + statusesResponse.status);
      }

      setResult({
        state: 'done',
        result: {
          account_id: accountId,
          statuses: statusesJson.map((item) => ({
            id: item && item.id ? item.id : null,
            created_at: item && item.created_at ? item.created_at : null,
            url: item && item.url ? item.url : '',
            content: item && item.content ? item.content : '',
            content_text: item && item.content ? String(item.content).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim() : '',
            media_urls: normalizeMediaAttachments(item && item.media_attachments),
            media_attachments: Array.isArray(item && item.media_attachments)
              ? item.media_attachments.map((media) => ({
                  type: media && media.type ? media.type : '',
                  url: media && media.url ? media.url : '',
                  preview_url: media && media.preview_url ? media.preview_url : '',
                }))
              : [],
            reblog: item ? item.reblog || null : null,
          })),
        },
      });
    } catch (error) {
      setResult({
        state: 'error',
        error: String(error && error.message ? error.message : error),
      });
    }
  })();

  return 'started';
})()
`;
}

function buildApiFetchStatusByIdScript(statusId, resultKey) {
  return `
(() => {
  const resultKey = ${JSON.stringify(resultKey)};
  const statusId = ${JSON.stringify(String(statusId || ''))};

  function setResult(payload) {
    localStorage.setItem(resultKey, JSON.stringify(payload));
  }

  function getAccessToken() {
    const auth = JSON.parse(localStorage.getItem('truth:auth') || 'null');
    const me = auth && typeof auth.me === 'string' ? auth.me : '';
    const userToken = me && auth && auth.users && auth.users[me] ? auth.users[me].access_token : '';
    const tokenMap = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
    const tokenKeys = tokenMap ? Object.keys(tokenMap).filter(Boolean) : [];
    return userToken || tokenKeys[0] || '';
  }

  setResult({ state: 'pending' });

  (async () => {
    try {
      const accessToken = getAccessToken();
      if (!accessToken) {
        throw new Error('No Truth Social access token found in Chrome session');
      }
      const response = await fetch('/api/v1/statuses/' + encodeURIComponent(statusId), {
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + accessToken,
        },
        credentials: 'include',
      });
      const json = await response.json();
      if (!response.ok || !json || !json.id) {
        throw new Error('Chrome Truth Social status lookup failed with HTTP ' + response.status);
      }
      setResult({
        state: 'done',
        result: {
          id: json.id || null,
          created_at: json.created_at || null,
          url: json.url || '',
          content: json.content || '',
          content_text: json.content ? String(json.content).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim() : '',
          media_urls: normalizeMediaAttachments(json.media_attachments),
          media_attachments: Array.isArray(json.media_attachments)
            ? json.media_attachments.map((media) => ({
                type: media && media.type ? media.type : '',
                url: media && media.url ? media.url : '',
                preview_url: media && media.preview_url ? media.preview_url : '',
              }))
            : [],
          reblog: json.reblog || null,
        },
      });
    } catch (error) {
      setResult({
        state: 'error',
        error: String(error && error.message ? error.message : error),
      });
    }
  })();

  return 'started';
})()
`;
}

export function createTruthSocialChromeClient(config) {
  let lastReloadAt = 0;
  let cachedAuthState = null;
  let cachedAccountId = '';

  async function findTab() {
    let raw;
    try {
      raw = await runAppleScript(buildFindTabScript(config.accountHandle));
    } catch (error) {
      throw normalizeAppleScriptError(error);
    }
    if (!raw) {
      throw new Error(`No open Chrome tab found for @${config.accountHandle}`);
    }
    const [windowIndex, tabIndex, url, title] = raw.split('\t');
    return {
      windowIndex: Number(windowIndex),
      tabIndex: Number(tabIndex),
      url,
      title,
    };
  }

  async function ensureTab() {
    try {
      return await findTab();
    } catch (error) {
      if (!String(error?.message || '').includes('No open Chrome tab found')) {
        throw error;
      }
    }

    try {
      await runAppleScript(buildOpenTabScript(config.accountHandle));
    } catch (error) {
      throw normalizeAppleScriptError(error);
    }

    return findTab();
  }

  async function ensureTimelineTab(tab) {
    const targetUrl = `https://truthsocial.com/@${config.accountHandle}`;
    const normalizedCurrent = String(tab?.url || '').replace(/\/+$/, '');
    const normalizedTarget = targetUrl.replace(/\/+$/, '');
    if (normalizedCurrent === normalizedTarget) {
      return tab;
    }

    try {
      const navigatedUrl = await runAppleScript(
        buildNavigateScript(tab.windowIndex, tab.tabIndex, config.accountHandle),
      );
      return {
        ...tab,
        url: navigatedUrl || targetUrl,
      };
    } catch (error) {
      throw normalizeAppleScriptError(error);
    }
  }

  async function executeFetch(tab) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'truth-social-chrome-'));
    const jsPath = path.join(tempDir, 'fetch.js');
    try {
      await fs.writeFile(jsPath, buildFetchScript(config.accountHandle, config.chrome.fetchLimit), 'utf8');
      let encoded;
      try {
        encoded = await runAppleScript(buildExecuteScript(tab.windowIndex, tab.tabIndex, jsPath));
      } catch (error) {
        throw normalizeAppleScriptError(error);
      }
      const decoded = decodeURIComponent(encoded || '');
      return JSON.parse(decoded || '{}');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function executeExpression(tab, expression) {
    let raw;
    try {
      raw = await runAppleScript(
        buildExecuteExpressionScript(tab.windowIndex, tab.tabIndex, expression),
      );
    } catch (error) {
      throw normalizeAppleScriptError(error);
    }
    return raw;
  }

  async function readAuthState(tab) {
    const raw = await executeExpression(tab, buildAuthStateScript());
    if (!raw) {
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed?.error) {
      throw new Error(`Chrome Truth Social auth state read failed: ${parsed.error}`);
    }
    return parsed;
  }

  function extractAccessToken(authState) {
    const state = authState && typeof authState === 'object' ? authState : null;
    const me = typeof state?.me === 'string' ? state.me : '';
    const userToken = me && state?.users && typeof state.users === 'object'
      ? state.users[me]?.access_token
      : '';
    if (userToken) {
      return userToken;
    }
    const tokenEntries = state?.tokens && typeof state.tokens === 'object'
      ? Object.keys(state.tokens).filter(Boolean)
      : [];
    return tokenEntries[0] || '';
  }

  async function ensureApiAccessToken(tab, { forceRefresh = false } = {}) {
    if (!forceRefresh && cachedAuthState) {
      const cachedToken = extractAccessToken(cachedAuthState);
      if (cachedToken) {
        return cachedToken;
      }
    }

    const authState = await readAuthState(tab);
    cachedAuthState = authState;
    cachedAccountId = '';
    const accessToken = extractAccessToken(authState);
    if (!accessToken) {
      throw new Error(
        'Chrome Truth Social API mode requires an authenticated Chrome Truth Social session. Sign in in Chrome first.',
      );
    }
    return accessToken;
  }

  async function fetchStatusesViaApi(tab, { forceRefresh = false, maxId = '', limit = config.chrome.fetchLimit } = {}) {
    await ensureApiAccessToken(tab, { forceRefresh });
    const resultKey = `__market_truthsocial_api_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await executeExpression(
      tab,
      buildApiFetchScript(config.accountHandle, limit, resultKey, forceRefresh ? '' : cachedAccountId, maxId),
    );

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const raw = await executeExpression(tab, `localStorage.getItem(${JSON.stringify(resultKey)}) || ''`);
      if (!raw) {
        continue;
      }
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        continue;
      }
      if (payload?.state === 'pending') {
        continue;
      }
      await executeExpression(tab, `localStorage.removeItem(${JSON.stringify(resultKey)})`);
      if (payload?.state === 'error') {
        const message = String(payload.error || 'Chrome Truth Social API fetch failed');
        if (!forceRefresh && /access token|401|403/i.test(message)) {
          cachedAuthState = null;
          cachedAccountId = '';
          return fetchStatusesViaApi(tab, { forceRefresh: true, maxId, limit });
        }
        throw new Error(message);
      }
      if (payload?.state === 'done' && payload.result && Array.isArray(payload.result.statuses)) {
        cachedAccountId = String(payload.result.account_id || cachedAccountId || '');
        return {
          account_id: payload.result.account_id,
          statuses: payload.result.statuses.map((item) => ({
            ...item,
            content_text: normalizeContentText(item?.content_text),
          })),
        };
      }
      throw new Error('Chrome Truth Social API fetch returned an invalid payload');
    }
    await executeExpression(tab, `localStorage.removeItem(${JSON.stringify(resultKey)})`);
    throw new Error('Chrome Truth Social API fetch timed out');
  }

  return {
    async fetchStatuses(options = {}) {
      const rawTab = await ensureTab();
      const tab = await ensureTimelineTab(rawTab);
      if (config.source === 'chrome_api') {
        return fetchStatusesViaApi(tab, options);
      }
      const shouldReload =
        config.chrome.reloadBeforeFetch
        || !lastReloadAt
        || (Date.now() - lastReloadAt) >= config.chrome.reloadMinIntervalMs;
      if (shouldReload) {
        await runAppleScript(buildReloadScript(tab.windowIndex, tab.tabIndex));
        lastReloadAt = Date.now();
      }
      const payload = await executeFetch(tab);
      if (!payload || payload.error) {
        throw new Error(payload?.error || 'Chrome Truth Social fetch failed');
      }
      if (payload.rateLimited) {
        throw new Error('Truth Social page is rate-limited in Chrome');
      }
      if ((!Array.isArray(payload.statuses) || !payload.statuses.length) && payload.emptyState) {
        throw new Error('Truth Social page shows no posts in Chrome');
      }
      return {
        account_id: payload.accountId,
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.map((item) => ({
              ...item,
              content_text: normalizeContentText(item.content_text),
            }))
          : [],
      };
    },
    async fetchAccountHistory(options = {}) {
      const maxPages = Math.max(1, Number(options.maxPages || config.chrome.backfillPages || 12));
      const maxItems = Math.max(1, Number(options.maxItems || config.chrome.backfillLimit || 1000));
      const pageLimit = Math.max(10, Number(options.limit || config.chrome.fetchLimit || 100));
      const pages = [];
      let maxId = '';
      let all = [];
      for (let page = 0; page < maxPages && all.length < maxItems; page += 1) {
        const payload = await this.fetchStatuses({ maxId, limit: pageLimit });
        const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
        if (!statuses.length) {
          break;
        }
        pages.push({
          page: page + 1,
          count: statuses.length,
          oldestId: statuses.at(-1)?.id || null,
        });
        all = all.concat(statuses);
        maxId = statuses.at(-1)?.id || '';
        if (!maxId || statuses.length < pageLimit) {
          break;
        }
      }
      const deduped = [...new Map(all.filter((item) => item?.id).map((item) => [String(item.id), item])).values()]
        .slice(0, maxItems);
      return {
        account_id: deduped[0]?.account_id || null,
        statuses: deduped,
        pages,
      };
    },
    async fetchStatusById(statusId, options = {}) {
      const rawTab = await ensureTab();
      const tab = await ensureTimelineTab(rawTab);
      await ensureApiAccessToken(tab, options);
      const resultKey = `__market_truthsocial_status_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await executeExpression(tab, buildApiFetchStatusByIdScript(statusId, resultKey));
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const raw = await executeExpression(tab, `localStorage.getItem(${JSON.stringify(resultKey)}) || ''`);
        if (!raw) continue;
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        if (payload?.state === 'pending') continue;
        await executeExpression(tab, `localStorage.removeItem(${JSON.stringify(resultKey)})`);
        if (payload?.state === 'error') {
          throw new Error(String(payload.error || 'Chrome Truth Social status lookup failed'));
        }
        return payload.result || null;
      }
      await executeExpression(tab, `localStorage.removeItem(${JSON.stringify(resultKey)})`);
      throw new Error('Chrome Truth Social status lookup timed out');
    },
    getStatus() {
      return {
        lastReloadAt: lastReloadAt ? new Date(lastReloadAt).toISOString() : null,
      };
    },
  };
}
