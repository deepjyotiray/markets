import {
  computeAbsoluteChange,
  computePercentChange,
  decodeHtmlEntities,
  fetchTextWithRetry,
  round,
  toNumber,
} from '../portfolio-alerts/utils.js';
import {
  createIndMoneyMcpProvider,
  normalizeMcpUsStockDetails,
} from '../portfolio-alerts/indmoney-mcp.js';
import { normalizeCandles } from './technical-indicators.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; SwingTradeEngine/1.0)';

function parseCsvRows(csv = '') {
  const lines = String(csv).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { date, open, high, low, close, volume };
  });
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function formatYahooDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function extractRssItems(xml, limit = 6) {
  const items = [];
  for (const match of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const raw = match[1];
    const title = decodeHtmlEntities((raw.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = decodeHtmlEntities((raw.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const pubDate = decodeHtmlEntities((raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    const description = decodeHtmlEntities((raw.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || raw.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '');
    if (title.trim()) {
      items.push({
        title: title.replace(/\s+/g, ' ').trim(),
        link: link.trim(),
        publishedAt: pubDate.trim(),
        description: description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      });
    }
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchYahooCandles(symbol, options = {}) {
  const days = Math.max(45, Math.min(Number(options.days || 365), 1825));
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', String(period1));
  url.searchParams.set('period2', String(period2));
  url.searchParams.set('interval', '1d');
  url.searchParams.set('events', 'history');
  url.searchParams.set('includeAdjustedClose', 'true');
  const text = await fetchTextWithRetry(url.toString(), { redirect: 'follow' }, {
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    timeoutMs: options.timeoutMs || 15000,
    maxRetries: options.maxRetries ?? 2,
  });
  const payload = JSON.parse(text);
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  if (!timestamps.length || !Array.isArray(quote.close)) {
    throw new Error(`Yahoo chart data unavailable for ${symbol}`);
  }
  return normalizeCandles(timestamps.map((timestamp, index) => ({
    date: formatYahooDate(timestamp * 1000),
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index],
  })));
}

async function fetchStooqCandles(symbol, options = {}) {
  const days = Math.max(45, Math.min(Number(options.days || 365), 1825));
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const url = new URL('https://stooq.com/q/d/l/');
  url.searchParams.set('s', `${symbol.toLowerCase()}.us`);
  url.searchParams.set('d1', formatDateKey(start));
  url.searchParams.set('d2', formatDateKey(end));
  url.searchParams.set('i', 'd');
  const csv = await fetchTextWithRetry(url.toString(), { redirect: 'follow' }, {
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    timeoutMs: options.timeoutMs || 15000,
    maxRetries: options.maxRetries ?? 2,
  });
  if (/No data/i.test(csv)) throw new Error(`Stooq chart data unavailable for ${symbol}`);
  return normalizeCandles(parseCsvRows(csv));
}

async function fetchFinnhubCandles(symbol, options = {}) {
  if (!options.finnhubApiKey) throw new Error('Finnhub API key unavailable');
  const days = Math.max(45, Math.min(Number(options.days || 365), 1825));
  const to = Math.floor(Date.now() / 1000);
  const from = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL('https://finnhub.io/api/v1/stock/candle');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('resolution', 'D');
  url.searchParams.set('from', String(from));
  url.searchParams.set('to', String(to));
  url.searchParams.set('token', options.finnhubApiKey);
  const text = await fetchTextWithRetry(url.toString(), { redirect: 'follow' }, {
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    timeoutMs: options.timeoutMs || 15000,
    maxRetries: options.maxRetries ?? 2,
  });
  const payload = JSON.parse(text);
  if (payload?.s !== 'ok') throw new Error(`Finnhub candle data unavailable for ${symbol}`);
  return normalizeCandles((payload.c || []).map((close, index) => ({
    date: payload.t?.[index] ? formatYahooDate(payload.t[index] * 1000) : '',
    open: payload.o?.[index],
    high: payload.h?.[index],
    low: payload.l?.[index],
    close,
    volume: payload.v?.[index],
  })));
}

async function fetchGoogleNews(ticker, name, options = {}) {
  const query = encodeURIComponent(name ? `${ticker} ${name} stock earnings analyst news` : `${ticker} stock earnings analyst news`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchTextWithRetry(url, { redirect: 'follow' }, {
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    timeoutMs: options.timeoutMs || 15000,
    maxRetries: options.maxRetries ?? 2,
  });
  return extractRssItems(xml, options.newsLimit || 6);
}

async function fetchFinnhubEarnings(symbol, options = {}) {
  if (!options.finnhubApiKey) return null;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = new URL('https://finnhub.io/api/v1/calendar/earnings');
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', options.finnhubApiKey);
  try {
    const text = await fetchTextWithRetry(url.toString(), { redirect: 'follow' }, {
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      timeoutMs: options.timeoutMs || 15000,
      maxRetries: options.maxRetries ?? 2,
    });
    const payload = JSON.parse(text);
    return Array.isArray(payload?.earningsCalendar) ? payload.earningsCalendar[0] || null : null;
  } catch {
    return null;
  }
}

function normalizeQuoteFromCandles(symbol, candles = [], quote = {}) {
  const latest = candles.at(-1) || {};
  const previous = candles.at(-2) || {};
  const price = toNumber(quote.price) ?? latest.close ?? null;
  const previousClose = toNumber(quote.previousClose) ?? previous.close ?? null;
  const name = quote.name || quote.title || quote.companyName || quote.displayName || symbol;
  return {
    symbol,
    name,
    source: quote.source || 'Historical candles',
    price,
    previousClose,
    pctChange: toNumber(quote.pctChange) ?? computePercentChange(price, previousClose),
    absChange: toNumber(quote.absChange) ?? computeAbsoluteChange(price, previousClose),
    volume: toNumber(quote.volume) ?? latest.volume ?? null,
    marketCap: toNumber(quote.marketCap),
    analystTargetPrice: toNumber(quote.analystTargetPrice),
    analystUpsidePct: toNumber(quote.analystUpsidePct),
    analystSentiment: quote.analystSentiment || null,
    news: Array.isArray(quote.news) ? quote.news : [],
  };
}

export function createSwingDataProvider(options = {}) {
  const provider = createIndMoneyMcpProvider({
    client: options.indmoneyMcpClient,
    cacheSeconds: options.indmoneyMcpCacheSeconds ?? 30,
  });
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;

  async function getMcpDetails(symbols = []) {
    if (!provider.isAvailable() || !symbols.length) return {};
    try {
      const payload = await provider.getUsStocksDetails(symbols, ['analyst', 'news']);
      return normalizeMcpUsStockDetails(payload);
    } catch {
      return {};
    }
  }

  async function getHoldingsAndWatchlistSymbols() {
    const symbols = new Set();
    if (!provider.isAvailable()) return [];
    try {
      const watchlists = await provider.userWatchlist('us');
      for (const list of watchlists?.watchlists || []) {
        for (const stock of list.stocks || []) {
          if (stock?.ticker) symbols.add(String(stock.ticker).toUpperCase());
        }
      }
    } catch {
      // Optional enrichment only.
    }
    return [...symbols];
  }

  async function getCandles(symbol) {
    const attempts = [
      ['Yahoo Finance', () => fetchYahooCandles(symbol, { ...options, userAgent })],
    ];
    const errors = [];
    for (const [source, loader] of attempts) {
      try {
        const candles = await loader();
        if (candles.length) return { source, candles };
      } catch (error) {
        errors.push(`${source}: ${error.message}`);
      }
    }
    throw new Error(errors.join(' | ') || `No candles for ${symbol}`);
  }

  async function getNews(symbol, name, mcpQuote = {}) {
    const mcpNews = Array.isArray(mcpQuote.news)
      ? mcpQuote.news.map((item) => ({
          title: item.title || item.headline || '',
          description: item.summary || item.description || '',
          publishedAt: item.date || item.published_at || '',
          link: item.url || item.link || '',
          sentiment: item.sentiment || null,
        })).filter((item) => item.title)
      : [];
    if (mcpNews.length >= 3) return mcpNews.slice(0, 6);
    try {
      return [...mcpNews, ...(await fetchGoogleNews(symbol, name, { ...options, userAgent }))].slice(0, 6);
    } catch {
      return mcpNews.slice(0, 6);
    }
  }

  async function getBenchmarkMoves() {
    const details = await getMcpDetails(['SPY', 'QQQ', 'SMH']);
    const result = {};
    for (const symbol of ['SPY', 'QQQ', 'SMH']) {
      let quote = details[symbol] || null;
      if (!quote?.pctChange) {
        try {
          const { candles } = await getCandles(symbol);
          quote = normalizeQuoteFromCandles(symbol, candles, quote || {});
        } catch {
          quote = quote || {};
        }
      }
      result[symbol] = round(toNumber(quote?.pctChange) ?? 0, 2);
    }
    return result;
  }

  async function getSymbolBundle(symbol, preloadedDetails = {}, benchmarkMoves = {}) {
    const details = preloadedDetails[symbol] || {};
    const { source, candles } = await getCandles(symbol);
    const quote = normalizeQuoteFromCandles(symbol, candles, details);
    const news = await getNews(symbol, quote.name, details);
    return {
      symbol,
      quote,
      candles,
      candleSource: source,
      news,
      earnings: null,
      benchmarkMoves,
      fetchedAt: new Date().toISOString(),
    };
  }

  return {
    getMcpDetails,
    getHoldingsAndWatchlistSymbols,
    getBenchmarkMoves,
    getSymbolBundle,
  };
}
