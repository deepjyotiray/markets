import vm from 'node:vm';

import {
  compactWhitespace,
  computeAbsoluteChange,
  computePercentChange,
  decodeHtmlEntities,
  fetchTextWithRetry,
  getTimePartsInZone,
  round,
  toNumber,
} from './utils.js';

function inferUsExtendedKind() {
  const { weekday, hour, minute } = getTimePartsInZone(new Date(), 'America/New_York');
  if (weekday === 'Sat' || weekday === 'Sun') {
    return 'After-hours';
  }
  return hour * 60 + minute < 9 * 60 + 30 ? 'Pre-market' : 'After-hours';
}

function normalizeGoogleFinanceSymbol(symbol) {
  const [ticker = '', exchange = ''] = String(symbol || '').split(':');
  return {
    full: String(symbol || '').trim(),
    ticker: ticker.trim(),
    exchange: exchange.trim(),
  };
}

function extractGoogleFinanceCallbackPayloads(html) {
  const payloads = [];
  const sandbox = {
    AF_initDataCallback(payload) {
      payloads.push(payload);
    },
  };
  vm.createContext(sandbox);
  for (const match of html.matchAll(/AF_initDataCallback\((\{[\s\S]*?\})\);/g)) {
    try {
      vm.runInContext(`AF_initDataCallback(${match[1]})`, sandbox, { timeout: 50 });
    } catch {
      // Ignore malformed blocks.
    }
  }
  return payloads;
}

