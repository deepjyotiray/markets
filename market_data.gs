/**
 * Daily market data collector for Google Sheets.
 *
 * Scope:
 * - Fetches, stores, classifies, and alerts.
 * - Does NOT automate trading, generate orders, or connect to brokers.
 * - Appends rows only and preserves history.
 */

const CONFIG = {
  SHEET_NAME: 'MarketData',
  TIMEZONE: 'Asia/Kolkata',
  DATE_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  TELEGRAM_ENABLED: true,
  TELEGRAM_PARSE_MODE: 'Markdown',
  MAX_RETRIES: 3,
  RETRY_BACKOFF_MS: 1500,
  FETCH_TIMEOUT_MS: 20000,
  MIN_SIGNALS_FOR_REGIME: 4,
  TRIGGER_HOUR: 8,
  TRIGGER_MINUTE: 45,
  ALPHA_VANTAGE_BASE_URL: 'https://www.alphavantage.co/query',
  GOOGLE_NEWS_RSS_URL: 'https://news.google.com/rss/search?q=Indian%20stock%20market&hl=en-IN&gl=IN&ceid=IN:en',
  USER_AGENT:
    'Mozilla/5.0 (compatible; GoogleAppsScript MarketDataBot/1.0; +https://script.google.com/)',
  MARKET_HEADERS: [
    'Timestamp',
    'GiftNifty',
    'GiftNiftyPct',
    'Brent',
    'BrentPct',
    'USDINR',
    'USDINRChange',
    'IndiaVIX',
    'IndiaVIXChange',
    'AdvanceDecline',
    'FIINet',
    'DIINet',
    'Headline',
    'Regime',
  ],
  THRESHOLDS: {
    GIFT_NIFTY_POSITIVE_PCT: 0.25,
    GIFT_NIFTY_NEGATIVE_PCT: -0.25,
    BRENT_POSITIVE_FOR_INDIA_PCT: -1.0,
    BRENT_NEGATIVE_FOR_INDIA_PCT: 1.0,
    USDINR_POSITIVE_CHANGE: -0.15,
    USDINR_NEGATIVE_CHANGE: 0.15,
    INDIA_VIX_POSITIVE_CHANGE: -0.50,
    INDIA_VIX_NEGATIVE_CHANGE: 0.50,
    ADVANCE_DECLINE_POSITIVE: 1.20,
    ADVANCE_DECLINE_NEGATIVE: 0.90,
    FII_NET_POSITIVE: 0.01,
    FII_NET_NEGATIVE: -0.01,
    DII_NET_POSITIVE: 0.01,
    DII_NET_NEGATIVE: -0.01,
    RISK_ON_SCORE: 3,
    DEFENSIVE_SCORE: -3,
  },
  URLS: {
    MONEYCONTROL_GIFT_NIFTY_PAGE: 'https://www.moneycontrol.com/indian-indices/-4993351.html',
    MONEYCONTROL_GIFT_NIFTY_FALLBACK_PAGE: 'https://www.moneycontrol.com/indian-indices/-4902491.html',
    MONEYCONTROL_FII_DII_PAGE: 'https://www.moneycontrol.com/markets/fii-dii-data/cash/',
    MONEYCONTROL_MARKET_NEWS_PAGE: 'https://www.moneycontrol.com/news/tags/market.html',
    NSE_HOME: 'https://www.nseindia.com/',
    NSE_ALL_INDICES_API: 'https://www.nseindia.com/api/allIndices',
    NSE_MARKET_STATUS_API: 'https://www.nseindia.com/api/marketStatus',
    NSE_BREADTH_PAGE: 'https://www.nseindia.com/market-data/decline',
    MONEYCONTROL_INDIA_VIX_PAGE: 'https://www.moneycontrol.com/india/indexfno/indiavix-17.html',
  },
  PROPERTY_KEYS: {
    ALPHA_VANTAGE_API_KEY: 'ALPHA_VANTAGE_API_KEY',
    TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
    TELEGRAM_CHAT_ID: 'TELEGRAM_CHAT_ID',
    LAST_REGIME: 'LAST_REGIME',
  },
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Market Tools')
    .addItem('Setup Sheet', 'setupSheet')
    .addItem('Fetch Data Now', 'fetchDataNow')
    .addSeparator()
    .addItem('Create Triggers', 'createTriggers')
    .addItem('Delete Triggers', 'deleteTriggers')
    .addToUi();
}

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, CONFIG.SHEET_NAME);
  const headers = CONFIG.MARKET_HEADERS;

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('B:I').setNumberFormat('0.00');
  sheet.getRange('J:J').setNumberFormat('0.00');
  sheet.getRange('K:L').setNumberFormat('0.00');
  sheet.autoResizeColumns(1, headers.length);
}

function fetchDataNow() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    setupSheet();
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const previousRow = getLastDataRowObject_(sheet);
    const snapshot = collectSnapshot_(sheet, previousRow);
    appendSnapshot_(sheet, snapshot);
    maybeSendRegimeAlert_(snapshot.regime, previousRow, snapshot);
  } finally {
    lock.releaseLock();
  }
}

function createTriggers() {
  deleteTriggers();
  ScriptApp.newTrigger('fetchDataNow')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.TRIGGER_HOUR)
    .nearMinute(CONFIG.TRIGGER_MINUTE)
    .create();
}

function deleteTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const fn = trigger.getHandlerFunction();
    if (fn === 'fetchDataNow') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function collectSnapshot_(sheet, previousRow) {
  const timestamp = new Date();
  const usdInr = fetchUsdInr_();
  const brent = fetchBrent_();
  const giftNifty = fetchGiftNifty_();
  const indiaVix = fetchIndiaVix_();
  const advanceDecline = fetchAdvanceDecline_();
  const fiiDii = fetchFiiDii_();
  const headline = fetchHeadline_();

  const snapshot = {
    timestamp: Utilities.formatDate(timestamp, CONFIG.TIMEZONE, CONFIG.DATE_FORMAT),
    giftNifty: valueOrNull_(giftNifty.value),
    giftNiftyPct: valueOrNull_(
      giftNifty.pctChange != null
        ? giftNifty.pctChange
        : computePercentChange_(giftNifty.value, previousRow && previousRow.GiftNifty)
    ),
    brent: valueOrNull_(brent.value),
    brentPct: valueOrNull_(
      brent.pctChange != null
        ? brent.pctChange
        : computePercentChange_(brent.value, previousRow && previousRow.Brent)
    ),
    usdInr: valueOrNull_(usdInr.value),
    usdInrChange: valueOrNull_(
      usdInr.change != null ? usdInr.change : computeAbsoluteChange_(usdInr.value, previousRow && previousRow.USDINR)
    ),
    indiaVix: valueOrNull_(indiaVix.value),
    indiaVixChange: valueOrNull_(
      indiaVix.change != null
        ? indiaVix.change
        : computeAbsoluteChange_(indiaVix.value, previousRow && previousRow.IndiaVIX)
    ),
    advanceDecline: valueOrNull_(advanceDecline.ratio),
    fiiNet: valueOrNull_(fiiDii.fiiNet),
    diiNet: valueOrNull_(fiiDii.diiNet),
    headline: headline.headline || '',
  };

  snapshot.regime = classifyRegime_(snapshot);
  return snapshot;
}

function appendSnapshot_(sheet, snapshot) {
  const row = [
    snapshot.timestamp,
    snapshot.giftNifty,
    snapshot.giftNiftyPct,
    snapshot.brent,
    snapshot.brentPct,
    snapshot.usdInr,
    snapshot.usdInrChange,
    snapshot.indiaVix,
    snapshot.indiaVixChange,
    snapshot.advanceDecline,
    snapshot.fiiNet,
    snapshot.diiNet,
    snapshot.headline,
    snapshot.regime,
  ];
  sheet.appendRow(row);
}

/**
 * Fetches USD/INR from Alpha Vantage's CURRENCY_EXCHANGE_RATE endpoint.
 * Expected JSON shape:
 * {
 *   "Realtime Currency Exchange Rate": {
 *     "5. Exchange Rate": "83.1234",
 *     ...
 *   }
 * }
 */