function findGoogleFinanceQuoteEntry(node, target) {
  if (!node) {
    return null;
  }
  if (Array.isArray(node)) {
    const looksLikeQuoteEntry =
      Array.isArray(node[1]) &&
      node[1][0] === target.ticker &&
      node[1][1] === target.exchange &&
      typeof node[2] === 'string' &&
      Array.isArray(node[5]) &&
      node.some((value) => value === target.full);
    if (looksLikeQuoteEntry) {
      return node;
    }
    for (const item of node) {
      const found = findGoogleFinanceQuoteEntry(item, target);
      if (found) {
        return found;
      }
    }
  } else if (typeof node === 'object') {
    for (const value of Object.values(node)) {
      const found = findGoogleFinanceQuoteEntry(value, target);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function parseGoogleFinanceStructuredQuote(html, symbol) {
  const target = normalizeGoogleFinanceSymbol(symbol);
  if (!target.full || !target.ticker || !target.exchange) {
    return null;
  }
  const callbacks = extractGoogleFinanceCallbackPayloads(html);
  for (const callback of callbacks) {
    const entry = findGoogleFinanceQuoteEntry(callback?.data, target);
    if (!entry) {
      continue;
    }
    const regular = Array.isArray(entry[5]) ? entry[5] : [];
    const extended = Array.isArray(entry[16]) ? entry[16] : null;
    const regularTimestamp = Array.isArray(entry[17]) ? toNumber(entry[17][0]) : null;
    const extendedTimestamp = Array.isArray(entry[18]) ? toNumber(entry[18][0]) : null;
    return {
      symbol: target.full,
      title: typeof entry[2] === 'string' ? entry[2] : '',
      exchange: target.exchange,
      price: toNumber(regular[0]),
      previousClose: toNumber(entry[7]),
      pctChange: toNumber(regular[2]),
      absChange: toNumber(regular[1]),
      timestamp: regularTimestamp,
      extended:
        extended && extended.length >= 3
          ? {
              kind: inferUsExtendedKind(),
              price: toNumber(extended[0]),
              absChange: toNumber(extended[1]),
              pctChange: toNumber(extended[2]),
              timestamp: extendedTimestamp,
            }
          : null,
    };
  }
  return null;
}

function getSignFromClassName(className) {
  if (!className) {
    return 1;
  }
  return String(className).includes('Ebnabc') ? -1 : 1;
}

function extractFirstNumber(text, regex) {
  if (!text) {
    return null;
  }
  const match = text.match(regex);
  return match ? toNumber(match[1]) : null;
}

export async function fetchGoogleFinanceQuote(symbol, config) {
  const url = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}`;
  const html = await fetchTextWithRetry(url, { redirect: 'follow' }, { userAgent: config.userAgent });
  const structuredQuote = parseGoogleFinanceStructuredQuote(html, symbol);
  let price = extractFirstNumber(html, /data-last-price="([^"]+)"/i);
  let previousClose = extractFirstNumber(
    html,
    /Previous close<\/div>[\s\S]{0,400}?<div class="P6K39c">\$?([0-9,]+(?:\.\d+)?)/i,
  );
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const exchangeMatch = html.match(/data-exchange="([^"]+)"/i);
  const timestampMatch = html.match(/data-last-normal-market-timestamp="([^"]+)"/i);
  const dayRangeMatch = html.match(/Day range<\/div><div[^>]*class="P6K39c"[^>]*>([^<]+)<\/div>/i);
  const extendedMatch = html.match(
    /(Pre-market|After-hours):[\s\S]*?<div class="YMlKec fxKbKc">\$?([0-9,]+(?:\.\d+)?)<\/div>[\s\S]*?<span[^>]*class="JwB6zf ([^"]+)"[^>]*>(?:[\s\S]*?<\/span>)?([0-9.]+%)<\/span>[\s\S]*?<span class="P2Luy [^"]+">([+-]?[0-9.,]+)/i,
  );

  if (structuredQuote) {
    price = structuredQuote.price ?? price;
    previousClose = structuredQuote.previousClose ?? previousClose;
  }

  let extended = structuredQuote?.extended || null;
  if (!extended && extendedMatch) {
    const kind = extendedMatch[1];
    const extendedPrice = toNumber(extendedMatch[2]);
    const sign = getSignFromClassName(extendedMatch[3]);
    const pctMagnitude = toNumber(extendedMatch[4]);
    const absValue = toNumber(extendedMatch[5]);
    extended = {
      kind,
      price: extendedPrice,
      pctChange: pctMagnitude === null ? null : round(sign * Math.abs(pctMagnitude), 4),
      absChange:
        absValue === null
          ? computeAbsoluteChange(extendedPrice, price)
          : round(Math.sign(absValue) === 0 ? sign * Math.abs(absValue) : absValue, 3),
      timestamp: null,
    };
  }

  return {
    symbol: structuredQuote?.symbol || symbol,
    title: decodeHtmlEntities(titleMatch?.[1] || structuredQuote?.title || ''),
    exchange: exchangeMatch?.[1] || structuredQuote?.exchange || '',
    price,
    previousClose,
    pctChange: structuredQuote?.pctChange ?? computePercentChange(price, previousClose),
    absChange: structuredQuote?.absChange ?? computeAbsoluteChange(price, previousClose),
    timestamp: timestampMatch?.[1] ? Number(timestampMatch[1]) : structuredQuote?.timestamp ?? null,
    extended,
    dayRange: dayRangeMatch ? decodeHtmlEntities(dayRangeMatch[1]) : '',
    fetchedAt: Date.now(),
  };
}

function extractRssItems(xml, limit = 6) {
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const raw = match[1];
    const title = decodeHtmlEntities((raw.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = decodeHtmlEntities((raw.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const pubDate = decodeHtmlEntities((raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    const description = decodeHtmlEntities((raw.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || raw.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '');
    if (compactWhitespace(title)) {
      items.push({
        title: compactWhitespace(title),
        link: compactWhitespace(link),
        publishedAt: compactWhitespace(pubDate),
        description: compactWhitespace(description.replace(/<[^>]+>/g, ' ')),
      });
    }
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

export async function fetchGoogleNews(ticker, name, config, limit = 4) {
  const query = encodeURIComponent(name ? `${name} OR ${ticker} stock` : `${ticker} stock`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchTextWithRetry(url, { redirect: 'follow' }, { userAgent: config.userAgent });
  return extractRssItems(xml, limit);
}

export async function fetchEarningsCalendar(ticker, config) {
  if (!config.providers.finnhubApiKey || !config.thresholds.earningsEnabled) {
    return null;
  }
  const from = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = new URL('https://finnhub.io/api/v1/calendar/earnings');
  url.searchParams.set('from', from);
  url.searchParams.set('to', toDate);
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('token', config.providers.finnhubApiKey);
  try {
    const text = await fetchTextWithRetry(url.toString(), { redirect: 'follow' }, { userAgent: config.userAgent });
    const payload = JSON.parse(text);
    return Array.isArray(payload?.earningsCalendar) ? payload.earningsCalendar[0] || null : null;
  } catch {
    return null;
  }
}

export async function fetchUsdInrRate(config) {
  try {
    const quote = await fetchGoogleFinanceQuote('USD-INR', config);
    if (quote?.price) {
      return toNumber(quote.price);
    }
  } catch {
    // Fall through.
  }
  try {
    const text = await fetchTextWithRetry('https://open.er-api.com/v6/latest/USD', { redirect: 'follow' }, { userAgent: config.userAgent });
    const payload = JSON.parse(text);
    return toNumber(payload?.rates?.INR) ?? config.thresholds.usdInrRate;
  } catch {
    return config.thresholds.usdInrRate;
  }
}

export function chooseDisplayQuote(quote, sessionClock) {
  if (!sessionClock.isRegular && quote?.extended?.price !== null && quote?.extended?.price !== undefined) {
    return {
      price: toNumber(quote.extended.price),
      movePct: toNumber(quote.extended.pctChange),
      moveAbs: toNumber(quote.extended.absChange),
      basis: quote.extended.kind || 'extended',
      timestamp: quote.extended.timestamp ?? quote.timestamp ?? null,
    };
  }
  return {
    price: toNumber(quote?.price),
    movePct: toNumber(quote?.pctChange),
    moveAbs: toNumber(quote?.absChange),
    basis: 'regular',
    timestamp: quote?.timestamp ?? null,
  };
}

export function quoteIsStale(quote, sessionClock, config, now = Date.now()) {
  const timestamp = toNumber(quote?.timestamp);
  if (timestamp === null) {
    return false;
  }
  const thresholdMinutes = sessionClock.isRegular
    ? config.thresholds.staleRegularMinutes
    : config.thresholds.staleExtendedMinutes;
  return now - timestamp * 1000 > thresholdMinutes * 60 * 1000;
}