function fetchUsdInr_() {
  return safeFetch_('USDINR', function () {
    const apiKey = getRequiredProperty_(CONFIG.PROPERTY_KEYS.ALPHA_VANTAGE_API_KEY);
    const data = fetchJsonWithRetry_(
      CONFIG.ALPHA_VANTAGE_BASE_URL +
        '?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=INR&apikey=' +
        encodeURIComponent(apiKey)
    );
    const node = data['Realtime Currency Exchange Rate'] || {};
    return {
      value: toNumber_(node['5. Exchange Rate']),
      change: null,
    };
  });
}

/**
 * Fetches Brent crude from Alpha Vantage's BRENT commodity endpoint.
 * Expected JSON shape on commodity responses is commonly:
 * {
 *   "data": [
 *     {"date":"2026-04-15","value":"88.31"},
 *     {"date":"2026-04-14","value":"87.44"}
 *   ]
 * }
 * If Alpha Vantage changes the shape, the parser also attempts several common
 * fallback layouts before failing gracefully.
 */
function fetchBrent_() {
  return safeFetch_('BRENT', function () {
    const apiKey = getRequiredProperty_(CONFIG.PROPERTY_KEYS.ALPHA_VANTAGE_API_KEY);
    const data = fetchJsonWithRetry_(
      CONFIG.ALPHA_VANTAGE_BASE_URL + '?function=BRENT&interval=daily&apikey=' + encodeURIComponent(apiKey)
    );

    if (Array.isArray(data.data) && data.data.length > 0) {
      const latest = data.data[0];
      const previous = data.data[1];
      return {
        value: toNumber_(latest.value),
        pctChange: computePercentChange_(toNumber_(latest.value), previous && toNumber_(previous.value)),
      };
    }

    const timeSeries = data['Time Series (Daily)'] || data['data'] || null;
    if (timeSeries && !Array.isArray(timeSeries)) {
      const keys = Object.keys(timeSeries).sort().reverse();
      const current = timeSeries[keys[0]];
      const previous = timeSeries[keys[1]];
      return {
        value: toNumber_(current && (current.value || current['4. close'] || current.close)),
        pctChange: computePercentChange_(
          toNumber_(current && (current.value || current['4. close'] || current.close)),
          toNumber_(previous && (previous.value || previous['4. close'] || previous.close))
        ),
      };
    }

    throw new Error('Unexpected Brent response shape');
  });
}

/**
 * Fetches GIFT Nifty from public Moneycontrol market pages.
 * Expected HTML/page characteristics:
 * - A legacy index page that may contain direct numbers in the HTML, OR
 * - JavaScript variables / API links containing the index name and current change.
 *
 * The parser tries several regex patterns so a markup change fails gracefully.
 */
function fetchGiftNifty_() {
  return safeFetch_('GIFT_NIFTY', function () {
    const pages = [
      CONFIG.URLS.MONEYCONTROL_GIFT_NIFTY_PAGE,
      CONFIG.URLS.MONEYCONTROL_GIFT_NIFTY_FALLBACK_PAGE,
    ];
    for (var i = 0; i < pages.length; i += 1) {
      const html = fetchTextWithRetry_(pages[i], { followRedirects: true });
      const parsed = parseGiftNiftyFromHtml_(html);
      if (parsed.value != null) {
        return parsed;
      }
    }
    throw new Error('Unable to parse GIFT Nifty from configured pages');
  });
}

/**
 * Fetches India VIX primarily from NSE allIndices and falls back to Moneycontrol HTML.
 * Expected NSE JSON shape often includes an array in "data" with rows like:
 * { "index":"INDIA VIX", "last":"12.34", "variation":"0.56" }
 * Fallback HTML expects visible labels around "India VIX" and nearby numeric values.
 */
function fetchIndiaVix_() {
  return safeFetch_('INDIA_VIX', function () {
    const nseData = fetchNseJson_(CONFIG.URLS.NSE_ALL_INDICES_API);
    const fromNse = parseIndiaVixFromNse_(nseData);
    if (fromNse.value != null) {
      return fromNse;
    }

    const html = fetchTextWithRetry_(CONFIG.URLS.MONEYCONTROL_INDIA_VIX_PAGE, { followRedirects: true });
    const fromHtml = parseIndiaVixFromHtml_(html);
    if (fromHtml.value != null) {
      return fromHtml;
    }

    throw new Error('Unable to parse India VIX');
  });
}

/**
 * Fetches advance/decline breadth.
 * Expected primary source shape:
 * - NSE market APIs/pages may expose advances and declines either in nested objects
 *   or as keys on a row object.
 * Fallback shape:
 * - Public HTML with "Advances" and "Declines" labels that can be regex matched.
 */
function fetchAdvanceDecline_() {
  return safeFetch_('ADVANCE_DECLINE', function () {
    const candidates = [
      fetchNseJson_(CONFIG.URLS.NSE_MARKET_STATUS_API),
      fetchNseJson_(CONFIG.URLS.NSE_ALL_INDICES_API),
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      const parsed = parseAdvanceDeclineFromJson_(candidates[i]);
      if (parsed.ratio != null) {
        return parsed;
      }
    }

    const breadthHtml = fetchTextWithRetry_(CONFIG.URLS.NSE_BREADTH_PAGE, { followRedirects: true });
    const breadthFromHtml = parseAdvanceDeclineFromHtml_(breadthHtml);
    if (breadthFromHtml.ratio != null) {
      return breadthFromHtml;
    }

    const mcHtml = fetchTextWithRetry_(CONFIG.URLS.MONEYCONTROL_MARKET_NEWS_PAGE, { followRedirects: true });
    const mcParsed = parseAdvanceDeclineFromHtml_(mcHtml);
    if (mcParsed.ratio != null) {
      return mcParsed;
    }

    throw new Error('Unable to parse advance/decline ratio');
  });
}

/**
 * Fetches FII and DII cash market net values from Moneycontrol.
 * Expected HTML shape:
 * - Next.js page with a <script id="__NEXT_DATA__"> JSON blob.
 * - The blob contains latest rows under props.pageProps.FiiDiiData.fiiDiiData.
 */
function fetchFiiDii_() {
  return safeFetch_('FII_DII', function () {
    const html = fetchTextWithRetry_(CONFIG.URLS.MONEYCONTROL_FII_DII_PAGE, { followRedirects: true });
    const jsonString = extractTagContents_(html, '__NEXT_DATA__');
    if (!jsonString) {
      throw new Error('Missing __NEXT_DATA__ JSON');
    }
    const payload = JSON.parse(jsonString);
    const rows =
      (((payload || {}).props || {}).pageProps || {}).FiiDiiData &&
      (((payload || {}).props || {}).pageProps || {}).FiiDiiData.fiiDiiData;
    const latest = rows && rows[0];
    if (!latest) {
      throw new Error('Missing latest FII/DII row');
    }
    return {
      fiiNet: toNumber_(latest.fiiNet),
      diiNet: toNumber_(latest.diiNet),
    };
  });
}

/**
 * Fetches a single headline for context using Google News RSS first, then Moneycontrol.
 * Expected RSS shape:
 * - Standard RSS with item/title nodes.
 * Expected HTML fallback:
 * - A headline tag or title-like anchor near the top of the market news page.
 */
function fetchHeadline_() {
  return safeFetch_('HEADLINE', function () {
    const rssText = fetchTextWithRetry_(CONFIG.GOOGLE_NEWS_RSS_URL, { followRedirects: true });
    const rssMatch = rssText.match(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/i);
    if (rssMatch && rssMatch[1]) {
      return { headline: decodeHtmlEntities_(rssMatch[1]).replace(/\s*-\s*[^-]+$/, '').trim() };
    }

    const html = fetchTextWithRetry_(CONFIG.URLS.MONEYCONTROL_MARKET_NEWS_PAGE, { followRedirects: true });
    const match =
      html.match(/<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) ||
      html.match(/<h3[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) ||
      html.match(/<title>([^<]+)<\/title>/i);
    return { headline: match ? decodeHtmlEntities_(match[1]).trim() : '' };
  });
}

function classifyRegime_(snapshot) {
  const thresholds = CONFIG.THRESHOLDS;
  const signals = [];

  pushSignal_(signals, snapshot.giftNiftyPct, thresholds.GIFT_NIFTY_POSITIVE_PCT, thresholds.GIFT_NIFTY_NEGATIVE_PCT);
  pushSignalReverse_(signals, snapshot.brentPct, thresholds.BRENT_POSITIVE_FOR_INDIA_PCT, thresholds.BRENT_NEGATIVE_FOR_INDIA_PCT);
  pushSignalReverse_(signals, snapshot.usdInrChange, thresholds.USDINR_POSITIVE_CHANGE, thresholds.USDINR_NEGATIVE_CHANGE);
  pushSignalReverse_(signals, snapshot.indiaVixChange, thresholds.INDIA_VIX_POSITIVE_CHANGE, thresholds.INDIA_VIX_NEGATIVE_CHANGE);
  pushSignal_(signals, snapshot.advanceDecline, thresholds.ADVANCE_DECLINE_POSITIVE, thresholds.ADVANCE_DECLINE_NEGATIVE);
  pushSignal_(signals, snapshot.fiiNet, thresholds.FII_NET_POSITIVE, thresholds.FII_NET_NEGATIVE);
  pushSignal_(signals, snapshot.diiNet, thresholds.DII_NET_POSITIVE, thresholds.DII_NET_NEGATIVE);

  if (signals.length < CONFIG.MIN_SIGNALS_FOR_REGIME) {
    return 'NEUTRAL';
  }

  const score = signals.reduce(function (acc, item) {
    return acc + item;
  }, 0);

  if (score >= thresholds.RISK_ON_SCORE) {
    return 'RISK_ON';
  }
  if (score <= thresholds.DEFENSIVE_SCORE) {
    return 'DEFENSIVE';
  }
  return 'NEUTRAL';
}

function maybeSendRegimeAlert_(newRegime, previousRow, snapshot) {
  if (!CONFIG.TELEGRAM_ENABLED) {
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const priorStoredRegime = props.getProperty(CONFIG.PROPERTY_KEYS.LAST_REGIME) || (previousRow && previousRow.Regime) || '';
  if (!newRegime || newRegime === priorStoredRegime) {
    if (newRegime) {
      props.setProperty(CONFIG.PROPERTY_KEYS.LAST_REGIME, newRegime);
    }
    return;
  }

  sendTelegramAlert_(
    '*Market regime changed*\n' +
      'From: `' +
      (priorStoredRegime || 'UNKNOWN') +
      '`\n' +
      'To: `' +
      newRegime +
      '`\n' +
      'Time: `' +
      snapshot.timestamp +
      '`\n' +
      'Headline: ' +
      (snapshot.headline || 'n/a')
  );

  props.setProperty(CONFIG.PROPERTY_KEYS.LAST_REGIME, newRegime);
}

function sendTelegramAlert_(message) {
  const token = getRequiredProperty_(CONFIG.PROPERTY_KEYS.TELEGRAM_BOT_TOKEN);
  const chatId = getRequiredProperty_(CONFIG.PROPERTY_KEYS.TELEGRAM_CHAT_ID);
  const url = 'https://api.telegram.org/bot' + encodeURIComponent(token) + '/sendMessage';
  fetchJsonWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: CONFIG.TELEGRAM_PARSE_MODE,
      disable_web_page_preview: true,
    }),
  });
}

function fetchNseJson_(url) {
  const seed = fetchResponseWithRetry_(CONFIG.URLS.NSE_HOME, {
    headers: nseHeaders_(),
    followRedirects: true,
  });
  const seedHeaders = seed.getAllHeaders();
  const setCookie = seedHeaders['Set-Cookie'] || seedHeaders['set-cookie'] || [];
  const cookieHeader = Array.isArray(setCookie)
    ? setCookie.map(function (cookie) {
        return String(cookie).split(';')[0];
      }).join('; ')
    : String(setCookie || '').split(',').map(function (cookie) {
        return String(cookie).split(';')[0];
      }).join('; ');

  const response = fetchResponseWithRetry_(url, {
    headers: Object.assign({}, nseHeaders_(), cookieHeader ? { Cookie: cookieHeader } : {}),
    followRedirects: true,
  });
  return JSON.parse(response.getContentText());
}

function parseGiftNiftyFromHtml_(html) {
  const snippet = sliceAround_(html, /(GIFT\s*NIFTY|SGX\s*NIFTY)/i, 2500);
  const value =
    extractFirstNumber_(snippet, /(?:last|ltp|price|close|current)[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i) ||
    extractFirstNumber_(snippet, /([+-]?\d[\d,]*\.?\d*)\s*<\/span>/i) ||
    extractFirstNumber_(snippet, /"pricecurrent":"([+-]?\d[\d,]*\.?\d*)"/i);
  const pctChange =
    extractFirstNumber_(snippet, /([+-]?\d[\d,]*\.?\d*)\s*%/) ||
    extractFirstNumber_(snippet, /"changePercent":"([+-]?\d[\d,]*\.?\d*)"/i);
  return { value: value, pctChange: pctChange };
}

function parseIndiaVixFromNse_(payload) {
  const rows = payload && payload.data;
  if (!Array.isArray(rows)) {
    return { value: null, change: null };
  }

  for (var i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const label = String(row.index || row.key || row.name || '').toUpperCase();
    if (label.indexOf('INDIA VIX') !== -1) {
      return {
        value: toNumber_(row.last || row.lastPrice || row.price || row.closingIndex),
        change: toNumber_(row.variation || row.change || row.pointChange),
      };
    }
  }

  return { value: null, change: null };
}

function parseIndiaVixFromHtml_(html) {
  const snippet = sliceAround_(html, /INDIA\s*VIX/i, 2200);
  return {
    value:
      extractFirstNumber_(snippet, /(?:last|ltp|price|close)[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i) ||
      extractFirstNumber_(snippet, /"pricecurrent":"([+-]?\d[\d,]*\.?\d*)"/i),
    change:
      extractFirstNumber_(snippet, /(?:change|variation)[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i) ||
      extractFirstNumber_(snippet, /"priceChange":"([+-]?\d[\d,]*\.?\d*)"/i),
  };
}

function parseAdvanceDeclineFromJson_(payload) {
  if (!payload) {
    return { ratio: null };
  }

  const stack = [payload];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (var i = 0; i < current.length; i += 1) {
        stack.push(current[i]);
      }
      continue;
    }
    if (current && typeof current === 'object') {
      const advances = toNumber_(current.advances || current.advance || current.adv);
      const declines = toNumber_(current.declines || current.decline || current.dec);
      if (advances != null && declines != null && declines !== 0) {
        return { ratio: round_(advances / declines, 2) };
      }
      Object.keys(current).forEach(function (key) {
        stack.push(current[key]);
      });
    }
  }

  return { ratio: null };
}

function parseAdvanceDeclineFromHtml_(html) {
  const advances = extractFirstNumber_(html, /Advances?[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)/i);
  const declines = extractFirstNumber_(html, /Declines?[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)/i);
  if (advances != null && declines != null && declines !== 0) {
    return { ratio: round_(advances / declines, 2) };
  }
  const ratio = extractFirstNumber_(html, /Advance[^A-Za-z0-9]{0,20}Decline[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)/i);
  return { ratio: ratio };
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getLastDataRowObject_(sheet) {
  const lastRow = getLastNonEmptyRow_(sheet);
  if (lastRow < 2) {
    return null;
  }
  const headers = sheet.getRange(1, 1, 1, CONFIG.MARKET_HEADERS.length).getValues()[0];
  const values = sheet.getRange(lastRow, 1, 1, CONFIG.MARKET_HEADERS.length).getValues()[0];
  const result = {};
  headers.forEach(function (header, index) {
    result[header] = values[index];
  });
  return result;
}

function getPreviousValue_(sheet, columnName) {
  const row = getLastDataRowObject_(sheet);
  return row ? row[columnName] : null;
}

function getLastNonEmptyRow_(sheet) {
  const values = sheet.getDataRange().getValues();
  for (var rowIndex = values.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = values[rowIndex];
    if (row.some(function (cell) { return cell !== ''; })) {
      return rowIndex + 1;
    }
  }
  return 0;
}

function computePercentChange_(currentValue, previousValue) {
  const current = toNumber_(currentValue);
  const previous = toNumber_(previousValue);
  if (current == null || previous == null || previous === 0) {
    return null;
  }
  return round_(((current - previous) / previous) * 100, 2);
}

function computeAbsoluteChange_(currentValue, previousValue) {
  const current = toNumber_(currentValue);
  const previous = toNumber_(previousValue);
  if (current == null || previous == null) {
    return null;
  }
  return round_(current - previous, 2);
}

function scoreRegime_(snapshot) {
  return classifyRegime_(snapshot);
}

function safeFetch_(label, fn) {
  try {
    return fn();
  } catch (error) {
    console.error(label + ' fetch failed: ' + error.message);
    return {};
  }
}

function fetchJsonWithRetry_(url, options) {
  return JSON.parse(fetchTextWithRetry_(url, options));
}

function fetchTextWithRetry_(url, options) {
  return fetchResponseWithRetry_(url, options).getContentText();
}

function fetchResponseWithRetry_(url, options) {
  const requestOptions = Object.assign(
    {
      muteHttpExceptions: true,
      headers: { 'User-Agent': CONFIG.USER_AGENT, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      followRedirects: true,
      escaping: false,
    },
    options || {}
  );

  for (var attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt += 1) {
    const response = UrlFetchApp.fetch(url, requestOptions);
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      Utilities.sleep(250);
      return response;
    }
    if (attempt < CONFIG.MAX_RETRIES && (code === 429 || code >= 500 || code === 403)) {
      Utilities.sleep(CONFIG.RETRY_BACKOFF_MS * attempt);
      continue;
    }
    throw new Error('HTTP ' + code + ' for ' + url);
  }
  throw new Error('Exhausted retries for ' + url);
}

function nseHeaders_() {
  return {
    'User-Agent': CONFIG.USER_AGENT,
    Accept: 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.nseindia.com/',
    Connection: 'keep-alive',
    DNT: '1',
  };
}

function getRequiredProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error('Missing Script Property: ' + key);
  }
  return value;
}

function extractTagContents_(html, tagId) {
  const regex = new RegExp('<script[^>]*id="' + escapeRegex_(tagId) + '"[^>]*>([\\s\\S]*?)<\\/script>', 'i');
  const match = html.match(regex);
  return match ? match[1] : '';
}

function sliceAround_(text, regex, radius) {
  const match = text.match(regex);
  if (!match || match.index == null) {
    return text.slice(0, Math.min(text.length, radius || 2000));
  }
  const start = Math.max(0, match.index - (radius || 2000));
  const end = Math.min(text.length, match.index + (radius || 2000));
  return text.slice(start, end);
}

function extractFirstNumber_(text, regex) {
  if (!text) {
    return null;
  }
  const match = text.match(regex);
  return match ? toNumber_(match[1]) : null;
}

function toNumber_(value) {
  if (value === '' || value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }
  const normalized = String(value).replace(/,/g, '').replace(/%/g, '').trim();
  if (!normalized || normalized === '-' || normalized === '--') {
    return null;
  }
  const parsed = Number(normalized);
  return isNaN(parsed) ? null : parsed;
}

function pushSignal_(bucket, value, positiveThreshold, negativeThreshold) {
  const number = toNumber_(value);
  if (number == null) {
    return;
  }
  if (number >= positiveThreshold) {
    bucket.push(1);
    return;
  }
  if (number <= negativeThreshold) {
    bucket.push(-1);
  }
}

function pushSignalReverse_(bucket, value, positiveThreshold, negativeThreshold) {
  const number = toNumber_(value);
  if (number == null) {
    return;
  }
  if (number <= positiveThreshold) {
    bucket.push(1);
    return;
  }
  if (number >= negativeThreshold) {
    bucket.push(-1);
  }
}

function round_(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

function valueOrNull_(value) {
  return value == null ? '' : value;
}

function decodeHtmlEntities_(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegex_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
