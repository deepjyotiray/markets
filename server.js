import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { STOCK_PROFILES } from './src/portfolio-alerts/config.js';
import {
  adjustIndMoneySnapshotForStaleIndianData,
  appendIndMoneyHistoryPoint,
  appendUsPortfolioSeriesPoint,
  buildCurrentHoldingsBaseline,
  buildCurrentHoldingsRepricedSeries,
  buildIndMoneyGrowthSeries,
  buildUsSessionPnlSummary,
  buildUsPortfolioSeriesPayload,
  buildUsPortfolioSeriesPoint,
  normalizeIndMoneyDashboardPayload,
  normalizeIndMoneyHistoryPoint,
  normalizeIndMoneyHoldings,
  normalizeUsPortfolioRange,
} from './src/portfolio-alerts/indmoney-dashboard.js';
import {
  buildIndMoney2Dashboard,
  getIndMoney2FxConfigPayload,
  getIndMoney2Holdings,
  getIndMoney2LivePrices,
  getIndMoney2SeriesRange,
  primeIndMoney2HoldingsCache,
  resolveIndMoney2FxConfigPath,
  resolveIndMoney2HoldingsCachePath,
  resolveIndMoney2PortfolioSeriesPath,
  saveIndMoney2FxConfig,
} from './src/portfolio-alerts/indmoney2-normalizer.js';
import {
  createIndMoneyMcpProvider,
  INDMONEY_GREEKS_LOOKBACKS,
  INDMONEY_OHLC_INTERVALS,
  INDMONEY_OHLC_LOOKBACKS,
  normalizeMcpNetworthSnapshot,
  normalizeMcpUsStockDetails,
  normalizeMcpWatchlists,
  parseCommaList,
  parseMutualFundCategories,
  parseSegments,
  resetDefaultIndMoneyMcpClient,
  validateIndMoneyAssetType,
  validateIndMoneyBreakdownType,
} from './src/portfolio-alerts/indmoney-mcp.js';
import {
  getIndMoneyMcpAdaptiveMinIntervalMs,
  getIndMoneyMcpBlockedUntil,
  noteIndMoneyMcpRateLimit,
  noteIndMoneyMcpSuccess,
  resolveIndMoneyMcpBudgetPath,
} from './src/portfolio-alerts/indmoney-mcp-budget.js';
import { defaultAuthPath, hasIndMoneyMcpHttpAuth, writeAuthFile } from './src/portfolio-alerts/indmoney-mcp-http-client.js';
import {
  buildLatestUsPortfolioSnapshot,
  buildLatestUsPortfolioSnapshotFromIndMoney2Dashboard,
  choosePreferredPortfolioStore,
} from './src/portfolio-alerts/latest-portfolio.js';
import { buildPortfolioEarningsPayload } from './src/portfolio-alerts/portfolio-earnings.js';
import { buildNewsDigest, buildSectorIntelligenceSnapshot } from './src/portfolio-alerts/sector-intelligence.js';
import { buildSwingTradeReport } from './src/swing-trades/swing-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const TRUTH_SOCIAL_WORKER_SCRIPT_PATH = path.join(__dirname, 'scripts', 'truth-social-alerts-worker.mjs');
const TRUTH_SOCIAL_WORKER_SCRIPT_SUFFIX = path.join('scripts', 'truth-social-alerts-worker.mjs');
const TRUTH_SOCIAL_ALERT_STATE_PATH = process.env.TRUTH_SOCIAL_ALERT_STATE_PATH || path.join(__dirname, 'data', 'truth-social-alert-state.json');
const TRUTH_SOCIAL_ALERT_EVENTS_PATH = process.env.TRUTH_SOCIAL_ALERT_EVENTS_PATH || path.join(__dirname, 'data', 'truth-social-alert-events.json');
const TRUTH_SOCIAL_WORKER_LOG_PATH = path.join(__dirname, 'data', 'server.log');

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

loadEnvFile(path.join(__dirname, '.env'));
// Project-local secrets should win over inherited shell exports for this app.
loadEnvFile(path.join(__dirname, '.env.local'), { overrideExisting: true });

const ENGINE_CACHE_TTL_MS = 1000;
const PORTFOLIO_CACHE_TTL_MS = 750;
const QUOTE_CACHE_TTL_MS = 750;
const HEADLINE_CACHE_TTL_MS = 5 * 60 * 1000;
const USDINR_TODAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WATCHLIST_CACHE_TTL_MS = 60 * 1000;
const FETCH_ERROR_CACHE_TTL_MS = 15000;
const LIVE_POLL_MIN_MS = 5000;
const DEFAULT_SNAPSHOT_RETENTION_DAYS = 7;
const DEFAULT_CACHE_MAX_ENTRIES = 250;
const DEFAULT_QUOTE_CACHE_MAX_ENTRIES = 400;
const DEFAULT_HEADLINE_CACHE_MAX_ENTRIES = 250;
const DEFAULT_MCP_CACHE_MAX_ENTRIES = 200;
const DEFAULT_SESSION_CACHE_MAX_ENTRIES = 64;
const DEFAULT_OAUTH_CACHE_MAX_ENTRIES = 32;
const parseRefreshIntervalMs = (value, fallbackMs) => {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(LIVE_POLL_MIN_MS, seconds * 1000);
  }
  return fallbackMs;
};
const LIVE_SESSION_REFRESH_MS = parseRefreshIntervalMs(process.env.PORTFOLIO_ALERTS_POLL_SECONDS_REGULAR, 5 * 1000);
const EXTENDED_SESSION_REFRESH_MS = 60 * 60 * 1000;
const INDMONEY_DASHBOARD_BASE_CACHE_MS = Math.max(
  0,
  Number(process.env.INDMONEY_DASHBOARD_BASE_CACHE_MS || 5 * 60 * 1000),
);
const US_CLOSED_SESSION_REFRESH_MS = parseRefreshIntervalMs(process.env.PORTFOLIO_ALERTS_POLL_SECONDS_CLOSED, 5 * 1000);
let indMoneyMcpResponseCache = {
  payloads: new Map(),
};
const liveSessionStores = {
  indMoneyHistory: [],
  indMoneyUsPortfolioSeries: [],
  aiSignalStore: {
    entries: {},
    watchlistSession: null,
    sectorIntelligenceSession: null,
  },
  dashboardLastSuccess: null,
};
let indMoneyDashboardBaseCache = {
  expiresAt: 0,
  payload: null,
  promise: null,
  sessionRefreshMs: null,
};
let engineResponseCache = {
  expiresAt: 0,
  payload: null,
  promise: null,
};
let portfolioResponseCache = {
  expiresAt: 0,
  payload: null,
  promise: null,
};
let watchlistResponseCache = {
  expiresAt: 0,
  payload: null,
  promise: null,
};
let sectorIntelligenceCache = {
  expiresAt: 0,
  payload: null,
  promise: null,
};
let swingTradeCache = {
  expiresAt: 0,
  payload: null,
  promise: null,
};
let swingTradeRunStatus = {
  running: false,
  startedAt: null,
  completedAt: null,
  error: null,
};
const indMoneyOauthStates = new Map();
const indMoneyDashboardSessions = new Map();
const aiSignalCache = new Map();
const quoteCache = new Map();
const headlineCache = new Map();
const indMoneyDashboardFxRateCache = new Map();

function invalidateEngineCache(options = {}) {
  const clearLiveRequestCaches = options.clearLiveRequestCaches !== false;
  engineResponseCache = {
    expiresAt: 0,
    payload: null,
    promise: null,
  };
  if (clearLiveRequestCaches) {
    portfolioResponseCache = {
      expiresAt: 0,
      payload: null,
      promise: null,
    };
    watchlistResponseCache = {
      expiresAt: 0,
      payload: null,
      promise: null,
    };
  }
  sectorIntelligenceCache = {
    expiresAt: 0,
    payload: null,
    promise: null,
  };
  swingTradeCache = {
    expiresAt: 0,
    payload: null,
    promise: null,
  };
  if (clearLiveRequestCaches) {
    quoteCache.clear();
    headlineCache.clear();
    indMoneyDashboardFxRateCache.clear();
    indMoneyMcpResponseCache = {
      payloads: new Map(),
    };
  }
}

function invalidateIndMoneyDashboardBaseCache() {
  indMoneyDashboardBaseCache = {
    expiresAt: 0,
    payload: null,
    promise: null,
    sessionRefreshMs: null,
  };
}

const INDIA = 'IND';
const US = 'US';

const CONFIG = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4012),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://markets.healthymealspot.com').replace(/\/+$/, ''),
  timezone: process.env.TZ || 'Asia/Kolkata',
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (compatible; MarketDashboard/2.0; +https://markets.healthymealspot.com)',
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || '',
  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5',
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'minimal',
  openaiSignalCacheMinutes: Number(process.env.OPENAI_SIGNAL_CACHE_MINUTES || 15),
  indMoneyMcpEnabled: !['0', 'false', 'no', 'off'].includes(String(process.env.INDMONEY_MCP_ENABLED ?? 'true').toLowerCase()),
  indMoneyMcpSourcePriority: process.env.INDMONEY_MCP_SOURCE_PRIORITY || 'mcp_first',
  indMoneyMcpCacheSeconds: Number(process.env.INDMONEY_MCP_CACHE_SECONDS || 30),
  indMoneyMcpIssuer: process.env.INDMONEY_MCP_ISSUER || 'https://mcp.indmoney.com',
  indMoneyMcpScopes: process.env.INDMONEY_MCP_SCOPES || 'portfolio:read market:read',
  indMoneyMcpAuthPath: process.env.INDMONEY_MCP_AUTH_PATH || defaultAuthPath(),
  indMoneyDashboardPasscode: process.env.INDMONEY_DASHBOARD_PASSCODE || process.env.WHATSAPP_AGENT_SECRET || '',
  indMoneyDashboardCookieName: process.env.INDMONEY_DASHBOARD_COOKIE_NAME || 'indmoney_dashboard_session',
  indMoneyDashboardSessionDays: Number(process.env.INDMONEY_DASHBOARD_SESSION_DAYS || 7),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  collectIntervalMinutes: Number(process.env.COLLECT_INTERVAL_MINUTES || 15),
  snapshotRetentionDays: Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS || DEFAULT_SNAPSHOT_RETENTION_DAYS)),
  maxRetries: Number(process.env.MAX_RETRIES || 3),
  retryBackoffMs: Number(process.env.RETRY_BACKOFF_MS || 1500),
  dataFile: path.join(__dirname, 'data', 'snapshots.json'),
  snapshotArchiveFile: path.join(__dirname, 'data', 'snapshots.archive.json'),
  portfolioFile: path.join(__dirname, 'data', 'portfolio.json'),
  latestPortfolioFile: path.join(__dirname, 'data', 'latest-portfolio.json'),
  indMoneyHistoryFile: path.join(__dirname, 'data', 'indmoney-networth-history.json'),
  indMoneyUsPortfolioSeriesFile: path.join(__dirname, 'data', 'indmoney-us-portfolio-series.json'),
  aiCacheFile: path.join(__dirname, 'data', 'ai-signals.json'),
  layoutFile: path.join(__dirname, 'data', 'layout.json'),
  uiPath: path.join(__dirname, 'public', 'index.html'),
  portfolioAlertsUiPath: path.join(__dirname, 'public', 'portfolio-alerts.html'),
  portfolioEarningsUiPath: path.join(__dirname, 'public', 'portfolio-earnings.html'),
  swingTradesUiPath: path.join(__dirname, 'public', 'swing-trades.html'),
  portfolioEarningsResearchFile: path.join(__dirname, 'data', 'portfolio-earnings-research.json'),
  stateFile: path.join(__dirname, 'data', 'state.json'),
  indMoney2FxConfigFile: resolveIndMoney2FxConfigPath(__dirname),
  indMoney2HoldingsCacheFile: resolveIndMoney2HoldingsCachePath(__dirname),
  indMoney2PortfolioSeriesFile: resolveIndMoney2PortfolioSeriesPath(__dirname),
  indMoneyMcpBudgetFile: resolveIndMoneyMcpBudgetPath(__dirname),
  urls: {
    alphaVantage: 'https://www.alphavantage.co/query',
    alphaVantageMcp: 'https://mcp.alphavantage.co/mcp',
    finnhub: 'https://finnhub.io/api/v1',
    openaiResponses: 'https://api.openai.com/v1/responses',
    googleFinanceQuote: 'https://www.google.com/finance/quote/',
    googleNewsIndia:
      'https://news.google.com/rss/search?q=Indian%20stock%20market&hl=en-IN&gl=IN&ceid=IN:en',
    googleNewsIndiaEvents:
      'https://news.google.com/rss/search?q=RBI%20policy%20OR%20India%20CPI%20OR%20India%20GDP%20OR%20India%20election%20OR%20Nifty%20earnings&hl=en-IN&gl=IN&ceid=IN:en',
    googleNewsUs:
      'https://news.google.com/rss/search?q=US%20stock%20market%20OR%20Federal%20Reserve%20OR%20Treasury%20yields%20OR%20oil&hl=en-US&gl=US&ceid=US:en',
    googleNewsFed:
      'https://news.google.com/rss/search?q=Federal%20Reserve%20OR%20Fed%20OR%20Powell&hl=en-US&gl=US&ceid=US:en',
    googleNewsOil:
      'https://news.google.com/rss/search?q=oil%20market%20OR%20brent%20OR%20wti&hl=en-US&gl=US&ceid=US:en',
    googleNewsUsEarnings:
      'https://news.google.com/rss/search?q=US%20earnings%20today%20OR%20after%20market%20close%20earnings&hl=en-US&gl=US&ceid=US:en',
    openExchangeUsd: 'https://open.er-api.com/v6/latest/USD',
    fredBrentCsv: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU',
    fredUsRatesCsv: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10,DGS2',
    fredDxyCsv: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS',
    iciciGiftNifty: 'https://www.icicidirect.com/equity/index/gift-nifty',
    giftPrimary: 'https://www.moneycontrol.com/indian-indices/-4993351.html',
    giftFallback: 'https://www.moneycontrol.com/indian-indices/-4902491.html',
    fiiDii: 'https://www.moneycontrol.com/markets/fii-dii-data/cash/',
    marketNews: 'https://www.moneycontrol.com/news/tags/market.html',
    nseHome: 'https://www.nseindia.com/',
    nseAllIndices: 'https://www.nseindia.com/api/allIndices',
    nseMarketStatus: 'https://www.nseindia.com/api/marketStatus',
    nsePreOpen: 'https://www.nseindia.com/api/market-data-pre-open',
    nseBreadthPage: 'https://www.nseindia.com/market-data/decline',
    indiaVixFallback: 'https://www.moneycontrol.com/india/indexfno/indiavix-17.html',
    tradingEconomicsCalendar: 'https://tradingeconomics.com/calendar',
    tradingEconomicsUsCurrency: 'https://tradingeconomics.com/united-states/currency',
    tradingEconomicsBrent: 'https://tradingeconomics.com/commodity/brent-crude-oil',
    tradingEconomicsWti: 'https://tradingeconomics.com/commodity/crude-oil',
    tradingEconomicsGold: 'https://tradingeconomics.com/commodity/gold',
  },
  usWishlistCandidates: [
    { ticker: 'PLTR', name: 'Palantir Technologies Inc.', amount: 300 },
    { ticker: 'CRWV', name: 'CoreWeave, Inc.', amount: 250 },
    { ticker: 'SMCI', name: 'Super Micro Computer, Inc.', amount: 200 },
    { ticker: 'VRT', name: 'Vertiv Holdings Co', amount: 150 },
    { ticker: 'ARM', name: 'Arm Holdings plc', amount: 100 },
    { ticker: 'ALMU', name: 'Aeluma, Inc.', amount: 100 },
    { ticker: 'AIRJ', name: 'AirJoule Technologies Corporation', amount: 100 },
    { ticker: 'AMPX', name: 'Amprius Technologies, Inc.', amount: 100 },
    { ticker: 'ZS', name: 'Zscaler, Inc.', amount: 150 },
    { ticker: 'MRAM', name: 'Everspin Technologies, Inc.', amount: 100 },
    { ticker: 'CEG', name: 'Constellation Energy Corporation', amount: 150 },
    { ticker: 'VST', name: 'Vistra Corp.', amount: 150 },
    { ticker: 'GLD', name: 'SPDR Gold Shares', amount: 100 },
    { ticker: 'SLV', name: 'iShares Silver Trust', amount: 100 },
    { ticker: 'LLY', name: 'Eli Lilly and Company', amount: 150 },
    { ticker: 'UNH', name: 'UnitedHealth Group Incorporated', amount: 150 },
    { ticker: 'CVS', name: 'CVS Health Corporation', amount: 100 },
    { ticker: 'SOFI', name: 'SoFi Technologies, Inc.', amount: 100 },
    { ticker: 'TSLA', name: 'Tesla, Inc.', amount: 150 },
    { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', amount: 150 },
    { ticker: 'USO', name: 'United States Oil Fund LP', amount: 100 },
  ],
  thresholds: {
    india: {
      giftPositivePct: 0.25,
      giftNegativePct: -0.25,
      brentPositiveForIndiaPct: -1.0,
      brentNegativeForIndiaPct: 1.0,
      usdInrPositiveChange: -0.15,
      usdInrNegativeChange: 0.15,
      indiaVixPositiveChange: -0.5,
      indiaVixNegativeChange: 0.5,
      advanceDeclinePositive: 1.2,
      advanceDeclineNegative: 0.9,
      fiiNetPositive: 0.01,
      fiiNetNegative: -0.01,
      diiNetPositive: 0.01,
      diiNetNegative: -0.01,
      riskOnScore: 3,
      defensiveScore: -3,
      minSignalsForRegime: 4,
    },
    us: {
      riskOnFloor: 4,
      neutralFloor: 2,
    },
  },
  usWatchlist: ['SPY', 'TSLA', 'AMD', 'META', 'NVDA', 'AMZN', 'AAPL', 'MSFT', 'MU', 'CEG', 'VST', 'GLD', 'SLV', 'LLY', 'UNH', 'CVS', 'SOFI', 'USO'],
  usSectors: [
    { symbol: 'XLK', name: 'Technology' },
    { symbol: 'XLC', name: 'Communication Services' },
    { symbol: 'XLY', name: 'Consumer Discretionary' },
    { symbol: 'XLF', name: 'Financials' },
    { symbol: 'XLV', name: 'Health Care' },
    { symbol: 'XLI', name: 'Industrials' },
    { symbol: 'XLP', name: 'Consumer Staples' },
    { symbol: 'XLU', name: 'Utilities' },
    { symbol: 'XLE', name: 'Energy' },
    { symbol: 'XLB', name: 'Materials' },
    { symbol: 'XLRE', name: 'Real Estate' },
  ],
  usSymbols: {
    futures: {
      sp: 'ESW00:CME_EMINIS',
      nasdaq: 'NQW00:CME_EMINIS',
      dow: 'YMW00:CBOT',
      russell: 'RTYW00:CME',
    },
    indices: {
      sox: 'SOX:INDEXNASDAQ',
      qqq: 'QQQ:NASDAQ',
    },
    volatility: {
      vix: 'VIX:INDEXCBOE',
    },
    rates: {
      us10y: 'TNX:INDEXCBOE',
    },
    commodities: {
      wti: 'CLW00:NYMEX',
      gold: 'GCW00:COMEX',
    },
    watchlist: {
      SPY: 'SPY:NYSEARCA',
      TSLA: 'TSLA:NASDAQ',
      AMD: 'AMD:NASDAQ',
      META: 'META:NASDAQ',
      NVDA: 'NVDA:NASDAQ',
      AMZN: 'AMZN:NASDAQ',
      AAPL: 'AAPL:NASDAQ',
      MSFT: 'MSFT:NASDAQ',
      MU: 'MU:NASDAQ',
      CEG: 'CEG:NASDAQ',
      VST: 'VST:NYSE',
      GLD: 'GLD:NYSEARCA',
      SLV: 'SLV:NYSEARCA',
      LLY: 'LLY:NYSE',
      UNH: 'UNH:NYSE',
      CVS: 'CVS:NYSE',
      SOFI: 'SOFI:NASDAQ',
      USO: 'USO:NYSEARCA',
    },
    portfolio: {
      MU: 'MU:NASDAQ',
      NVDA: 'NVDA:NASDAQ',
      AMD: 'AMD:NASDAQ',
      GOOGL: 'GOOGL:NASDAQ',
      AVGO: 'AVGO:NASDAQ',
      AMZN: 'AMZN:NASDAQ',
      AAPL: 'AAPL:NASDAQ',
      INTC: 'INTC:NASDAQ',
      META: 'META:NASDAQ',
      TSM: 'TSM:NYSE',
    },
    sectors: {
      XLK: 'XLK:NYSEARCA',
      XLC: 'XLC:NASDAQ',
      XLY: 'XLY:NYSEARCA',
      XLF: 'XLF:NYSEARCA',
      XLV: 'XLV:NYSEARCA',
      XLI: 'XLI:NYSEARCA',
      XLP: 'XLP:NYSEARCA',
      XLU: 'XLU:NYSEARCA',
      XLE: 'XLE:NYSEARCA',
      XLB: 'XLB:NYSEARCA',
      XLRE: 'XLRE:NYSEARCA',
    },
    semis: {
      SMH: 'SMH:NASDAQ',
      AVGO: 'AVGO:NASDAQ',
      QCOM: 'QCOM:NASDAQ',
    },
  },
};

let isCollecting = false;
let collectTimer = null;
let collectStarterTimer = null;

async function ensureFiles() {
  await fsp.mkdir(path.dirname(CONFIG.dataFile), { recursive: true });
  await fsp.mkdir(path.dirname(CONFIG.uiPath), { recursive: true });

  if (!fs.existsSync(CONFIG.dataFile)) {
    await fsp.writeFile(CONFIG.dataFile, '[]\n', 'utf8');
  }

  if (!fs.existsSync(CONFIG.snapshotArchiveFile)) {
    await fsp.writeFile(CONFIG.snapshotArchiveFile, '[]\n', 'utf8');
  }

  if (!fs.existsSync(CONFIG.portfolioFile)) {
    await fsp.writeFile(CONFIG.portfolioFile, JSON.stringify({ US: null, IND: null }, null, 2) + '\n', 'utf8');
  }

  if (!fs.existsSync(CONFIG.latestPortfolioFile)) {
    if (fs.existsSync(CONFIG.portfolioFile)) {
      await fsp.copyFile(CONFIG.portfolioFile, CONFIG.latestPortfolioFile);
    } else {
      await fsp.writeFile(CONFIG.latestPortfolioFile, JSON.stringify({ US: null, IND: null }, null, 2) + '\n', 'utf8');
    }
  }

  if (!fs.existsSync(CONFIG.indMoneyHistoryFile)) {
    await fsp.writeFile(CONFIG.indMoneyHistoryFile, '[]\n', 'utf8');
  }

  if (!fs.existsSync(CONFIG.aiCacheFile)) {
    await fsp.writeFile(
      CONFIG.aiCacheFile,
      JSON.stringify({ entries: {}, watchlistSession: null, sectorIntelligenceSession: null }, null, 2) + '\n',
      'utf8',
    );
  }

  if (!fs.existsSync(CONFIG.layoutFile)) {
    await fsp.writeFile(CONFIG.layoutFile, JSON.stringify({ widgets: null }, null, 2) + '\n', 'utf8');
  }

  if (!fs.existsSync(CONFIG.stateFile)) {
    await fsp.writeFile(
      CONFIG.stateFile,
      JSON.stringify({ lastRegimeByMarket: { [INDIA]: null, [US]: null } }, null, 2) + '\n',
      'utf8',
    );
  }

  for (const portfolio of getPortfolioDefinitions()) {
    if (!fs.existsSync(portfolio.fxConfigPath)) {
      await fsp.writeFile(portfolio.fxConfigPath, JSON.stringify({}, null, 2) + '\n', 'utf8');
    }
    if (!fs.existsSync(portfolio.holdingsCachePath)) {
      await fsp.writeFile(portfolio.holdingsCachePath, JSON.stringify({}, null, 2) + '\n', 'utf8');
    }
    if (!fs.existsSync(portfolio.portfolioSeriesPath)) {
      await fsp.writeFile(portfolio.portfolioSeriesPath, '[]\n', 'utf8');
    }
  }
}

function normalizeMarket(value) {
  const market = String(value || '').trim().toUpperCase();
  if (market === INDIA || market === US) {
    return market;
  }
  return null;
}

function normalizeSnapshot(snapshot) {
  return {
    ...snapshot,
    market: normalizeMarket(snapshot.market) || INDIA,
  };
}

async function readSnapshots() {
  try {
    const raw = await fsp.readFile(CONFIG.dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeSnapshot) : [];
  } catch (error) {
    console.error('Failed to read snapshots:', error.message);
    return [];
  }
}

async function readSnapshotArchive() {
  try {
    const raw = await fsp.readFile(CONFIG.snapshotArchiveFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeSnapshot) : [];
  } catch (error) {
    console.error('Failed to read snapshot archive:', error.message);
    return [];
  }
}

async function readAllSnapshots() {
  const [archiveSnapshots, hotSnapshots] = await Promise.all([readSnapshotArchive(), readSnapshots()]);
  return archiveSnapshots.concat(hotSnapshots);
}

function findLatestSnapshots(snapshots) {
  let latestInd = null;
  let latestUs = null;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (!latestInd && snapshot?.market === INDIA) {
      latestInd = snapshot;
    } else if (!latestUs && snapshot?.market === US) {
      latestUs = snapshot;
    }
    if (latestInd && latestUs) {
      break;
    }
  }
  return {
    latestInd,
    latestUs,
  };
}

async function readDashboardState() {
  const [snapshots, portfolioStore] = await Promise.all([readSnapshots(), readPortfolioStore()]);
  return {
    snapshots,
    portfolioStore,
    ...findLatestSnapshots(snapshots),
  };
}

async function writeSnapshots(snapshots) {
  await fsp.writeFile(CONFIG.dataFile, JSON.stringify(snapshots, null, 2) + '\n', 'utf8');
}

async function writeSnapshotArchive(snapshots) {
  await fsp.writeFile(CONFIG.snapshotArchiveFile, JSON.stringify(snapshots, null, 2) + '\n', 'utf8');
}

function getSnapshotRetentionPerMarket(retentionDays = CONFIG.snapshotRetentionDays) {
  const pointsPerDay = Math.max(1, Math.ceil((24 * 60) / Math.max(1, CONFIG.collectIntervalMinutes)));
  return Math.max(pointsPerDay * retentionDays, 96);
}

export function partitionSnapshotsForRetention(snapshots = [], retentionPerMarket = getSnapshotRetentionPerMarket()) {
  const grouped = new Map();
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = {
      ...normalizeSnapshot(snapshots[index]),
      __index: index,
    };
    const market = snapshot.market || INDIA;
    if (!grouped.has(market)) {
      grouped.set(market, []);
    }
    grouped.get(market).push(snapshot);
  }

  const hot = [];
  const archived = [];
  for (const marketSnapshots of grouped.values()) {
    const cutIndex = Math.max(0, marketSnapshots.length - retentionPerMarket);
    archived.push(...marketSnapshots.slice(0, cutIndex));
    hot.push(...marketSnapshots.slice(cutIndex));
  }

  hot.sort((a, b) => a.__index - b.__index);
  archived.sort((a, b) => a.__index - b.__index);
  return {
    hot: hot.map(({ __index, ...snapshot }) => snapshot),
    archived: archived.map(({ __index, ...snapshot }) => snapshot),
  };
}

async function compactSnapshotStorage() {
  const hotSnapshots = await readSnapshots();
  const retentionPerMarket = getSnapshotRetentionPerMarket();
  const { hot, archived } = partitionSnapshotsForRetention(hotSnapshots, retentionPerMarket);
  if (!archived.length) {
    return {
      archivedCount: 0,
      hotCount: hotSnapshots.length,
      retentionPerMarket,
    };
  }
  const archivedSnapshots = await readSnapshotArchive();
  await writeSnapshotArchive(archivedSnapshots.concat(archived));
  await writeSnapshots(hot);
  return {
    archivedCount: archived.length,
    hotCount: hot.length,
    retentionPerMarket,
  };
}

async function readIndMoneyHistory() {
  return liveSessionStores.indMoneyHistory.slice();
}

async function writeIndMoneyHistory(history) {
  liveSessionStores.indMoneyHistory = Array.isArray(history) ? history.slice() : [];
}

async function readIndMoneyUsPortfolioSeries() {
  return liveSessionStores.indMoneyUsPortfolioSeries.slice();
}

async function writeIndMoneyUsPortfolioSeries(series) {
  liveSessionStores.indMoneyUsPortfolioSeries = Array.isArray(series) ? series.slice() : [];
}

async function readPortfolioStore() {
  try {
    const [latestRaw, legacyRaw] = await Promise.all([
      fsp.readFile(CONFIG.latestPortfolioFile, 'utf8').catch(() => null),
      fsp.readFile(CONFIG.portfolioFile, 'utf8').catch(() => null),
    ]);
    const latestStore = latestRaw ? JSON.parse(latestRaw) : {};
    const legacyStore = legacyRaw ? JSON.parse(legacyRaw) : {};
    const preferred = choosePreferredPortfolioStore(latestStore, legacyStore);
    return {
      US: preferred?.US || null,
      IND: preferred?.IND || null,
    };
  } catch (error) {
    console.error('Portfolio snapshot read failed:', error.message);
    return {
      US: null,
      IND: null,
    };
  }
}

async function writePortfolioStore(store = {}) {
  const payload = {
    US: store?.US || null,
    IND: store?.IND || null,
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  await Promise.all([
    fsp.writeFile(CONFIG.latestPortfolioFile, serialized, 'utf8'),
    fsp.writeFile(CONFIG.portfolioFile, serialized, 'utf8'),
  ]);
  return payload;
}

async function persistLatestUsPortfolioReference({ summary = {}, holdings = [], updatedAt, source = 'INDmoney MCP' } = {}) {
  if (!Array.isArray(holdings) || !holdings.length) {
    return null;
  }
  const currentStore = await readPortfolioStore();
  const nextUs = buildLatestUsPortfolioSnapshot({
    summary,
    holdings,
    updatedAt,
    source,
    previousUs: currentStore?.US || null,
  });
  await writePortfolioStore({
    ...currentStore,
    US: nextUs,
  });
  return nextUs;
}

async function persistCanonicalLatestUsPortfolioReference() {
  const currentStore = await readPortfolioStore();
  const dashboard = await buildPortfolioDashboard('deep');
  const nextUs = buildLatestUsPortfolioSnapshotFromIndMoney2Dashboard(dashboard, currentStore?.US || null);
  await writePortfolioStore({
    ...currentStore,
    US: nextUs,
  });
  return nextUs;
}

async function readPortfolioEarningsResearch() {
  const raw = await fsp.readFile(CONFIG.portfolioEarningsResearchFile, 'utf8');
  return JSON.parse(raw);
}

async function readPortfolioEarningsPayload() {
  const [portfolioStore, research] = await Promise.all([
    readPortfolioStore(),
    readPortfolioEarningsResearch(),
  ]);
  return buildPortfolioEarningsPayload(portfolioStore, research);
}

async function readAiSignalStore() {
  return {
    entries: { ...(liveSessionStores.aiSignalStore.entries || {}) },
    watchlistSession: liveSessionStores.aiSignalStore.watchlistSession || null,
    sectorIntelligenceSession: liveSessionStores.aiSignalStore.sectorIntelligenceSession || null,
  };
}

async function writeAiSignalStore(store) {
  liveSessionStores.aiSignalStore = {
    entries: store?.entries && typeof store.entries === 'object' ? { ...store.entries } : {},
    watchlistSession: store?.watchlistSession || null,
    sectorIntelligenceSession: store?.sectorIntelligenceSession || null,
  };
}

async function persistAiSignalCacheEntry(cacheKey, value, expiresAt) {
  const store = await readAiSignalStore();
  store.entries[cacheKey] = {
    expiresAt,
    value,
    savedAt: nowTimestamp(),
  };
  await writeAiSignalStore(store);
}

async function loadPersistedAiSignalCacheEntry(cacheKey) {
  cleanupHotCaches();
  const store = await readAiSignalStore();
  const entry = store.entries?.[cacheKey];
  if (!entry) {
    return null;
  }
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    delete store.entries[cacheKey];
    await writeAiSignalStore(store);
    return null;
  }
  return entry;
}

async function persistWatchlistSessionPayload(payload) {
  const store = await readAiSignalStore();
  store.watchlistSession = {
    savedAt: nowTimestamp(),
    payload,
  };
  await writeAiSignalStore(store);
}

async function loadPersistedWatchlistSessionPayload() {
  const store = await readAiSignalStore();
  const entry = store.watchlistSession;
  if (!entry || !entry.payload || typeof entry.payload !== 'object') {
    return null;
  }
  const configuredTickers = CONFIG.usWishlistCandidates.map((item) => String(item.ticker || '').toUpperCase()).sort();
  const persistedTickers = Array.isArray(entry.payload?.stocksPayload?.stocks)
    ? entry.payload.stocksPayload.stocks.map((item) => String(item?.ticker || '').toUpperCase()).sort()
    : [];
  if (
    configuredTickers.length !== persistedTickers.length ||
    configuredTickers.some((ticker, index) => ticker !== persistedTickers[index])
  ) {
    return null;
  }
  const stocks = Array.isArray(entry.payload?.stocksPayload?.stocks) ? entry.payload.stocksPayload.stocks : [];
  const hasFinancialCoverage = stocks.some(
    (item) => item?.financialSnapshot && Object.keys(item.financialSnapshot).length,
  );
  if (!hasFinancialCoverage) {
    return null;
  }
  return entry.payload;
}

async function persistSectorIntelligenceSessionPayload(payload) {
  const store = await readAiSignalStore();
  const previous = store.sectorIntelligenceSession?.payload || null;
  store.sectorIntelligenceSession = {
    savedAt: nowTimestamp(),
    payload,
    previousPayload: previous,
  };
  await writeAiSignalStore(store);
}

async function loadPersistedSectorIntelligenceSessionPayload() {
  const store = await readAiSignalStore();
  const entry = store.sectorIntelligenceSession;
  if (!entry?.payload || typeof entry.payload !== 'object') {
    return null;
  }
  return entry;
}

async function maybePrimeWatchlistSessionCache() {
  const persisted = await loadPersistedWatchlistSessionPayload();
  if (persisted?.watchlistAiPayload && persisted?.stocksPayload) {
    return persisted;
  }
  try {
    const payload = await buildLiveWatchlistPayloads();
    watchlistResponseCache = {
      expiresAt: Date.now() + WATCHLIST_CACHE_TTL_MS,
      payload,
      promise: null,
    };
    return payload;
  } catch (error) {
    console.error('Initial watchlist session prime failed:', error.message);
    return null;
  }
}

async function prunePersistedAiSignalStore() {
  const store = await readAiSignalStore();
  let changed = false;
  Object.keys(store.entries || {}).forEach((key) => {
    const entry = store.entries[key];
    if (!entry?.expiresAt || entry.expiresAt <= Date.now()) {
      delete store.entries[key];
      changed = true;
    }
  });
  if (changed) {
    await writeAiSignalStore(store);
  }
}

async function readState() {
  try {
    const raw = await fsp.readFile(CONFIG.stateFile, 'utf8');
    const state = JSON.parse(raw);
    return {
      lastRegimeByMarket: {
        [INDIA]: state?.lastRegimeByMarket?.[INDIA] ?? state?.lastRegime ?? null,
        [US]: state?.lastRegimeByMarket?.[US] ?? null,
      },
    };
  } catch {
    return {
      lastRegimeByMarket: {
        [INDIA]: null,
        [US]: null,
      },
    };
  }
}

async function writeState(state) {
  await fsp.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function readLayoutStore() {
  try {
    const raw = await fsp.readFile(CONFIG.layoutFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      widgets: parsed?.widgets && typeof parsed.widgets === 'object' ? parsed.widgets : null,
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (error) {
    console.error('Failed to read layout store:', error.message);
    return {
      widgets: null,
      updatedAt: null,
    };
  }
}

async function writeLayoutStore(layout) {
  await fsp.writeFile(
    CONFIG.layoutFile,
    JSON.stringify({ widgets: layout, updatedAt: nowTimestamp() }, null, 2) + '\n',
    'utf8',
  );
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return new URLSearchParams(raw);
}

function filterSnapshotsByMarket(snapshots, market) {
  const normalized = normalizeMarket(market);
  if (!normalized) {
    return snapshots;
  }
  return snapshots.filter((snapshot) => (snapshot.market || INDIA) === normalized);
}

function jsonResponse(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonFileSafe(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function listTruthSocialWorkerProcesses() {
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter((item) => (
        item
        && item.pid !== process.pid
        && (
          item.command.includes(TRUTH_SOCIAL_WORKER_SCRIPT_PATH)
          || item.command.includes(TRUTH_SOCIAL_WORKER_SCRIPT_SUFFIX)
        )
      ));
  } catch {
    return [];
  }
}

async function buildTruthSocialWorkerRuntimeSnapshot() {
  const [processes, state, events] = await Promise.all([
    listTruthSocialWorkerProcesses(),
    readJsonFileSafe(TRUTH_SOCIAL_ALERT_STATE_PATH, {}),
    readJsonFileSafe(TRUTH_SOCIAL_ALERT_EVENTS_PATH, []),
  ]);
  const recentUsage = (Array.isArray(events) ? events : [])
    .filter((item) => item?.type === 'openai_usage')
    .slice(-20)
    .reverse();
  return {
    running: processes.length > 0,
    pid: processes[0]?.pid || null,
    pids: processes.map((item) => item.pid),
    processCount: processes.length,
    workerManaged: true,
    lastRunAt: state?.updatedAt || null,
    lastScrapeAt: state?.updatedAt || null,
    lastDeliveryAt: state?.lastDeliveryAt || null,
    lastSeenId: state?.lastSeenId || null,
    config: {
      enabled: !['0', 'false', 'no', 'off'].includes(String(process.env.TRUTH_SOCIAL_ALERTS_ENABLED ?? 'true').toLowerCase()),
      source: process.env.TRUTH_SOCIAL_ALERT_SOURCE || 'rss',
      accountHandle: process.env.TRUTH_SOCIAL_ACCOUNT_HANDLE || 'realDonaldTrump',
      pollingIntervalMs: Math.max(1_000, Number(process.env.TRUTH_SOCIAL_ALERTS_POLL_SECONDS || 5) * 1000),
      statePath: TRUTH_SOCIAL_ALERT_STATE_PATH,
      eventsPath: TRUTH_SOCIAL_ALERT_EVENTS_PATH,
    },
    recentUsage,
  };
}

async function startTruthSocialWorkerProcess() {
  const current = await listTruthSocialWorkerProcesses();
  if (current.length) {
    return { ok: true, started: false, runtime: await buildTruthSocialWorkerRuntimeSnapshot() };
  }
  let logFd = null;
  try {
    logFd = fs.openSync(TRUTH_SOCIAL_WORKER_LOG_PATH, 'a');
    const child = spawn(process.execPath, [TRUTH_SOCIAL_WORKER_SCRIPT_PATH], {
      cwd: __dirname,
      env: {
        ...process.env,
        TRUTH_SOCIAL_ALERTS_ENABLED: String(process.env.TRUTH_SOCIAL_ALERTS_ENABLED || 'true'),
      },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
  } finally {
    if (logFd !== null) {
      fs.closeSync(logFd);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { ok: true, started: true, runtime: await buildTruthSocialWorkerRuntimeSnapshot() };
}

async function stopTruthSocialWorkerProcess() {
  const processes = await listTruthSocialWorkerProcesses();
  for (const item of processes) {
    try {
      process.kill(item.pid, 'SIGTERM');
    } catch {
      // Ignore already-dead processes.
    }
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const remaining = await listTruthSocialWorkerProcesses();
    if (!remaining.length) {
      return { ok: true, stopped: processes.length > 0, runtime: await buildTruthSocialWorkerRuntimeSnapshot() };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const lingering = await listTruthSocialWorkerProcesses();
  for (const item of lingering) {
    try {
      process.kill(item.pid, 'SIGKILL');
    } catch {
      // Ignore already-dead processes.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { ok: true, stopped: processes.length > 0, runtime: await buildTruthSocialWorkerRuntimeSnapshot() };
}

function getIndMoneyMcpProvider() {
  return createIndMoneyMcpProvider({
    cacheSeconds: CONFIG.indMoneyMcpCacheSeconds,
  });
}

async function withIndMoneyMcpCache(key, producer) {
  if (!CONFIG.indMoneyMcpEnabled) {
    throw new Error('INDmoney MCP is disabled by INDMONEY_MCP_ENABLED');
  }
  cleanupHotCaches();
  const now = Date.now();
  const minimumSpacingMs = await getIndMoneyMcpAdaptiveMinIntervalMs(CONFIG.indMoneyMcpBudgetFile, {
    minimumSpacingMs: Math.max(0, CONFIG.indMoneyMcpCacheSeconds * 1000),
  });
  const blockedUntil = await getIndMoneyMcpBlockedUntil(CONFIG.indMoneyMcpBudgetFile, key, now);
  const cachedEntry = indMoneyMcpResponseCache.payloads.get(key) || null;
  if (cachedEntry && now - cachedEntry.fetchedAt < minimumSpacingMs) {
    return cachedEntry.payload;
  }
  if (cachedEntry && blockedUntil > now) {
    return cachedEntry.payload;
  }
  const provider = getIndMoneyMcpProvider();
  if (!provider.isAvailable()) {
    throw new Error('INDmoney MCP client is not available in this Node runtime');
  }
  const payload = await producer(provider);
  if (String(payload?.error || '').trim().toLowerCase() === 'rate_limit_exceeded') {
    await noteIndMoneyMcpRateLimit(
      CONFIG.indMoneyMcpBudgetFile,
      key,
      Math.max(1, Math.floor(toNumber(payload?.retry_after_seconds) || 60)),
      now,
    );
    if (cachedEntry) {
      return cachedEntry.payload;
    }
    return payload;
  }
  await noteIndMoneyMcpSuccess(CONFIG.indMoneyMcpBudgetFile, key, now);
  indMoneyMcpResponseCache.payloads.set(key, {
    payload,
    fetchedAt: now,
  });
  cleanupHotCaches();
  return payload;
}

function indMoneyErrorResponse(res, error) {
  const unavailable = /not available|disabled/i.test(error.message || '');
  return jsonResponse(res, unavailable ? 503 : 500, {
    ok: false,
    error: error.message,
  });
}

function requireQueryList(res, url, name, normalizer = (item) => item) {
  const values = parseCommaList(url.searchParams.get(name), normalizer);
  if (!values.length) {
    jsonResponse(res, 400, { ok: false, error: `${name} query parameter is required` });
    return null;
  }
  return values;
}

function optionalQueryList(url, name, normalizer = (item) => item) {
  return parseCommaList(url.searchParams.get(name), normalizer);
}

function textResponse(res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function redirectResponse(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end();
}

function normalizeReturnTo(value = '/') {
  const text = String(value || '').trim();
  if (!text || !text.startsWith('/') || text.startsWith('//')) {
    return '/';
  }
  if (
    text.startsWith('/api/') ||
    text === '/health' ||
    text === '/login' ||
    text === '/indmoney/login'
  ) {
    return '/';
  }
  return text;
}

function redirectToLogin(req, res, returnTo = null) {
  const requested = returnTo || req.url || '/';
  return redirectResponse(res, `/login?returnTo=${encodeURIComponent(normalizeReturnTo(requested))}`);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const APP_PAGE_ICON_NAMES = new Map([
  ['/', 'market'],
  ['/swing-trades', 'swing'],
  ['/portfolio-alerts', 'alerts'],
  ['/watchlist-stocks', 'watchlist'],
  ['/portfolio-earnings', 'earnings'],
  ['/portfolios', 'portfolio'],
  ['/portfolios/deep', 'portfolio'],
  ['/portfolios/mom', 'portfolio'],
  ['/indmoney', 'indmoney2'],
  ['/indmoney2', 'indmoney2'],
]);

const APP_PAGE_ICON_PATHS = {
  market: '<path d="M8 44h48"/><path d="m14 36 10-12 11 8 15-20"/><circle cx="48" cy="18" r="4" fill="#2db587" stroke="none"/>',
  swing: '<path d="M9 42c11-20 22-20 46-5"/><path d="M9 18h46"/><path d="m41 32 8 5 6-10"/>',
  alerts: '<path d="M32 10 11 50h42L32 10Z"/><path d="M32 24v11"/><path d="M32 42h.01"/>',
  watchlist: '<path d="M18 18h30"/><path d="M18 32h30"/><path d="M18 46h30"/><path d="m10 18 .01 0"/><path d="m10 32 .01 0"/><path d="m10 46 .01 0"/>',
  earnings: '<path d="M14 16h36"/><path d="M14 30h36"/><path d="M14 44h22"/><path d="m41 41 5 5 10-12"/>',
  portfolio: '<path d="M14 46V18"/><path d="M25 46V25"/><path d="M36 46V13"/><path d="M47 46V29"/><path d="M12 52h40"/>',
  indmoney2: '<path d="M14 46V18"/><path d="M25 46V25"/><path d="M36 46V13"/><path d="M47 46V29"/><path d="M12 52h40"/>',
};

function renderPageFavicon(pathname = '/') {
  const iconName = APP_PAGE_ICON_NAMES.get(pathname) || 'market';
  const iconMarkup = APP_PAGE_ICON_PATHS[iconName] || APP_PAGE_ICON_PATHS.market;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0b6370"/><g fill="none" stroke="#f4efe4" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">${iconMarkup}</g></svg>`;
}

function renderPageFaviconHref(pathname = '/') {
  const activePath = pathname === '/alerts' ? '/portfolio-alerts' : pathname;
  return `/favicon.svg?page=${encodeURIComponent(activePath)}`;
}

function renderAppShellHead(currentPath = '/', options = {}) {
  const activePath = currentPath === '/alerts' ? '/portfolio-alerts' : currentPath;
  const actionSelectors = Array.isArray(options.actionSelectors) ? options.actionSelectors : [];
  const tabs = PORTFOLIO_APP_TABS;
  return `
    <link rel="stylesheet" href="/app-shell.css" />
    <link rel="icon" type="image/svg+xml" href="${renderPageFaviconHref(activePath)}" />
    <link rel="shortcut icon" href="${renderPageFaviconHref(activePath)}" />
    <script>
      window.__APP_SHELL__ = {
        currentPath: ${JSON.stringify(activePath)},
        tabs: ${JSON.stringify(tabs)},
        actionSelectors: ${JSON.stringify(actionSelectors)}
      };
    </script>
    <script defer src="/app-shell.js"></script>
  `;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function pruneMapEntries(map, options = {}) {
  const {
    maxEntries = DEFAULT_CACHE_MAX_ENTRIES,
    isExpired = null,
    sortValue = null,
    now = Date.now(),
  } = options;
  if (!(map instanceof Map)) {
    return 0;
  }

  let removed = 0;
  if (typeof isExpired === 'function') {
    for (const [key, value] of map.entries()) {
      if (isExpired(value, now)) {
        map.delete(key);
        removed += 1;
      }
    }
  }

  const overflow = map.size - Math.max(0, maxEntries);
  if (overflow > 0) {
    const entries = [...map.entries()].sort((a, b) => {
      const aValue = typeof sortValue === 'function' ? sortValue(a[1]) : 0;
      const bValue = typeof sortValue === 'function' ? sortValue(b[1]) : 0;
      return aValue - bValue;
    });
    for (let index = 0; index < overflow; index += 1) {
      map.delete(entries[index][0]);
      removed += 1;
    }
  }

  return removed;
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function cleanupIndMoneyDashboardSessions() {
  pruneMapEntries(indMoneyDashboardSessions, {
    maxEntries: DEFAULT_SESSION_CACHE_MAX_ENTRIES,
    isExpired: (session, now) => !session?.expiresAt || session.expiresAt <= now,
    sortValue: (session) => session?.expiresAt || session?.createdAt || 0,
  });
}

function cleanupIndMoneyOauthStates() {
  pruneMapEntries(indMoneyOauthStates, {
    maxEntries: DEFAULT_OAUTH_CACHE_MAX_ENTRIES,
    isExpired: (session, now) => !session?.createdAt || now - session.createdAt > 10 * 60 * 1000,
    sortValue: (session) => session?.createdAt || 0,
  });
}

function cleanupHotCaches() {
  pruneMapEntries(aiSignalCache, {
    maxEntries: DEFAULT_CACHE_MAX_ENTRIES,
    isExpired: (entry, now) => !entry?.expiresAt || entry.expiresAt <= now,
    sortValue: (entry) => entry?.expiresAt || 0,
  });
  pruneMapEntries(quoteCache, {
    maxEntries: DEFAULT_QUOTE_CACHE_MAX_ENTRIES,
    isExpired: (entry, now) => !entry?.expiresAt || entry.expiresAt <= now,
    sortValue: (entry) => entry?.expiresAt || 0,
  });
  pruneMapEntries(headlineCache, {
    maxEntries: DEFAULT_HEADLINE_CACHE_MAX_ENTRIES,
    isExpired: (entry, now) => !entry?.expiresAt || entry.expiresAt <= now,
    sortValue: (entry) => entry?.expiresAt || 0,
  });
  pruneMapEntries(indMoneyMcpResponseCache.payloads, {
    maxEntries: DEFAULT_MCP_CACHE_MAX_ENTRIES,
    sortValue: (entry) => entry?.fetchedAt || 0,
  });
}

function dashboardSessionSecret() {
  return String(CONFIG.indMoneyDashboardPasscode || process.env.WHATSAPP_AGENT_SECRET || CONFIG.publicBaseUrl || 'market-dashboard-session');
}

function signDashboardSession(exp, nonce) {
  return base64Url(crypto.createHmac('sha256', dashboardSessionSecret()).update(`${exp}.${nonce}`).digest());
}

function verifySignedDashboardSession(token) {
  const [version, expText, nonce, signature] = String(token || '').split('.');
  if (version !== 'v1' || !expText || !nonce || !signature) {
    return false;
  }
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    return false;
  }
  const expected = Buffer.from(signDashboardSession(expText, nonce));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isSecureRequest(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || req?.headers?.['x-forwarded-protocol'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req?.socket?.encrypted || forwardedProto === 'https');
}

function indMoneyDashboardCookie(token, options = {}) {
  const parts = [
    `${CONFIG.indMoneyDashboardCookieName}=${encodeURIComponent(token || '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push(`Max-Age=${Math.max(60, CONFIG.indMoneyDashboardSessionDays * 24 * 60 * 60)}`);
  }
  const secure = options.secure ?? CONFIG.publicBaseUrl.startsWith('https://');
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function isIndMoneyDashboardAuthenticated(req) {
  cleanupIndMoneyDashboardSessions();
  const token = parseCookies(req)[CONFIG.indMoneyDashboardCookieName];
  if (verifySignedDashboardSession(token)) {
    return true;
  }
  const session = token ? indMoneyDashboardSessions.get(token) : null;
  return Boolean(session && session.expiresAt > Date.now());
}

function createIndMoneyDashboardSession() {
  cleanupIndMoneyDashboardSessions();
  const expiresAt = Date.now() + Math.max(1, CONFIG.indMoneyDashboardSessionDays) * 24 * 60 * 60 * 1000;
  const nonce = randomToken(16);
  const token = `v1.${expiresAt}.${nonce}.${signDashboardSession(expiresAt, nonce)}`;
  indMoneyDashboardSessions.set(token, {
    createdAt: Date.now(),
    expiresAt,
  });
  return token;
}

function createIndMoneyDashboardSessionHeaders(req) {
  const token = createIndMoneyDashboardSession();
  return {
    'Set-Cookie': indMoneyDashboardCookie(token, { secure: isSecureRequest(req) }),
  };
}

function verifyIndMoneyDashboardPasscode(passcode) {
  if (!CONFIG.indMoneyDashboardPasscode) {
    return false;
  }
  const expected = Buffer.from(String(CONFIG.indMoneyDashboardPasscode));
  const actual = Buffer.from(String(passcode || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireIndMoneyDashboardAuth(req, res) {
  if (isIndMoneyDashboardAuthenticated(req)) {
    return true;
  }
  jsonResponse(res, 401, {
    ok: false,
    error: 'INDmoney dashboard login required',
  });
  return false;
}

async function fetchJsonStrict(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url} failed: ${payload.error_description || payload.error || response.status}`);
  }
  return payload;
}

function requestBaseUrl(req) {
  const host = String(req?.headers?.host || '').trim();
  if (!host) {
    return CONFIG.publicBaseUrl;
  }
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

function indMoneyOAuthRedirectUri(req) {
  return `${requestBaseUrl(req)}/api/indmoney/auth/callback`;
}

function inferPortfolioKeyFromReturnTo(returnTo = '') {
  const pathText = normalizeReturnTo(returnTo);
  if (pathText === '/portfolios/mom') return 'mom';
  return 'deep';
}

function getPortfolioAuthPath(portfolioKey = 'deep') {
  return getPortfolioDefinition(portfolioKey)?.authPath || CONFIG.indMoneyMcpAuthPath;
}

function isIndMoneyMcpConnected(portfolioKey = 'deep') {
  return hasIndMoneyMcpHttpAuth({ authPath: getPortfolioAuthPath(portfolioKey) });
}

function indMoneyUiIcon(name) {
  const icons = {
    connect: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2a5 5 0 0 0 7.1 7.1l1.2-1.2"/></svg>',
    disconnect: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18.8 5.2-3.1 3.1"/><path d="m8.3 15.7-3.1 3.1"/><path d="M14 7.5a5 5 0 0 1 5.2 8.2l-2 2a5 5 0 0 1-7.1 0"/><path d="M10 16.5a5 5 0 0 1-5.2-8.2l2-2a5 5 0 0 1 7.1 0"/><path d="m3 3 18 18"/></svg>',
  };
  return icons[name] || '';
}

function renderIndMoneyConnectionAction(connected, returnTo = '/portfolios/deep', portfolioKey = 'deep') {
  const normalizedPortfolioKey = inferPortfolioKeyFromReturnTo(returnTo) || portfolioKey;
  const label = portfolioLabelFromKey(normalizedPortfolioKey);
  if (connected) {
    return `<form class="toolbar-form" method="post" action="/api/indmoney/auth/disconnect?portfolio=${encodeURIComponent(normalizedPortfolioKey)}"><button class="ghost-btn toolbar-link" type="submit" aria-label="Disconnect ${escapeHtml(label)} INDmoney account" title="Disconnect ${escapeHtml(label)} INDmoney account">${indMoneyUiIcon('disconnect')}<span>Disconnect ${escapeHtml(label)}</span></button></form>`;
  }
  return `<a class="cta-btn toolbar-link connection" href="/api/indmoney/auth/start?portfolio=${encodeURIComponent(normalizedPortfolioKey)}&returnTo=${encodeURIComponent(normalizeReturnTo(returnTo))}" aria-label="Connect ${escapeHtml(label)} INDmoney account" title="Connect ${escapeHtml(label)} INDmoney account">${indMoneyUiIcon('connect')}<span>Connect ${escapeHtml(label)}</span></a>`;
}

function portfolioLabelFromKey(key) {
  return getPortfolioDefinition(key)?.label || 'Portfolio';
}

function sumNumbers(values = []) {
  return round(values.reduce((sum, value) => sum + (toNumber(value) || 0), 0), 2);
}

function computePctFromTotals(numerator, denominator) {
  const a = toNumber(numerator);
  const b = toNumber(denominator);
  if (a === null || b === null || b === 0) {
    return null;
  }
  return round((a / b) * 100, 2);
}

function latestTimestamp(values = []) {
  return values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())
    .at(-1)
    ?.toISOString() || null;
}

function mergePortfolioWarnings(portfolios = []) {
  const warnings = [];
  for (const portfolio of portfolios) {
    const label = portfolioLabelFromKey(portfolio?.key).toUpperCase();
    for (const warning of Array.isArray(portfolio?.dashboard?.warnings) ? portfolio.dashboard.warnings : []) {
      if (warning) {
        warnings.push(`[${label}] ${warning}`);
      }
    }
  }
  return [...new Set(warnings)];
}

export function combinePortfolioHoldings(portfolios = []) {
  const holdingsByTicker = new Map();
  for (const portfolio of portfolios) {
    const portfolioKey = portfolio?.key || '';
    const portfolioLabel = portfolioLabelFromKey(portfolioKey);
    for (const row of Array.isArray(portfolio?.dashboard?.holdings) ? portfolio.dashboard.holdings : []) {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      if (!ticker) {
        continue;
      }
      const existing = holdingsByTicker.get(ticker) || {
        ticker,
        name: row?.name || ticker,
        quantity: 0,
        investedUsd: 0,
        currentHoldingValueUsd: 0,
        oneDayPnlUsd: 0,
        actualPnlUsd: 0,
        updatedAtValues: [],
        priceSessionValues: new Set(),
        priceSourceValues: new Set(),
        portfolioLabels: new Set(),
      };
      existing.quantity += toNumber(row?.quantity) || 0;
      existing.investedUsd += toNumber(row?.investedUsd) || 0;
      existing.currentHoldingValueUsd += toNumber(row?.currentHoldingValueUsd) || 0;
      existing.oneDayPnlUsd += toNumber(row?.oneDayPnlUsd) || 0;
      existing.actualPnlUsd += toNumber(row?.actualPnlUsd) || 0;
      existing.updatedAtValues.push(row?.updatedAt || null);
      if (row?.priceSession) {
        existing.priceSessionValues.add(String(row.priceSession));
      }
      if (row?.priceSource) {
        existing.priceSourceValues.add(String(row.priceSource));
      }
      existing.portfolioLabels.add(portfolioLabel);
      holdingsByTicker.set(ticker, existing);
    }
  }

  return [...holdingsByTicker.values()].map((holding) => {
    const quantity = round(holding.quantity, 6);
    const investedUsd = round(holding.investedUsd, 2);
    const currentHoldingValueUsd = round(holding.currentHoldingValueUsd, 2);
    const oneDayPnlUsd = round(holding.oneDayPnlUsd, 2);
    const actualPnlUsd = round(holding.actualPnlUsd, 2);
    const previousCloseValueUsd = round(currentHoldingValueUsd - oneDayPnlUsd, 2);
    const avgPriceUsd = quantity ? round(investedUsd / quantity, 4) : null;
    const currentPriceUsd = quantity ? round(currentHoldingValueUsd / quantity, 4) : null;
    const previousCloseUsd = quantity ? round(previousCloseValueUsd / quantity, 4) : null;
    return {
      ticker: holding.ticker,
      name: holding.name,
      quantity,
      investedUsd,
      avgPriceUsd,
      currentPriceUsd,
      currentHoldingValueUsd,
      oneDayPnlUsd,
      oneDayPnlPct: computePctFromTotals(oneDayPnlUsd, previousCloseValueUsd),
      actualPnlUsd,
      actualPnlPct: computePctFromTotals(actualPnlUsd, investedUsd),
      priceSession: [...holding.priceSessionValues].join(', ') || null,
      updatedAt: latestTimestamp(holding.updatedAtValues),
      priceSource: [...holding.priceSourceValues].join(', ') || null,
      portfolioScope: [...holding.portfolioLabels].join(', '),
      previousCloseUsd,
    };
  });
}

function combineSeriesPoints(pointCollections = []) {
  const pointsByTime = new Map();
  for (const pointCollection of pointCollections) {
    for (const point of Array.isArray(pointCollection) ? pointCollection : []) {
      const time = point?.time || null;
      if (!time) {
        continue;
      }
      const existing = pointsByTime.get(time) || {
        time,
        timestamp: toNumber(point?.timestamp),
        portfolioValueUsd: 0,
        actualPnlUsd: 0,
        investedValueUsd: 0,
        previousClosePortfolioValueUsd: 0,
      };
      existing.portfolioValueUsd += toNumber(point?.portfolioValueUsd) || 0;
      existing.actualPnlUsd += toNumber(point?.actualPnlUsd) || 0;
      existing.investedValueUsd += toNumber(point?.investedValueUsd ?? point?.investedUsd) || 0;
      existing.previousClosePortfolioValueUsd += toNumber(point?.previousClosePortfolioValueUsd) || 0;
      existing.timestamp = Math.max(existing.timestamp || 0, toNumber(point?.timestamp) || 0) || null;
      pointsByTime.set(time, existing);
    }
  }

  return [...pointsByTime.values()]
    .map((point) => {
      const portfolioValueUsd = round(point.portfolioValueUsd, 2);
      const actualPnlUsd = round(point.actualPnlUsd, 2);
      const investedValueUsd = round(point.investedValueUsd, 2);
      const previousClosePortfolioValueUsd = round(point.previousClosePortfolioValueUsd, 2);
      const oneDayPnlUsd = round(portfolioValueUsd - previousClosePortfolioValueUsd, 2);
      return {
        time: point.time,
        timestamp: point.timestamp,
        portfolioValueUsd,
        value: portfolioValueUsd,
        investedUsd: investedValueUsd,
        investedValueUsd,
        previousClosePortfolioValueUsd,
        oneDayPnlUsd,
        oneDayPnlPct: computePctFromTotals(oneDayPnlUsd, previousClosePortfolioValueUsd),
        actualPnlUsd,
        actualPnlPct: computePctFromTotals(actualPnlUsd, investedValueUsd),
      };
    })
    .sort((left, right) => (toNumber(left.timestamp) || 0) - (toNumber(right.timestamp) || 0));
}

function combinePnlSeriesPoints(pointCollections = []) {
  const pointsByTime = new Map();
  for (const pointCollection of pointCollections) {
    for (const point of Array.isArray(pointCollection) ? pointCollection : []) {
      const time = point?.time || null;
      if (!time) {
        continue;
      }
      const existing = pointsByTime.get(time) || {
        time,
        currentValueUsd: 0,
        investedUsd: 0,
        actualPnlUsd: 0,
      };
      existing.currentValueUsd += toNumber(point?.currentValueUsd) || 0;
      existing.investedUsd += toNumber(point?.investedUsd) || 0;
      existing.actualPnlUsd += toNumber(point?.value) || 0;
      pointsByTime.set(time, existing);
    }
  }
  return [...pointsByTime.values()].map((point) => ({
    time: point.time,
    value: round(point.actualPnlUsd, 2),
    currentValueUsd: round(point.currentValueUsd, 2),
    investedUsd: round(point.investedUsd, 2),
    actualPnlPct: computePctFromTotals(point.actualPnlUsd, point.investedUsd),
  }));
}

export function buildCombinedSeries(portfolios = []) {
  const ranges = new Set(['1d', '1w', '1m', 'all']);
  for (const portfolio of portfolios) {
    Object.keys(portfolio?.dashboard?.series || {}).forEach((range) => ranges.add(range));
  }
  return Object.fromEntries([...ranges].map((range) => {
    const rangePayloads = portfolios
      .map((portfolio) => portfolio?.dashboard?.series?.[range] || null)
      .filter(Boolean);
    const valuePoints = combineSeriesPoints(rangePayloads.map((payload) => payload?.valuePoints || []));
    const pnlPoints = combinePnlSeriesPoints(rangePayloads.map((payload) => payload?.pnlPoints || []));
    const lastPoint = valuePoints.at(-1) || null;
    return [range, {
      ok: valuePoints.length > 0,
      range,
      currency: 'USD',
      displayCurrency: 'USD',
      baselineAt: rangePayloads.map((payload) => payload?.baselineAt).filter(Boolean).sort().at(0) || null,
      granularity: rangePayloads.map((payload) => payload?.granularity).filter(Boolean).at(0) || null,
      pointCount: valuePoints.length,
      viewportStart: rangePayloads.map((payload) => toNumber(payload?.viewportStart)).filter((value) => value !== null).sort((a, b) => a - b).at(0) || null,
      viewportEnd: rangePayloads.map((payload) => toNumber(payload?.viewportEnd)).filter((value) => value !== null).sort((a, b) => b - a).at(0) || null,
      marketTimezone: rangePayloads.map((payload) => payload?.marketTimezone).filter(Boolean).at(0) || null,
      source: 'combined-portfolios',
      warnings: mergePortfolioWarnings(portfolios),
      valuePoints,
      pnlPoints,
      summary: lastPoint ? {
        currentPortfolioValueUsd: lastPoint.portfolioValueUsd,
        investedValueUsd: lastPoint.investedValueUsd,
        previousClosePortfolioValueUsd: lastPoint.previousClosePortfolioValueUsd,
        oneDayPnlUsd: lastPoint.oneDayPnlUsd,
        oneDayPnlPct: lastPoint.oneDayPnlPct,
        actualPnlUsd: lastPoint.actualPnlUsd,
        actualPnlPct: lastPoint.actualPnlPct,
      } : null,
    }];
  }));
}

async function buildPortfolioDashboard(portfolioKey) {
  const definition = getPortfolioDefinition(portfolioKey);
  if (!definition) {
    throw new Error(`Unknown portfolio "${portfolioKey}"`);
  }
  return buildIndMoney2Dashboard({
    fxConfigPath: definition.fxConfigPath,
    holdingsCachePath: definition.holdingsCachePath,
    budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
    portfolioSeriesPath: definition.portfolioSeriesPath,
    allowLiveFetch: definition.liveSyncEnabled !== false,
    portfolioLabel: definition.label,
    historyMode: definition.historyMode || 'repriced',
    authPath: definition.authPath,
  });
}

async function buildCombinedPortfolioDashboard() {
  const settled = await Promise.all(
    getPortfolioDefinitions().map(async (definition) => {
      try {
        return {
          key: definition.key,
          dashboard: await buildPortfolioDashboard(definition.key),
          error: null,
        };
      } catch (error) {
        return {
          key: definition.key,
          dashboard: null,
          error,
        };
      }
    }),
  );
  const portfolios = settled.filter((portfolio) => portfolio.dashboard);
  const holdings = combinePortfolioHoldings(portfolios);
  const summary = {
    currentPortfolioValueUsd: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.summary?.currentPortfolioValueUsd)),
    investedValueUsd: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.summary?.investedValueUsd)),
    previousClosePortfolioValueUsd: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.summary?.previousClosePortfolioValueUsd)),
    oneDayPnlUsd: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.summary?.oneDayPnlUsd)),
    actualPnlUsd: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.summary?.actualPnlUsd)),
  };
  summary.oneDayPnlPct = computePctFromTotals(summary.oneDayPnlUsd, summary.previousClosePortfolioValueUsd);
  summary.actualPnlPct = computePctFromTotals(summary.actualPnlUsd, summary.investedValueUsd);
  const fx = {
    manualActualInvestedUsd: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.fx?.manualActualInvestedUsd)),
    totalInvestedInrFromMcp: sumNumbers(portfolios.map((portfolio) => portfolio.dashboard?.fx?.totalInvestedInrFromMcp)),
    updatedAt: latestTimestamp(portfolios.map((portfolio) => portfolio.dashboard?.fx?.updatedAt)),
  };
  fx.effectiveUsdInrRate = fx.manualActualInvestedUsd > 0 && fx.totalInvestedInrFromMcp > 0
    ? round(fx.totalInvestedInrFromMcp / fx.manualActualInvestedUsd, 6)
    : null;
  const warnings = [
    ...mergePortfolioWarnings(portfolios),
    ...settled
      .filter((portfolio) => !portfolio.dashboard && portfolio.error)
      .map((portfolio) => `[${portfolioLabelFromKey(portfolio.key).toUpperCase()}] ${portfolio.error.message || 'Portfolio unavailable.'}`),
  ];
  const series = buildCombinedSeries(portfolios);
  return {
    ok: true,
    updatedAt: latestTimestamp(portfolios.map((portfolio) => portfolio.dashboard?.updatedAt)),
    baselineDate: portfolios.map((portfolio) => portfolio.dashboard?.baselineDate).filter(Boolean).sort().at(0) || null,
    currency: 'USD',
    displayCurrency: 'USD',
    sourceCurrency: 'INR',
    priceSource: 'combined-portfolios',
    fx,
    sessionMeta: {
      marketSession: portfolios.map((portfolio) => portfolio.dashboard?.sessionMeta?.marketSession).filter(Boolean).join(', ') || 'unknown',
    },
    summary,
    holdings,
    series,
    seriesAvailability: Object.fromEntries(
      Object.entries(series).map(([range, payload]) => [range, {
        ok: Boolean(payload.ok),
        pointCount: payload.pointCount || 0,
        warningCount: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
      }]),
    ),
    warnings,
    dataFreshness: {
      livePricesUpdatedAt: latestTimestamp(portfolios.map((portfolio) => portfolio.dashboard?.dataFreshness?.livePricesUpdatedAt)),
      holdingsUpdatedAt: latestTimestamp(portfolios.map((portfolio) => portfolio.dashboard?.dataFreshness?.holdingsUpdatedAt)),
      historicalPricesUpdatedAt: latestTimestamp(portfolios.map((portfolio) => portfolio.dashboard?.dataFreshness?.historicalPricesUpdatedAt)),
      fxConfigUpdatedAt: latestTimestamp(portfolios.map((portfolio) => portfolio.dashboard?.dataFreshness?.fxConfigUpdatedAt)),
      isStale: warnings.length > 0,
    },
    componentPortfolios: portfolios.map((portfolio) => ({
      key: portfolio.key,
      label: portfolioLabelFromKey(portfolio.key),
      routePath: getPortfolioDefinition(portfolio.key)?.routePath || `/portfolios/${portfolio.key}`,
      updatedAt: portfolio.dashboard?.updatedAt || null,
      summary: {
        currentPortfolioValueUsd: portfolio.dashboard?.summary?.currentPortfolioValueUsd ?? null,
        investedValueUsd: portfolio.dashboard?.summary?.investedValueUsd ?? null,
        oneDayPnlUsd: portfolio.dashboard?.summary?.oneDayPnlUsd ?? null,
        oneDayPnlPct: portfolio.dashboard?.summary?.oneDayPnlPct ?? null,
        actualPnlUsd: portfolio.dashboard?.summary?.actualPnlUsd ?? null,
        actualPnlPct: portfolio.dashboard?.summary?.actualPnlPct ?? null,
      },
    })),
  };
}

async function buildIndMoneyAuthorizeUrl(req, options = {}) {
  cleanupIndMoneyOauthStates();
  const metadata = await fetchJsonStrict(`${CONFIG.indMoneyMcpIssuer}/.well-known/oauth-authorization-server`);
  const redirectUri = indMoneyOAuthRedirectUri(req);
  const returnTo = normalizeReturnTo(options.returnTo || '/portfolios/deep');
  const portfolioKey = isSupportedPortfolioKey(options.portfolioKey) ? options.portfolioKey : inferPortfolioKeyFromReturnTo(returnTo);
  const authPath = getPortfolioAuthPath(portfolioKey);
  const registration = await fetchJsonStrict(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Market Dashboard INDmoney MCP',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: CONFIG.indMoneyMcpScopes,
    }),
  });
  const state = randomToken(24);
  const codeVerifier = randomToken(64);
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  indMoneyOauthStates.set(state, {
    createdAt: Date.now(),
    codeVerifier,
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    tokenEndpoint: metadata.token_endpoint,
    issuer: CONFIG.indMoneyMcpIssuer,
    redirectUri,
    returnTo,
    portfolioKey,
    authPath,
  });
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', registration.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', CONFIG.indMoneyMcpScopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  return authorizeUrl.toString();
}

async function completeIndMoneyOAuth(url) {
  cleanupIndMoneyOauthStates();
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(url.searchParams.get('error_description') || error);
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const session = indMoneyOauthStates.get(state);
  indMoneyOauthStates.delete(state);
  if (!state || !code || !session) {
    throw new Error('Missing or expired INDmoney OAuth state. Start authorization again.');
  }
  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    throw new Error('INDmoney OAuth state expired. Start authorization again.');
  }
  const tokenPayload = await fetchJsonStrict(session.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      client_secret: session.clientSecret,
      code_verifier: session.codeVerifier,
    }).toString(),
  });
  const authPath = session.authPath || getPortfolioAuthPath(session.portfolioKey || inferPortfolioKeyFromReturnTo(session.returnTo));
  await writeAuthFile(authPath, {
    ...tokenPayload,
    client_id: session.clientId,
    client_secret: session.clientSecret,
    issuer: session.issuer,
    scopes: CONFIG.indMoneyMcpScopes,
    token_endpoint: session.tokenEndpoint,
    expires_at: Date.now() + Math.max(0, Number(tokenPayload.expires_in || 3600)) * 1000,
    updated_at: nowTimestamp(),
  });
  indMoneyMcpResponseCache = {
    expiresAt: 0,
    payloads: new Map(),
  };
  invalidateIndMoneyDashboardBaseCache();
  resetDefaultIndMoneyMcpClient();
  await Promise.all(
    getPortfolioDefinitions()
      .filter((portfolio) => portfolio.liveSyncEnabled && portfolio.key === (session.portfolioKey || 'deep'))
      .map((portfolio) => primeIndMoney2HoldingsCache({
        authPath: portfolio.authPath,
        holdingsCachePath: portfolio.holdingsCachePath,
        budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
        portfolioLabel: portfolio.label,
      }).catch(() => false)),
  );
  return {
    authPath,
    returnTo: normalizeReturnTo(session.returnTo || '/portfolios/deep'),
    portfolioKey: session.portfolioKey || 'deep',
  };
}

function renderIndMoneyLoginPage(options = {}) {
  const returnTo = normalizeReturnTo(options.returnTo || '/');
  const message = options.error
    ? `<p class="error">${escapeHtml(options.error)}</p>`
    : options.connected
      ? '<p class="success">INDmoney is connected. Continue to the dashboard.</p>'
      : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>INDmoney Portfolio</title>
  <link rel="icon" type="image/svg+xml" href="${renderPageFaviconHref(returnTo)}" />
  <link rel="shortcut icon" href="${renderPageFaviconHref(returnTo)}" />
  <style>
    :root { color-scheme: light; --ink: #162021; --muted: #647173; --line: #d9e0e2; --surface: #ffffff; --wash: #f4f6f7; --accent: #0b5966; --accent2: #176a4d; --warn: #95640f; --font: Inter, "Avenir Next", "SF Pro Display", "Segoe UI", Arial, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: var(--font); background: var(--wash); color: var(--ink); }
    main { width: min(1120px, calc(100% - 32px)); min-height: 100vh; margin: 0 auto; display: grid; place-items: center; padding: 34px 0; }
    .panel { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 1px 2px rgba(18, 28, 31, .05); padding: 22px; }
    .brand { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 26px; }
    .mark { width: 30px; height: 30px; border-radius: 6px; background: var(--accent); }
    h1 { margin: 0; font-size: 28px; line-height: 1; letter-spacing: 0; font-weight: 800; }
    p { color: var(--muted); line-height: 1.55; margin: 12px 0 0; }
    label { display: block; margin: 24px 0 8px; color: #34413d; font-size: 13px; font-weight: 700; }
    input { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); min-height: 38px; padding: 0 11px; font: inherit; }
    button, a.button { appearance: none; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 800; text-decoration: none; cursor: pointer; }
    .secondary { background: #eef3f1; color: #24332f; }
    .actions { display: grid; gap: 10px; margin-top: 16px; }
    .error { color: #8d1b1b; background: #fff0ee; border: 1px solid #f0c9c3; border-radius: 8px; padding: 10px 12px; }
    .success { color: #145844; background: #eaf6f1; border: 1px solid #c6e6d9; border-radius: 8px; padding: 10px 12px; }
    .foot { margin-top: 24px; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <section class="panel chart-panel">
      <div class="brand"><div><h1>Markets</h1><p>Private market watch dashboard</p></div><div class="mark" aria-hidden="true"></div></div>
      ${message}
      <form method="post" action="/login?returnTo=${encodeURIComponent(returnTo)}">
        <label for="passcode">Dashboard passcode</label>
        <input id="passcode" name="passcode" type="password" autocomplete="current-password" autofocus />
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <div class="actions">
          <button type="submit">Enter</button>
        </div>
      </form>
      <p class="foot">All market pages are available after this server-side session gate passes.</p>
    </section>
  </main>
</body>
</html>`;
}

function sanitizeResearchWarnings(warnings = []) {
  return (Array.isArray(warnings) ? warnings : []).filter((item) => {
    const text = String(item || '');
    if (!text) {
      return false;
    }
    if (text.includes('/stock/candle') && text.includes('HTTP 403')) {
      return false;
    }
    if (text.includes('Finnhub HTTP 429')) {
      return false;
    }
    if (text.includes('Finnhub returned non-JSON') && text.includes('429 Too Many Requests')) {
      return false;
    }
    if (text.includes('Remaining Limit: 0')) {
      return false;
    }
    return true;
  });
}

async function safeIndMoneyMcpRead(label, read) {
  try {
    return { label, value: await read(), error: null };
  } catch (error) {
    return { label, value: null, error: error.message };
  }
}

async function captureIndMoneyNetworthSnapshot(options = {}) {
  const result = await safeIndMoneyMcpRead('networth', () =>
    withIndMoneyMcpCache('networth', async (provider) =>
      adjustIndMoneySnapshotForStaleIndianData(normalizeMcpNetworthSnapshot(await provider.networthSnapshot())),
    ),
  );
  if (result.error || !result.value) {
    return {
      ok: false,
      appended: false,
      error: result.error || 'INDmoney MCP net worth was empty',
    };
  }
  const point = normalizeIndMoneyHistoryPoint(result.value, {
    timezone: CONFIG.timezone,
    timestamp: nowTimestamp(),
  });
  if (!point) {
    return {
      ok: false,
      appended: false,
      error: 'INDmoney MCP net worth did not include a numeric value',
    };
  }
  const current = await readIndMoneyHistory();
  const appendResult = appendIndMoneyHistoryPoint(current, point, {
    force: Boolean(options.force),
    allowMultiplePerDay: Boolean(options.force),
    timezone: CONFIG.timezone,
  });
  if (appendResult.appended) {
    await writeIndMoneyHistory(appendResult.history);
  }
  return {
    ok: true,
    appended: appendResult.appended,
    reason: appendResult.reason,
    point,
    growth: buildIndMoneyGrowthSeries(appendResult.history),
  };
}

async function buildIndMoneyDashboardBasePayload() {
  const assetTypes = ['US_STOCK'];
  const networthResult = await safeIndMoneyMcpRead('networth', () =>
    withIndMoneyMcpCache('networth', async (provider) =>
      adjustIndMoneySnapshotForStaleIndianData(normalizeMcpNetworthSnapshot(await provider.networthSnapshot())),
    ),
  );

  const [holdingsResults, usWatchlistResult] = await Promise.all([
    Promise.all(
      assetTypes.map((assetType) =>
        ['MF', 'IND_STOCK'].includes(assetType)
          ? Promise.resolve({ label: `holdings:${assetType}`, value: { holdings: [] }, error: null })
          : safeIndMoneyMcpRead(`holdings:${assetType}`, () =>
              withIndMoneyMcpCache(`holdings:${assetType}`, async (provider) => provider.networthHoldings(assetType)),
            ),
      ),
    ),
    safeIndMoneyMcpRead('watchlist:us', () =>
      withIndMoneyMcpCache('watchlist:us', async (provider) => normalizeMcpWatchlists(await provider.userWatchlist('us'))),
    ),
  ]);

  return {
    assetTypes,
    networthResult,
    holdingsResults,
    usWatchlistResult,
    refreshedAt: nowTimestamp(),
  };
}

function normalizeIndMoneyAllocationDimension(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function isUsAllocationRow(row = {}) {
  const candidates = [
    row?.asset_type,
    row?.assetclass_l2,
    row?.asset_class,
    row?.label,
  ];
  return candidates.some((candidate) => {
    const normalized = normalizeIndMoneyAllocationDimension(candidate);
    return normalized.startsWith('USSTOCK') || normalized.startsWith('US_STOCK') || normalized.startsWith('US STOCK');
  });
}

function normalizeIndMoneyText(value = '') {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function hasPendingSettlementSignal(value = '') {
  const normalized = normalizeIndMoneyText(value);
  if (!normalized) {
    return false;
  }
  return /\bin(?:\s+|-)*progress\b|\bpending\b|\bunsettled\b|\bpendingsettl|\binprogress\b|\bsettlement\b|\bprocessing\b|\bqueued\b|\bin\s+progress/.test(
    normalized,
  );
}

function parseLooseBoolFromString(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return value !== 0;
  }
  const normalized = normalizeIndMoneyText(value).trim();
  if (!normalized) {
    return fallback;
  }
  if (['true', '1', 'yes', 'on', 'settled', 'done', 'completed', 'closed'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off', 'unsettled', 'pending', 'processing', 'queued', 'in progress', 'in_progress', 'inprogress', 'open'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseSettlementDelayDays(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const asNumber = toNumber(value);
  if (asNumber !== null) {
    return asNumber;
  }
  const normalized = String(value).toLowerCase();
  const tPlusMatch = normalized.match(/t\s*\+?\s*(\d+)/i);
  if (tPlusMatch) {
    const extracted = toNumber(tPlusMatch[1]);
    if (extracted !== null) {
      return extracted;
    }
  }
  const dayMatch = normalized.match(/(\d+)\s*days?/i);
  if (dayMatch) {
    return toNumber(dayMatch[1]);
  }
  return null;
}

function isLikelyUnsettledIndMoneyRow(row = {}) {
  const settlementData = row?.settlement || {};
  const tradeData = row?.trade || {};
  const orderData = row?.order || {};
  const transactionData = row?.transaction || {};
  const statusCandidates = [
    row?.status,
    row?.orderStatus,
    row?.order_status,
    row?.tradeStatus,
    row?.trade_status,
    row?.transactionStatus,
    row?.transaction_status,
    row?.settlementStatus,
    row?.settlement_status,
    row?.holdingsStatus,
    row?.holding_status,
    row?.investmentStatus,
    row?.investment_status,
    row?.settlementStatusMessage,
    row?.settlement_status_message,
    settlementData?.status,
    settlementData?.settlement_status,
    settlementData?.state,
    settlementData?.order_status,
    settlementData?.is_settled,
    tradeData?.status,
    tradeData?.trade_status,
    tradeData?.state,
    orderData?.status,
    orderData?.order_status,
    orderData?.state,
    orderData?.order_type,
    transactionData?.status,
    transactionData?.trade_status,
    transactionData?.state,
  ];
  if (statusCandidates.some((status) => hasPendingSettlementSignal(status))) {
    return true;
  }
  const settledFlags = [
    row?.is_settled,
    row?.isSettled,
    row?.settled,
    row?.isSettledFlag,
    row?.settled_status,
    row?.settlementStatus,
    settlementData?.isSettled,
    settlementData?.settled,
    settlementData?.is_settled,
    tradeData?.isSettled,
    orderData?.isSettled,
    transactionData?.isSettled,
    tradeData?.settled,
    orderData?.settled,
  ];
  if (settledFlags.some((value) => parseLooseBoolFromString(value) === false)) {
    return true;
  }
  if (parseSettlementDelayDays(row?.settlement_days_remaining) > 0 || parseSettlementDelayDays(row?.settlement_days) > 0) {
    return true;
  }
  if (parseSettlementDelayDays(row?.tPlus) > 0 || parseSettlementDelayDays(row?.t_plus) > 0) {
    return true;
  }
  return false;
}

function firstIndMoneyNumber(row = {}, keys = []) {
  for (const key of keys) {
    const value = toNumber(row?.[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function hasMaterialUsSummaryValues(values = []) {
  return values.some((value) => {
    const num = toNumber(value);
    return num !== null && Math.abs(num) > 0.000001;
  });
}

function summarizeDashboardHoldingValues(rows = []) {
  const normalizedValueRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      invested: toNumber(row?.invested),
      currentValue: toNumber(row?.currentValue),
    }))
    .filter((row) => row.invested !== null || row.currentValue !== null);
  const hasInvestedValueRows = normalizedValueRows.some((row) => row.invested !== null);
  const hasCurrentValueRows = normalizedValueRows.some((row) => row.currentValue !== null);
  const hasAnyValues = normalizedValueRows.length > 0;
  const hasMaterialValues = normalizedValueRows.some(
    (row) => Math.abs(row.invested || 0) > 0.000001 || Math.abs(row.currentValue || 0) > 0.000001,
  );
  const totalInvested = hasInvestedValueRows
    ? round(normalizedValueRows.reduce((sum, row) => sum + (row.invested || 0), 0), 2)
    : null;
  const totalCurrentValue = hasCurrentValueRows
    ? round(normalizedValueRows.reduce((sum, row) => sum + (row.currentValue || 0), 0), 2)
    : null;
  const totalReturn =
    totalInvested !== null && totalCurrentValue !== null
      ? round(totalCurrentValue - totalInvested, 2)
      : null;
  return {
    hasAnyValues,
    hasMaterialValues,
    hasInvestedValueRows,
    hasCurrentValueRows,
    totalInvested,
    totalCurrentValue,
    totalReturn,
  };
}

function hasTrustworthyUsSummary(summary = {}) {
  return hasMaterialUsSummaryValues([
    summary.total_invested,
    summary.total_current_value,
    summary.total_networth,
    summary.total_return,
    summary.totalInvested,
    summary.totalCurrentValue,
    summary.totalNetworth,
    summary.totalReturn,
  ]);
}

export function toUsOnlyIndMoneyNetworth(snapshot = {}, usHoldings = []) {
  const sourceInvestments = Array.isArray(snapshot?.investments) ? snapshot.investments : [];
  const sourceAssets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  const investments = sourceInvestments
    .filter(isUsAllocationRow)
    .filter((row) => !isLikelyUnsettledIndMoneyRow(row));
  const assets = sourceAssets.filter(isUsAllocationRow);
  const liabilities = toNumber(snapshot.liabilities || snapshot.total_liabilities || snapshot.liability);
  const hasUsAllocationRows = investments.length > 0 || assets.length > 0 || (Array.isArray(usHoldings) && usHoldings.length > 0);
  const investmentTotalInvested = investments.reduce(
    (sum, row) => sum + (firstIndMoneyNumber(row, ['invested', 'invested_value', 'invested_amount', 'total_invested']) || 0),
    0,
  );
  const investmentTotalCurrent = investments.reduce(
    (sum, row) => sum + (firstIndMoneyNumber(row, ['current', 'current_value', 'currentValue', 'market_value', 'value', 'total_current_value']) || 0),
    0,
  );
  const activeUsHoldings = Array.isArray(usHoldings) ? usHoldings.filter((row) => !isLikelyUnsettledIndMoneyRow(row)) : [];
  const hasInvestmentValues = investments.some((row) =>
    firstIndMoneyNumber(row, ['invested', 'invested_value', 'invested_amount', 'total_invested']) !== null
  ) || investments.some((row) =>
    firstIndMoneyNumber(row, ['current', 'current_value', 'currentValue', 'market_value', 'value', 'total_current_value']) !== null
  );
  const hasMaterialInvestmentValues = investments.some((row) => hasMaterialUsSummaryValues([
    firstIndMoneyNumber(row, ['invested', 'invested_value', 'invested_amount', 'total_invested']),
    firstIndMoneyNumber(row, ['current', 'current_value', 'currentValue', 'market_value', 'value', 'total_current_value']),
  ]));
  const holdingSummary = summarizeDashboardHoldingValues(activeUsHoldings);
  const snapshotInvested = firstIndMoneyNumber(snapshot, ['total_invested', 'totalInvested', 'invested_amount']);
  const snapshotCurrentValue = firstIndMoneyNumber(snapshot, ['total_current_value', 'totalCurrentValue', 'current_value']);
  const snapshotNetworth = firstIndMoneyNumber(snapshot, ['total_networth', 'totalNetworth', 'networth', 'total']);
  const snapshotReturn = firstIndMoneyNumber(snapshot, ['total_return', 'total_pnl', 'pnl']);
  const snapshotReturnPct = firstIndMoneyNumber(snapshot, ['total_return_pct', 'total_pnl_percentage', 'return_percentage']);
  const hasTrustworthyInvestmentTotals = investments.length > 0 && hasMaterialInvestmentValues;
  const hasTrustworthyHoldingTotals = holdingSummary.hasMaterialValues;
  const canUseSnapshotTotals = !hasUsAllocationRows && hasTrustworthyUsSummary(snapshot);
  const totalInvested = hasTrustworthyInvestmentTotals
    ? round(investmentTotalInvested, 2)
    : hasTrustworthyHoldingTotals
      ? holdingSummary.totalInvested
      : canUseSnapshotTotals
        ? snapshotInvested
        : null;
  const totalCurrentValue = hasTrustworthyInvestmentTotals
    ? round(investmentTotalCurrent, 2)
    : hasTrustworthyHoldingTotals
      ? holdingSummary.totalCurrentValue
      : canUseSnapshotTotals
        ? snapshotCurrentValue
        : null;
  const totalReturn = totalInvested !== null && totalCurrentValue !== null ? round(totalCurrentValue - totalInvested, 2) : null;
  const totalNetworth = totalCurrentValue !== null
    ? liabilities !== null ? round(totalCurrentValue + liabilities, 2) : totalCurrentValue
    : canUseSnapshotTotals ? snapshotNetworth : null;
  const returnValue = totalReturn !== null ? totalReturn : canUseSnapshotTotals ? snapshotReturn : null;
  const returnPctValue =
    returnValue !== null && totalInvested
      ? round((returnValue / totalInvested) * 100, 2)
      : canUseSnapshotTotals
        ? snapshotReturnPct
        : null;

  return {
    ...snapshot,
    investments,
    assets,
    sector: [],
    market_cap: [],
    total_invested: totalInvested,
    total_current_value: totalCurrentValue,
    total_networth: totalNetworth,
    total_return: returnValue,
    total_return_pct:
      returnPctValue,
    dataAdjustments: [
      ...(Array.isArray(snapshot.dataAdjustments) ? snapshot.dataAdjustments : []),
      {
        rule: 'us_stock_only',
        reason: 'Dashboard view is limited to US stock holdings.',
        assetTypes: ['US_STOCK'],
      },
    ],
  };
}

function portfolioAuthPath(filename) {
  const homeDir = process.env.HOME || __dirname;
  return path.join(homeDir, '.codex', filename);
}

const PORTFOLIO_REGISTRY = Object.freeze({
  deep: Object.freeze({
    key: 'deep',
    label: 'Deep',
    routePath: '/portfolios/deep',
    apiBasePath: '/api/portfolios/deep',
    legacyPaths: ['/indmoney2'],
    liveSyncEnabled: true,
    historyMode: 'repriced',
    authPath: CONFIG.indMoneyMcpAuthPath,
    fxConfigPath: CONFIG.indMoney2FxConfigFile,
    holdingsCachePath: CONFIG.indMoney2HoldingsCacheFile,
    portfolioSeriesPath: CONFIG.indMoney2PortfolioSeriesFile,
  }),
  mom: Object.freeze({
    key: 'mom',
    label: 'Mom',
    routePath: '/portfolios/mom',
    apiBasePath: '/api/portfolios/mom',
    legacyPaths: [],
    liveSyncEnabled: true,
    historyMode: 'current_only',
    authPath: portfolioAuthPath('indmoney-mcp-market-auth-mom.json'),
    fxConfigPath: path.join(__dirname, 'data', 'mom-fx-config.json'),
    holdingsCachePath: path.join(__dirname, 'data', 'mom-holdings-cache.json'),
    portfolioSeriesPath: path.join(__dirname, 'data', 'mom-portfolio-series.json'),
  }),
});

const PORTFOLIO_APP_TABS = [
  ['/', 'Market', 'Cross-market dashboard'],
  ['/swing-trades', 'Swing', 'Trade scan'],
  ['/portfolio-alerts', 'Alerts', 'Risk decisions'],
  ['/watchlist-stocks', 'Watchlist', 'Buy list research'],
  ['/portfolio-earnings', 'Earnings', 'Post-print portfolio'],
  ['/portfolios', 'Combined', 'Merged portfolios'],
  ['/portfolios/deep', 'Deep', 'USD tracker'],
  ['/portfolios/mom', 'Mom', 'USD tracker'],
];

function getPortfolioDefinition(key) {
  const normalized = String(key || '').trim().toLowerCase();
  return PORTFOLIO_REGISTRY[normalized] || null;
}

function isSupportedPortfolioKey(key) {
  return Boolean(getPortfolioDefinition(key));
}

function getPortfolioDefinitions() {
  return Object.values(PORTFOLIO_REGISTRY);
}

export function resolvePortfolioDefinition(key) {
  return getPortfolioDefinition(key);
}

export function reconcileIndMoneyDashboardSummary(payload = {}, options = {}) {
  const nextPayload = payload || {};
  const summary = nextPayload.summary || {};
  const usOnlyNetworth = options.usOnlyNetworth || {};
  const hasStaleAdjustment = Boolean(options.hasStaleAdjustment);
  const holdings = Array.isArray(options.holdings) ? options.holdings : [];
  const usAssetClassPnl = Array.isArray(nextPayload.assetClassPnl)
    ? nextPayload.assetClassPnl.filter((row) => isUsAllocationRow(row))
    : [];
  const holdingsSummary = summarizeDashboardHoldingValues(holdings);
  const summaryUsesExtendedPricing =
    ['extended', 'pre-market', 'after-hours', 'post-market'].includes(
      String(summary?.priceBasis || '').toLowerCase(),
    );
  const summarySession = nextPayload.usSessionPnl || {};
  const summarySessionOverall = summarySession.overall || {};
  const summarySessionActual = summarySession.actual || {};
  const summarySessionReference = summarySession.reference || {};
  const summaryFxRate =
    toNumber(nextPayload.fxRate) ??
    toNumber(summarySession.fxRate) ??
    toNumber(summarySessionReference.fxRate);
  const closeEnough = (left, right) => {
    const a = toNumber(left);
    const b = toNumber(right);
    if (a === null || b === null) return false;
    return Math.abs(a - b) <= Math.max(1, Math.abs(a) * 0.01);
  };
  const deriveUsdSummaryFields = (inrSummary = {}) => {
    const totalInvestedInr = toNumber(inrSummary.totalInvested);
    const totalCurrentValueInr = toNumber(inrSummary.totalCurrentValue);
    const totalReturnInr = toNumber(inrSummary.totalReturn);
    const totalInvestedUsd =
      (closeEnough(totalInvestedInr, summarySessionReference.investedInr) ? toNumber(summarySessionReference.investedUsd) : null) ??
      (summaryFxRate && totalInvestedInr !== null ? round(totalInvestedInr / summaryFxRate, 2) : null);
    const totalCurrentValueUsd =
      (closeEnough(totalCurrentValueInr, summarySessionOverall.valueInr) ? toNumber(summarySessionOverall.valueUsd) : null) ??
      (closeEnough(totalCurrentValueInr, summarySessionActual.valueInr) ? toNumber(summarySessionActual.valueUsd) : null) ??
      (summaryFxRate && totalCurrentValueInr !== null ? round(totalCurrentValueInr / summaryFxRate, 2) : null);
    const totalReturnUsd =
      (closeEnough(totalReturnInr, summarySessionOverall.pnlInr) ? toNumber(summarySessionOverall.pnlUsd) : null) ??
      (closeEnough(totalReturnInr, summarySessionActual.pnlInr) ? toNumber(summarySessionActual.pnlUsd) : null) ??
      (summaryFxRate && totalReturnInr !== null ? round(totalReturnInr / summaryFxRate, 2) : null);
    return {
      totalInvestedUsd,
      totalCurrentValueUsd,
      totalReturnUsd,
    };
  };
  const assignSummaryTotals = (patch = {}) => {
    const merged = {
      ...(nextPayload.summary || {}),
      ...patch,
    };
    return {
      ...merged,
      ...deriveUsdSummaryFields(merged),
    };
  };
  const currentSummaryIsMeaningful = hasMaterialUsSummaryValues([
    summary.totalInvested,
    summary.totalCurrentValue,
    summary.totalNetworth,
    summary.totalReturn,
  ]);

  if (usAssetClassPnl.length) {
    const assetClassInvested = round(usAssetClassPnl.reduce((sum, row) => sum + (toNumber(row.invested) || 0), 0), 2);
    const assetClassCurrentValue = round(usAssetClassPnl.reduce((sum, row) => sum + (toNumber(row.currentValue) || 0), 0), 2);
    const assetClassReturn = round(assetClassCurrentValue - assetClassInvested, 2);
    if (
      hasMaterialUsSummaryValues([assetClassInvested, assetClassCurrentValue, assetClassReturn]) ||
      (!currentSummaryIsMeaningful && !summaryUsesExtendedPricing)
    ) {
      const liabilities = toNumber(summary.liabilities);
      nextPayload.summary = assignSummaryTotals({
        totalInvested: assetClassInvested,
        totalCurrentValue: assetClassCurrentValue,
        totalNetworth: liabilities !== null ? round(assetClassCurrentValue + liabilities, 2) : assetClassCurrentValue,
        totalReturn: assetClassReturn,
        totalReturnPct: assetClassInvested ? round((assetClassReturn / assetClassInvested) * 100, 2) : null,
      });
    }
  }

  const refreshedSummary = nextPayload.summary || {};
  const refreshedSummaryIsMeaningful = hasMaterialUsSummaryValues([
    refreshedSummary.totalInvested,
    refreshedSummary.totalCurrentValue,
    refreshedSummary.totalNetworth,
    refreshedSummary.totalReturn,
  ]);

  if (
    !summaryUsesExtendedPricing &&
    !hasStaleAdjustment &&
    holdingsSummary.hasAnyValues &&
    holdingsSummary.hasMaterialValues &&
    !refreshedSummaryIsMeaningful
  ) {
    const liabilities = toNumber(refreshedSummary.liabilities);
    nextPayload.summary = assignSummaryTotals({
      totalInvested: holdingsSummary.totalInvested,
      totalCurrentValue: holdingsSummary.totalCurrentValue,
      totalNetworth:
        holdingsSummary.totalCurrentValue !== null && liabilities !== null
          ? round(holdingsSummary.totalCurrentValue + liabilities, 2)
          : holdingsSummary.totalCurrentValue,
      totalReturn: holdingsSummary.totalReturn,
      totalReturnPct:
        holdingsSummary.totalReturn !== null && holdingsSummary.totalInvested
          ? round((holdingsSummary.totalReturn / holdingsSummary.totalInvested) * 100, 2)
          : null,
    });
  }

  const usOnlyInvested = toNumber(usOnlyNetworth.total_invested);
  const usOnlyCurrentValue = toNumber(usOnlyNetworth.total_current_value);
  const usOnlyNetworthTotal = toNumber(usOnlyNetworth.total_networth);
  const usOnlyReturn = toNumber(usOnlyNetworth.total_return);
  const usOnlyReturnPct = toNumber(usOnlyNetworth.total_return_pct);
  const usOnlySummaryIsTrustworthy = hasTrustworthyUsSummary(usOnlyNetworth);
  if (!summaryUsesExtendedPricing && usOnlySummaryIsTrustworthy) {
    nextPayload.summary = assignSummaryTotals({
      totalInvested: usOnlyInvested !== null ? usOnlyInvested : nextPayload.summary?.totalInvested,
      totalCurrentValue: usOnlyCurrentValue !== null ? usOnlyCurrentValue : nextPayload.summary?.totalCurrentValue,
      totalNetworth: usOnlyNetworthTotal !== null ? usOnlyNetworthTotal : nextPayload.summary?.totalNetworth,
      totalReturn: usOnlyReturn !== null ? usOnlyReturn : nextPayload.summary?.totalReturn,
      totalReturnPct: usOnlyReturnPct !== null ? usOnlyReturnPct : nextPayload.summary?.totalReturnPct,
    });
  }

  return nextPayload;
}

function parseUsPortfolioCandleTime(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes('T')
    ? raw
    : raw.length <= 10
      ? `${raw}T00:00:00Z`
      : `${raw.replace(' ', 'T')}:00Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getUsPortfolioUniverseFromStore(portfolioStore = {}) {
  return (Array.isArray(portfolioStore?.US?.holdings) ? portfolioStore.US.holdings : [])
    .map((row) => String(row.ticker || row.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
    .filter(Boolean);
}

function getUsPortfolioCashFlowSince(portfolioStore = {}, since, until) {
  const us = portfolioStore.US || portfolioStore.us || {};
  const start = since instanceof Date ? since : new Date(since);
  const end = until instanceof Date ? until : new Date(until);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return (Array.isArray(us.orders) ? us.orders : []).reduce((sum, order) => {
    const ticker = String(order?.ticker || order?.symbol || '').trim();
    const rawTime = String(order?.filledAt || order?.placedAt || '').trim();
    const filledAt = /IST$/i.test(rawTime)
      ? new Date(rawTime.replace(/\s+IST$/i, '+05:30').replace(' ', 'T'))
      : parseUsPortfolioCandleTime(rawTime);
    if (!ticker || !filledAt || filledAt <= start || filledAt > end) return sum;
    const quantity = toNumber(order.quantity ?? order.units ?? order.shares) || 0;
    const value =
      toNumber(order.orderValue ?? order.order_value) ??
      toNumber(order.grossAmount ?? order.gross_amount) ??
      toNumber(order.netAmount ?? order.net_amount) ??
      ((toNumber(order.avgPrice ?? order.avg_price ?? order.price) || 0) * quantity);
    const side = String(order.side || '').trim().toUpperCase();
    if (side === 'BUY') return sum + value;
    if (side === 'SELL') return sum - value;
    return sum;
  }, 0);
}

function chartDaysSinceUsPortfolioBaseline() {
  const baseline = new Date(getUsPortfolioRangeStart('all').getTime() - 5 * 24 * 60 * 60 * 1000);
  const days = Math.ceil((Date.now() - baseline.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(7, days);
}

const PORTFOLIO_ANALYZER_RANGES = {
  '1d': { interval: 'h1', days: 5, pointLimit: 16, latestSessionOnly: true },
  '1w': { interval: 'd1', days: 14, pointLimit: 7, latestSessionOnly: false },
  '1m': { interval: 'd1', days: 45, pointLimit: 30, latestSessionOnly: false },
};

function normalizePortfolioAnalyzerRange(value = '1m') {
  const range = String(value || '1m').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PORTFOLIO_ANALYZER_RANGES, range) ? range : '1m';
}

function holdingLiveUsdPrice(row = {}) {
  const explicit = toNumber(row.lastPrice) ?? toNumber(row.livePrice) ?? toNumber(row.regularPrice);
  if (explicit !== null) return explicit;
  const units = toNumber(row.units);
  const value = toNumber(row.currentValue);
  return units && value !== null ? round(value / units, 6) : null;
}

function toCandleTimestamp(value = '', interval = 'd1') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (interval === 'd1') {
    return `${raw}T00:00:00.000Z`;
  }
  if (raw.includes('T') || raw.endsWith('Z')) {
    return raw;
  }
  return `${raw.replace(' ', 'T')}:00.000Z`;
}

function buildPriceSnapshotsFromCandleMap(candleMap = {}, options = {}) {
  const {
    interval = 'd1',
    pointLimit = 30,
    latestSessionOnly = false,
  } = options;
  const rows = [];
  for (const [ticker, candles] of Object.entries(candleMap || {})) {
    for (const candle of Array.isArray(candles) ? candles : []) {
      const timestamp = toCandleTimestamp(candle.date, interval);
      const close = toNumber(candle.close);
      if (!timestamp || close === null) continue;
      rows.push({ ticker, timestamp, close });
    }
  }
  rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (!rows.length) return [];
  const targetDay = latestSessionOnly
    ? rows.at(-1).timestamp.slice(0, 10)
    : null;
  const grouped = new Map();
  for (const row of rows) {
    if (targetDay && row.timestamp.slice(0, 10) !== targetDay) continue;
    const existing = grouped.get(row.timestamp) || { timestamp: row.timestamp, prices: {}, source: 'historical_us_stock_candles' };
    existing.prices[row.ticker] = row.close;
    grouped.set(row.timestamp, existing);
  }
  return [...grouped.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).slice(-pointLimit);
}

function priceOnBaselineDate(candles = [], baselineDate = '2026-06-05') {
  const match = (Array.isArray(candles) ? candles : []).find((candle) => String(candle.date || '').slice(0, 10) === baselineDate);
  return toNumber(match?.close);
}

function warningMessage(label, error) {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  return `${label}: ${message}`;
}

async function fetchPortfolioAnalyzerSeriesData(usHoldings = []) {
  const tickers = [...new Set(
    (Array.isArray(usHoldings) ? usHoldings : [])
      .map((row) => String(row?.ticker || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  const warnings = [];
  const dailyCandlesByTicker = {};
  const intradayCandlesByTicker = {};

  await Promise.all(tickers.map(async (ticker) => {
    try {
      const daily = await fetchUsHistoricalCandles(ticker, { interval: 'd1', days: 60 });
      dailyCandlesByTicker[ticker] = daily.candles || [];
    } catch (error) {
      warnings.push(warningMessage(`${ticker} daily history`, error));
      dailyCandlesByTicker[ticker] = [];
    }
    try {
      const intraday = await fetchUsHistoricalCandles(ticker, { interval: 'h1', days: 5 });
      intradayCandlesByTicker[ticker] = intraday.candles || [];
    } catch (error) {
      warnings.push(warningMessage(`${ticker} intraday history`, error));
      intradayCandlesByTicker[ticker] = [];
    }
  }));

  const baselinePrices = Object.fromEntries(tickers.map((ticker) => [
    ticker,
    priceOnBaselineDate(dailyCandlesByTicker[ticker], '2026-06-05'),
  ]).filter(([, price]) => price !== null));
  const baseline = buildCurrentHoldingsBaseline(usHoldings, baselinePrices);

  const portfolioSeries = Object.fromEntries(Object.entries(PORTFOLIO_ANALYZER_RANGES).map(([range, config]) => {
    const candleMap = config.interval === 'h1' ? intradayCandlesByTicker : dailyCandlesByTicker;
    const snapshots = buildPriceSnapshotsFromCandleMap(candleMap, config);
    const series = buildCurrentHoldingsRepricedSeries({
      rows: usHoldings,
      baselineValueUsd: baseline.baselineValueUsd,
      snapshots,
      fallbackLatestTimestamp: new Date().toISOString(),
    });
    return [range, buildUsPortfolioSeriesPayload(series, {
      range,
      currency: 'USD',
      source: 'INDmoney current holdings repriced',
      warnings,
    })];
  }));

  const seriesAvailability = Object.fromEntries(Object.entries(portfolioSeries).map(([range, payload]) => [
    range,
    {
      ok: Array.isArray(payload.valuePoints) && payload.valuePoints.length > 0,
      pointCount: payload.pointCount || 0,
      warningCount: warnings.length,
    },
  ]));

  return {
    baseline,
    portfolioSeries,
    seriesAvailability,
    warnings,
  };
}

async function getIndMoneyUsPortfolioSeriesPayload(options = {}) {
  const range = normalizePortfolioAnalyzerRange(options.range || '1m');
  const dashboardPayload = await buildIndMoneyDashboardPayload();
  return dashboardPayload.portfolioSeries?.[range] || buildUsPortfolioSeriesPayload([], {
    range,
    currency: 'USD',
    source: 'INDmoney current holdings repriced',
    warnings: dashboardPayload.warnings || [],
  });
}

async function getCachedIndMoneyDashboardBase(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  const cacheTtlMs = getIndMoneyDashboardBaseCacheIntervalMs();
  if (!force && indMoneyDashboardBaseCache.payload && indMoneyDashboardBaseCache.expiresAt > now) {
    if (indMoneyDashboardBaseCache.sessionRefreshMs === cacheTtlMs) {
      return {
        ...indMoneyDashboardBaseCache.payload,
        cached: true,
        expiresAt: indMoneyDashboardBaseCache.expiresAt,
      };
    }
  }
  if (!force && indMoneyDashboardBaseCache.promise) {
    const payload = await indMoneyDashboardBaseCache.promise;
    return {
      ...payload,
      cached: true,
      expiresAt: indMoneyDashboardBaseCache.expiresAt,
    };
  }

  indMoneyDashboardBaseCache.promise = buildIndMoneyDashboardBasePayload()
    .then((payload) => {
      indMoneyDashboardBaseCache = {
        payload,
        expiresAt: Date.now() + cacheTtlMs,
        sessionRefreshMs: cacheTtlMs,
        promise: null,
      };
      return payload;
    })
    .catch((error) => {
      indMoneyDashboardBaseCache.promise = null;
      throw error;
    });

  const payload = await indMoneyDashboardBaseCache.promise;
  return {
    ...payload,
    cached: false,
    expiresAt: indMoneyDashboardBaseCache.expiresAt,
  };
}

function normalizeUsHoldingForIndMoneyDashboard(row = {}) {
  const ticker = String(row.ticker || '').trim().toUpperCase();
  if (!ticker) return null;
  const fundamentals = row.fundamentalSnapshot || {};
  const sector = row.sectorContext || {};
  const recommendation = row.recommendation || {};
  return {
    name: row.name || row.sourceTitle || ticker,
    ticker,
    broker: row.broker || row.source || 'INDmoney / Market engine',
    units: toNumber(row.quantity ?? row.units),
    invested: toNumber(row.invested),
    currentValue: toNumber(row.currentValue ?? row.liveValue),
    pnl: toNumber(row.totalReturn ?? row.liveReturn),
    pnlPct: toNumber(row.totalReturnPct ?? row.liveReturnPct),
    weightPct: toNumber(row.weightPct),
    avgPrice: toNumber(row.avgPrice),
    lastPrice: toNumber(row.livePrice ?? row.lastPrice ?? row.regularPrice),
    regularPrice: toNumber(row.regularPrice),
    extendedPrice: toNumber(row.extendedPrice),
    previousClose: toNumber(row.previousClose),
    oneDayReturn: toNumber(row.oneDayReturn),
    oneDayReturnPct: toNumber(row.oneDayReturnPct),
    movePct: toNumber(row.movePct),
    moveAbs: toNumber(row.moveAbs ?? row.sessionMoveAbs),
    moveBasis: row.moveBasis || 'regular',
    sector: sector.label || fundamentals.sector || row.sector || '',
    sectorSummary: sector.summary || '',
    marketCap: toNumber(fundamentals.marketCap ?? row.marketCap),
    pe: toNumber(fundamentals.pe),
    epsTTM: toNumber(fundamentals.epsTTM),
    revenueGrowthYoY: toNumber(fundamentals.revenueGrowthYoY),
    epsGrowthYoY: toNumber(fundamentals.epsGrowthYoY),
    operatingMargin: toNumber(fundamentals.operatingMargin),
    beta: toNumber(fundamentals.beta),
    week52High: toNumber(fundamentals.week52High),
    week52Low: toNumber(fundamentals.week52Low),
    qualityLabel: fundamentals.qualityLabel || '',
    recommendationAction: recommendation.actionLabel || recommendation.action || '',
    recommendationConviction: recommendation.conviction || '',
    detailSummary: fundamentals.summary || row.newsDigest?.summary || row.catalyst || '',
    catalyst: row.catalyst || row.newsDigest?.latestHeadline || '',
    source: 'Market portfolio engine',
    currency: 'USD',
  };
}

function normalizeWatchlistStockForIndMoneyDashboard(row = {}) {
  const ticker = String(row.ticker || '').trim().toUpperCase();
  if (!ticker) return null;
  const fundamentals = row.financialSnapshot || row.fundamentalSnapshot || {};
  const recommendation = row.recommendationDetail || {};
  const profile = STOCK_PROFILES[ticker] || {};
  return {
    ticker,
    name: row.name || row.sourceTitle || ticker,
    lastPrice: toNumber(row.currentPrice ?? row.livePrice ?? row.lastPrice),
    movePct: toNumber(row.movePct),
    moveAbs: toNumber(row.moveAbs),
    moveBasis: row.moveBasis || 'regular',
    sector: fundamentals.sector || row.sector || profile.aiCategory || profile.category || profile.role || '',
    marketCap: toNumber(fundamentals.marketCap ?? fundamentals.marketCapitalization ?? row.marketCap ?? profile.fundamentals?.marketCap),
    pe: toNumber(fundamentals.pe ?? fundamentals.peTTM),
    beta: toNumber(fundamentals.beta),
    revenueGrowthYoY: toNumber(fundamentals.revenueGrowthYoY ?? fundamentals.revenueGrowthTTMYoy),
    epsGrowthYoY: toNumber(fundamentals.epsGrowthYoY ?? fundamentals.epsGrowthTTMYoy),
    qualityLabel: fundamentals.qualityLabel || '',
    recommendation: row.recommendation || recommendation.wishlistAction || recommendation.action || '',
    confidence: row.confidence || recommendation.confidence || '',
    buyBelow: toNumber(row.buyBelow),
    entryZoneLow: toNumber(row.entryZoneLow),
    entryZoneHigh: toNumber(row.entryZoneHigh),
    stopLoss: toNumber(row.stopLoss),
    target1: toNumber(row.target1),
    target2: toNumber(row.target2),
    invalidateBelow: toNumber(row.invalidateBelow),
    newsTone: row.newsTone || '',
    catalystQuality: row.catalystQuality || '',
    earningsDate: row.earnings?.next?.date || row.earningsDate || '',
    planSummary: row.planSummary || recommendation.planSummary || '',
    fundingAction: row.fundingAction || '',
    gapRule: row.gapRule || '',
    currency: 'USD',
  };
}

function extractDashboardHoldingRows(payload) {
  return normalizeIndMoneyHoldings(payload?.holdings || payload?.data?.holdings || payload?.data || payload);
}

export async function refillEmptyDashboardUsHoldings(holdings = {}, options = {}) {
  const currentRows = Array.isArray(holdings?.US_STOCK) ? holdings.US_STOCK : [];
  if (currentRows.length) {
    return currentRows;
  }
  const portfolioStore = options.portfolioStore || await readPortfolioStore();
  const baselinePortfolio = buildStoredUsPortfolio(portfolioStore?.US || null);
  const baselineHoldings = Array.isArray(baselinePortfolio?.holdings) ? baselinePortfolio.holdings : [];
  if (!baselineHoldings.length) {
    return [];
  }
  return baselineHoldings
    .map((row) => normalizeUsHoldingForIndMoneyDashboard({
      ...row,
      source: 'Baseline portfolio snapshot',
      broker: 'INDmoney baseline snapshot',
    }))
    .filter(Boolean);
}

export async function refreshEmptyDashboardHoldingsResults(holdingsResults = [], options = {}) {
  const provider = options.provider || createIndMoneyMcpProvider({ cacheSeconds: 0 });
  const canRefresh = typeof provider?.isAvailable === 'function' ? provider.isAvailable() : Boolean(provider);
  if (!canRefresh) {
    return Array.isArray(holdingsResults) ? holdingsResults : [];
  }
  return Promise.all((Array.isArray(holdingsResults) ? holdingsResults : []).map(async (result) => {
    const assetType = String(result?.label || '').split(':')[1] || '';
    if (assetType !== 'US_STOCK' || result?.error) {
      return result;
    }
    if (extractDashboardHoldingRows(result?.value).length) {
      return result;
    }
    try {
      const refreshedValue = options.provider
        ? await provider.networthHoldings(assetType)
        : await withIndMoneyMcpCache(`holdings:${assetType}:refresh`, async (liveProvider) => liveProvider.networthHoldings(assetType));
      return extractDashboardHoldingRows(refreshedValue).length
        ? { ...result, value: refreshedValue }
        : result;
    } catch {
      return result;
    }
  }));
}

export function applyLiveQuotesToDashboardHoldings(holdings = {}, quoteRows = [], tradeDateLots = {}) {
  const quotesByTicker = new Map(
    (Array.isArray(quoteRows) ? quoteRows : [])
      .map((row) => [String(row?.ticker || '').trim().toUpperCase(), row])
      .filter(([ticker, row]) => ticker && toNumber(row?.lastPrice) !== null),
  );
  if (!quotesByTicker.size) {
    return holdings;
  }
  return Object.fromEntries(Object.entries(holdings || {}).map(([assetType, rows]) => [
    assetType,
    (Array.isArray(rows) ? rows : []).map((row) => {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      const quote = quotesByTicker.get(ticker);
      if (!quote) return row;
      const tradeLots = tradeDateLots[ticker] || null;
      const liveLastPrice = toNumber(quote.lastPrice);
      const quoteMovePct = toNumber(quote.movePct);
      const inferredPreviousClose =
        liveLastPrice !== null &&
        quoteMovePct !== null &&
        quoteMovePct > -100
          ? round(liveLastPrice / (1 + (quoteMovePct / 100)), 4)
          : null;
      const previousClose = toNumber(quote.previousClose) ?? toNumber(row.previousClose) ?? inferredPreviousClose;
      const units = toNumber(row.units);
      const invested = toNumber(row.invested);
      const quoteBasis = String(quote.moveBasis || row.moveBasis || 'regular');
      const liveRegularPrice = toNumber(quote.regularPrice) ?? toNumber(row.regularPrice) ?? liveLastPrice;
      const liveExtendedPrice = toNumber(quote.extendedPrice);
      const effectiveExtendedPrice = quoteBasis === 'regular'
        ? toNumber(row.extendedPrice)
        : (liveExtendedPrice ?? liveLastPrice);
      const regularValue = liveRegularPrice !== null && units !== null ? round(units * liveRegularPrice, 2) : toNumber(row.regularValue);
      const extendedValue = effectiveExtendedPrice !== null && units !== null ? round(units * effectiveExtendedPrice, 2) : toNumber(row.extendedValue);
      const currentValue = liveLastPrice !== null && units !== null ? round(units * liveLastPrice, 2) : toNumber(row.currentValue);
      const pnl = currentValue !== null && invested !== null ? round(currentValue - invested, 2) : toNumber(row.pnl);
      const pnlPct = pnl !== null && invested ? round((pnl / invested) * 100, 2) : toNumber(row.pnlPct);
      const regularPnl = regularValue !== null && invested !== null ? round(regularValue - invested, 2) : toNumber(row.regularPnl);
      const regularPnlPct = regularPnl !== null && invested ? round((regularPnl / invested) * 100, 2) : toNumber(row.regularPnlPct);
      const extendedReturn = extendedValue !== null && invested !== null ? round(extendedValue - invested, 2) : toNumber(row.extendedReturn);
      const extendedReturnPct = extendedReturn !== null && invested ? round((extendedReturn / invested) * 100, 2) : toNumber(row.extendedReturnPct);
      const oneDayMetrics = computeHoldingOneDayReturn({
        quantity: units,
        regularPrice: liveLastPrice,
        previousClose,
        importedOneDayReturn: toNumber(row.oneDayReturn),
        importedOneDayReturnPct: toNumber(row.oneDayReturnPct),
        tradeLots,
      });
      return {
        ...row,
        livePrice: liveLastPrice,
        lastPrice: liveLastPrice,
        updatedAt: quote.updatedAt || quote.timestamp || row.updatedAt || null,
        currentValue,
        pnl,
        pnlPct,
        regularPrice: liveRegularPrice,
        lastPriceCurrency: 'USD',
        regularPriceCurrency: 'USD',
        extendedPrice: effectiveExtendedPrice,
        extendedValue,
        extendedReturn,
        extendedReturnPct,
        regularValue,
        regularPnl,
        regularPnlPct,
        previousClose,
        heldQuantityAtPreviousClose: oneDayMetrics.heldQuantityAtPreviousClose,
        todayBoughtQuantity: oneDayMetrics.todayBoughtQuantity,
        previousCloseValue: oneDayMetrics.previousCloseValue,
        oneDayReturn: oneDayMetrics.oneDayReturn,
        oneDayReturnPct: oneDayMetrics.oneDayReturnPct,
        movePct: quoteMovePct ?? row.movePct,
        moveAbs: toNumber(quote.moveAbs) ?? row.moveAbs,
        moveBasis: quoteBasis,
        marketCap: toNumber(quote.marketCap) ?? row.marketCap,
        sector: quote.sector || row.sector,
        pe: toNumber(quote.pe) ?? row.pe,
        beta: toNumber(quote.beta) ?? row.beta,
        revenueGrowthYoY: toNumber(quote.revenueGrowthYoY) ?? row.revenueGrowthYoY,
        epsGrowthYoY: toNumber(quote.epsGrowthYoY) ?? row.epsGrowthYoY,
      };
    }),
  ]));
}

async function fetchLiveQuoteRowsForDashboardHoldings(rows = []) {
  const tickers = [...new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => String(row?.ticker || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  if (!tickers.length) {
    return [];
  }
  const details = normalizeMcpUsStockDetails(await withIndMoneyMcpCache(
    `us:holding-quotes:${tickers.join(',')}`,
    async (provider) => provider.getUsStocksDetails(tickers, ['analyst', 'news']),
  ));
  return tickers
    .map((ticker) => {
      const quote = details[ticker];
      if (!quote) return null;
      return {
        ticker,
        regularPrice: toNumber(quote.price),
        lastPrice: toNumber(quote.price),
        previousClose: toNumber(quote.previousClose),
        movePct: toNumber(quote.pctChange),
        moveAbs: toNumber(quote.absChange),
        moveBasis: 'regular',
        marketCap: toNumber(quote.marketCap),
        updatedAt: quote.timestamp || null,
      };
    })
    .filter((row) => row?.ticker && toNumber(row.lastPrice) !== null);
}

async function buildIndMoneyDashboardPayload(options = {}) {
  const buildDisconnectedPayload = (errorMessage, fxRate) => {
    const usRefreshIntervalMs = getUsRefreshIntervalMs();
    const sessionMeta = {
      usSession: getUsSessionLabel(),
      usRefreshIntervalMs: usRefreshIntervalMs || US_CLOSED_SESSION_REFRESH_MS,
      usRefreshEnabled: Boolean(usRefreshIntervalMs),
      indMoneyDashboardBaseCacheMs: getIndMoneyDashboardBaseCacheIntervalMs(),
    };
    if (liveSessionStores.dashboardLastSuccess) {
      return {
        ...liveSessionStores.dashboardLastSuccess,
        updatedAt: nowTimestamp(),
        fxRate: toNumber(fxRate),
        connection: {
          ...(liveSessionStores.dashboardLastSuccess.connection || {}),
          source: 'INDmoney MCP',
          mcpAvailable: false,
          errors: { networth: errorMessage || 'INDmoney MCP is disconnected.' },
        },
        dataFreshness: {
          ...(liveSessionStores.dashboardLastSuccess.dataFreshness || {}),
          status: 'stale-in-memory',
          source: 'INDmoney MCP',
          reason: errorMessage || 'INDmoney MCP is disconnected.',
        },
        sessionMeta,
      };
    }
    const payload = normalizeIndMoneyDashboardPayload({
      networth: {},
      holdings: {},
      usWatchlist: { watchlists: [] },
      watchlistDetails: [],
      history: [],
      sessionMeta,
      errors: { networth: errorMessage || 'INDmoney MCP is disconnected.' },
    });
    payload.dataFreshness = {
      status: 'unavailable',
      source: 'INDmoney MCP',
      indMoneyMcpBaselineCached: false,
      indMoneyMcpBaselineRefreshedAt: null,
      indMoneyMcpBaselineExpiresAt: null,
      indMoneyMcpBaselineCacheMs: getIndMoneyDashboardBaseCacheIntervalMs(),
    };
    payload.sessionMeta = sessionMeta;
    payload.fxRate = toNumber(fxRate);
    return payload;
  };

  let fxRate = null;

  if (!isIndMoneyMcpConnected()) {
    return buildDisconnectedPayload('INDmoney MCP is disconnected.', fxRate);
  }

  const base = await getCachedIndMoneyDashboardBase({ force: options.forceBase });
  const {
    networthResult,
    holdingsResults,
    usWatchlistResult,
    cached: baseCached,
    refreshedAt: baseRefreshedAt,
    expiresAt: baseExpiresAt,
  } = base;
  const resilientHoldingsResults = await refreshEmptyDashboardHoldingsResults(holdingsResults);
  const portfolioStore = await readPortfolioStore();
  const errors = {};
  if (networthResult.error) {
    errors.networth = networthResult.error;
  }
  if (errors.networth) {
    return buildDisconnectedPayload(errors.networth, fxRate);
  }
  const holdings = {};
  for (const result of resilientHoldingsResults) {
    const assetType = result.label.split(':')[1];
    if (result.error) {
      errors[result.label] = result.error;
      holdings[assetType] = [];
    } else {
      holdings[assetType] = extractDashboardHoldingRows(result.value);
    }
  }
  const mcpUsHoldingsCount = Array.isArray(holdings.US_STOCK) ? holdings.US_STOCK.length : 0;
  holdings.US_STOCK = await refillEmptyDashboardUsHoldings(holdings, { portfolioStore });
  const usingBaselineSnapshot = mcpUsHoldingsCount === 0 && Array.isArray(holdings.US_STOCK) && holdings.US_STOCK.length > 0;
  const usOnlyNetworth = toUsOnlyIndMoneyNetworth(networthResult.value || {}, holdings.US_STOCK || []);
  if (usWatchlistResult.error) errors.usWatchlist = usWatchlistResult.error;

  let watchlistDetails = [];

  try {
    const { stocksPayload } = await getWatchlistPayloadsForRequest();
    watchlistDetails = Array.isArray(stocksPayload?.stocks)
      ? stocksPayload.stocks.map(normalizeWatchlistStockForIndMoneyDashboard).filter(Boolean)
      : [];
    holdings.US_STOCK = applyLiveQuotesToDashboardHoldings(
      { US_STOCK: holdings.US_STOCK || [] },
      watchlistDetails,
      {},
    ).US_STOCK || holdings.US_STOCK || [];
  } catch (error) {
    errors.watchlistDetails = error.message;
  }

  try {
    const holdingQuoteRows = await fetchLiveQuoteRowsForDashboardHoldings(holdings.US_STOCK || []);
    holdings.US_STOCK = applyLiveQuotesToDashboardHoldings(
      { US_STOCK: holdings.US_STOCK || [] },
      holdingQuoteRows,
      {},
    ).US_STOCK || holdings.US_STOCK || [];
  } catch (error) {
    errors.holdingQuotes = error.message;
  }

  const history = await readIndMoneyHistory();
  const usRefreshIntervalMs = getUsRefreshIntervalMs();
  const sessionMeta = {
    usSession: getUsSessionLabel(),
    usRefreshIntervalMs: usRefreshIntervalMs || US_CLOSED_SESSION_REFRESH_MS,
    usRefreshEnabled: Boolean(usRefreshIntervalMs),
    indMoneyDashboardBaseCacheMs: getIndMoneyDashboardBaseCacheIntervalMs(),
  };
  const payload = normalizeIndMoneyDashboardPayload({
    networth: usOnlyNetworth,
    holdings,
    usWatchlist: usWatchlistResult.value || { watchlists: [] },
    watchlistDetails,
    history,
    sessionMeta,
    errors,
  });
  const assetClassInvested = toNumber(payload.assetClassPnl?.[0]?.invested);
  const assetClassInvestedUsd = toNumber(payload.assetClassPnl?.[0]?.investedUsd);
  fxRate = toNumber(payload.usSessionPnl?.fxRate)
    ?? toNumber(payload.usSessionPnl?.reference?.fxRate)
    ?? (assetClassInvested !== null && assetClassInvestedUsd
      ? round(assetClassInvested / assetClassInvestedUsd, 4)
      : null);
  payload.fxRate = toNumber(fxRate);
  payload.dataFreshness = {
    ...(payload.dataFreshness || {}),
    status: usingBaselineSnapshot ? 'stale-in-memory' : 'live',
    source: 'INDmoney MCP',
    reason: usingBaselineSnapshot
      ? `Portfolio positions are extrapolated from the baseline snapshot dated ${portfolioStore?.US?.updatedAt || '2026-06-05'} because MCP holdings are empty.`
      : null,
    indMoneyMcpBaselineCached: Boolean(baseCached),
    indMoneyMcpBaselineRefreshedAt: baseRefreshedAt || null,
    indMoneyMcpBaselineExpiresAt: baseExpiresAt ? new Date(baseExpiresAt).toISOString() : null,
    indMoneyMcpBaselineCacheMs: getIndMoneyDashboardBaseCacheIntervalMs(),
  };
  payload.sourceMetadata = {
    ...(payload.sourceMetadata || {}),
    provider: 'INDmoney MCP',
    holdingsSource: usingBaselineSnapshot ? 'baseline-portfolio-snapshot' : 'indmoney-mcp',
    holdingsBaselineUpdatedAt: usingBaselineSnapshot ? (portfolioStore?.US?.updatedAt || null) : null,
  };
  payload.sessionMeta = {
    ...(payload.sessionMeta || {}),
    usSession: sessionMeta.usSession,
    usRefreshIntervalMs: sessionMeta.usRefreshIntervalMs,
    usRefreshEnabled: sessionMeta.usRefreshEnabled,
    indMoneyDashboardBaseCacheMs: getIndMoneyDashboardBaseCacheIntervalMs(),
  };
  const hasStaleAdjustment =
    Array.isArray(usOnlyNetworth?.dataAdjustments) &&
    usOnlyNetworth.dataAdjustments.some((item) => item?.rule === 'zero_stale_indian_mf_and_stocks');
  reconcileIndMoneyDashboardSummary(payload, {
    usOnlyNetworth,
    holdings: holdings.US_STOCK || [],
    hasStaleAdjustment,
  });
  const portfolioAnalyzer = await fetchPortfolioAnalyzerSeriesData(payload.holdings?.US_STOCK || holdings.US_STOCK || []);
  payload.baseline = {
    baselineDate: portfolioAnalyzer.baseline.baselineDate,
    baselineMethod: portfolioAnalyzer.baseline.baselineMethod,
    baselineValueUsd: portfolioAnalyzer.baseline.baselineValueUsd,
    latestValueUsd: portfolioAnalyzer.baseline.latestValueUsd,
    changeUsd: portfolioAnalyzer.baseline.changeUsd,
    changePct: portfolioAnalyzer.baseline.changePct,
    missingBaselineTickers: portfolioAnalyzer.baseline.missingBaselineTickers,
  };
  payload.holdings = {
    US_STOCK: portfolioAnalyzer.baseline.holdings,
  };
  payload.portfolioSeries = portfolioAnalyzer.portfolioSeries;
  payload.seriesAvailability = portfolioAnalyzer.seriesAvailability;
  payload.warnings = [
    ...new Set([
      ...Object.values(errors).filter(Boolean),
      ...(portfolioAnalyzer.warnings || []),
    ]),
  ];
  try {
    await persistCanonicalLatestUsPortfolioReference();
  } catch {
    await persistLatestUsPortfolioReference({
      summary: payload.summary || {},
      holdings: payload.holdings?.US_STOCK || [],
      updatedAt: payload.updatedAt || nowIso(),
      source: usingBaselineSnapshot ? 'Baseline portfolio snapshot' : 'INDmoney MCP',
    });
  }
  const snapshotPoint = normalizeIndMoneyHistoryPoint(usOnlyNetworth, {
    timezone: CONFIG.timezone,
    timestamp: nowTimestamp(),
  });
  if (snapshotPoint) {
    const appendResult = appendIndMoneyHistoryPoint(await readIndMoneyHistory(), snapshotPoint, {
      force: true,
      allowMultiplePerDay: true,
      timezone: CONFIG.timezone,
    });
    await writeIndMoneyHistory(appendResult.history);
    payload.growth = buildIndMoneyGrowthSeries(appendResult.history);
  }
  liveSessionStores.dashboardLastSuccess = structuredClone(payload);
  return payload;
}

function formatCompactCurrency(value) {
  const amount = toNumber(value);
  if (amount === null) {
    return 'n/a';
  }
  const abs = Math.abs(amount);
  if (abs >= 1e12) return `$${round(amount / 1e12, 2)}T`;
  if (abs >= 1e9) return `$${round(amount / 1e9, 2)}B`;
  if (abs >= 1e6) return `$${round(amount / 1e6, 2)}M`;
  if (abs >= 1e3) return `$${round(amount / 1e3, 2)}K`;
  return `$${round(amount, 2).toFixed(2)}`;
}

function renderWatchlistStocksPage(payload, watchlistAiPayload = null) {
  const rows = Array.isArray(payload?.stocks) ? payload.stocks : [];
  const pagePayloadForClient = JSON.stringify({
    updatedAt: payload?.updatedAt || null,
    marketRegime: payload?.marketRegime || null,
    marketSession: payload?.marketSession || null,
    liveDataEnabled: Boolean(payload?.liveDataEnabled),
    stale: Boolean(payload?.stale),
    message: payload?.message || null,
    stocks: rows,
  }).replace(/</g, '\\u003c');
  const fullPayloadForClient = JSON.stringify({
    page: {
      updatedAt: payload?.updatedAt || null,
      marketRegime: payload?.marketRegime || null,
      marketSession: payload?.marketSession || null,
      liveDataEnabled: Boolean(payload?.liveDataEnabled),
      stale: Boolean(payload?.stale),
      message: payload?.message || null,
    },
    stocksPayload: payload || null,
    watchlistAiPayload: watchlistAiPayload || null,
  }).replace(/</g, '\\u003c');
  const liveDataEnabled = Boolean(payload?.liveDataEnabled);
  const marketSession = payload?.marketSession || 'unknown';
  const statusLabel = liveDataEnabled ? 'Live API refresh is active during market hours.' : 'Live API refresh is paused until the U.S. market opens.';
  const summaryText =
    payload?.message ||
    (liveDataEnabled
      ? 'A human-readable view of the live watchlist analysis for your planned buys, including recommendations, entry levels, funding notes, and risk flags.'
      : 'This page is showing the last cached watchlist analysis. Fresh market data and OpenAI calls will resume automatically once the U.S. market is open.');
  const money = (value) => value !== null && value !== undefined && toNumber(value) !== null ? `$${round(toNumber(value), 2).toFixed(2)}` : 'n/a';
  const compactMoney = (value) => formatCompactCurrency(value);
  const multiple = (value) => value !== null && value !== undefined && toNumber(value) !== null ? `${round(toNumber(value), 2).toFixed(2)}x` : 'n/a';
  const percent = (value) => value !== null && value !== undefined && toNumber(value) !== null ? `${formatSignedValue(value, 1, '%')}` : 'n/a';
  const cards = rows.map((stock) => {
    const toneClass =
      stock.recommendation === 'BUY_PULLBACK_ONLY' || stock.recommendation === 'BUY_OPEN'
        ? 'buy'
        : stock.recommendation === 'SKIP' || stock.recommendation === 'WATCH_NO_BUY'
          ? 'skip'
          : 'watch';
    const warnings = sanitizeResearchWarnings(stock.researchSummary?.warnings);
    const financials = stock.financialSnapshot || {};
    const earnings = Array.isArray(stock.earnings?.recent) ? stock.earnings.recent.slice(0, 3) : [];
    return `
      <article class="card">
        <div class="topline">
          <div class="identity">
            <div class="ticker">${escapeHtml(stock.ticker)}</div>
            <div class="name">${escapeHtml(stock.name)}</div>
          </div>
          <div class="pill ${toneClass}">${escapeHtml(stock.recommendation || 'WATCH')}</div>
        </div>
        <div class="price-row">
          <div class="metric"><span>Price</span><strong>${stock.currentPrice !== null && stock.currentPrice !== undefined ? `$${round(toNumber(stock.currentPrice) || 0, 2).toFixed(2)}` : 'n/a'}</strong></div>
          <div class="metric"><span>Move</span><strong>${escapeHtml(formatSignedValue(stock.movePct, 2, '%'))}</strong></div>
          <div class="metric"><span>Planned</span><strong>$${escapeHtml(String(stock.plannedAmount || 0))}</strong></div>
          <div class="metric"><span>Confidence</span><strong>${escapeHtml(stock.confidence || 'n/a')}</strong></div>
        </div>
        <p class="summary">${escapeHtml(stock.planSummary || 'No summary available.')}</p>
        <div class="levels">
          <div><span>Buy Below</span><strong>${stock.buyBelow !== null && stock.buyBelow !== undefined ? `$${round(toNumber(stock.buyBelow) || 0, 2).toFixed(2)}` : 'n/a'}</strong></div>
          <div><span>Stop</span><strong>${stock.stopLoss !== null && stock.stopLoss !== undefined ? `$${round(toNumber(stock.stopLoss) || 0, 2).toFixed(2)}` : 'n/a'}</strong></div>
          <div><span>Target 1</span><strong>${stock.target1 !== null && stock.target1 !== undefined ? `$${round(toNumber(stock.target1) || 0, 2).toFixed(2)}` : 'n/a'}</strong></div>
          <div><span>Target 2</span><strong>${stock.target2 !== null && stock.target2 !== undefined ? `$${round(toNumber(stock.target2) || 0, 2).toFixed(2)}` : 'n/a'}</strong></div>
        </div>
        <div class="detail-stack">
          <div class="detail"><span>Funding</span><strong>${escapeHtml(stock.fundingAction || 'n/a')}</strong></div>
          <div class="detail"><span>Gap Rule</span><strong>${escapeHtml(stock.gapRule || 'n/a')}</strong></div>
          <div class="detail"><span>News Tone</span><strong>${escapeHtml(stock.newsTone || 'n/a')}</strong></div>
          <div class="detail"><span>Catalyst Quality</span><strong>${escapeHtml(stock.catalystQuality || 'n/a')}</strong></div>
        </div>
        <div class="section-title">Financials</div>
        <div class="fundamentals">
          <div><span>Market Cap</span><strong>${compactMoney(financials.marketCapitalization)}</strong></div>
          <div><span>P/E</span><strong>${multiple(financials.peTTM)}</strong></div>
          <div><span>P/S</span><strong>${multiple(financials.psTTM)}</strong></div>
          <div><span>Revenue Growth</span><strong>${percent(financials.revenueGrowthTTMYoy)}</strong></div>
          <div><span>EPS Growth</span><strong>${percent(financials.epsGrowthTTMYoy)}</strong></div>
          <div><span>Operating Margin</span><strong>${percent(financials.operatingMargin)}</strong></div>
          <div><span>Gross Margin</span><strong>${percent(financials.grossMarginTTM)}</strong></div>
          <div><span>52W High</span><strong>${money(financials.week52High)}</strong></div>
        </div>
        <div class="section-title">Recent Earnings</div>
        <div class="earnings">
          ${
            earnings.length
              ? earnings.map((item) => `
                <div class="earning-row">
                  <div><span>Period</span><strong>${escapeHtml(item.period || 'n/a')}</strong></div>
                  <div><span>Actual</span><strong>${item.actual !== null && item.actual !== undefined ? round(toNumber(item.actual) || 0, 2).toFixed(2) : 'n/a'}</strong></div>
                  <div><span>Estimate</span><strong>${item.estimate !== null && item.estimate !== undefined ? round(toNumber(item.estimate) || 0, 2).toFixed(2) : 'n/a'}</strong></div>
                  <div><span>Surprise</span><strong>${percent(item.surprisePercent)}</strong></div>
                </div>
              `).join('')
              : `<div class="detail"><span>Earnings</span><strong>No recent earnings data.</strong></div>`
          }
        </div>
        ${
          warnings.length
            ? `<div class="warnings"><span>Data warnings</span><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
            : ''
        }
      </article>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Watchlist Stocks Dashboard</title>
    ${renderAppShellHead('/watchlist-stocks', { actionSelectors: ['.actions'] })}
    <style>
      :root {
        --bg: #f4efe3;
        --panel: rgba(255,251,244,0.92);
        --panel-glass: rgba(255,255,255,.65);
        --panel-glass-soft: rgba(255,255,255,.55);
        --ink: #1f2423;
        --muted: #5d645f;
        --line: rgba(31,36,35,0.12);
        --accent: #0b5966;
        --buy: #16653e;
        --watch: #8b6b2e;
        --skip: #9f2d2d;
      }
      :root[data-app-theme="dark"] {
        --bg: #0d1415;
        --panel: rgba(18,27,28,0.92);
        --panel-glass: rgba(22,33,34,.82);
        --panel-glass-soft: rgba(27,40,41,.78);
        --ink: #edf5f2;
        --muted: #9aa8a3;
        --line: rgba(214,230,225,0.12);
        --accent: #6dccd8;
        --buy: #57c989;
        --watch: #d8aa4f;
        --skip: #ee7f7f;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-app-theme="light"]) {
          --bg: #0d1415;
          --panel: rgba(18,27,28,0.92);
          --panel-glass: rgba(22,33,34,.82);
          --panel-glass-soft: rgba(27,40,41,.78);
          --ink: #edf5f2;
          --muted: #9aa8a3;
          --line: rgba(214,230,225,0.12);
          --accent: #6dccd8;
          --buy: #57c989;
          --watch: #d8aa4f;
          --skip: #ee7f7f;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: var(--app-font);
        background:
          radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 22%, transparent), transparent 28%),
          radial-gradient(circle at top right, color-mix(in srgb, var(--skip) 16%, transparent), transparent 24%),
          linear-gradient(180deg, var(--bg), color-mix(in srgb, var(--bg) 70%, #e9dfcb));
      }
      .wrap { max-width: 1400px; margin: 0 auto; padding: 16px 18px 30px; }
      .hero { margin-bottom: 10px; }
      .eyebrow { text-transform: uppercase; letter-spacing: .18em; font-size: 12px; color: var(--accent); }
      h1 { margin: 8px 0; font-size: clamp(34px, 5vw, 58px); line-height: .95; }
      .sub { color: var(--muted); max-width: 980px; font-size: 18px; line-height: 1.5; }
      .meta {
        display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 12px;
      }
      .meta-chip, .pill {
        display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px;
        padding: 9px 14px; background: var(--panel-glass); font: inherit;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 10px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 12px;
        box-shadow: 0 18px 50px rgba(30,35,30,.08);
        min-width: 0;
      }
      .topline {
        display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; margin-bottom: 8px;
      }
      .identity { min-width: 0; }
      .ticker {
        font: 800 clamp(22px, 2.2vw, 27px)/1 var(--app-font-numeric);
        overflow-wrap: anywhere;
      }
      .name {
        color: var(--muted);
        font-size: 14px;
        margin-top: 4px;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }
      .pill.buy { color: white; background: var(--buy); border-color: var(--buy); }
      .pill.watch { color: white; background: var(--watch); border-color: var(--watch); }
      .pill.skip { color: white; background: var(--skip); border-color: var(--skip); }
      .price-row, .levels {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px;
      }
      .metric, .levels div, .detail, .warnings {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 9px 10px;
        background: var(--panel-glass-soft);
        min-width: 0;
      }
      .metric span, .levels span, .detail span, .warnings span {
        display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px;
      }
      .metric strong, .levels strong, .detail strong {
        font-family: var(--app-font-numeric);
        display: block;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .summary {
        margin: 0 0 10px;
        color: var(--ink);
        line-height: 1.45;
        font-size: 15px;
        overflow-wrap: anywhere;
      }
      .section-title {
        margin: 10px 0 6px;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: .14em;
        font: 800 12px/1 var(--app-font);
      }
      .detail-stack {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .fundamentals {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .fundamentals div, .earning-row {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 9px 10px;
        background: var(--panel-glass-soft);
        min-width: 0;
      }
      .fundamentals span, .earning-row span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: .08em;
        margin-bottom: 4px;
      }
      .fundamentals strong, .earning-row strong {
        font-family: var(--app-font-numeric);
        display: block;
        overflow-wrap: anywhere;
        line-height: 1.35;
      }
      .earnings {
        display: grid;
        gap: 8px;
        margin-bottom: 10px;
      }
      .earning-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .warnings {
        background: rgba(159,45,45,.06);
        border-color: rgba(159,45,45,.18);
      }
      .warnings ul {
        margin: 6px 0 0 18px;
        color: var(--muted);
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .actions { margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; }
      .actions a, .actions button {
        color: white; background: var(--accent); text-decoration: none; padding: 11px 16px; border-radius: 999px;
        font-family: var(--app-font); display: inline-block;
        border: 0; cursor: pointer; font-size: 14px;
      }
      @media (min-width: 1100px) {
        .detail-stack {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .wrap { padding: 12px 10px 24px; }
        h1 { font-size: clamp(28px, 8vw, 42px); }
        .sub { font-size: 16px; }
        .grid { grid-template-columns: 1fr; }
        .price-row, .levels, .fundamentals, .earning-row { grid-template-columns: 1fr; }
        .topline { flex-direction: column; align-items: flex-start; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <div class="eyebrow">US Watchlist Analysis</div>
        <h1>Watchlisted Stocks Dashboard</h1>
        <p class="sub">${escapeHtml(summaryText)}</p>
        <div class="meta">
          <div class="meta-chip">Updated: ${escapeHtml(payload?.updatedAt || 'n/a')}</div>
          <div class="meta-chip">Regime: ${escapeHtml(payload?.marketRegime || 'n/a')}</div>
          <div class="meta-chip">Session: ${escapeHtml(marketSession)}</div>
          <div class="meta-chip">API Calls: ${escapeHtml(liveDataEnabled ? 'active' : 'paused')}</div>
          <div class="meta-chip">Stocks: ${escapeHtml(String(rows.length))}</div>
        </div>
        <div class="detail"><span>Status</span><strong>${escapeHtml(statusLabel)}</strong></div>
      </section>
      <section class="grid">
        ${cards || '<article class="card"><p class="summary">No watchlist analysis is available right now.</p></article>'}
      </section>
      <div class="actions">
        <button id="copyWatchlistDataBtn" type="button">Copy Page</button>
        <button id="copyAllWatchlistDataBtn" type="button">Copy All</button>
        <a href="/api/watchlist-stocks?format=json">Raw JSON</a>
      </div>
      <script id="watchlistPageData" type="application/json">${pagePayloadForClient}</script>
      <script id="watchlistFullData" type="application/json">${fullPayloadForClient}</script>
    </div>
    <script>
      (function () {
        const LIVE_DATA_ENABLED = ${liveDataEnabled ? 'true' : 'false'};
        const REFRESH_MS = 60000;
        let timer = null;
        function readJsonScript(id) {
          const element = document.getElementById(id);
          if (!element) return null;
          try {
            return JSON.parse(element.textContent || 'null');
          } catch (error) {
            console.error('Watchlist JSON parse failed:', error);
            return null;
          }
        }
        async function copyPayload(button, payload) {
          const originalText = button.textContent;
          const text = JSON.stringify(payload, null, 2);
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(text);
            } else {
              const textarea = document.createElement('textarea');
              textarea.value = text;
              textarea.setAttribute('readonly', '');
              textarea.style.position = 'fixed';
              textarea.style.opacity = '0';
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              textarea.remove();
            }
            button.textContent = 'Copied';
          } catch (error) {
            console.error('Watchlist copy failed:', error);
            button.textContent = 'Copy Failed';
          }
          window.setTimeout(() => {
            button.textContent = originalText;
          }, 1400);
        }
        async function copyCurrentData(button) {
          await copyPayload(button, readJsonScript('watchlistPageData'));
        }
        async function copyAllWatchlistData(button) {
          await copyPayload(button, readJsonScript('watchlistFullData'));
        }
        async function refreshPageData() {
          if (!LIVE_DATA_ENABLED) return;
          if (document.hidden) return;
          try {
            const response = await fetch(window.location.pathname + '?format=html&_ts=' + Date.now(), {
              headers: { Accept: 'text/html' },
              cache: 'no-store'
            });
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const nextWrap = doc.querySelector('.wrap');
            const currentWrap = document.querySelector('.wrap');
            if (nextWrap && currentWrap) {
              currentWrap.replaceWith(nextWrap);
            }
            const nextTitle = doc.querySelector('title');
            if (nextTitle) {
              document.title = nextTitle.textContent;
            }
          } catch (error) {
            console.error('Watchlist auto-refresh failed:', error);
          }
        }
        function schedule() {
          if (timer) window.clearInterval(timer);
          if (!LIVE_DATA_ENABLED) return;
          timer = window.setInterval(refreshPageData, REFRESH_MS);
        }
        document.addEventListener('click', (event) => {
          const currentDataButton = event.target.closest('#copyWatchlistDataBtn');
          if (currentDataButton) {
            copyCurrentData(currentDataButton);
            return;
          }
          const allDataButton = event.target.closest('#copyAllWatchlistDataBtn');
          if (allDataButton) {
            copyAllWatchlistData(allDataButton);
          }
        });
        document.addEventListener('visibilitychange', schedule);
        schedule();
      })();
    </script>
  </body>
</html>`;
}

function renderStableIndMoneyPage(options = {}) {
  const connected = options.connected ? '<span class="pill ok">Connected</span>' : '<span class="pill">Disconnected</span>';
  const connectionAction = renderIndMoneyConnectionAction(Boolean(options.connected), '/indmoney');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>INDmoney Portfolio Dashboard</title>
  ${renderAppShellHead('/indmoney', { actionSelectors: ['.indmoney-toolbar'] })}
  <link rel="stylesheet" href="/indmoney-dashboard.css" />
</head>
<body>
  <main class="shell indmoney-dashboard">
    <header class="indmoney-header">
      <div class="indmoney-heading">
        <p class="eyebrow">INDmoney Portfolio Analyzer</p>
        <h1>Current holdings repriced to June 5, 2026</h1>
        <p class="subtle">A stable dashboard for your US stocks portfolio, based on live INDMoney holdings and a fixed June 5 baseline.</p>
      </div>
      <nav class="indmoney-toolbar" aria-label="Dashboard actions">
        <button class="icon-btn" id="refreshBtn" type="button" aria-label="Refresh dashboard" title="Refresh dashboard">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.7 5.7"/><path d="M4 12a8 8 0 0 1 13.7-5.7"/><path d="M18 2v5h-5"/><path d="M6 22v-5h5"/></svg>
        </button>
        ${connectionAction}
      </nav>
    </header>

    <section class="status-row">
      <div id="status" class="status-pill"><span class="dot"></span><span>Loading dashboard…</span></div>
      ${connected}
    </section>

    <section class="panel account-split-panel" id="accountSplitPanel" hidden>
      <div class="panel-head">
        <div>
          <h3>Account split</h3>
          <p class="subtle">Combined total as the sum of the underlying portfolio accounts.</p>
        </div>
      </div>
      <div class="account-split-grid" id="accountSplitGrid"></div>
    </section>

    <section class="panel auth-panel" id="authPanel" ${options.connected ? 'hidden' : ''}>
      <div class="panel-head">
        <div>
          <h3>INDmoney Login</h3>
          <p class="subtle">This tracker uses the same INDmoney MCP login flow as the existing <code>/indmoney</code> page.</p>
        </div>
      </div>
      <p class="subtle" id="authMessage">${options.connected ? 'Reconnect if your session expired.' : 'Login is required before holdings can load.'}</p>
      <div class="auth-actions">
        <a class="cta-btn auth-link" href="/api/indmoney/auth/start?returnTo=%2Findmoney">Connect INDmoney</a>
        <a class="ghost-btn auth-link" href="/indmoney">Reload /indmoney</a>
      </div>
    </section>

    <section class="hero-grid">
      <article class="hero-card primary">
        <p class="label">Current Value</p>
        <h2 id="currentValueUsd">$-</h2>
        <p class="subtle" id="currentValueMeta">Waiting for current holdings</p>
      </article>
      <article class="hero-card">
        <p class="label">June 5 Baseline</p>
        <h2 id="baselineValueUsd">$-</h2>
        <p class="subtle" id="baselineMeta">Current holdings repriced at the June 5, 2026 close</p>
      </article>
      <article class="hero-card">
        <p class="label">Change Vs Baseline</p>
        <h2 id="changeUsd">$-</h2>
        <p class="subtle" id="changePct">-</p>
      </article>
      <article class="hero-card">
        <p class="label">Holdings</p>
        <h2 id="holdingsCount">0</h2>
        <p class="subtle" id="freshnessCopy">Waiting for data</p>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>Portfolio Value</h3>
          <p class="subtle" id="chartCopy">Current holdings repriced through time.</p>
        </div>
        <div class="range-switch" id="rangeSwitch" aria-label="Portfolio timeframe">
          <button type="button" data-range="1d">1D</button>
          <button type="button" data-range="1w">1W</button>
          <button type="button" data-range="1m" class="active">1M</button>
        </div>
      </div>
      <div id="chartSurface" class="chart-surface" role="img" aria-label="Portfolio value chart"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>Holdings</h3>
          <p class="subtle">Current INDMoney quantities with June 5 baseline pricing.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Ticker</th>
              <th class="num">Quantity</th>
              <th class="num">Baseline Price</th>
              <th class="num">Baseline Value</th>
              <th class="num">Latest Price</th>
              <th class="num">Latest Value</th>
              <th class="num">Change</th>
            </tr>
          </thead>
          <tbody id="holdingsBody">
            <tr><td colspan="8" class="empty-row">Loading holdings…</td></tr>
          </tbody>
        </table>
      </div>
    </section>

  </main>
  <script>
    window.__INDMONEY_DASHBOARD__ = {
      connected: ${JSON.stringify(Boolean(options.connected))}
    };
  </script>
  <script defer src="/indmoney-dashboard.js"></script>
</body>
</html>`;
}

function renderPortfolioTrackerPage(options = {}) {
  const pagePath = options.pagePath || '/portfolios/deep';
  const portfolioKey = String(options.portfolioKey || 'deep');
  const portfolioLabel = options.label || portfolioLabelFromKey(portfolioKey);
  const readOnly = Boolean(options.readOnly);
  const connected = options.connected ? '<span class="pill ok">Connected</span>' : '<span class="pill">Disconnected</span>';
  const connectionAction = renderIndMoneyConnectionAction(Boolean(options.connected), pagePath, portfolioKey);
  const headingTitle = options.headingTitle || `${portfolioLabel} portfolio`;
  const headingCopy = options.headingCopy || 'Current holdings repriced from June 5, 2026 in USD only';
  const introCopy = options.introCopy || 'Live portfolio value, 1D PNL, and actual PNL based on your current US holdings and a manual INR-to-USD normalization layer.';
  const authCopy = options.authCopy || `This tracker signs into the ${escapeHtml(portfolioLabel)} INDmoney MCP account directly and returns to <code>${escapeHtml(pagePath)}</code>.`;
  const authReloadLabel = options.authReloadLabel || `Reload ${pagePath}`;
  const fxPanelBody = readOnly
    ? `<div id="fxPanelBody" class="fx-body" hidden>
        <div class="fx-grid">
          <div class="fx-stat"><span>Effective USD/INR Rate</span><strong id="effectiveFxRate">-</strong></div>
          <div class="fx-stat"><span>MCP Total Invested INR</span><strong id="totalInvestedInrFromMcp">-</strong></div>
          <div class="fx-stat"><span>Manual Actual Invested USD</span><strong id="manualActualInvestedUsdValue">-</strong></div>
        </div>
        <p class="subtle" id="fxUpdatedAt">Waiting for config.</p>
      </div>`
    : `<div id="fxPanelBody" class="fx-body" hidden>
        <div class="fx-grid">
          <div class="fx-stat"><span>Effective USD/INR Rate</span><strong id="effectiveFxRate">-</strong></div>
          <div class="fx-stat"><span>MCP Total Invested INR</span><strong id="totalInvestedInrFromMcp">-</strong></div>
          <div class="fx-stat"><span>Manual Actual Invested USD</span><strong id="manualActualInvestedUsdValue">-</strong></div>
        </div>
        <form id="fxForm" class="fx-form">
          <label>
            <span>Manual actual invested USD</span>
            <input id="manualActualInvestedUsdInput" name="manualActualInvestedUsd" type="number" min="0" step="0.01" inputmode="decimal" />
          </label>
          <button id="saveFxBtn" type="submit" class="cta-btn">Save</button>
        </form>
        <p class="subtle" id="fxUpdatedAt">Waiting for config.</p>
      </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.pageTitle || `${portfolioLabel} Portfolio Tracker`)}</title>
  ${renderAppShellHead(pagePath, { actionSelectors: ['.indmoney2-toolbar'] })}
  <link rel="stylesheet" href="/indmoney2-dashboard.css" />
</head>
<body>
  <main class="shell indmoney2-dashboard">
    <header class="indmoney-header">
      <div class="indmoney-heading">
        <p class="eyebrow">${escapeHtml(headingTitle)}</p>
        <h1>${escapeHtml(headingCopy)}</h1>
        <p class="subtle">${escapeHtml(introCopy)}</p>
      </div>
      <nav class="indmoney-toolbar indmoney2-toolbar" aria-label="Dashboard actions">
        <button class="icon-btn" id="refreshBtn" type="button" aria-label="Refresh dashboard" title="Refresh dashboard">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.7 5.7"/><path d="M4 12a8 8 0 0 1 13.7-5.7"/><path d="M18 2v5h-5"/><path d="M6 22v-5h5"/></svg>
        </button>
        ${connectionAction}
      </nav>
    </header>

    <section class="status-row">
      <div id="status" class="status-pill"><span class="dot"></span><span>Loading dashboard…</span></div>
      ${connected}
    </section>

    <section class="panel auth-panel" id="authPanel" ${options.connected ? 'hidden' : ''}>
      <div class="panel-head">
        <div>
          <h3>${escapeHtml(portfolioLabel)} Account Login</h3>
          <p class="subtle">${authCopy}</p>
        </div>
      </div>
      <p class="subtle" id="authMessage">${options.connected ? 'Reconnect if your session expired.' : 'Login is required before holdings can load.'}</p>
      <div class="auth-actions">
        <a class="cta-btn auth-link" href="/api/indmoney/auth/start?portfolio=${encodeURIComponent(portfolioKey)}&returnTo=${encodeURIComponent(pagePath)}">Connect INDmoney</a>
        <a class="ghost-btn auth-link" href="${pagePath}">${escapeHtml(authReloadLabel)}</a>
      </div>
    </section>

    <section class="panel fx-panel">
      <div class="panel-head">
        <div>
          <h3>${readOnly ? 'FX Summary' : 'FX Config'}</h3>
          <p class="subtle">${readOnly ? 'Combined view is read-only. Edit FX on the underlying Deep or Mom portfolios.' : 'Manual USD invested amount normalizes MCP INR invested values into USD.'}</p>
        </div>
        <button id="fxToggleBtn" class="ghost-btn" type="button" aria-expanded="false" aria-controls="fxPanelBody">Show</button>
      </div>
      ${fxPanelBody}
    </section>

    <section class="panel chart-panel">
      <div class="chart-quote-shell">
        <div class="chart-quote-copy">
          <p class="chart-kicker">Portfolio</p>
          <h2 class="chart-quote-title">Market value</h2>
          <div id="currentPortfolioValueUsd" class="chart-quote-value">$-</div>
          <div class="chart-quote-change">
            <span id="chartPrimaryChangeUsd">$-</span>
            <span id="chartPrimaryChangePct">-</span>
            <span id="chartPrimaryChangeLabel">Today</span>
          </div>
          <p class="subtle chart-quote-meta" id="currentPortfolioMeta">Waiting for live prices</p>
        </div>
      </div>

      <div class="chart-metric-strip" aria-label="Portfolio metrics">
        <article class="chart-metric-card">
          <span>Day change</span>
          <strong id="oneDayPnlUsd">$-</strong>
          <small id="oneDayPnlPct">-</small>
          <small id="oneDayPnlSplit" class="metric-split" hidden>-</small>
        </article>
        <article class="chart-metric-card">
          <span>Total return</span>
          <strong id="actualPnlUsd">$-</strong>
          <small id="actualPnlPct">-</small>
          <small id="actualPnlSplit" class="metric-split" hidden>-</small>
        </article>
      </div>

      <div class="chart-toolbar-shell">
        <div class="chart-toolbar-group" id="chartToolbarGroup" aria-label="Chart tools">
          <button type="button" class="chart-tool-btn active" id="chartStyleBtn" data-chart-menu="style">Area</button>
          <button type="button" class="chart-tool-btn" id="chartCompareBtn" data-chart-menu="compare">Compare</button>
          <button type="button" class="chart-tool-btn" id="chartIndicatorsBtn" data-chart-menu="indicators">Indicators</button>
          <button type="button" class="chart-tool-btn" id="chartResetViewBtn">Reset view</button>
        </div>
        <div class="chart-range-note subtle" id="chartRangeNote">${escapeHtml(options.chartRangeNote || 'Full history from Jun 5 on load. Zoom for intraday detail.')}</div>
      </div>

      <div class="chart-toolbar-popovers" id="chartToolbarPopovers">
        <div class="chart-menu" id="chartStyleMenu" hidden>
          <button type="button" class="chart-menu-option active" data-chart-style="area">Area</button>
          <button type="button" class="chart-menu-option" data-chart-style="line">Line</button>
        </div>
        <div class="chart-menu" id="chartCompareMenu" hidden>
          <button type="button" class="chart-menu-option" data-compare-mode="off">None</button>
          <button type="button" class="chart-menu-option" data-compare-mode="invested">Invested capital</button>
        </div>
        <div class="chart-menu" id="chartIndicatorsMenu" hidden>
          <button type="button" class="chart-menu-option" data-indicator="ma20" aria-pressed="false">MA 20</button>
          <button type="button" class="chart-menu-option" data-indicator="ma50" aria-pressed="false">MA 50</button>
        </div>
      </div>

      <div id="chartSurface" class="chart-surface" role="img" aria-label="Portfolio value chart"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>Holdings</h3>
          <p class="subtle">One canonical USD row per ticker. No INR appears in the main table.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th aria-sort="ascending"><button type="button" class="sort-btn active" data-sort-key="ticker">Ticker <span class="sort-indicator" aria-hidden="true">↑</span></button></th>
              <th aria-sort="none"><button type="button" class="sort-btn" data-sort-key="name">Name <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="quantity">Qty <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="investedUsd">Invested USD <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="avgPriceUsd">Avg Price USD <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="currentPriceUsd">Current Price USD <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="currentHoldingValueUsd">Current Value USD <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="oneDayPnlUsd">1D PNL USD <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="oneDayPnlPct">1D % <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="actualPnlUsd">Actual PNL USD <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th class="num" aria-sort="none"><button type="button" class="sort-btn" data-sort-key="actualPnlPct">Actual % <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th aria-sort="none"><button type="button" class="sort-btn" data-sort-key="priceSession">Session <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th aria-sort="none"><button type="button" class="sort-btn" data-sort-key="updatedAt">Updated At <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
              <th aria-sort="none"><button type="button" class="sort-btn" data-sort-key="priceSource">Price Source <span class="sort-indicator" aria-hidden="true">↕</span></button></th>
            </tr>
          </thead>
          <tbody id="holdingsBody">
            <tr><td colspan="14" class="empty-row">Loading holdings…</td></tr>
          </tbody>
        </table>
      </div>
    </section>

  </main>
  <script>
    window.__INDMONEY2_DASHBOARD__ = {
      connected: ${JSON.stringify(Boolean(options.connected))},
      portfolioKey: ${JSON.stringify(portfolioKey)},
      apiBasePath: ${JSON.stringify(options.apiBasePath || '/api/indmoney2')},
      authStartPath: ${JSON.stringify(`/api/indmoney/auth/start?portfolio=${encodeURIComponent(portfolioKey)}&returnTo=${encodeURIComponent(pagePath)}`)},
      readOnly: ${JSON.stringify(readOnly)},
      pagePath: ${JSON.stringify(pagePath)}
    };
  </script>
  <script type="module" src="/indmoney2-dashboard.js"></script>
</body>
</html>`;
}

async function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const isHead = req.method === 'HEAD';
  const market = normalizeMarket(url.searchParams.get('market'));
  const acceptHeader = String(req.headers.accept || '');
  const wantsHtml =
    url.searchParams.get('format') === 'html' ||
    (!url.searchParams.get('format') && acceptHeader.includes('text/html'));

  if ((req.method === 'GET' || isHead) && url.pathname === '/app-shell.css') {
    const css = await fsp.readFile(path.join(__dirname, 'public', 'app-shell.css'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, css, 'text/css; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/app-shell.js') {
    const js = await fsp.readFile(path.join(__dirname, 'public', 'app-shell.js'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, js, 'application/javascript; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney-dashboard.css') {
    const css = await fsp.readFile(path.join(__dirname, 'public', 'indmoney-dashboard.css'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, css, 'text/css; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney-dashboard.js') {
    const js = await fsp.readFile(path.join(__dirname, 'public', 'indmoney-dashboard.js'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, js, 'application/javascript; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney2-dashboard.css') {
    const css = await fsp.readFile(path.join(__dirname, 'public', 'indmoney2-dashboard.css'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, css, 'text/css; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney2-dashboard.js') {
    const js = await fsp.readFile(path.join(__dirname, 'public', 'indmoney2-dashboard.js'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, js, 'application/javascript; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney2-chart-helpers.js') {
    const js = await fsp.readFile(path.join(__dirname, 'public', 'indmoney2-chart-helpers.js'), 'utf8');
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return textResponse(res, 200, js, 'application/javascript; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) {
    const page = normalizeReturnTo(url.searchParams.get('page') || '/');
    const svg = renderPageFavicon(page);
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return textResponse(res, 200, svg, 'image/svg+xml; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/health') {
    const snapshots = await readSnapshots();
    const filtered = filterSnapshotsByMarket(snapshots, market);
    const payload = {
      ok: true,
      service: 'market-dashboard',
      market: market || 'ALL',
      lastSnapshotAt: filtered.length ? filtered[filtered.length - 1].timestamp : null,
      snapshotCount: filtered.length,
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/market-data') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const snapshots = await readAllSnapshots();
    const filtered = filterSnapshotsByMarket(snapshots, market);
    const payload = {
      ok: true,
      market: market || 'ALL',
      count: filtered.length,
      snapshots: filtered,
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/login') {
    const returnTo = normalizeReturnTo(url.searchParams.get('returnTo') || '/');
    if (isIndMoneyDashboardAuthenticated(req)) {
      return redirectResponse(res, returnTo);
    }
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return textResponse(res, 200, renderIndMoneyLoginPage({ returnTo }), 'text/html; charset=utf-8');
  }

  if (req.method === 'POST' && (url.pathname === '/login' || url.pathname === '/indmoney/login')) {
    const form = await readFormBody(req);
    const returnTo = normalizeReturnTo(form.get('returnTo') || url.searchParams.get('returnTo') || '/');
    const passcode = form.get('passcode') || '';
    if (!verifyIndMoneyDashboardPasscode(passcode)) {
      return textResponse(
        res,
        401,
        renderIndMoneyLoginPage({ returnTo, error: 'Invalid dashboard passcode.' }),
        'text/html; charset=utf-8',
      );
    }
    return redirectResponse(res, returnTo, createIndMoneyDashboardSessionHeaders(req));
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney') {
    return redirectResponse(res, '/portfolios/deep');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/charts') {
    return redirectResponse(res, '/portfolios/deep');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/indmoney2') {
    return redirectResponse(res, '/portfolios/deep');
  }

  if ((req.method === 'GET' || isHead) && (url.pathname === '/portfolios' || url.pathname.startsWith('/portfolios/'))) {
    const portfolioKey = url.pathname === '/portfolios'
      ? 'combined'
      : String(url.pathname.slice('/portfolios/'.length) || '').trim().toLowerCase();
    const connected = portfolioKey === 'combined'
      ? getPortfolioDefinitions().some((portfolio) => isIndMoneyMcpConnected(portfolio.key))
      : isIndMoneyMcpConnected(portfolioKey);
    if (!isIndMoneyDashboardAuthenticated(req)) {
      return redirectToLogin(req, res, url.pathname);
    }
    if (portfolioKey !== 'combined' && !isSupportedPortfolioKey(portfolioKey)) {
      return textResponse(res, 404, '<!doctype html><meta charset="utf-8"><title>Portfolio Not Found</title><p>Unknown portfolio.</p>', 'text/html; charset=utf-8');
    }
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    if (portfolioKey === 'combined') {
      return textResponse(
        res,
        200,
        renderPortfolioTrackerPage({
          connected,
          portfolioKey: 'combined',
          label: 'Combined',
          pagePath: '/portfolios',
          apiBasePath: '/api/portfolios',
          readOnly: true,
          pageTitle: 'Combined Portfolio Tracker',
          headingTitle: 'Combined USD Portfolio Tracker',
          headingCopy: 'Deep and Mom combined into one USD portfolio view',
          introCopy: 'Aggregated holdings, merged overlapping tickers, and summed portfolio history across both portfolio books.',
          authReloadLabel: 'Reload /portfolios',
          defaultChartCopy: 'Combined portfolio history across all connected accounts.',
          chartRangeNote: 'Combined portfolio view. Connect underlying accounts separately as needed.',
        }),
        'text/html; charset=utf-8',
      );
    }
    const definition = getPortfolioDefinition(portfolioKey);
    return textResponse(
      res,
      200,
      renderPortfolioTrackerPage({
        connected,
        portfolioKey,
        label: definition.label,
        pagePath: definition.routePath,
        apiBasePath: definition.apiBasePath,
        pageTitle: `${definition.label} Portfolio Tracker`,
        headingTitle: `${definition.label} USD Portfolio Tracker`,
        headingCopy: definition.historyMode === 'current_only'
          ? 'Current holdings in USD with no historical repricing'
          : 'Current holdings repriced from June 5, 2026 in USD only',
        introCopy: definition.historyMode === 'current_only'
          ? 'Live portfolio value and P/L for this account from its own starting point. Historical repricing is disabled.'
          : 'Live portfolio value, 1D PNL, and actual PNL based on your current US holdings and a manual INR-to-USD normalization layer.',
        authReloadLabel: `Reload ${definition.routePath}`,
        defaultChartCopy: definition.historyMode === 'current_only'
          ? 'Current account history only. No historical repricing.'
          : 'Current holdings repriced through time.',
        chartRangeNote: definition.historyMode === 'current_only'
          ? 'This portfolio starts from its own inception. Historical repricing is disabled.'
          : 'Full history from Jun 5 on load. Zoom for intraday detail.',
      }),
      'text/html; charset=utf-8',
    );
  }

  if (req.method === 'POST' && url.pathname === '/indmoney/logout') {
    const token = parseCookies(req)[CONFIG.indMoneyDashboardCookieName];
    if (token) {
      indMoneyDashboardSessions.delete(token);
    }
    return redirectResponse(res, '/portfolios/deep', {
      'Set-Cookie': indMoneyDashboardCookie('', { clear: true, secure: isSecureRequest(req) }),
    });
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/auth/start') {
    try {
      const portfolioKey = String(url.searchParams.get('portfolio') || inferPortfolioKeyFromReturnTo(url.searchParams.get('returnTo') || '/portfolios/deep')).trim().toLowerCase();
      const authorizeUrl = await buildIndMoneyAuthorizeUrl(req, {
        portfolioKey,
        returnTo: url.searchParams.get('returnTo') || '/portfolios/deep',
      });
      res.writeHead(302, {
        Location: authorizeUrl,
        'Cache-Control': 'no-store',
      });
      return res.end();
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/auth/callback') {
    try {
      const result = await completeIndMoneyOAuth(url);
      const nextReturnTo = normalizeReturnTo(result?.returnTo || '/portfolios/deep');
      return redirectResponse(res, nextReturnTo);
    } catch (error) {
      return textResponse(
        res,
        400,
        `<!doctype html><meta charset="utf-8"><title>INDmoney Auth Failed</title><p>INDmoney MCP authorization failed: ${escapeHtml(error.message)}</p><p><a href="/portfolios/deep">Try again</a></p>`,
        'text/html; charset=utf-8',
      );
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/indmoney/auth/disconnect') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const portfolioKey = String(url.searchParams.get('portfolio') || 'deep').trim().toLowerCase();
      const definition = getPortfolioDefinition(portfolioKey);
      const authPath = definition?.authPath || CONFIG.indMoneyMcpAuthPath;
      await fsp.rm(authPath, { force: true });
      await fsp.rm(`${authPath}.bak`, { force: true });
      resetDefaultIndMoneyMcpClient();
      indMoneyMcpResponseCache = {
        payloads: new Map(),
      };
      invalidateIndMoneyDashboardBaseCache();
      return redirectResponse(res, definition?.routePath || '/portfolios/deep');
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if (url.pathname.startsWith('/api/indmoney/')) {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
  }

  if (url.pathname.startsWith('/api/portfolios')) {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
  }

  if (url.pathname.startsWith('/api/indmoney2/')) {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/portfolios/dashboard') {
    try {
      const payload = await buildCombinedPortfolioDashboard();
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  const portfolioApiMatch = url.pathname.match(/^\/api\/portfolios\/([^/]+)\/(fx-config|dashboard|portfolio-series|holdings|live-prices|stream)$/);
  if (portfolioApiMatch) {
    const portfolioKey = String(portfolioApiMatch[1] || '').trim().toLowerCase();
    const action = portfolioApiMatch[2];
    const definition = getPortfolioDefinition(portfolioKey);
    if (!definition) {
      return jsonResponse(res, 400, { ok: false, error: `Unknown portfolio "${portfolioKey}"` });
    }
    try {
      if (action === 'fx-config') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req).catch(() => ({}));
          const manualActualInvestedUsd = toNumber(body?.manualActualInvestedUsd);
          if (manualActualInvestedUsd === null || manualActualInvestedUsd <= 0) {
            return jsonResponse(res, 400, { ok: false, error: 'manualActualInvestedUsd must be a positive number' });
          }
          const payload = await saveIndMoney2FxConfig({
            fxConfigPath: definition.fxConfigPath,
            holdingsCachePath: definition.holdingsCachePath,
            budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
            manualActualInvestedUsd,
            manualHoldingInvestedUsd: body?.manualHoldingInvestedUsd,
          });
          return jsonResponse(res, 200, payload);
        }
        if (req.method === 'GET' || isHead) {
          const payload = await getIndMoney2FxConfigPayload({
            fxConfigPath: definition.fxConfigPath,
            holdingsCachePath: definition.holdingsCachePath,
            budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
          });
          if (isHead) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end();
          }
          return jsonResponse(res, 200, payload);
        }
      }

      if ((req.method === 'GET' || isHead) && action === 'dashboard') {
        const payload = await buildPortfolioDashboard(portfolioKey);
        if (isHead) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return jsonResponse(res, 200, payload);
      }

      if ((req.method === 'GET' || isHead) && action === 'portfolio-series') {
        const range = String(url.searchParams.get('range') || '1m').trim().toLowerCase();
        const payload = await getIndMoney2SeriesRange({
          fxConfigPath: definition.fxConfigPath,
          holdingsCachePath: definition.holdingsCachePath,
          budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
          portfolioSeriesPath: definition.portfolioSeriesPath,
          range,
        });
        if (isHead) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return jsonResponse(res, 200, payload || { ok: false, error: 'Range unavailable' });
      }

      if ((req.method === 'GET' || isHead) && action === 'holdings') {
        const payload = await getIndMoney2Holdings({
          fxConfigPath: definition.fxConfigPath,
          holdingsCachePath: definition.holdingsCachePath,
          budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
          portfolioSeriesPath: definition.portfolioSeriesPath,
        });
        if (isHead) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return jsonResponse(res, 200, payload);
      }

      if ((req.method === 'GET' || isHead) && action === 'live-prices') {
        const payload = await getIndMoney2LivePrices({
          fxConfigPath: definition.fxConfigPath,
          holdingsCachePath: definition.holdingsCachePath,
          budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
          portfolioSeriesPath: definition.portfolioSeriesPath,
        });
        if (isHead) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return jsonResponse(res, 200, payload);
      }

      if ((req.method === 'GET' || isHead) && action === 'stream') {
        if (isHead) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        const sendSnapshot = async () => {
          try {
            const dashboard = await buildPortfolioDashboard(portfolioKey);
            res.write(`event: dashboard\n`);
            res.write(`data: ${JSON.stringify({
              updatedAt: dashboard.updatedAt,
              summary: dashboard.summary,
              holdings: dashboard.holdings,
              series: dashboard.series,
              warnings: dashboard.warnings,
            })}\n\n`);
          } catch (error) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message || 'Unknown error' })}\n\n`);
          }
        };
        const timer = setInterval(sendSnapshot, 10000);
        req.on('close', () => {
          clearInterval(timer);
        });
        await sendSnapshot();
        return;
      }

      return jsonResponse(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney2/fx-config') {
    try {
      const definition = getPortfolioDefinition('deep');
      const payload = await getIndMoney2FxConfigPayload({
        fxConfigPath: definition.fxConfigPath,
        holdingsCachePath: definition.holdingsCachePath,
        budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
      });
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/indmoney2/fx-config') {
    try {
      const definition = getPortfolioDefinition('deep');
      const body = await readJsonBody(req).catch(() => ({}));
      const manualActualInvestedUsd = toNumber(body?.manualActualInvestedUsd);
      if (manualActualInvestedUsd === null || manualActualInvestedUsd <= 0) {
        return jsonResponse(res, 400, { ok: false, error: 'manualActualInvestedUsd must be a positive number' });
      }
      const payload = await saveIndMoney2FxConfig({
        fxConfigPath: definition.fxConfigPath,
        holdingsCachePath: definition.holdingsCachePath,
        budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
        manualActualInvestedUsd,
        manualHoldingInvestedUsd: body?.manualHoldingInvestedUsd,
      });
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney2/dashboard') {
    try {
      const payload = await buildPortfolioDashboard('deep');
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney2/portfolio-series') {
    try {
      const definition = getPortfolioDefinition('deep');
      const range = String(url.searchParams.get('range') || '1m').trim().toLowerCase();
      const payload = await getIndMoney2SeriesRange({
        fxConfigPath: definition.fxConfigPath,
        holdingsCachePath: definition.holdingsCachePath,
        budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
        portfolioSeriesPath: definition.portfolioSeriesPath,
        range,
      });
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload || { ok: false, error: 'Range unavailable' });
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney2/holdings') {
    try {
      const definition = getPortfolioDefinition('deep');
      const payload = await getIndMoney2Holdings({
        fxConfigPath: definition.fxConfigPath,
        holdingsCachePath: definition.holdingsCachePath,
        budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
        portfolioSeriesPath: definition.portfolioSeriesPath,
      });
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney2/live-prices') {
    try {
      const definition = getPortfolioDefinition('deep');
      const payload = await getIndMoney2LivePrices({
        fxConfigPath: definition.fxConfigPath,
        holdingsCachePath: definition.holdingsCachePath,
        budgetStatePath: CONFIG.indMoneyMcpBudgetFile,
        portfolioSeriesPath: definition.portfolioSeriesPath,
      });
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney2/stream') {
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const sendSnapshot = async () => {
      try {
        const dashboard = await buildPortfolioDashboard('deep');
        res.write(`event: dashboard\n`);
        res.write(`data: ${JSON.stringify({
          updatedAt: dashboard.updatedAt,
          summary: dashboard.summary,
          holdings: dashboard.holdings,
          series: dashboard.series,
          warnings: dashboard.warnings,
        })}\n\n`);
      } catch (error) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: error.message || 'Unknown error' })}\n\n`);
      }
    };
    const timer = setInterval(sendSnapshot, 10000);
    req.on('close', () => {
      clearInterval(timer);
    });
    await sendSnapshot();
    return;
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/dashboard') {
    try {
      const forceBase = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refreshBase') || '').toLowerCase());
      const payload = await buildIndMoneyDashboardPayload({ forceBase });
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/indmoney/snapshot') {
    return jsonResponse(res, 410, {
      ok: false,
      error: 'Snapshot persistence was removed in MCP-only mode.',
      source: 'INDmoney MCP',
    });
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/networth') {
    try {
      const payload = await withIndMoneyMcpCache('networth', async (provider) => ({
        ok: true,
        data: adjustIndMoneySnapshotForStaleIndianData(normalizeMcpNetworthSnapshot(await provider.networthSnapshot())),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname.startsWith('/api/indmoney/holdings/')) {
    const assetType = validateIndMoneyAssetType(decodeURIComponent(url.pathname.split('/').pop() || ''));
    if (!assetType) {
      return jsonResponse(res, 400, { ok: false, error: 'Invalid asset type' });
    }
    if (assetType !== 'US_STOCK') {
      return jsonResponse(res, 400, { ok: false, error: 'Only US_STOCK is supported by this dashboard' });
    }
    try {
      const payload = await withIndMoneyMcpCache(`holdings:${assetType}`, async (provider) => ({
        ok: true,
        assetType,
        data: await provider.networthHoldings(assetType),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname.startsWith('/api/indmoney/allocation/')) {
    const [, , , , rawAssetType, rawBreakdownBy] = url.pathname.split('/');
    const assetType = validateIndMoneyAssetType(decodeURIComponent(rawAssetType || ''));
    const breakdownBy = validateIndMoneyBreakdownType(decodeURIComponent(rawBreakdownBy || ''));
    if (!assetType || !breakdownBy) {
      return jsonResponse(res, 400, { ok: false, error: 'Invalid asset type or breakdown type' });
    }
    if (assetType !== 'US_STOCK') {
      return jsonResponse(res, 400, { ok: false, error: 'Only US_STOCK is supported by this dashboard' });
    }
    try {
      const payload = await withIndMoneyMcpCache(`allocation:${assetType}:${breakdownBy}`, async (provider) => ({
        ok: true,
        assetType,
        breakdownBy,
        data: await provider.networthAllocationBreakdown(assetType, breakdownBy),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/watchlist') {
    const type = ['indian', 'us', 'all'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';
    try {
      const payload = await withIndMoneyMcpCache(`watchlist:${type}`, async (provider) => ({
        ok: true,
        type,
        data: normalizeMcpWatchlists(await provider.userWatchlist(type)),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/sips') {
    const payload = { ok: true, data: { sips: [] }, message: 'SIPs are not part of the US-stocks-only dashboard.' };
    if (isHead) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/us-stocks') {
    const symbols = requireQueryList(res, url, 'symbols', (item) => item.toUpperCase());
    if (!symbols) return;
    const segments = parseSegments(url.searchParams.get('segments'));
    try {
      const payload = await withIndMoneyMcpCache(`us:${symbols.join(',')}:${segments?.join(',') || ''}`, async (provider) => ({
        ok: true,
        symbols,
        segments,
        data: await provider.getUsStocksDetails(symbols, segments),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/indian/lookup') {
    const names = requireQueryList(res, url, 'names');
    if (!names) return;
    const filterType = ['IN_STOCKS', 'IN_STOCKS_FNO', 'US_STOCKS', 'MF'].includes(url.searchParams.get('filterType'))
      ? url.searchParams.get('filterType')
      : undefined;
    try {
      const payload = await withIndMoneyMcpCache(`lookup:${filterType || ''}:${names.join(',')}`, async (provider) => ({
        ok: true,
        names,
        filterType,
        data: await provider.lookupIndKeys(names, filterType),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/indian/details') {
    const keys = requireQueryList(res, url, 'keys');
    if (!keys) return;
    const segments = parseSegments(url.searchParams.get('segments'));
    try {
      const payload = await withIndMoneyMcpCache(`ind-details:${keys.join(',')}:${segments?.join(',') || ''}`, async (provider) => ({
        ok: true,
        keys,
        segments,
        data: await provider.getIndianStocksDetails(keys, segments),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/indian/ohlc') {
    const key = String(url.searchParams.get('key') || '').trim();
    const interval = url.searchParams.get('interval') || '1day';
    const lookback = url.searchParams.get('lookback') || '14d';
    if (!key || !INDMONEY_OHLC_INTERVALS.includes(interval) || !INDMONEY_OHLC_LOOKBACKS.includes(lookback)) {
      return jsonResponse(res, 400, { ok: false, error: 'Valid key, interval, and lookback are required' });
    }
    try {
      const payload = await withIndMoneyMcpCache(`ohlc:${key}:${interval}:${lookback}`, async (provider) => ({
        ok: true,
        key,
        interval,
        lookback,
        data: await provider.getIndianStocksOhlc(key, interval, lookback),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/indian/options') {
    const key = String(url.searchParams.get('key') || '').trim();
    const strikes = Math.max(1, Math.min(20, Math.round(Number(url.searchParams.get('strikes') || 5))));
    const expiryDate = url.searchParams.get('expiryDate') || null;
    if (!key) {
      return jsonResponse(res, 400, { ok: false, error: 'key query parameter is required' });
    }
    try {
      const payload = await withIndMoneyMcpCache(`options:${key}:${strikes}:${expiryDate || ''}`, async (provider) => ({
        ok: true,
        key,
        strikes,
        expiryDate,
        data: await provider.getIndianStocksOptionChain(key, {
          strikesAroundAtm: strikes,
          expiryDate,
          useExpiryDate: Boolean(expiryDate),
        }),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/indian/greeks') {
    const key = String(url.searchParams.get('key') || '').trim();
    const lookback = url.searchParams.get('lookback') || '1d';
    if (!key || !INDMONEY_GREEKS_LOOKBACKS.includes(lookback)) {
      return jsonResponse(res, 400, { ok: false, error: 'Valid key and lookback are required' });
    }
    try {
      const payload = await withIndMoneyMcpCache(`greeks:${key}:${lookback}`, async (provider) => ({
        ok: true,
        key,
        lookback,
        data: await provider.getIndianStocksGreeksHistory(key, lookback),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/mf/category') {
    const categories = parseMutualFundCategories(url.searchParams.get('categories'));
    if (!categories.length) {
      return jsonResponse(res, 400, { ok: false, error: 'At least one valid categories value is required' });
    }
    const size = Math.max(1, Math.min(50, Math.round(Number(url.searchParams.get('size') || 10))));
    const sortKey = ['category_ind_rank', 'returns_1yr', 'returns_3yr', 'returns_5yr', 'aum'].includes(url.searchParams.get('sortKey'))
      ? url.searchParams.get('sortKey')
      : undefined;
    const sortAsc = ['1', 'true', 'yes'].includes(String(url.searchParams.get('sortAsc') || '').toLowerCase());
    try {
      const payload = await withIndMoneyMcpCache(`mf-category:${categories.join(',')}:${size}:${sortKey || ''}:${sortAsc}`, async (provider) => ({
        ok: true,
        categories,
        size,
        sortKey,
        sortAsc,
        data: await provider.getMfByCategory(categories, { size, sortKey, sortAsc }),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/indmoney/mf/details') {
    const fundIds = String(url.searchParams.get('fundIds') || '').trim();
    const includes = parseCommaList(url.searchParams.get('includes'));
    if (!fundIds) {
      return jsonResponse(res, 400, { ok: false, error: 'fundIds query parameter is required' });
    }
    try {
      const payload = await withIndMoneyMcpCache(`mf-details:${fundIds}:${includes.join(',')}`, async (provider) => ({
        ok: true,
        fundIds,
        includes: includes.length ? includes : null,
        data: await provider.getMfFundsDetails(fundIds, includes.length ? includes : null),
      }));
      if (isHead) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return indMoneyErrorResponse(res, error);
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/portfolio-alerts/status') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const payload = {
      ok: true,
      runtime: null,
      workerManaged: true,
      message: 'Portfolio alerts now run in the separate market-dashboard-portfolio-alerts worker.',
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/portfolio-alerts/report') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const payload = {
      ok: true,
      updatedAt: null,
      summary: null,
      decisionReport: null,
      workerManaged: true,
      message: 'Portfolio alert report is no longer hosted by the web process.',
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/portfolio-alerts/indmoney-refresh') {
    return jsonResponse(res, 410, {
      ok: false,
      error: 'INDmoney fundamentals refresh was removed in MCP-only mode.',
      source: 'INDmoney MCP',
    });
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/portfolio-alerts/indmoney-cache') {
    return jsonResponse(res, 410, {
      ok: false,
      error: 'INDmoney fundamentals cache was removed in MCP-only mode.',
      source: 'INDmoney MCP',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/portfolio-alerts/run') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    return jsonResponse(res, 503, {
      ok: false,
      error: 'Portfolio alert runtime moved to the market-dashboard-portfolio-alerts worker.',
    });
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/truth-social-alerts/status') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const payload = {
      ok: true,
      runtime: await buildTruthSocialWorkerRuntimeSnapshot(),
      workerManaged: true,
      message: 'Truth Social alerts run in the separate market-dashboard-truth-social worker.',
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/truth-social-alerts/start') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const result = await startTruthSocialWorkerProcess();
      return jsonResponse(res, 200, {
        ok: true,
        runtime: result.runtime,
        workerManaged: true,
        started: result.started,
        message: result.started ? 'Truth Social worker started.' : 'Truth Social worker was already running.',
      });
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/truth-social-alerts/stop') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const result = await stopTruthSocialWorkerProcess();
      return jsonResponse(res, 200, {
        ok: true,
        runtime: result.runtime,
        workerManaged: true,
        stopped: result.stopped,
        message: result.stopped ? 'Truth Social worker stopped.' : 'Truth Social worker was not running.',
      });
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/truth-social-alerts/run') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    return jsonResponse(res, 503, {
      ok: false,
      error: 'Truth Social alert runtime moved to the market-dashboard-truth-social worker.',
    });
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/swing-trades/report') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const cacheOnly = ['1', 'true', 'yes'].includes(String(url.searchParams.get('cacheOnly') || '').toLowerCase());
      if (cacheOnly && (!swingTradeCache.payload || swingTradeCache.expiresAt <= Date.now())) {
        return jsonResponse(res, 202, {
          ok: false,
          pending: true,
          error: 'Swing report is not cached yet. Open the Swing page or run a fresh scan.',
        });
      }
      if (cacheOnly && swingTradeCache.payload && url.searchParams.has('freshSince')) {
        const freshSinceMs = Date.parse(url.searchParams.get('freshSince') || '');
        const generatedMs = Date.parse(swingTradeCache.payload.generatedAt || '');
        if (Number.isFinite(freshSinceMs) && (!Number.isFinite(generatedMs) || generatedMs < freshSinceMs)) {
          return jsonResponse(res, 202, {
            ok: false,
            pending: true,
            error: 'Swing report is still refreshing.',
          });
        }
      }
      const symbols = optionalQueryList(url, 'symbols', (item) => item.toUpperCase().replace(/[^A-Z0-9.-]/g, ''));
      const payload = await getCachedSwingTradeReport({
        symbols,
        limit: Number(url.searchParams.get('limit') || 30),
        includeRejected: ['1', 'true', 'yes'].includes(String(url.searchParams.get('includeRejected') || '').toLowerCase()),
        maxScanSymbols: Number(url.searchParams.get('maxScanSymbols') || process.env.SWING_TRADE_MAX_SCAN_SYMBOLS || 140),
      });
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/swing-trades/run') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const symbols = Array.isArray(body?.symbols)
        ? body.symbols.map((item) => String(item || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean)
        : optionalQueryList(url, 'symbols', (item) => item.toUpperCase().replace(/[^A-Z0-9.-]/g, ''));
      const run = startSwingTradeScan({
        symbols,
        limit: Number(body?.limit || url.searchParams.get('limit') || 30),
        includeRejected: Boolean(body?.includeRejected),
        maxScanSymbols: Number(body?.maxScanSymbols || url.searchParams.get('maxScanSymbols') || process.env.SWING_TRADE_RUN_MAX_SCAN_SYMBOLS || 24),
      });
      return jsonResponse(res, 202, {
        ok: true,
        pending: true,
        alreadyRunning: run.alreadyRunning,
        run: run.status,
        message: run.alreadyRunning ? 'Swing scan is already running.' : 'Swing scan started in the background.',
      });
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/latest') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const snapshots = await readSnapshots();
    const filtered = filterSnapshotsByMarket(snapshots, market);
    const payload = {
      ok: true,
      market: market || 'ALL',
      latest: filtered.length ? filtered[filtered.length - 1] : null,
      historyCount: filtered.length,
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/portfolio') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const payload = await getCachedPortfolioPayload(market);
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/portfolio-earnings') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const payload = await readPortfolioEarningsPayload();
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/portfolio-ai') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const ticker = String(body?.ticker || '').trim().toUpperCase();
      if (!ticker) {
        return jsonResponse(res, 400, { ok: false, error: 'Ticker is required' });
      }
      if (!CONFIG.openaiApiKey) {
        return jsonResponse(res, 400, { ok: false, error: 'OPENAI_API_KEY is not configured' });
      }
      const portfolioStore = await readPortfolioStore();
      const latestSnapshots = await readSnapshots();
      const latestUs = [...latestSnapshots].reverse().find((snapshot) => snapshot.market === US) || null;
      const sectorIntelligence = await getCachedSectorIntelligencePayload(latestUs, portfolioStore.US);
      const sectorStockIndex = indexSectorStocks(sectorIntelligence);
      const portfolio = attachSectorResearchToPortfolio(
        await buildLiveUsPortfolio(portfolioStore.US, latestUs),
        sectorIntelligence,
      );
      const holding = portfolio?.holdings?.find((item) => String(item.ticker || '').toUpperCase() === ticker);
      if (!holding) {
        return jsonResponse(res, 404, { ok: false, error: `Holding not found for ticker ${ticker}` });
      }
      const sectorStock = sectorStockIndex[ticker] || null;

      try {
        const overlay = await fetchOpenAiHoldingOverlay(holding, latestUs, holding.recommendation, holding.headlines);
        const recommendation = mergeAiRecommendation(holding.recommendation, overlay, holding, latestUs);
        const enriched = attachSectorResearchFields(
          { ...holding, recommendation },
          sectorStock,
        );
        return jsonResponse(res, 200, {
          ok: true,
          ticker,
          updatedAt: nowTimestamp(),
          recommendation,
          technicalSnapshot: enriched.technicalSnapshot,
          fundamentalSnapshot: enriched.fundamentalSnapshot,
          newsDigest: enriched.newsDigest,
          sectorContext: enriched.sectorContext,
          shiftAlignment: enriched.shiftAlignment,
          researchQuality: enriched.researchQuality,
          aiOverlay: enriched.aiOverlay,
        });
      } catch (error) {
        const enriched = attachSectorResearchFields(
          {
            ...holding,
            recommendation: {
              ...holding.recommendation,
              aiOverlay: {
                enabled: true,
                model: CONFIG.openaiModel,
                error: error.message,
                debugHint: 'Check aiOverlay.error for raw OpenAI response summary.',
              },
            },
          },
          sectorStock,
        );
        return jsonResponse(res, 200, {
          ok: true,
          ticker,
          updatedAt: nowTimestamp(),
          recommendation: enriched.recommendation,
          technicalSnapshot: enriched.technicalSnapshot,
          fundamentalSnapshot: enriched.fundamentalSnapshot,
          newsDigest: enriched.newsDigest,
          sectorContext: enriched.sectorContext,
          shiftAlignment: enriched.shiftAlignment,
          researchQuality: enriched.researchQuality,
          aiOverlay: enriched.aiOverlay,
        });
      }
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/sector-intelligence') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const { portfolioStore, latestUs } = await readDashboardState();
      const payload = portfolioStore.US ? await getCachedSectorIntelligencePayload(latestUs, portfolioStore.US) : {
        updatedAt: nowTimestamp(),
        marketSession: getUsSessionLabel(),
        benchmarks: {},
        shiftSignals: [],
        sectorBreadth: {},
        leaders: [],
        laggards: [],
        capexTakers: {},
        capexSpenders: {},
        aiSummary: null,
        stocks: [],
      };
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      return jsonResponse(res, 200, payload);
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/watchlist-ai') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const { watchlistAiPayload } = await getWatchlistPayloadsForRequest();
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      return jsonResponse(res, 200, watchlistAiPayload);
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/watchlist-stocks') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const { stocksPayload, watchlistAiPayload } = await getWatchlistPayloadsForRequest();
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': wantsHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      if (wantsHtml) {
        return textResponse(res, 200, renderWatchlistStocksPage(stocksPayload, watchlistAiPayload), 'text/html; charset=utf-8');
      }
      return jsonResponse(res, 200, stocksPayload);
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/watchlist-stocks') {
    if (!isIndMoneyDashboardAuthenticated(req)) {
      return redirectToLogin(req, res, '/watchlist-stocks');
    }
    try {
      const { stocksPayload, watchlistAiPayload } = await getWatchlistPayloadsForRequest();
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      return textResponse(res, 200, renderWatchlistStocksPage(stocksPayload, watchlistAiPayload), 'text/html; charset=utf-8');
    } catch (error) {
      return textResponse(res, 500, `Watchlist dashboard failed: ${error.message}`);
    }
  }

  if ((req.method === 'GET' || isHead) && (url.pathname === '/portfolio-alerts' || url.pathname === '/alerts')) {
    if (!isIndMoneyDashboardAuthenticated(req)) {
      return redirectToLogin(req, res, url.pathname);
    }
    const html = await fsp.readFile(CONFIG.portfolioAlertsUiPath, 'utf8');
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return textResponse(res, 200, html, 'text/html; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/portfolio-earnings') {
    if (!isIndMoneyDashboardAuthenticated(req)) {
      return redirectToLogin(req, res, '/portfolio-earnings');
    }
    const html = await fsp.readFile(CONFIG.portfolioEarningsUiPath, 'utf8');
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return textResponse(res, 200, html, 'text/html; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/swing-trades') {
    if (!isIndMoneyDashboardAuthenticated(req)) {
      return redirectToLogin(req, res, '/swing-trades');
    }
    const html = await fsp.readFile(CONFIG.swingTradesUiPath, 'utf8');
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return textResponse(res, 200, html, 'text/html; charset=utf-8');
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/layout') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const layoutStore = await readLayoutStore();
    const payload = {
      ok: true,
      layout: layoutStore.widgets,
      updatedAt: layoutStore.updatedAt,
    };
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/api/engine') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    const payload = await getCachedEnginePayload();
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return jsonResponse(res, 200, payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/layout') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const layout = body?.layout;
      if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
        return jsonResponse(res, 400, { ok: false, error: 'Invalid layout payload' });
      }
      await writeLayoutStore(layout);
      return jsonResponse(res, 200, { ok: true, layout, updatedAt: nowTimestamp() });
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/collect-now') {
    if (!requireIndMoneyDashboardAuth(req, res)) {
      return;
    }
    try {
      const targetMarket = market || url.searchParams.get('market')?.toUpperCase() || 'ALL';
      const snapshots = await collectAndStoreSnapshots('manual', targetMarket);
      invalidateEngineCache();
      return jsonResponse(res, 200, { ok: true, snapshots });
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: error.message });
    }
  }

  if ((req.method === 'GET' || isHead) && url.pathname === '/') {
    if (!isIndMoneyDashboardAuthenticated(req)) {
      return redirectToLogin(req, res, '/');
    }
    const html = await fsp.readFile(CONFIG.uiPath, 'utf8');
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return textResponse(res, 200, html, 'text/html; charset=utf-8');
  }

  return textResponse(res, 404, 'Not found');
}

async function buildEnginePayload() {
  const { latestInd, latestUs, portfolioStore } = await readDashboardState();
  const sectorIntelligence = portfolioStore.US ? await getCachedSectorIntelligencePayload(latestUs, portfolioStore.US) : null;
  const portfolio = portfolioStore.US
    ? await buildBestAvailableUsPortfolio(portfolioStore.US, latestUs, sectorIntelligence)
    : null;
  const global = buildGlobalDecision(latestInd, latestUs, portfolio);
  return {
    ok: true,
    ind: latestInd,
    us: latestUs,
    portfolio: {
      us: portfolio,
    },
    sectorIntelligence,
    global,
    report: buildEngineReport(latestInd, latestUs, global, portfolio),
  };
}

async function getCachedEnginePayload() {
  const now = Date.now();
  if (engineResponseCache.payload && engineResponseCache.expiresAt > now) {
    return engineResponseCache.payload;
  }
  if (engineResponseCache.promise) {
    return engineResponseCache.promise;
  }

  engineResponseCache.promise = buildEnginePayload()
    .then((payload) => {
      engineResponseCache = {
        payload,
        expiresAt: Date.now() + ENGINE_CACHE_TTL_MS,
        promise: null,
      };
      return payload;
    })
    .catch((error) => {
      engineResponseCache.promise = null;
      throw error;
    });

  return engineResponseCache.promise;
}

async function buildPortfolioPayload(market) {
  const { portfolioStore, latestUs } = await readDashboardState();
  const sectorIntelligence = !market || market === US
    ? portfolioStore.US
      ? await getCachedSectorIntelligencePayload(latestUs, portfolioStore.US)
      : null
    : null;
  const hydratedUs =
    !market || market === US
      ? await buildBestAvailableUsPortfolio(portfolioStore.US, latestUs, sectorIntelligence)
      : null;
  const selected = market
    ? market === US
      ? hydratedUs
      : portfolioStore[market] || null
    : { ...portfolioStore, US: hydratedUs };
  return {
    ok: true,
    market: market || 'ALL',
    portfolio: selected,
  };
}

async function getCachedPortfolioPayload(market) {
  if (market && market !== US) {
    return buildPortfolioPayload(market);
  }

  const refreshIntervalMs = getUsRefreshIntervalMs();
  if (!refreshIntervalMs) {
    return buildPortfolioPayload(market);
  }

  const now = Date.now();
  const formatPayloadForMarket = (payload, options = {}) => ({
    ...payload,
    market: market || 'ALL',
    stale: Boolean(options.stale),
    refreshing: Boolean(options.refreshing),
    portfolio: market === US ? payload.portfolio.US : payload.portfolio,
  });
  if (portfolioResponseCache.payload && portfolioResponseCache.expiresAt > now) {
    return formatPayloadForMarket(portfolioResponseCache.payload);
  }
  const startRefresh = () => {
    if (!portfolioResponseCache.promise) {
      portfolioResponseCache.promise = buildPortfolioPayload()
        .then((payload) => {
          portfolioResponseCache = {
            payload,
            expiresAt: Date.now() + Math.max(refreshIntervalMs, PORTFOLIO_CACHE_TTL_MS),
            promise: null,
          };
          return payload;
        })
        .catch((error) => {
          portfolioResponseCache.promise = null;
          console.error('Portfolio cache refresh failed:', error.message);
          throw error;
        });
    }
    return portfolioResponseCache.promise;
  };

  if (portfolioResponseCache.payload) {
    startRefresh().catch(() => {});
    return formatPayloadForMarket(portfolioResponseCache.payload, { stale: true, refreshing: true });
  }

  const payload = await startRefresh();
  return formatPayloadForMarket(payload);
}

async function fetchTextWithRetry(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': CONFIG.userAgent,
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(options.headers || {}),
        },
      });
      if (response.ok) {
        return await response.text();
      }
      if ([403, 429].includes(response.status) || response.status >= 500) {
        await sleep(CONFIG.retryBackoffMs * attempt);
        continue;
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
      await sleep(CONFIG.retryBackoffMs * attempt);
    }
  }
  throw new Error(`Fetch failed for ${url}: ${lastError?.message || 'unknown error'}`);
}

async function fetchJsonWithRetry(url, options = {}) {
  return JSON.parse(await fetchTextWithRetry(url, options));
}

async function fetchOpenAiResponse(payload) {
  if (!CONFIG.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const response = await fetch(CONFIG.urls.openaiResponses, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function extractOpenAiOutputText(payload) {
  const parts = [];
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    parts.push(payload.output_text);
  }
  (payload?.output || []).forEach((item) => {
    (item?.content || []).forEach((contentItem) => {
      if (contentItem?.type === 'output_text' && typeof contentItem.text === 'string') {
        parts.push(contentItem.text);
      }
      if (contentItem?.type === 'text' && typeof contentItem.text === 'string') {
        parts.push(contentItem.text);
      }
    });
  });
  return parts.map((item) => item.trim()).filter(Boolean);
}

function extractFirstJsonObject(textCandidates) {
  const candidates = Array.isArray(textCandidates) ? textCandidates : [textCandidates];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf('{');
      if (start === -1) {
        continue;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < candidate.length; i += 1) {
        const ch = candidate[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            const slice = candidate.slice(start, i + 1);
            try {
              return JSON.parse(slice);
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

function summarizeOpenAiResponse(payload, outputText = '') {
  const preview = Array.isArray(outputText) ? outputText.join('\n---\n').slice(0, 400) : String(outputText || '').slice(0, 400);
  return {
    id: payload?.id || null,
    status: payload?.status || null,
    incompleteDetails: payload?.incomplete_details || null,
    error: payload?.error || null,
    outputTextPreview: preview,
    outputTypes: Array.isArray(payload?.output)
      ? payload.output.map((item) => ({
          type: item?.type || null,
          role: item?.role || null,
          contentTypes: Array.isArray(item?.content) ? item.content.map((contentItem) => contentItem?.type || null) : [],
        }))
      : [],
  };
}

async function fetchTextWithCurl(url, headers = {}) {
  const args = ['-sL', '--max-time', '20'];
  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }
  args.push(url);

  try {
    const { stdout, stderr } = await execFileAsync('/usr/bin/curl', args, { maxBuffer: 10 * 1024 * 1024 });
    if (!stdout) {
      throw new Error(`Empty response for ${url}${stderr ? `: ${stderr}` : ''}`);
    }
    return stdout;
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    throw new Error(`curl failed for ${url}: ${error.message}${stderr ? ` | ${stderr}` : ''}`);
  }
}

async function fetchJsonWithCurl(url, headers = {}) {
  return JSON.parse(await fetchTextWithCurl(url, headers));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value).replace(/,/g, '').replace(/%/g, '').replace(/\$/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '--' || cleaned === 'N/A') {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCompactNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw || raw === '-' || raw === '--' || raw === 'N/A') {
    return null;
  }
  const match = raw.replace(/,/g, '').match(/^([+-]?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) {
    return toNumber(raw);
  }
  const base = Number(match[1]);
  const suffix = String(match[2] || '').toUpperCase();
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Number.isFinite(base) ? base * (multipliers[suffix] || 1) : null;
}

function extractGoogleFinanceStat(html, label) {
  const pattern = new RegExp(`${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}</div><div class="dO6ijd">([^<]+)</div>`, 'i');
  return (html.match(pattern) || [])[1] || null;
}

function extractGoogleFinanceTableFirstValue(html, label) {
  const pattern = new RegExp(
    `${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}</div></div></td><td[^>]*><div[^>]*><div class="CNzF7d">([^<]+)</div>`,
    'i',
  );
  return (html.match(pattern) || [])[1] || null;
}

async function fetchGoogleFinanceFundamentalsFallback(ticker, currentPrice = null) {
  const symbol = getUsSymbolForTicker(ticker);
  const html = await fetchTextWithRetry(`${CONFIG.urls.googleFinanceQuote}${encodeURIComponent(symbol)}`, {
    redirect: 'follow',
  });

  const peRatio = toNumber(extractGoogleFinanceStat(html, 'P/E ratio'));
  const week52High = toNumber(extractGoogleFinanceStat(html, '52-wk high'));
  const week52Low = toNumber(extractGoogleFinanceStat(html, '52-wk low'));
  const sharesOutstanding = parseCompactNumber(extractGoogleFinanceStat(html, 'Shares outstanding'));
  const eps = toNumber(extractGoogleFinanceStat(html, 'EPS'));
  const revenue = parseCompactNumber(extractGoogleFinanceTableFirstValue(html, 'Revenue'));
  const operatingIncome = parseCompactNumber(extractGoogleFinanceTableFirstValue(html, 'Operating income'));
  const netProfitMargin = toNumber(extractGoogleFinanceTableFirstValue(html, 'Net profit margin'));
  const earningsPerShare = toNumber(extractGoogleFinanceTableFirstValue(html, 'Earnings per share'));
  const marketCapitalization =
    sharesOutstanding !== null && toNumber(currentPrice) !== null ? round(sharesOutstanding * toNumber(currentPrice), 2) : null;
  const operatingMargin =
    operatingIncome !== null && revenue !== null && revenue !== 0 ? round((operatingIncome / revenue) * 100, 2) : null;

  return {
    marketCapitalization,
    peTTM: peRatio,
    psTTM: null,
    revenueGrowthTTMYoy: null,
    epsGrowthTTMYoy: null,
    operatingMargin,
    grossMarginTTM: null,
    netMargin: netProfitMargin,
    week52High,
    week52Low,
    epsTTM: eps ?? earningsPerShare,
    source: 'Google Finance fallback',
  };
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computePercentChange(current, previous) {
  const a = toNumber(current);
  const b = toNumber(previous);
  if (a === null || b === null || b === 0) {
    return null;
  }
  return round(((a - b) / b) * 100, 2);
}

function computeAbsoluteChange(current, previous) {
  const a = toNumber(current);
  const b = toNumber(previous);
  if (a === null || b === null) {
    return null;
  }
  return round(a - b, 2);
}

function computeBasisPointChange(currentPct, previousPct) {
  const a = toNumber(currentPct);
  const b = toNumber(previousPct);
  if (a === null || b === null) {
    return null;
  }
  return round((a - b) * 100, 1);
}

function extractFirstNumber(text, regex) {
  if (!text) {
    return null;
  }
  const match = text.match(regex);
  return match ? toNumber(match[1]) : null;
}

function sliceAround(text, regex, radius = 2400) {
  const match = text.match(regex);
  if (!match || match.index === undefined) {
    return text.slice(0, radius);
  }
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + radius);
  return text.slice(start, end);
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·');
}

function safeFetch(label, fn) {
  return fn().catch((error) => {
    console.error(`${label} failed:`, error.message);
    return {};
  });
}

function hasFinnhubAccess() {
  return Boolean(CONFIG.finnhubApiKey);
}

function buildFinnhubUrl(resourcePath, params = {}) {
  const url = new URL(`${CONFIG.urls.finnhub}${resourcePath}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

async function fetchFinnhubJson(resourcePath, params = {}) {
  if (!hasFinnhubAccess()) {
    throw new Error('FINNHUB_API_KEY is not configured');
  }
  const url = buildFinnhubUrl(resourcePath, params);
  const headers = {
    'X-Finnhub-Token': CONFIG.finnhubApiKey,
    Accept: 'application/json',
  };
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers,
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Finnhub returned non-JSON for ${resourcePath}: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`Finnhub HTTP ${response.status} for ${resourcePath}: ${text.slice(0, 200)}`);
    }
    if (payload?.error) {
      throw new Error(`Finnhub error for ${resourcePath}: ${payload.error}`);
    }
    return payload;
  } catch (error) {
    if (/fetch failed|ECONNRESET|ENOTFOUND|unexpected EOF/i.test(String(error.message || ''))) {
      return await fetchJsonWithCurl(url.toString(), headers);
    }
    throw error;
  }
}

async function getCachedResource(cache, key, ttlMs, loader, options = {}) {
  cleanupHotCaches();
  const { errorTtlMs = FETCH_ERROR_CACHE_TTL_MS } = options;
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    if (entry.promise) {
      return entry.promise;
    }
    if (entry.error !== undefined) {
      throw entry.error;
    }
    return entry.value;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
        promise: null,
      });
      cleanupHotCaches();
      return value;
    })
    .catch((error) => {
      cache.set(key, {
        error,
        expiresAt: Date.now() + errorTtlMs,
        promise: null,
      });
      cleanupHotCaches();
      throw error;
    });

  cache.set(key, {
    promise,
    expiresAt: now + Math.max(ttlMs, errorTtlMs),
  });

  return promise;
}

function getTodaysDateKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    const actualDate = date instanceof Date ? date : new Date(date);
    return `${actualDate.getFullYear()}-${String(actualDate.getMonth() + 1).padStart(2, '0')}-${String(actualDate.getDate()).padStart(2, '0')}`;
  }
}

async function getTodaysUsdInrRate() {
  const key = `USDINR::${getTodaysDateKey()}`;
  try {
    const rate = await getCachedResource(
      indMoneyDashboardFxRateCache,
      key,
      USDINR_TODAY_CACHE_TTL_MS,
      async () => {
        const response = await fetchUsdInr();
        const value = toNumber(response?.value);
        if (value === null || !Number.isFinite(value) || value <= 0) {
          throw new Error('Unable to parse USDINR conversion value');
        }
        return round(value, 4);
      },
      { errorTtlMs: 60 * 1000 },
    );
    return toNumber(rate);
  } catch (error) {
    console.error('USDINR helper failed:', error.message);
    return null;
  }
}

function buildStoredUsPortfolio(portfolio) {
  if (!portfolio) {
    return null;
  }

  const holdings = Array.isArray(portfolio.holdings)
    ? portfolio.holdings.map((holding) => {
        const quantity = toNumber(holding.quantity);
        const lastPrice = toNumber(holding.lastPrice);
        const movePct = toNumber(holding.movePct);
        const investedRaw = toNumber(holding.invested);
        const currentValueRaw = toNumber(holding.currentValue);
        const totalReturnRaw = toNumber(holding.totalReturn);
        const totalReturnPctRaw = toNumber(holding.totalReturnPct);
        const derivedCurrentValue = currentValueRaw ?? (quantity !== null && lastPrice !== null ? quantity * lastPrice : null);
        const currentValue = derivedCurrentValue !== null ? round(derivedCurrentValue, 2) : null;
        const invested = investedRaw !== null ? round(investedRaw, 2) : null;
        const actualReturn = totalReturnRaw ?? (currentValue !== null && invested !== null ? round(currentValue - invested, 2) : null);
        const actualReturnPct =
          totalReturnPctRaw ?? (actualReturn !== null && invested ? round((actualReturn / invested) * 100, 2) : null);
        const previousClose =
          lastPrice !== null && movePct !== null && movePct !== -100 ? round(lastPrice / (1 + movePct / 100), 4) : null;
        const oneDayReturn =
          quantity !== null && lastPrice !== null && previousClose !== null ? round(quantity * (lastPrice - previousClose), 2) : null;

        return {
          ...holding,
          investedRaw: invested,
          currentValueRaw: currentValue,
          previousClose,
          previousCloseValueRaw: previousClose !== null && quantity !== null ? round(previousClose * quantity, 2) : null,
          regularPrice: lastPrice,
          livePrice: lastPrice,
          currentValue,
          actualReturn,
          actualReturnPct,
          oneDayReturn,
          oneDayReturnPct: movePct,
          totalReturn: actualReturn,
          totalReturnPct: actualReturnPct,
          sessionMovePct: movePct,
          sessionMoveAbs: previousClose !== null && lastPrice !== null ? round(lastPrice - previousClose, 2) : null,
          moveBasis: holding.moveBasis || 'Imported',
          extendedPrice: lastPrice,
          extendedValue: currentValue,
          liveValue: currentValue,
          liveReturn: actualReturn,
          liveReturnPct: actualReturnPct,
        };
      })
    : [];

  return {
    ...portfolio,
    holdings,
    isLive: false,
    source: portfolio.source || 'stored',
    snapshotUpdatedAt: portfolio.updatedAt || null,
  };
}

async function buildBestAvailableUsPortfolio(portfolio, usSnapshot, sectorIntelligence = null) {
  if (!portfolio) {
    return null;
  }
  try {
    const livePortfolio = await buildLiveUsPortfolio(portfolio, usSnapshot);
    if (livePortfolio) {
      return attachSectorResearchToPortfolio(livePortfolio, sectorIntelligence);
    }
  } catch (error) {
    console.error('Live US portfolio hydration failed, falling back to stored snapshot:', error.message);
  }
  return attachSectorResearchToPortfolio(buildStoredUsPortfolio(portfolio), sectorIntelligence);
}

function formatTitleCase(text) {
  return String(text || '')
    .trim()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getSignFromClassName(className) {
  if (!className) {
    return 1;
  }
  if (String(className).includes('Ebnabc')) {
    return -1;
  }
  return 1;
}

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function classifyStrength(movePct) {
  const value = toNumber(movePct);
  if (value === null) {
    return 'not available';
  }
  const abs = Math.abs(value);
  if (abs >= 1.5) {
    return value > 0 ? 'strong' : 'weak';
  }
  if (abs >= 0.4) {
    return value > 0 ? 'green' : 'red';
  }
  return 'flat';
}

function computeConfidence(score, usableSignals) {
  if (usableSignals >= 7 && Math.abs(score) >= 3) {
    return 'High';
  }
  if (usableSignals >= 5) {
    return 'Medium';
  }
  return 'Low';
}

function getIstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function nowTimestamp() {
  const parts = getIstParts();
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')} IST`;
}

function getTimePartsInZone(date = new Date(), timeZone = CONFIG.timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function formatCalendarDate(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getCalendarDateInZone(date = new Date(), timeZone = CONFIG.timezone) {
  return formatCalendarDate(getTimePartsInZone(date, timeZone));
}

function getCurrentUsTradingDate(date = new Date()) {
  const candidate = new Date(date);
  for (let index = 0; index < 7; index += 1) {
    const parts = getTimePartsInZone(candidate, 'America/New_York');
    if (parts.weekday !== 'Sat' && parts.weekday !== 'Sun') {
      return formatCalendarDate(parts);
    }
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return getCalendarDateInZone(date, 'America/New_York');
}

function parseIstTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+IST$/i);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second = '00'] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 5, Number(minute) - 30, Number(second)));
}

function computeHoldingOneDayReturn({
  quantity,
  regularPrice,
  previousClose,
  importedOneDayReturn,
  importedOneDayReturnPct,
  tradeLots,
} = {}) {
  const normalizedQuantity = toNumber(quantity);
  const normalizedRegularPrice = toNumber(regularPrice);
  const normalizedPreviousClose = toNumber(previousClose);
  const normalizedImportedOneDayReturn = toNumber(importedOneDayReturn);
  const normalizedImportedOneDayReturnPct = toNumber(importedOneDayReturnPct);
  const buyLots = Array.isArray(tradeLots?.buys) ? tradeLots.buys : [];

  let remainingHeldBuyQuantity = normalizedQuantity ?? null;
  let todayBoughtQuantityRaw = 0;
  let todayBoughtValueBasisRaw = 0;

  if (remainingHeldBuyQuantity !== null && remainingHeldBuyQuantity > 0) {
    for (const lot of buyLots) {
      const lotQuantity = toNumber(lot?.quantity);
      const lotPrice = toNumber(lot?.price);
      if (lotQuantity === null || lotQuantity <= 0 || remainingHeldBuyQuantity <= 0) {
        continue;
      }
      const matchedQuantity = Math.min(remainingHeldBuyQuantity, lotQuantity);
      todayBoughtQuantityRaw += matchedQuantity;
      if (lotPrice !== null) {
        todayBoughtValueBasisRaw += matchedQuantity * lotPrice;
      } else if (normalizedRegularPrice !== null) {
        todayBoughtValueBasisRaw += matchedQuantity * normalizedRegularPrice;
      }
      remainingHeldBuyQuantity -= matchedQuantity;
    }
  }

  const hasTradeLotContext = buyLots.length > 0 || toNumber(tradeLots?.sold) !== null;
  const heldQuantityAtPreviousCloseRaw =
    normalizedQuantity !== null ? Math.max(0, normalizedQuantity - todayBoughtQuantityRaw) : null;
  const previousCloseValueRaw =
    heldQuantityAtPreviousCloseRaw !== null && normalizedPreviousClose !== null
      ? heldQuantityAtPreviousCloseRaw * normalizedPreviousClose
      : null;
  const overnightOneDayReturnRaw =
    heldQuantityAtPreviousCloseRaw !== null &&
    normalizedRegularPrice !== null &&
    normalizedPreviousClose !== null
      ? heldQuantityAtPreviousCloseRaw * (normalizedRegularPrice - normalizedPreviousClose)
      : null;
  const todayBoughtOneDayReturnRaw =
    todayBoughtQuantityRaw > 0 && normalizedRegularPrice !== null
      ? todayBoughtQuantityRaw * normalizedRegularPrice - todayBoughtValueBasisRaw
      : 0;
  const computedOneDayReturnRaw =
    overnightOneDayReturnRaw !== null || todayBoughtQuantityRaw > 0
      ? (overnightOneDayReturnRaw || 0) + todayBoughtOneDayReturnRaw
      : null;
  const computedOneDayReturn =
    computedOneDayReturnRaw !== null ? round(computedOneDayReturnRaw, 2) : null;
  const computedOneDayReturnPct =
    computedOneDayReturn !== null &&
    previousCloseValueRaw !== null &&
    previousCloseValueRaw + todayBoughtValueBasisRaw !== 0
      ? round((computedOneDayReturn / (previousCloseValueRaw + todayBoughtValueBasisRaw)) * 100, 2)
      : null;
  const fallbackPreviousCloseValueRaw =
    normalizedPreviousClose !== null && normalizedQuantity !== null
      ? normalizedPreviousClose * normalizedQuantity
      : null;
  const fallbackComputedOneDayReturn =
    normalizedPreviousClose !== null && normalizedRegularPrice !== null && normalizedQuantity !== null
      ? round(normalizedQuantity * (normalizedRegularPrice - normalizedPreviousClose), 2)
      : null;
  const importedLooksLikePlaceholder =
    normalizedImportedOneDayReturn === 0 &&
    normalizedImportedOneDayReturnPct === 0 &&
    fallbackComputedOneDayReturn !== null;
  const fallbackOneDayReturn =
    normalizedImportedOneDayReturn !== null && !importedLooksLikePlaceholder
      ? normalizedImportedOneDayReturn
      : fallbackComputedOneDayReturn;
  const fallbackOneDayReturnPct =
    normalizedImportedOneDayReturn !== null && !importedLooksLikePlaceholder
      ? normalizedImportedOneDayReturnPct
      : (fallbackPreviousCloseValueRaw
        ? round((fallbackOneDayReturn / fallbackPreviousCloseValueRaw) * 100, 2)
        : normalizedImportedOneDayReturnPct);

  if (!hasTradeLotContext) {
    return {
      heldQuantityAtPreviousClose: null,
      todayBoughtQuantity: 0,
      previousCloseValue: fallbackPreviousCloseValueRaw !== null ? round(fallbackPreviousCloseValueRaw, 2) : null,
      oneDayReturn: fallbackOneDayReturn,
      oneDayReturnPct: fallbackOneDayReturnPct,
    };
  }

  return {
    heldQuantityAtPreviousClose: heldQuantityAtPreviousCloseRaw !== null ? round(heldQuantityAtPreviousCloseRaw, 6) : null,
    todayBoughtQuantity: todayBoughtQuantityRaw ? round(todayBoughtQuantityRaw, 6) : 0,
    previousCloseValue: previousCloseValueRaw !== null ? round(previousCloseValueRaw, 2) : null,
    oneDayReturn: computedOneDayReturn,
    oneDayReturnPct: computedOneDayReturnPct,
  };
}

function buildUsTradeDateLots(orders, tradeDate) {
  if (!Array.isArray(orders) || !tradeDate) {
    return {};
  }

  return orders.reduce((acc, order) => {
    const ticker = String(order?.ticker || '').toUpperCase();
    if (!ticker) {
      return acc;
    }
    const filledAt = parseIstTimestamp(order?.filledAt || order?.placedAt);
    if (!filledAt || getCalendarDateInZone(filledAt, 'America/New_York') !== tradeDate) {
      return acc;
    }

    const quantity = toNumber(order?.quantity);
    if (quantity === null || quantity <= 0) {
      return acc;
    }

    const side = String(order?.side || '').toUpperCase();
    const bucket = acc[ticker] || { buys: [], sold: 0 };
    if (side === 'BUY') {
      bucket.buys.push({
        quantity,
        price: toNumber(order?.avgPrice),
      });
    } else if (side === 'SELL') {
      bucket.sold += quantity;
    }
    acc[ticker] = bucket;
    return acc;
  }, {});
}

export function getUsSessionLabel(date = new Date()) {
  const { weekday, hour, minute } = getTimePartsInZone(date, 'America/New_York');
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) {
    return 'post-close';
  }
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 4 * 60) {
    return 'post-close';
  }
  const openMinutes = 9 * 60 + 30;
  if (totalMinutes < openMinutes) {
    return 'pre-market';
  }
  if (totalMinutes < openMinutes + 15) {
    return '15 min after open';
  }
  if (totalMinutes < openMinutes + 60) {
    return '60 min after open';
  }
  if (totalMinutes >= 16 * 60 && totalMinutes < 20 * 60) {
    return 'post-market';
  }
  if (totalMinutes >= 20 * 60) {
    return 'post-close';
  }
  if (totalMinutes >= 15 * 60 + 30) {
    return 'near close';
  }
  return 'live';
}

function isUsRegularSession(date = new Date()) {
  const session = getUsSessionLabel(date);
  return session === 'live' || session === '15 min after open' || session === '60 min after open' || session === 'near close';
}

function getIndiaSessionLabel(date = new Date()) {
  const { weekday, hour, minute } = getTimePartsInZone(date, CONFIG.timezone);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return 'post-close';
  }
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 9 * 60 + 15) {
    return 'pre-open';
  }
  if (totalMinutes < 15 * 60 + 30) {
    return 'live';
  }
  return 'post-close';
}

function isUsExtendedSession(date = new Date()) {
  const session = getUsSessionLabel(date);
  return session === 'pre-market' || session === 'post-market';
}

function isUsWatchSessionActive(date = new Date()) {
  const session = getUsSessionLabel(date);
  return session === 'pre-market' ||
    session === '15 min after open' ||
    session === '60 min after open' ||
    session === 'near close' ||
    session === 'live' ||
    session === 'post-market';
}

function isIndiaPreOpenWindow(date = new Date()) {
  const { weekday, hour, minute } = getTimePartsInZone(date, CONFIG.timezone);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= 9 * 60 && totalMinutes < 9 * 60 + 15;
}

function isIndiaMarketOpen(date = new Date()) {
  const { weekday, hour, minute } = getTimePartsInZone(date, CONFIG.timezone);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  const totalMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 15;
  const closeMinutes = 15 * 60 + 30;
  return totalMinutes >= openMinutes && totalMinutes < closeMinutes;
}

function isIndiaExtendedSession(date = new Date()) {
  const { weekday, hour, minute } = getTimePartsInZone(date, CONFIG.timezone);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  const totalMinutes = hour * 60 + minute;
  return (totalMinutes >= 9 * 60 && totalMinutes < 9 * 60 + 15) || (totalMinutes >= 15 * 60 + 30 && totalMinutes < 16 * 60 + 30);
}

function isUsMarketOpen(date = new Date()) {
  const { weekday, hour, minute } = getTimePartsInZone(date, 'America/New_York');
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  const totalMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;
  return totalMinutes >= openMinutes && totalMinutes < closeMinutes;
}

function getOpenMarkets(date = new Date()) {
  const markets = [];
  if (isIndiaMarketOpen(date)) {
    markets.push(INDIA);
  }
  if (isUsMarketOpen(date)) {
    markets.push(US);
  }
  return markets;
}

export function getUsRefreshIntervalMs(date = new Date()) {
  return isUsWatchSessionActive(date) ? LIVE_SESSION_REFRESH_MS : null;
}

function getIndMoneyDashboardBaseCacheIntervalMs(date = new Date()) {
  const liveRefreshMs = getUsRefreshIntervalMs(date);
  return liveRefreshMs || Math.max(US_CLOSED_SESSION_REFRESH_MS, INDMONEY_DASHBOARD_BASE_CACHE_MS);
}

function getMarketRefreshIntervalMs(market, date = new Date()) {
  if (market === US) {
    return getUsRefreshIntervalMs(date);
  }
  if (market === INDIA) {
    if (isIndiaMarketOpen(date)) {
      return LIVE_SESSION_REFRESH_MS;
    }
    if (isIndiaExtendedSession(date)) {
      return EXTENDED_SESSION_REFRESH_MS;
    }
  }
  return null;
}

function shouldCollectMarketNow(market, date = new Date()) {
  const intervalMs = getMarketRefreshIntervalMs(market, date);
  if (!intervalMs) {
    return false;
  }
  if (intervalMs === LIVE_SESSION_REFRESH_MS) {
    return true;
  }
  const timeZone = market === US ? 'America/New_York' : CONFIG.timezone;
  const { minute } = getTimePartsInZone(date, timeZone);
  return minute === 0;
}

function getNextAlignedRunDate(date = new Date()) {
  const nextRun = new Date(date);
  nextRun.setSeconds(0, 0);
  nextRun.setMinutes(nextRun.getMinutes() + 1);
  return nextRun;
}

async function fetchUsdInr() {
  if (CONFIG.alphaVantageApiKey) {
    const data = await fetchJsonWithRetry(
      `${CONFIG.urls.alphaVantage}?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=INR&apikey=${encodeURIComponent(
        CONFIG.alphaVantageApiKey,
      )}`,
    );
    const node = data['Realtime Currency Exchange Rate'] || {};
    const value = toNumber(node['5. Exchange Rate']);
    if (value !== null) {
      return {
        value,
        change: null,
      };
    }
  }

  const data = await fetchJsonWithRetry(CONFIG.urls.openExchangeUsd);
  const latest = toNumber(data?.rates?.INR);
  if (latest === null) {
    throw new Error('Unable to fetch USDINR from fallback source');
  }
  return {
    value: latest,
    change: null,
  };
}

async function fetchBrent() {
  try {
    const quote = await fetchTradingEconomicsCommodity(CONFIG.urls.tradingEconomicsBrent);
    if (quote.value !== null) {
      return {
        value: quote.value,
        pctChange: quote.pctChange,
      };
    }
  } catch (error) {
    console.error('TradingEconomics Brent fetch failed:', error.message);
  }

  if (CONFIG.alphaVantageApiKey) {
    const data = await fetchJsonWithRetry(
      `${CONFIG.urls.alphaVantage}?function=BRENT&interval=daily&apikey=${encodeURIComponent(CONFIG.alphaVantageApiKey)}`,
    );

    if (Array.isArray(data.data) && data.data.length > 0) {
      const latest = data.data[0];
      const previous = data.data[1];
      return {
        value: toNumber(latest.value),
        pctChange: computePercentChange(latest.value, previous?.value),
      };
    }
  }

  const csv = await fetchTextWithRetry(CONFIG.urls.fredBrentCsv);
  const rows = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .map((parts) => ({ date: parts[0], value: toNumber(parts[1]) }))
    .filter((row) => row.value !== null);
  const latest = rows.at(-1)?.value;
  const previous = rows.at(-2)?.value;
  if (latest === undefined) {
    throw new Error('Unable to fetch Brent from fallback source');
  }
  return {
    value: latest,
    pctChange: computePercentChange(latest, previous),
  };
}

function parseGiftNiftyFromHtml(html) {
  const snippet = sliceAround(html, /(GIFT\s*NIFTY|SGX\s*NIFTY)/i, 2600);
  const value =
    extractFirstNumber(snippet, /(?:last|ltp|price|close|current)[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i) ||
    extractFirstNumber(snippet, /"pricecurrent":"([+-]?\d[\d,]*\.?\d*)"/i);
  const pctChange =
    extractFirstNumber(snippet, /([+-]?\d[\d,]*\.?\d*)\s*%/i) ||
    extractFirstNumber(snippet, /"changePercent":"([+-]?\d[\d,]*\.?\d*)"/i);
  return { value, pctChange };
}

async function fetchGiftNifty() {
  try {
    const html = await fetchTextWithCurl(CONFIG.urls.iciciGiftNifty);
    const value = extractFirstNumber(
      html,
      /GIFT NIFTY<\/p>[\s\S]{0,1200}?<p[^>]*>\s*([0-9,]+\.\d+)/i,
    );
    const pctChange = extractFirstNumber(
      html,
      /GIFT NIFTY<\/p>[\s\S]{0,1200}?\(([+-]?\d+(?:\.\d+)?)\s*%\)/i,
    );
    if (value !== null) {
      return { value, pctChange };
    }
  } catch (error) {
    console.error('ICICI GIFT Nifty fetch failed:', error.message);
  }

  for (const url of [CONFIG.urls.giftPrimary, CONFIG.urls.giftFallback]) {
    const html = await fetchTextWithRetry(url, { redirect: 'follow' });
    const parsed = parseGiftNiftyFromHtml(html);
    if (parsed.value !== null) {
      return parsed;
    }
  }
  throw new Error('Unable to parse GIFT Nifty');
}

function parseIndiaVixFromNse(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  for (const row of rows) {
    const label = String(row.index || row.key || row.name || '').toUpperCase();
    if (label.includes('INDIA VIX')) {
      return {
        value: toNumber(row.last || row.lastPrice || row.price || row.closingIndex),
        change: toNumber(row.variation || row.change || row.pointChange),
      };
    }
  }
  return { value: null, change: null };
}

function parseIndiaVixFromHtml(html) {
  const snippet = sliceAround(html, /INDIA\s*VIX/i, 2200);
  return {
    value:
      extractFirstNumber(snippet, /"pricecurrent":"([+-]?\d[\d,]*\.?\d*)"/i) ||
      extractFirstNumber(snippet, /(?:last|ltp|price|close)[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i),
    change:
      extractFirstNumber(snippet, /"priceChange":"([+-]?\d[\d,]*\.?\d*)"/i) ||
      extractFirstNumber(snippet, /(?:change|variation)[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i),
  };
}

async function fetchNseJson(url) {
  return fetchJsonWithCurl(url, {
    'user-agent': 'Mozilla/5.0',
    accept: 'application/json,text/plain,*/*',
    referer: 'https://www.nseindia.com/',
  });
}

async function fetchIndiaVix() {
  try {
    const data = await fetchNseJson(CONFIG.urls.nseAllIndices);
    const parsed = parseIndiaVixFromNse(data);
    if (parsed.value !== null) {
      return parsed;
    }
  } catch (error) {
    console.error('NSE India VIX fetch failed:', error.message);
  }

  const html = await fetchTextWithRetry(CONFIG.urls.indiaVixFallback, { redirect: 'follow' });
  return parseIndiaVixFromHtml(html);
}

async function fetchNseAllIndicesData() {
  try {
    const data = await fetchNseJson(CONFIG.urls.nseAllIndices);
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

async function fetchNsePreOpen(key) {
  const encodedKey = encodeURIComponent(key);
  return fetchNseJson(`${CONFIG.urls.nsePreOpen}?key=${encodedKey}`);
}

function parseNseTimestampToIstParts(value) {
  const match = String(value || '').match(/(\d{1,2})-[A-Za-z]{3}-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[3]),
    minute: Number(match[4]),
    second: Number(match[5]),
  };
}

function classifyPreOpenGap(pctChange) {
  const pct = toNumber(pctChange);
  if (pct === null) {
    return 'not available';
  }
  if (pct >= 0.25) {
    return 'gap-up';
  }
  if (pct <= -0.25) {
    return 'gap-down';
  }
  return 'flat';
}

const PREOPEN_SECTOR_MAP = {
  INFY: 'IT',
  TCS: 'IT',
  WIPRO: 'IT',
  HCLTECH: 'IT',
  TECHM: 'IT',
  LTIM: 'IT',
  SBIN: 'Banks',
  HDFCBANK: 'Banks',
  ICICIBANK: 'Banks',
  AXISBANK: 'Banks',
  KOTAKBANK: 'Banks',
  INDUSINDBK: 'Banks',
  BAJFINANCE: 'Banks',
  BAJAJFINSV: 'Banks',
  ITC: 'Defensives',
  HINDUNILVR: 'Defensives',
  NESTLEIND: 'Defensives',
  BRITANNIA: 'Defensives',
  TATACONSUM: 'Defensives',
  SUNPHARMA: 'Defensives',
  CIPLA: 'Defensives',
  DRREDDY: 'Defensives',
  DIVISLAB: 'Defensives',
};

function classifyPreOpenLeadership(rows, advances, declines) {
  const leaders = rows
    .filter((row) => toNumber(row?.metadata?.pChange) !== null)
    .sort((a, b) => (toNumber(b.metadata?.pChange) ?? -999) - (toNumber(a.metadata?.pChange) ?? -999))
    .slice(0, 8)
    .map((row) => PREOPEN_SECTOR_MAP[row?.metadata?.symbol] || 'Other');
  const counts = leaders.reduce((acc, sector) => {
    acc[sector] = (acc[sector] || 0) + 1;
    return acc;
  }, {});
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const adv = toNumber(advances);
  const dec = toNumber(declines);
  const breadthStrong = adv !== null && dec !== null && dec !== 0 && adv / dec >= 1.5;
  if (breadthStrong && Object.keys(counts).filter((key) => counts[key] > 0 && key !== 'Other').length >= 2) {
    return 'broad-based';
  }
  if (dominant?.[0] === 'IT' && dominant[1] >= 2) {
    return 'IT-concentrated';
  }
  if (dominant?.[0] === 'Banks' && dominant[1] >= 2) {
    return 'banks-concentrated';
  }
  if (dominant?.[0] === 'Defensives' && dominant[1] >= 2) {
    return 'defensives-concentrated';
  }
  return breadthStrong ? 'broad-based' : 'mixed';
}

function buildPreOpenBlock(niftyPayload, bankPayload, allPayload, niftyPrevClose, bankPrevClose) {
  const niftyStatus = niftyPayload?.niftyPreopenStatus || {};
  const bankStatus = bankPayload?.niftyPreopenStatus || {};
  const allRows = Array.isArray(allPayload?.data) ? allPayload.data : [];
  const topGainers = [...allRows]
    .filter((row) => toNumber(row?.metadata?.pChange) !== null)
    .sort((a, b) => (toNumber(b.metadata?.pChange) ?? -999) - (toNumber(a.metadata?.pChange) ?? -999))
    .slice(0, 5)
    .map((row) => `${row.metadata.symbol} ${round(toNumber(row.metadata.pChange) ?? 0, 2)}%`);
  const topLosers = [...allRows]
    .filter((row) => toNumber(row?.metadata?.pChange) !== null)
    .sort((a, b) => (toNumber(a.metadata?.pChange) ?? 999) - (toNumber(b.metadata?.pChange) ?? 999))
    .slice(0, 5)
    .map((row) => `${row.metadata.symbol} ${round(toNumber(row.metadata.pChange) ?? 0, 2)}%`);
  const timestamp = allPayload?.timestamp || niftyPayload?.timestamp || bankPayload?.timestamp || null;
  const timestampParts = parseNseTimestampToIstParts(timestamp);
  const isWithinWindow = timestampParts ? timestampParts.hour === 9 && timestampParts.minute < 15 : false;
  const niftyIndicative = toNumber(niftyStatus.lastPrice);
  const bankIndicative = toNumber(bankStatus.lastPrice);
  const niftyPct = toNumber(niftyStatus.pChange) ?? computePercentChange(niftyIndicative, niftyPrevClose);
  const bankPct = toNumber(bankStatus.pChange) ?? computePercentChange(bankIndicative, bankPrevClose);
  const breadthStyle = classifyPreOpenLeadership(allRows, allPayload?.advances, allPayload?.declines);
  const positive = (niftyPct ?? 0) > 0 && (bankPct ?? 0) >= 0;
  let confidenceAdjustment = 'no change';
  let confidenceNote = 'Pre-open not used.';
  let cautiousNeutral = false;
  if (isWithinWindow) {
    if (positive && breadthStyle === 'broad-based') {
      confidenceAdjustment = 'upgrade';
      confidenceNote = 'Broad-based positive pre-open supports a higher opening confidence.';
    } else if (positive && /concentrated|mixed/.test(breadthStyle)) {
      confidenceAdjustment = 'downgrade';
      confidenceNote = 'Positive but narrow pre-open breadth keeps the stance cautious before the open.';
      cautiousNeutral = true;
    } else if ((niftyPct ?? 0) < 0 || (bankPct ?? 0) < 0) {
      confidenceAdjustment = 'downgrade';
      confidenceNote = 'Weak pre-open tone reduces confidence before 9:15 IST.';
    }
  }
  return {
    available: isWithinWindow,
    timestamp: isWithinWindow ? timestamp : null,
    niftyIndicative,
    niftyPct,
    niftyGap: classifyPreOpenGap(niftyPct),
    bankIndicative,
    bankPct,
    bankGap: classifyPreOpenGap(bankPct),
    expectedOpenNote:
      niftyIndicative !== null && bankIndicative !== null
        ? `Nifty ${classifyPreOpenGap(niftyPct)}, Bank Nifty ${classifyPreOpenGap(bankPct)} vs previous close`
        : 'not available',
    topGainers,
    topLosers,
    advances: toNumber(allPayload?.advances),
    declines: toNumber(allPayload?.declines),
    unchanged: toNumber(allPayload?.unchanged),
    breadthStyle,
    confidenceAdjustment,
    confidenceNote,
    cautiousNeutral,
  };
}

function getNseIndexRow(rows, name) {
  return rows.find((row) => String(row.index || '').toUpperCase() === name.toUpperCase()) || null;
}

function readNseIndexSnapshot(row) {
  if (!row) {
    return {
      level: null,
      pctChange: null,
      change: null,
      previousClose: null,
      open: null,
      high: null,
      low: null,
      advances: null,
      declines: null,
    };
  }
  return {
    level: toNumber(row.last),
    pctChange: toNumber(row.percentChange),
    change: toNumber(row.variation),
    previousClose: toNumber(row.previousClose || row.previousDayVal),
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    advances: toNumber(row.advances),
    declines: toNumber(row.declines),
  };
}

function parseAdvanceDeclineFromJson(payload) {
  const stack = [payload];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current && typeof current === 'object') {
      const advances = toNumber(current.advances || current.advance || current.adv);
      const declines = toNumber(current.declines || current.decline || current.dec);
      if (advances !== null && declines !== null && declines !== 0) {
        return { ratio: round(advances / declines, 2) };
      }
      stack.push(...Object.values(current));
    }
  }
  return { ratio: null };
}

function parseAdvanceDeclineFromHtml(html) {
  const advances = extractFirstNumber(html, /Advances?[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)/i);
  const declines = extractFirstNumber(html, /Declines?[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)/i);
  if (advances !== null && declines !== null && declines !== 0) {
    return { ratio: round(advances / declines, 2) };
  }
  return {
    ratio: extractFirstNumber(html, /Advance[^A-Za-z0-9]{0,20}Decline[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)/i),
  };
}

async function fetchAdvanceDecline() {
  for (const url of [CONFIG.urls.nseMarketStatus, CONFIG.urls.nseAllIndices]) {
    try {
      const parsed = parseAdvanceDeclineFromJson(await fetchNseJson(url));
      if (parsed.ratio !== null) {
        return parsed;
      }
    } catch (error) {
      console.error('Advance/decline JSON fetch failed:', error.message);
    }
  }

  for (const url of [CONFIG.urls.nseBreadthPage, CONFIG.urls.marketNews]) {
    try {
      const parsed = parseAdvanceDeclineFromHtml(await fetchTextWithRetry(url, { redirect: 'follow' }));
      if (parsed.ratio !== null) {
        return parsed;
      }
    } catch (error) {
      console.error('Advance/decline HTML fetch failed:', error.message);
    }
  }

  throw new Error('Unable to parse advance/decline');
}

async function fetchFiiDii() {
  const html = await fetchTextWithCurl(CONFIG.urls.fiiDii);
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    throw new Error('Missing __NEXT_DATA__');
  }
  const payload = JSON.parse(match[1]);
  const latest = payload?.props?.pageProps?.FiiDiiData?.fiiDiiData?.[0];
  if (!latest) {
    throw new Error('Missing latest FII/DII row');
  }
  return {
    fiiNet: toNumber(latest.fiiNet),
    diiNet: toNumber(latest.diiNet),
  };
}

function extractRssItems(rss, limit = 10) {
  const items = [];
  const regex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/gi;
  let match;
  while ((match = regex.exec(rss)) && items.length < limit) {
    const title = decodeHtmlEntities(match[1]).replace(/\s*-\s*[^-]+$/, '').trim();
    const link = decodeHtmlEntities(match[2]).trim();
    if (title && link) {
      items.push({ title, link });
    }
  }
  return items;
}

async function fetchHeadline() {
  try {
    const rss = await fetchTextWithRetry(CONFIG.urls.googleNewsIndia, { redirect: 'follow' });
    const items = extractRssItems(rss);
    if (items.length) {
      return {
        headline: items[0].title,
        headlines: items,
      };
    }
  } catch (error) {
    console.error('RSS headline fetch failed:', error.message);
  }

  const html = await fetchTextWithRetry(CONFIG.urls.marketNews, { redirect: 'follow' });
  const match =
    html.match(/<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) ||
    html.match(/<h3[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) ||
    html.match(/<title>([^<]+)<\/title>/i);

  return {
    headline: match?.[1] ? decodeHtmlEntities(match[1]).trim() : '',
    headlines: match?.[1]
      ? [{ title: decodeHtmlEntities(match[1]).trim(), link: CONFIG.urls.marketNews }]
      : [],
  };
}

async function fetchRssHeadlines(url, limit = 6) {
  const rss = await fetchTextWithRetry(url, { redirect: 'follow' });
  return extractRssItems(rss, limit);
}

function inferUsExtendedKind() {
  const { weekday, hour, minute } = getTimePartsInZone(new Date(), 'America/New_York');
  if (weekday === 'Sat' || weekday === 'Sun') {
    return 'After-hours';
  }
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 9 * 60 + 30) {
    return 'Pre-market';
  }
  return 'After-hours';
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
      // Ignore malformed or unrelated callback chunks and keep scanning.
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
      dayRange: '',
    };
  }

  return null;
}

async function fetchGoogleFinanceQuote(symbol) {
  const url = `${CONFIG.urls.googleFinanceQuote}${encodeURIComponent(symbol)}`;
  const html = await fetchTextWithRetry(url, { redirect: 'follow' });
  const structuredQuote = parseGoogleFinanceStructuredQuote(html, symbol);
  let price = extractFirstNumber(html, /data-last-price="([^"]+)"/i);
  let previousClose = extractFirstNumber(
    html,
    /Previous close<\/div>[\s\S]{0,400}?<div class="P6K39c">\$?([0-9,]+(?:\.\d+)?)/i,
  );
  const dayRangeMatch = html.match(/Day range<\/div><div[^>]*class="P6K39c"[^>]*>([^<]+)<\/div>/i);
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const exchangeMatch = html.match(/data-exchange="([^"]+)"/i);
  const timestampMatch = html.match(/data-last-normal-market-timestamp="([^"]+)"/i);

  const extendedMatch = html.match(
    /(Pre-market|After-hours):[\s\S]*?<div class="YMlKec fxKbKc">\$?([0-9,]+(?:\.\d+)?)<\/div>[\s\S]*?<span[^>]*class="JwB6zf ([^"]+)"[^>]*>(?:[\s\S]*?<\/span>)?([0-9.]+%)<\/span>[\s\S]*?<span class="P2Luy [^"]+">([+-]?[0-9.,]+)/i,
  );
  const betaExtendedMatch = html.match(
    /<div class="B0rt4b">[\s\S]*?<div class="fpRuab">[\s\S]*?\$?([0-9,]+(?:\.\d+)?)<\/span>[\s\S]*?<span class="ougHge">([+\-−]?[0-9.]+%)<\/span>[\s\S]*?<span jsname="xnruHf" class=""><span>([+\-−]?[0-9.,]+)<\/span>[\s\S]*?<div class="bU8Fdf">[\s\S]*?(Pre-market|After-hours)<\/div>/i,
  );

  if (structuredQuote) {
    price = structuredQuote.price ?? price;
    previousClose = structuredQuote.previousClose ?? previousClose;
  }

  let regularPctChange = structuredQuote?.pctChange ?? computePercentChange(price, previousClose);
  let regularAbsChange = structuredQuote?.absChange ?? computeAbsoluteChange(price, previousClose);
  let extended = null;

  if (extendedMatch) {
    const kind = extendedMatch[1];
    const extendedPrice = toNumber(extendedMatch[2]);
    const className = extendedMatch[3];
    const pctMagnitude = toNumber(extendedMatch[4]);
    const absValue = toNumber(extendedMatch[5]);
    const sign = getSignFromClassName(className);
    extended = {
      kind,
      price: extendedPrice,
      pctChange: pctMagnitude === null ? null : round(sign * Math.abs(pctMagnitude), 4),
      absChange:
        absValue === null
          ? computeAbsoluteChange(extendedPrice, price)
          : round(Math.sign(absValue) === 0 ? sign * Math.abs(absValue) : absValue, 3),
    };
  } else if (betaExtendedMatch) {
    extended = {
      kind: betaExtendedMatch[4].replace('−', '-'),
      price: toNumber(betaExtendedMatch[1]),
      pctChange: toNumber(String(betaExtendedMatch[2]).replace('−', '-')),
      absChange: toNumber(String(betaExtendedMatch[3]).replace('−', '-')),
    };
  }

  if (structuredQuote) {
    extended =
      structuredQuote.extended && structuredQuote.extended.price !== null
        ? structuredQuote.extended
        : extended;
  }

  return {
    symbol: structuredQuote?.symbol || symbol,
    title: decodeHtmlEntities(titleMatch?.[1] || structuredQuote?.title || ''),
    exchange: exchangeMatch?.[1] || structuredQuote?.exchange || '',
    price,
    previousClose,
    pctChange: regularPctChange,
    absChange: regularAbsChange,
    timestamp: timestampMatch?.[1] ? Number(timestampMatch[1]) : structuredQuote?.timestamp ?? null,
    extended,
    dayRange: dayRangeMatch ? decodeHtmlEntities(dayRangeMatch[1]) : '',
  };
}

async function fetchGoogleFinanceQuoteCached(symbol) {
  return getCachedResource(quoteCache, symbol, QUOTE_CACHE_TTL_MS, () => fetchGoogleFinanceQuote(symbol));
}

async function fetchFredRows(url) {
  const csv = await fetchTextWithRetry(url, { redirect: 'follow' });
  const [headerLine, ...lines] = csv.trim().split('\n');
  const headers = headerLine.split(',');
  return lines.map((line) => {
    const parts = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = parts[index] ?? '';
    });
    return row;
  });
}

async function fetchFredRates() {
  const rows = await fetchFredRows(CONFIG.urls.fredUsRatesCsv);
  const valid = rows.filter((row) => toNumber(row.DGS10) !== null || toNumber(row.DGS2) !== null);
  const latest = valid.at(-1) || {};
  const previous10 = [...valid].reverse().find((row) => row !== latest && toNumber(row.DGS10) !== null) || {};
  const previous2 = [...valid].reverse().find((row) => row !== latest && toNumber(row.DGS2) !== null) || {};
  return {
    us10y: toNumber(latest.DGS10),
    us10yPrev: toNumber(previous10.DGS10),
    us2y: toNumber(latest.DGS2),
    us2yPrev: toNumber(previous2.DGS2),
  };
}

async function fetchFredDxy() {
  const rows = await fetchFredRows(CONFIG.urls.fredDxyCsv);
  const valid = rows.filter((row) => toNumber(row.DTWEXBGS) !== null);
  const latest = valid.at(-1) || {};
  const previous = valid.at(-2) || {};
  const value = toNumber(latest.DTWEXBGS);
  return {
    value,
    previous: toNumber(previous.DTWEXBGS),
    pctChange: computePercentChange(value, previous.DTWEXBGS),
  };
}

async function fetchTradingEconomicsMeta(url) {
  const html = await fetchTextWithRetry(url, { redirect: 'follow' });
  const title = decodeHtmlEntities((html.match(/<title>\s*([^<]+)\s*<\/title>/i) || [])[1] || '');
  const description = decodeHtmlEntities(
    (html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) || [])[1] || '',
  );
  return { title, description, html };
}

function parseTradingEconomicsQuote(description) {
  const value =
    extractFirstNumber(description, /(?:rose|fell|was|stood|closed|traded|exchange rate rose to|exchange rate fell to)\s+(?:to\s+)?([0-9,]+(?:\.\d+)?)/i) ||
    extractFirstNumber(description, /([0-9,]+(?:\.\d+)?)\s+on\s+[A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4}/i);
  const pctMagnitude =
    extractFirstNumber(description, /(?:up|down)\s+([0-9]+(?:\.\d+)?)%\s+from the previous/i) ||
    extractFirstNumber(description, /([+-]?\d+(?:\.\d+)?)%\s+from the previous/i);
  const direction = (description.match(/\b(up|down)\b\s+[0-9]+(?:\.\d+)?%\s+from the previous/i) || [])[1];
  const pctChange =
    pctMagnitude === null ? null : round((direction && direction.toLowerCase() === 'down' ? -1 : 1) * Math.abs(pctMagnitude), 2);
  return {
    value,
    pctChange,
  };
}

async function fetchUsDollarIndex() {
  const meta = await fetchTradingEconomicsMeta(CONFIG.urls.tradingEconomicsUsCurrency);
  const quote = parseTradingEconomicsQuote(meta.description);
  return {
    title: meta.title,
    value: quote.value,
    pctChange: quote.pctChange,
  };
}

async function fetchTradingEconomicsCommodity(url) {
  const meta = await fetchTradingEconomicsMeta(url);
  const quote = parseTradingEconomicsQuote(meta.description);
  return {
    title: meta.title,
    value: quote.value,
    pctChange: quote.pctChange,
  };
}

async function fetchIndiaBondYield() {
  const meta = await fetchTradingEconomicsMeta('https://tradingeconomics.com/india/government-bond-yield');
  const value =
    extractFirstNumber(meta.description, /India 10Y Bond Yield (?:eased|rose|fell|stood|was)\s+to\s+([0-9.]+)%/i) ||
    extractFirstNumber(meta.description, /yield on India 10Y Bond Yield [^0-9]*([0-9.]+)%/i);
  const pctPointChange = extractFirstNumber(meta.description, /([0-9.]+)\s+percentage points\s+(?:decrease|increase)/i);
  const direction = (meta.description.match(/\b(decrease|increase)\b/) || [])[1];
  const bpChange =
    pctPointChange === null ? null : round((direction === 'decrease' ? -1 : 1) * pctPointChange * 100, 1);
  return {
    value,
    bpChange,
  };
}

function classifyIndiaSectorLeadership(sectorRows) {
  const sorted = [...sectorRows]
    .filter((row) => toNumber(row.pctChange) !== null)
    .sort((a, b) => (toNumber(b.pctChange) ?? -999) - (toNumber(a.pctChange) ?? -999));
  const leaders = sorted.slice(0, 3).map((row) => row.key);
  const positiveCount = sectorRows.filter((row) => toNumber(row.pctChange) !== null && toNumber(row.pctChange) > 0).length;
  if (positiveCount >= 6) {
    return 'Broad-based';
  }
  if (leaders.includes('Nifty Bank') || leaders.includes('Nifty PSU Bank')) {
    return 'Banks-led';
  }
  if (leaders.includes('Nifty IT')) {
    return 'IT-led';
  }
  if (leaders.filter((item) => ['Nifty FMCG', 'Nifty Pharma'].includes(item)).length >= 2) {
    return 'Defensives-led';
  }
  if (leaders.filter((item) => ['Nifty Auto', 'Nifty Energy', 'Nifty Metal'].includes(item)).length >= 2) {
    return 'Cyclical-led';
  }
  return 'Mixed';
}

function classifyIndiaVixDirection(value, change) {
  const c = toNumber(change);
  const v = toNumber(value);
  if (c !== null) {
    if (c > 0) {
      return 'rising';
    }
    if (c < 0) {
      return 'falling';
    }
  }
  if (v !== null && v < 16) {
    return 'falling';
  }
  return 'flat';
}

function classifyUsStrength(movePct) {
  const value = toNumber(movePct);
  if (value === null) {
    return 'not available';
  }
  if (value <= -1) {
    return 'weak';
  }
  if (value < -0.2) {
    return 'red';
  }
  if (value < 0.2) {
    return 'flat';
  }
  return 'green';
}

async function fetchUsCalendar() {
  const html = await fetchTextWithRetry(CONFIG.urls.tradingEconomicsCalendar, { redirect: 'follow' });
  const rows = [];
  for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = match[1];
    const text = compactWhitespace(
      decodeHtmlEntities(
        rowHtml
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<\/(td|th|span|a|div)>/gi, ' ')
          .replace(/<[^>]+>/g, ' '),
      ),
    );
    if (!text) {
      continue;
    }
    if ((/\bUS\b/.test(text) || /United States/i.test(text)) && /^\d{1,2}:\d{2}\s+[AP]M/.test(text)) {
      const normalized = text.replace(/\bUnited States\b/g, 'US').trim();
      const detail = normalized.replace(/^\d{1,2}:\d{2}\s+[AP]M\s+US\s*/, '').trim();
      if (detail.length > 4) {
        rows.push(normalized);
      }
    }
  }

  const cleaned = rows.slice(0, 16);

  const highImpact = cleaned.filter((row) =>
    /(CPI|PPI|Retail Sales|Initial Jobless Claims|Non Farm Payrolls|FOMC|Fed|Treasury|Auction|GDP|PMI|Consumer Confidence|Housing)/i.test(
      row,
    ),
  );

  return {
    pending: highImpact.slice(0, 5),
    all: cleaned.slice(0, 8),
  };
}

function toUnixTimestamp(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function classifyFinnhubSentiment(score) {
  const value = toNumber(score);
  if (value === null) {
    return 'unclear';
  }
  if (value >= 0.15) {
    return 'bullish';
  }
  if (value <= -0.15) {
    return 'bearish';
  }
  return 'mixed';
}

function summarizeFinnhubNews(items) {
  const scores = (Array.isArray(items) ? items : [])
    .map((item) => toNumber(item.sentiment ?? item.overall_sentiment_score))
    .filter((value) => value !== null);
  if (!scores.length) {
    return {
      averageScore: null,
      label: 'unclear',
      positiveCount: 0,
      negativeCount: 0,
    };
  }
  const averageScore = round(scores.reduce((sum, value) => sum + value, 0) / scores.length, 3);
  return {
    averageScore,
    label: classifyFinnhubSentiment(averageScore),
    positiveCount: scores.filter((value) => value > 0.15).length,
    negativeCount: scores.filter((value) => value < -0.15).length,
  };
}

async function fetchFinnhubQuote(symbol) {
  const [quote, profile] = await Promise.all([
    fetchFinnhubJson('/quote', { symbol }),
    fetchFinnhubJson('/stock/profile2', { symbol }).catch(() => ({})),
  ]);
  const price = toNumber(quote.c);
  const previousClose = toNumber(quote.pc);
  return {
    symbol,
    title: typeof profile.name === 'string' ? profile.name : '',
    exchange: typeof profile.exchange === 'string' ? profile.exchange : '',
    price,
    previousClose,
    pctChange: computePercentChange(price, previousClose),
    absChange: computeAbsoluteChange(price, previousClose),
    timestamp: toNumber(quote.t),
    extended: null,
    dayRange:
      toNumber(quote.l) !== null && toNumber(quote.h) !== null
        ? `${round(toNumber(quote.l), 2)} - ${round(toNumber(quote.h), 2)}`
        : '',
    open: toNumber(quote.o),
    high: toNumber(quote.h),
    low: toNumber(quote.l),
  };
}

function normalizeUsEquityQuotePayload(symbol, quote = {}, source = '') {
  const normalizedSymbol = String(quote.symbol || symbol || '').toUpperCase();
  const price = toNumber(quote.price);
  const previousClose = toNumber(quote.previousClose);
  return {
    symbol: normalizedSymbol,
    title: quote.title || quote.name || normalizedSymbol,
    exchange: quote.exchange || '',
    price,
    previousClose,
    pctChange: toNumber(quote.pctChange) ?? computePercentChange(price, previousClose),
    absChange: toNumber(quote.absChange) ?? computeAbsoluteChange(price, previousClose),
    timestamp: toNumber(quote.timestamp) ?? quote.timestamp ?? null,
    extended:
      quote.extended && toNumber(quote.extended.price) !== null
        ? quote.extended
        : null,
    dayRange: quote.dayRange || '',
    open: toNumber(quote.open),
    high: toNumber(quote.high),
    low: toNumber(quote.low),
    marketCap: toNumber(quote.marketCap),
    volume: toNumber(quote.volume),
    source,
  };
}

function pickYahooExtendedPrice(meta = {}, regularPrice = null) {
  const postMarketPrice = toNumber(meta.postMarketPrice);
  if (postMarketPrice !== null) {
    return {
      kind: 'After-hours',
      price: postMarketPrice,
      absChange: toNumber(meta.postMarketChange) ?? computeAbsoluteChange(postMarketPrice, regularPrice),
      pctChange: toNumber(meta.postMarketChangePercent) ?? computePercentChange(postMarketPrice, regularPrice),
      timestamp: toNumber(meta.postMarketTime),
    };
  }
  const preMarketPrice = toNumber(meta.preMarketPrice);
  if (preMarketPrice !== null) {
    return {
      kind: 'Pre-market',
      price: preMarketPrice,
      absChange: toNumber(meta.preMarketChange) ?? computeAbsoluteChange(preMarketPrice, regularPrice),
      pctChange: toNumber(meta.preMarketChangePercent) ?? computePercentChange(preMarketPrice, regularPrice),
      timestamp: toNumber(meta.preMarketTime),
    };
  }
  return null;
}

function readRawQuoteField(value) {
  if (value && typeof value === 'object' && 'raw' in value) {
    return toNumber(value.raw);
  }
  return toNumber(value);
}

export function parseYahooQuotePagePayload(html, symbol) {
  const ticker = String(symbol || '').trim().toUpperCase();
  if (!ticker || typeof html !== 'string' || !html.length) {
    return null;
  }
  const scriptMatches = [...html.matchAll(/<script[^>]*data-url="[^"]*"[^>]*data-ttl="[^"]*"[^>]*>(\{.*?\})<\/script>/gis)];
  for (const match of scriptMatches) {
    try {
      const outer = JSON.parse(decodeHtmlEntities(match[1]));
      const body = outer?.body;
      if (typeof body !== 'string' || !body.includes('"quoteResponse"') || !body.includes(`"symbol":"${ticker}"`)) {
        continue;
      }
      const parsedBody = JSON.parse(body);
      const result = Array.isArray(parsedBody?.quoteResponse?.result)
        ? parsedBody.quoteResponse.result.find((item) => String(item?.symbol || '').trim().toUpperCase() === ticker)
        : null;
      if (!result) continue;
      const regularPrice = readRawQuoteField(result.regularMarketPrice);
      const previousClose = readRawQuoteField(result.regularMarketPreviousClose) ?? readRawQuoteField(result.previousClose);
      const marketState = String(result.marketState || '').toUpperCase();
      const preMarketPrice = readRawQuoteField(result.preMarketPrice);
      const preMarketTime = readRawQuoteField(result.preMarketTime);
      const postMarketPrice = readRawQuoteField(result.postMarketPrice);
      const postMarketTime = readRawQuoteField(result.postMarketTime);
      const overnightMarketPrice = readRawQuoteField(result.overnightMarketPrice);
      const overnightMarketTime = readRawQuoteField(result.overnightMarketTime);
      let extended = null;
      if (marketState === 'PRE' && preMarketPrice !== null) {
        extended = {
          kind: 'Pre-market',
          price: preMarketPrice,
          absChange: readRawQuoteField(result.preMarketChange) ?? computeAbsoluteChange(preMarketPrice, regularPrice),
          pctChange: readRawQuoteField(result.preMarketChangePercent) ?? computePercentChange(preMarketPrice, regularPrice),
          timestamp: preMarketTime,
        };
      } else if (marketState === 'POST' && postMarketPrice !== null) {
        extended = {
          kind: 'After-hours',
          price: postMarketPrice,
          absChange: readRawQuoteField(result.postMarketChange) ?? computeAbsoluteChange(postMarketPrice, regularPrice),
          pctChange: readRawQuoteField(result.postMarketChangePercent) ?? computePercentChange(postMarketPrice, regularPrice),
          timestamp: postMarketTime,
        };
      } else if (overnightMarketPrice !== null) {
        extended = {
          kind: 'Overnight',
          price: overnightMarketPrice,
          absChange: readRawQuoteField(result.overnightMarketChange) ?? computeAbsoluteChange(overnightMarketPrice, regularPrice),
          pctChange: readRawQuoteField(result.overnightMarketChangePercent) ?? computePercentChange(overnightMarketPrice, regularPrice),
          timestamp: overnightMarketTime,
        };
      }
      const topLevelTimestamp = [preMarketTime, postMarketTime, overnightMarketTime, readRawQuoteField(result.regularMarketTime)]
        .filter((value) => value !== null)
        .sort((a, b) => b - a)[0] ?? null;
      return normalizeUsEquityQuotePayload(ticker, {
        symbol: result.symbol || ticker,
        title: result.longName || result.shortName || ticker,
        exchange: result.fullExchangeName || result.exchange || '',
        price: regularPrice,
        previousClose,
        pctChange: readRawQuoteField(result.regularMarketChangePercent) ?? computePercentChange(regularPrice, previousClose),
        absChange: readRawQuoteField(result.regularMarketChange) ?? computeAbsoluteChange(regularPrice, previousClose),
        timestamp: topLevelTimestamp,
        extended,
        dayRange: result.regularMarketDayRange?.fmt || '',
        open: readRawQuoteField(result.regularMarketOpen),
        high: readRawQuoteField(result.regularMarketDayHigh),
        low: readRawQuoteField(result.regularMarketDayLow),
        marketCap: readRawQuoteField(result.marketCap),
        volume: readRawQuoteField(result.regularMarketVolume),
      }, 'Yahoo Finance quote page');
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchYahooQuotePageDetails(symbol) {
  const ticker = String(symbol || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('Ticker is required');
  }
  const html = await fetchTextWithRetry(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`, { redirect: 'follow' });
  return parseYahooQuotePagePayload(html, ticker);
}

async function fetchIndMoneyUsEquityQuote(symbol) {
  const ticker = String(symbol || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('Ticker is required');
  }
  const payload = await withIndMoneyMcpCache(`us-quote:${ticker}`, async (provider) =>
    provider.getUsStocksDetails([ticker], ['market_stats', 'analyst', 'news']),
  );
  const details = normalizeMcpUsStockDetails(payload);
  const quote = details[ticker];
  if (!quote || toNumber(quote.price) === null) {
    throw new Error(`INDmoney MCP quote unavailable for ${ticker}`);
  }
  return normalizeUsEquityQuotePayload(ticker, {
    symbol: quote.symbol,
    title: quote.name,
    price: quote.price,
    previousClose: quote.previousClose,
    pctChange: quote.pctChange,
    absChange: quote.absChange,
    timestamp: quote.timestamp,
    marketCap: quote.marketCap,
    volume: quote.volume,
    exchange: 'INDmoney',
  }, quote.source || 'INDmoney MCP');
}

async function fetchYahooQuote(symbol) {
  const ticker = String(symbol || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('Ticker is required');
  }
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set('range', '1d');
  url.searchParams.set('interval', '1m');
  url.searchParams.set('includePrePost', 'true');
  url.searchParams.set('events', 'history');
  const payload = await fetchJsonWithRetry(url.toString(), { redirect: 'follow' });
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta || {};
  const quote = result?.indicators?.quote?.[0] || {};
  const closes = Array.isArray(quote.close) ? quote.close.map(toNumber).filter((value) => value !== null) : [];
  const highs = Array.isArray(quote.high) ? quote.high.map(toNumber).filter((value) => value !== null) : [];
  const lows = Array.isArray(quote.low) ? quote.low.map(toNumber).filter((value) => value !== null) : [];
  const price = toNumber(meta.regularMarketPrice) ?? closes.at(-1) ?? null;
  const previousClose = toNumber(meta.previousClose) ?? toNumber(meta.chartPreviousClose);
  if (price === null) {
    throw new Error(`Yahoo Finance quote unavailable for ${ticker}`);
  }
  const dayLow = toNumber(meta.regularMarketDayLow) ?? (lows.length ? Math.min(...lows) : null);
  const dayHigh = toNumber(meta.regularMarketDayHigh) ?? (highs.length ? Math.max(...highs) : null);
  const chartQuote = normalizeUsEquityQuotePayload(ticker, {
    symbol: meta.symbol || ticker,
    title: meta.longName || meta.shortName || ticker,
    exchange: meta.fullExchangeName || meta.exchangeName || meta.exchange || '',
    price,
    previousClose,
    pctChange: computePercentChange(price, previousClose),
    absChange: computeAbsoluteChange(price, previousClose),
    timestamp: toNumber(meta.regularMarketTime),
    extended: pickYahooExtendedPrice(meta, price),
    dayRange:
      dayLow !== null && dayHigh !== null
        ? `${round(dayLow, 2)} - ${round(dayHigh, 2)}`
        : '',
    open: toNumber(meta.regularMarketOpen) ?? toNumber(quote.open?.find((value) => toNumber(value) !== null)),
    high: dayHigh,
    low: dayLow,
    marketCap: toNumber(meta.marketCap),
    volume: toNumber(meta.regularMarketVolume),
  }, 'Yahoo Finance');
  if (chartQuote.extended) {
    return chartQuote;
  }
  try {
    const pageQuote = await fetchYahooQuotePageDetails(ticker);
    if (pageQuote) {
      return reconcileUsEquityQuoteSources(pageQuote, chartQuote);
    }
  } catch {}
  return chartQuote;
}

function mergeUsEquityQuoteSources(primaryQuote, fallbackQuote) {
  const primary = primaryQuote || {};
  const fallback = fallbackQuote || {};
  return {
    symbol: primary.symbol || fallback.symbol || '',
    title: primary.title || fallback.title || '',
    exchange: primary.exchange || fallback.exchange || '',
    price: toNumber(primary.price) ?? toNumber(fallback.price),
    previousClose: toNumber(primary.previousClose) ?? toNumber(fallback.previousClose),
    pctChange: toNumber(primary.pctChange) ?? toNumber(fallback.pctChange),
    absChange: toNumber(primary.absChange) ?? toNumber(fallback.absChange),
    timestamp: toNumber(primary.timestamp) ?? toNumber(fallback.timestamp),
    extended:
      primary.extended && toNumber(primary.extended.price) !== null
        ? primary.extended
        : fallback.extended && toNumber(fallback.extended.price) !== null
          ? fallback.extended
          : null,
    dayRange: primary.dayRange || fallback.dayRange || '',
    open: toNumber(primary.open) ?? toNumber(fallback.open),
    high: toNumber(primary.high) ?? toNumber(fallback.high),
    low: toNumber(primary.low) ?? toNumber(fallback.low),
    marketCap: toNumber(primary.marketCap) ?? toNumber(fallback.marketCap),
    volume: toNumber(primary.volume) ?? toNumber(fallback.volume),
    source: primary.source || fallback.source || '',
  };
}

export function reconcileUsEquityQuoteSources(primaryQuote, fallbackQuote) {
  const primary = primaryQuote || {};
  const fallback = fallbackQuote || {};
  const primaryTs = toNumber(primary.timestamp);
  const fallbackTs = toNumber(fallback.timestamp);
  const primaryDisplay = chooseDisplayMove(primary);
  const fallbackDisplay = chooseDisplayMove(fallback);
  const primaryDisplayPrice = toNumber(primaryDisplay?.lastPrice);
  const fallbackDisplayPrice = toNumber(fallbackDisplay?.lastPrice);

  let priceLeader = primary;
  let priceLeaderDisplay = primaryDisplay;
  if (fallbackDisplayPrice !== null) {
    if (primaryDisplayPrice === null) {
      priceLeader = fallback;
      priceLeaderDisplay = fallbackDisplay;
    } else if (fallbackTs !== null && (primaryTs === null || fallbackTs > primaryTs)) {
      priceLeader = fallback;
      priceLeaderDisplay = fallbackDisplay;
    } else if (primaryDisplayPrice !== null && primaryTs !== null && fallbackTs !== null && fallbackTs === primaryTs) {
      const fallbackBasis = String(fallbackDisplay?.basis || '').toLowerCase();
      const primaryBasis = String(primaryDisplay?.basis || '').toLowerCase();
      const fallbackIsExtended = fallbackBasis.includes('pre') || fallbackBasis.includes('post') || fallbackBasis.includes('after');
      const primaryIsExtended = primaryBasis.includes('pre') || primaryBasis.includes('post') || primaryBasis.includes('after');
      if (fallbackIsExtended && !primaryIsExtended) {
        priceLeader = fallback;
        priceLeaderDisplay = fallbackDisplay;
      }
    }
  }

  const merged = mergeUsEquityQuoteSources(primary, fallback);
  return {
    ...merged,
    price: toNumber(priceLeader?.price) ?? merged.price,
    previousClose: toNumber(priceLeader?.previousClose) ?? merged.previousClose,
    pctChange: toNumber(priceLeaderDisplay?.movePct) ?? toNumber(priceLeader?.pctChange) ?? merged.pctChange,
    absChange: toNumber(priceLeaderDisplay?.moveAbs) ?? toNumber(priceLeader?.absChange) ?? merged.absChange,
    timestamp: toNumber(priceLeader?.timestamp) ?? merged.timestamp,
    extended:
      priceLeader?.extended && toNumber(priceLeader.extended.price) !== null
        ? priceLeader.extended
        : merged.extended,
    source: priceLeader?.source || merged.source,
  };
}

async function fetchUsEquityQuote(symbol) {
  const ticker = String(symbol || '').trim().toUpperCase();
  const sourcePriority = String(CONFIG.indMoneyMcpSourcePriority || 'mcp_first').toLowerCase();
  const attempts = sourcePriority === 'yahoo_first'
    ? [
      ['Yahoo Finance', () => fetchYahooQuote(ticker)],
      ['INDmoney MCP', () => fetchIndMoneyUsEquityQuote(ticker)],
    ]
    : [
      ['INDmoney MCP', () => fetchIndMoneyUsEquityQuote(ticker)],
      ['Yahoo Finance', () => fetchYahooQuote(ticker)],
    ];
  const errors = [];
  const quotes = [];
  for (const [source, loader] of attempts) {
    try {
      const quote = await loader();
      if (toNumber(quote?.price) !== null || toNumber(quote?.extended?.price) !== null) {
        quotes.push(quote);
        continue;
      }
      errors.push(`${source}: empty price`);
    } catch (error) {
      errors.push(`${source}: ${error.message}`);
    }
  }
  if (quotes.length >= 2) {
    return reconcileUsEquityQuoteSources(quotes[0], quotes[1]);
  }
  if (quotes.length === 1) {
    return quotes[0];
  }
  throw new Error(`Failed to fetch quote for ${ticker}. ${errors.join(' | ')}`);
}

async function fetchUsEquityQuoteCached(symbol) {
  return getCachedResource(quoteCache, `us-equity::${symbol}`, QUOTE_CACHE_TTL_MS, () => fetchUsEquityQuote(symbol));
}

async function fetchFinnhubCompanyNews(symbol, fromDate = isoDateDaysAgo(14), toDate = new Date().toISOString().slice(0, 10)) {
  const payload = await fetchFinnhubJson('/company-news', {
    symbol,
    from: fromDate,
    to: toDate,
  });
  return (Array.isArray(payload) ? payload : []).map((item) => ({
    title: item.headline || '',
    summary: item.summary || '',
    sentiment: toNumber(item.sentiment),
    source: item.source || '',
    time_published: item.datetime ? new Date(item.datetime * 1000).toISOString() : '',
    url: item.url || '',
  }));
}

async function fetchTickerHeadlines(ticker, name = '') {
  try {
    const items = await fetchFinnhubCompanyNews(ticker);
    if (items.length) {
      return items.slice(0, 3);
    }
  } catch {}
  try {
    const query = name ? `${name} OR ${ticker} stock` : `${ticker} stock`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    return await fetchRssHeadlines(url, 3);
  } catch {
    return [];
  }
}

async function fetchTickerCatalyst(ticker) {
  try {
    const items = await fetchTickerHeadlines(ticker);
    return items[0]?.title || 'no clear catalyst';
  } catch {
    return 'no clear catalyst';
  }
}

function getUsSymbolForTicker(ticker) {
  return (
    CONFIG.usSymbols.portfolio?.[ticker] ||
    CONFIG.usSymbols.watchlist?.[ticker] ||
    CONFIG.usSymbols.sectors?.[ticker] ||
    `${ticker}:NASDAQ`
  );
}

async function fetchTickerHeadlinesCached(ticker, name = '') {
  const key = `${ticker}::${name}`;
  return getCachedResource(headlineCache, key, HEADLINE_CACHE_TTL_MS, () => fetchTickerHeadlines(ticker, name));
}

function chooseDisplayMove(quote) {
  if (!isUsRegularSession() && quote?.extended?.pctChange !== null && quote?.extended?.pctChange !== undefined) {
    return {
      movePct: quote.extended.pctChange,
      moveAbs: quote.extended.absChange,
      lastPrice: quote.extended.price ?? quote.price,
      basis: quote.extended.kind,
    };
  }
  return {
    movePct: quote?.pctChange ?? null,
    moveAbs: quote?.absChange ?? null,
    lastPrice: quote?.price ?? null,
    basis: 'regular',
  };
}

function classifyVolatility(vixPctChange, vixValue) {
  const pct = toNumber(vixPctChange);
  const spot = toNumber(vixValue);
  if (pct !== null) {
    if (pct >= 1.5) {
      return 'rising';
    }
    if (pct <= -1.5) {
      return 'falling';
    }
  }
  if (spot !== null && spot < 20) {
    return 'falling';
  }
  return 'flat';
}

function classifyLeadershipStyle(sectors) {
  const leaderSymbols = sectors.slice(0, 3).map((sector) => sector.symbol);
  const positiveCount = sectors.filter((sector) => toNumber(sector.movePct) !== null && toNumber(sector.movePct) > 0).length;
  if (positiveCount >= 8) {
    return 'broad-based';
  }
  if (leaderSymbols.includes('XLK') || leaderSymbols.includes('XLC')) {
    return 'tech-led';
  }
  if (leaderSymbols.includes('XLF')) {
    return 'financials-led';
  }
  if (leaderSymbols.includes('XLE')) {
    return 'energy-led';
  }
  if (leaderSymbols.filter((symbol) => ['XLP', 'XLU', 'XLV'].includes(symbol)).length >= 2) {
    return 'defensives-led';
  }
  return 'mixed';
}

function classifySemiBreadth(semis) {
  const values = ['SOX', 'SMH', 'AVGO', 'QCOM', 'AMD', 'NVDA', 'MU']
    .map((symbol) => toNumber(semis?.[symbol]?.movePct))
    .filter((value) => value !== null);
  if (!values.length) {
    return 'not available';
  }
  const positive = values.filter((value) => value > 0).length;
  if (positive >= 5) {
    return 'strong';
  }
  if (positive <= 2) {
    return 'weak';
  }
  return 'mixed';
}

function classifyUsBreadthWeak(breadth) {
  const nyse = toNumber(breadth?.nyseAdvanceDecline);
  const nasdaq = toNumber(breadth?.nasdaqAdvanceDecline);
  const sectorsGreen = toNumber(breadth?.sectorsPositivePercent);
  return (
    (nyse !== null && nyse < 1) ||
    (nasdaq !== null && nasdaq < 1) ||
    (sectorsGreen !== null && sectorsGreen < 45)
  );
}

function computeGlobalConfidence({ breadthConfirmed, semisConfirmed, vwapConfirmed, usableSignals, scoreMagnitude }) {
  let confidence = 'Low';
  if (usableSignals >= 8 || scoreMagnitude >= 6) {
    confidence = 'Medium';
  }
  if (usableSignals >= 10 || scoreMagnitude >= 8) {
    confidence = 'High';
  }
  if (breadthConfirmed && semisConfirmed && vwapConfirmed) {
    confidence = confidence === 'Low' ? 'Medium' : 'High';
  }
  return confidence;
}

function buildIndiaSummaryLine(snapshot) {
  const parts = [];
  if (snapshot.session === 'pre-open' && snapshot.preOpen?.available) {
    parts.push(`pre-open ${snapshot.preOpen.expectedOpenNote}`);
    parts.push(snapshot.preOpen.breadthStyle || 'not available');
  }
  if (toNumber(snapshot.giftNiftyPct) !== null) {
    parts.push(`GIFT ${snapshot.giftNiftyPct >= 0 ? 'supports' : 'pressures'} the open`);
  }
  if (toNumber(snapshot.advanceDecline) !== null) {
    parts.push(`A/D ${round(snapshot.advanceDecline, 2)}`);
  }
  if (snapshot.sectorLeadershipStyle) {
    parts.push(snapshot.sectorLeadershipStyle);
  }
  if (toNumber(snapshot.fiiNet) !== null) {
    parts.push(`FII ${snapshot.fiiNet >= 0 ? 'buying' : 'selling'}`);
  }
  return parts.length ? parts.join('; ') : 'not available';
}

function buildUsSummaryLine(snapshot) {
  const parts = [];
  if (toNumber(snapshot?.macro?.spFuturesPct) !== null && toNumber(snapshot?.macro?.nasdaqFuturesPct) !== null) {
    parts.push(snapshot.macro.spFuturesPct >= 0 && snapshot.macro.nasdaqFuturesPct >= 0 ? 'futures firm' : 'futures mixed');
  }
  if (snapshot?.semiconductors?.breadthLabel && snapshot.semiconductors.breadthLabel !== 'not available') {
    parts.push(`semis ${snapshot.semiconductors.breadthLabel}`);
  }
  if (snapshot?.sectorLeadership?.leadershipStyle) {
    parts.push(snapshot.sectorLeadership.leadershipStyle);
  }
  if (toNumber(snapshot?.breadth?.sectorsPositivePercent) !== null) {
    parts.push(`${round(snapshot.breadth.sectorsPositivePercent, 0)}% sectors green`);
  }
  return parts.length ? parts.join('; ') : 'not available';
}

function displayOrNA(value) {
  return value === null || value === undefined || value === '' ? 'not available' : value;
}

function formatValue(value, digits = 2, suffix = '') {
  const number = toNumber(value);
  if (number === null) {
    return 'not available';
  }
  return `${round(number, digits).toFixed(digits)}${suffix}`;
}

function formatSignedValue(value, digits = 2, suffix = '') {
  const number = toNumber(value);
  if (number === null) {
    return 'not available';
  }
  return `${number > 0 ? '+' : ''}${round(number, digits).toFixed(digits)}${suffix}`;
}

function formatInteger(value) {
  const number = toNumber(value);
  if (number === null) {
    return 'not available';
  }
  return String(Math.round(number));
}

function roundIfNumber(value, digits = 2) {
  const number = toNumber(value);
  return number === null ? null : round(number, digits);
}

function formatPortfolioMoney(value) {
  const number = toNumber(value);
  if (number === null) {
    return 'not available';
  }
  return `${number < 0 ? '-$' : '$'}${Math.abs(round(number, 2)).toFixed(2)}`;
}

function hydrateUsPortfolio(portfolio, usSnapshot) {
  if (!portfolio || !Array.isArray(portfolio.holdings)) {
    return null;
  }

  const watchlist = Array.isArray(usSnapshot?.watchlist) ? usSnapshot.watchlist : [];
  const liveRows = Object.fromEntries(
    watchlist
      .filter((item) => item?.ticker)
      .map((item) => [item.ticker, item]),
  );

  const holdings = portfolio.holdings.map((holding) => {
    const liveRow = liveRows[holding.ticker] || null;
    const quantity = toNumber(holding.quantity);
    const invested = toNumber(holding.invested);
    const livePrice = toNumber(liveRow?.lastPrice) ?? toNumber(holding.lastPrice);
    const regularPrice = toNumber(liveRow?.regularPrice) ?? toNumber(holding.regularPrice) ?? toNumber(holding.lastPrice);
    const extendedPrice = toNumber(liveRow?.extendedPrice) ?? toNumber(holding.extendedPrice) ?? livePrice;
    const regularValue = quantity !== null && regularPrice !== null ? round(quantity * regularPrice, 2) : null;
    const extendedValue = quantity !== null && extendedPrice !== null ? round(quantity * extendedPrice, 2) : null;
    const currentValue = quantity !== null && livePrice !== null ? round(quantity * livePrice, 2) : toNumber(holding.currentValue);
    const totalReturn = currentValue !== null && invested !== null ? round(currentValue - invested, 2) : toNumber(holding.totalReturn);
    const totalReturnPct =
      totalReturn !== null && invested !== null && invested !== 0 ? round((totalReturn / invested) * 100, 2) : toNumber(holding.totalReturnPct);

    return {
      ...holding,
      livePrice: livePrice ?? null,
      regularPrice: regularPrice ?? null,
      extendedPrice: extendedPrice ?? null,
      previousClose: toNumber(liveRow?.previousClose) ?? toNumber(holding.previousClose),
      regularValue: regularValue ?? null,
      extendedValue: extendedValue ?? null,
      regularReturn: regularValue !== null && invested !== null ? round(regularValue - invested, 2) : null,
      extendedReturn: extendedValue !== null && invested !== null ? round(extendedValue - invested, 2) : null,
      extendedImpact: regularValue !== null && extendedValue !== null ? round(extendedValue - regularValue, 2) : null,
      currentValue: currentValue ?? null,
      totalReturn: totalReturn ?? null,
      totalReturnPct: totalReturnPct ?? null,
      movePct: toNumber(liveRow?.movePct) ?? toNumber(holding.movePct),
      moveBasis: liveRow?.moveBasis || holding.moveBasis || 'Imported',
      regularMovePct: toNumber(liveRow?.regularMovePct) ?? toNumber(holding.regularMovePct),
      extendedMovePct: toNumber(liveRow?.extendedMovePct) ?? toNumber(holding.extendedMovePct),
      strength: liveRow?.strength || holding.strength || 'not available',
      note: liveRow?.note || holding.note || '',
    };
  });

  const investedValue = holdings.reduce((sum, holding) => sum + (toNumber(holding.invested) || 0), 0);
  const portfolioValue = holdings.reduce((sum, holding) => sum + (toNumber(holding.currentValue) || 0), 0);
  const totalReturns = round(portfolioValue - investedValue, 2);
  const totalReturnsPct = investedValue ? round((totalReturns / investedValue) * 100, 2) : null;

  return {
    ...portfolio,
    holdings,
    summary: {
      ...portfolio.summary,
      holdingsCount: holdings.length,
      investedValue: round(investedValue, 2),
      portfolioValue: round(portfolioValue, 2),
      totalReturns,
      totalReturnsPct,
    },
  };
}

function isSemiTicker(ticker) {
  return ['MU', 'NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'SMH', 'SOX'].includes(String(ticker || '').toUpperCase());
}

function scoreHeadlineSignal(headline) {
  const text = String(headline?.title || '').toLowerCase();
  if (!text) {
    return {
      score: 0,
      credibility: 'low',
      eventRisk: false,
      speculative: false,
    };
  }

  let score = 0;
  let eventRisk = false;
  let speculative = false;

  const bullishPatterns = [
    /beats?/,
    /raised? guidance/,
    /guidance raised/,
    /upgrade/,
    /surge/,
    /strong demand/,
    /record/,
    /expands?/,
    /wins?/,
    /partnership/,
  ];
  const bearishPatterns = [
    /miss(es|ed)?/,
    /cuts? guidance/,
    /guidance cut/,
    /downgrade/,
    /investigation/,
    /lawsuit/,
    /probe/,
    /decline/,
    /falls?/,
    /warns?/,
    /delay/,
    /weak demand/,
  ];
  const eventRiskPatterns = [
    /earnings/,
    /fed/,
    /fomc/,
    /powell/,
    /cpi/,
    /ppi/,
    /tariff/,
    /export/,
    /ban/,
    /regulation/,
    /guidance/,
    /forecast/,
  ];
  const speculativePatterns = [
    /rumou?r/,
    /could/,
    /may/,
    /might/,
    /possible/,
    /reportedly/,
    /unconfirmed/,
    /speculation/,
  ];

  bullishPatterns.forEach((pattern) => {
    if (pattern.test(text)) {
      score += 1;
    }
  });
  bearishPatterns.forEach((pattern) => {
    if (pattern.test(text)) {
      score -= 1;
    }
  });
  eventRiskPatterns.forEach((pattern) => {
    if (pattern.test(text)) {
      eventRisk = true;
    }
  });
  speculativePatterns.forEach((pattern) => {
    if (pattern.test(text)) {
      speculative = true;
    }
  });

  return {
    score,
    credibility: speculative ? 'low' : eventRisk || Math.abs(score) >= 2 ? 'high' : 'medium',
    eventRisk,
    speculative,
  };
}

function summarizeHeadlineSignals(headlines) {
  const items = Array.isArray(headlines) ? headlines.slice(0, 3).map(scoreHeadlineSignal) : [];
  const score = items.reduce((sum, item) => sum + item.score, 0);
  const bullishCount = items.filter((item) => item.score > 0).length;
  const bearishCount = items.filter((item) => item.score < 0).length;
  const eventRiskCount = items.filter((item) => item.eventRisk).length;
  const lowCredibilityCount = items.filter((item) => item.credibility === 'low').length;

  return {
    score,
    bullishCount,
    bearishCount,
    eventRiskCount,
    lowCredibilityCount,
    credibility: eventRiskCount ? 'high' : bullishCount || bearishCount ? 'medium' : 'low',
  };
}

function computeHoldingNewsScore(holding, headlines) {
  const summary = summarizeHeadlineSignals(headlines);
  let score = 0;

  if (summary.score >= 2) {
    score += 1;
  } else if (summary.score <= -2) {
    score -= 2;
  } else if (summary.score < 0) {
    score -= 1;
  }

  if (summary.eventRiskCount >= 2) {
    score -= 1;
  }
  if (summary.lowCredibilityCount >= 2) {
    score -= 1;
  }
  if (holding.catalyst && /earnings|guidance|fed|cpi|tariff|export/i.test(holding.catalyst)) {
    score -= 1;
  }

  return {
    score,
    summary,
  };
}

function computeOvernightRisk(holding, usSnapshot, newsSummary) {
  let score = 0;
  const reasons = [];
  const movePct = toNumber(holding.movePct);
  const totalReturnPct = toNumber(holding.totalReturnPct);
  const oneDayReturnPct = toNumber(holding.oneDayReturnPct);
  const session = getUsSessionLabel();

  if (usSnapshot?.regime === 'US RISK-OFF') {
    score += 2;
    reasons.push('US macro regime is risk-off.');
  }
  if (isSemiTicker(holding.ticker) && usSnapshot?.semiconductors?.breadthLabel === 'weak') {
    score += 2;
    reasons.push('Semiconductor breadth is weak.');
  }
  if (newsSummary.eventRiskCount >= 1) {
    score += 1;
    reasons.push('Fresh headline flow includes event-driven risk.');
  }
  if (newsSummary.lowCredibilityCount >= 2) {
    score += 1;
    reasons.push('Headline mix includes speculative or low-credibility items.');
  }
  if (holding.moveBasis !== 'regular') {
    score += 1;
    reasons.push(`Trading signal is leaning on ${holding.moveBasis} liquidity.`);
  }
  if (movePct !== null && movePct >= 3) {
    score += 1;
    reasons.push('Name is extended on the day, which raises overnight gap risk.');
  }
  if (movePct !== null && movePct <= -2) {
    score += 1;
    reasons.push('Name is already under pressure today.');
  }
  if (totalReturnPct !== null && totalReturnPct >= 12 && movePct !== null && movePct < 0.2) {
    score += 1;
    reasons.push('Open profit is meaningful, but momentum has cooled.');
  }
  if (oneDayReturnPct !== null && oneDayReturnPct <= -2) {
    score += 1;
    reasons.push('One-day damage is large enough to respect overnight downside.');
  }
  if (session === 'near close' && movePct !== null && movePct <= 0) {
    score += 1;
    reasons.push('Weakness into the close raises carry risk.');
  }

  let level = 'low';
  if (score >= 5) {
    level = 'high';
  } else if (score >= 3) {
    level = 'medium';
  }

  return {
    score,
    level,
    reasons,
  };
}

function buildOvernightTradePlan(action, livePrice, movePct, regime, basis = 'regular') {
  const basePlan = buildTradePlan('HOLD', livePrice, movePct, regime, basis);

  if (action === 'BUY_TODAY') {
    return {
      ...buildTradePlan('BUY', livePrice, movePct, regime, basis),
      reviewWindow: 'Review near the close and again next US session.',
    };
  }

  if (action === 'REDUCE_BEFORE_CLOSE') {
    return {
      ...buildTradePlan('REDUCE', livePrice, movePct, regime, basis),
      reviewWindow: 'Trim before the closing bell. Reassess the remainder next session.',
    };
  }

  if (action === 'SELL_NEXT_SESSION') {
    return {
      ...buildTradePlan('SELL', livePrice, movePct, regime, basis),
      reviewWindow: 'Queue the exit for the next regular session instead of forcing an after-hours fill.',
    };
  }

  if (action === 'WATCH_ONLY') {
    return {
      entryPrice: null,
      exitPrice: null,
      stopLoss: basePlan.stopLoss,
      target1: null,
      target2: null,
      setup: 'Do not chase today. Wait for a cleaner next-session setup.',
      reviewWindow: 'Review on the next session open.',
    };
  }

  return {
    ...basePlan,
    reviewWindow: 'Hold overnight and review on the next session open.',
  };
}

function formatHoldingActionLabel(action) {
  if (action === 'BUY_TODAY') return 'Buy today for an overnight hold';
  if (action === 'REDUCE_BEFORE_CLOSE') return 'Trim before the close';
  if (action === 'SELL_NEXT_SESSION') return 'Sell next session';
  if (action === 'WATCH_ONLY') return 'Watch only today';
  return 'Hold overnight';
}

function buildAiCacheKey(holding, usSnapshot, baseRecommendation, headlines) {
  return JSON.stringify({
    v: 4,
    t: holding.ticker,
    p: roundIfNumber(holding.livePrice, 2),
    m: roundIfNumber(holding.movePct, 2),
    r: roundIfNumber(holding.totalReturnPct, 2),
    s: usSnapshot?.timestamp || '',
    h: (headlines || []).slice(0, 3).map((item) => item.title),
    a: baseRecommendation.action,
  });
}

function getAllowedAiActions(baseRecommendation) {
  const actions = new Set(['HOLD_OVERNIGHT', 'WATCH_ONLY']);
  if ((baseRecommendation?.score || 0) >= 3 && (baseRecommendation?.overnightRisk?.score || 99) <= 3) {
    actions.add('BUY_TODAY');
  }
  if ((baseRecommendation?.overnightRisk?.score || 0) >= 3 || (baseRecommendation?.score || 0) <= -2) {
    actions.add('REDUCE_BEFORE_CLOSE');
  }
  if ((baseRecommendation?.overnightRisk?.score || 0) >= 4 || (baseRecommendation?.score || 0) <= -4) {
    actions.add('SELL_NEXT_SESSION');
  }
  return [...actions];
}

function computeRsiSeries(values, period = 14) {
  const closes = (Array.isArray(values) ? values : []).map((item) => toNumber(item?.close)).filter((value) => value !== null);
  const points = [];
  if (closes.length <= period) {
    return points;
  }
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  points.push({ date: values[period].date, RSI: round(100 - 100 / (1 + firstRs), 2) });
  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    points.push({ date: values[index].date, RSI: round(100 - 100 / (1 + rs), 2) });
  }
  return points.slice(-15).reverse();
}

const CHART_INTERVALS = {
  m1: { label: 'M1', finnhub: '1', yahoo: '1m', defaultDays: 5, maxYahooDays: 7 },
  m5: { label: 'M5', finnhub: '5', yahoo: '5m', defaultDays: 30, maxYahooDays: 60 },
  m15: { label: 'M15', finnhub: '15', yahoo: '15m', defaultDays: 30, maxYahooDays: 60 },
  m30: { label: 'M30', finnhub: '30', yahoo: '30m', defaultDays: 60, maxYahooDays: 60 },
  h1: { label: 'H1', finnhub: '60', yahoo: '60m', defaultDays: 120, maxYahooDays: 730 },
  h2: { label: 'H2', finnhub: '120', yahoo: '60m', defaultDays: 180, maxYahooDays: 730, resampleHours: 2 },
  h4: { label: 'H4', finnhub: '240', yahoo: '60m', defaultDays: 180, maxYahooDays: 730, resampleHours: 4 },
  h6: { label: 'H6', finnhub: '360', yahoo: '60m', defaultDays: 240, maxYahooDays: 730, resampleHours: 6 },
  h12: { label: 'H12', finnhub: '720', yahoo: '60m', defaultDays: 365, maxYahooDays: 730, resampleHours: 12 },
  d1: { label: 'D1', finnhub: 'D', yahoo: '1d', defaultDays: 365, maxYahooDays: 1825, stooq: 'd' },
  w1: { label: 'W1', finnhub: 'W', yahoo: '1wk', defaultDays: 1825, maxYahooDays: 3650, stooq: 'w' },
  mn1: { label: 'MN1', finnhub: 'M', yahoo: '1mo', defaultDays: 3650, maxYahooDays: 3650 },
};

function normalizeChartInterval(value = 'd1') {
  const key = String(value || 'd1').trim().toLowerCase();
  return CHART_INTERVALS[key] ? key : 'd1';
}

function chartDaysForInterval(interval, requestedDays = null) {
  const config = CHART_INTERVALS[normalizeChartInterval(interval)];
  const raw = toNumber(requestedDays) ?? config.defaultDays;
  return Math.max(1, Math.min(config.maxYahooDays, raw));
}

function formatChartDate(timestamp, interval = 'd1') {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  if (['m1', 'm5', 'm15', 'm30', 'h1', 'h2', 'h4', 'h6', 'h12'].includes(interval)) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
  return date.toISOString().slice(0, 10);
}

async function fetchFinnhubCandles(symbol, options = {}) {
  if (typeof options === 'number') {
    options = { days: options, interval: 'd1' };
  }
  const interval = normalizeChartInterval(options.interval);
  const days = chartDaysForInterval(interval, options.days);
  const config = CHART_INTERVALS[interval];
  const to = toUnixTimestamp(new Date());
  const from = toUnixTimestamp(Date.now() - days * 24 * 60 * 60 * 1000);
  const payload = await fetchFinnhubJson('/stock/candle', {
    symbol,
    resolution: config.finnhub,
    from,
    to,
  });
  if (payload?.s !== 'ok') {
    throw new Error(`Finnhub candle data unavailable for ${symbol}`);
  }
  return (payload.c || []).map((close, index) => ({
    date: payload.t?.[index] ? formatChartDate(payload.t[index] * 1000, interval) : '',
    open: toNumber(payload.o?.[index]),
    high: toNumber(payload.h?.[index]),
    low: toNumber(payload.l?.[index]),
    close: toNumber(close),
    volume: toNumber(payload.v?.[index]),
  }));
}

function normalizeHistoricalCandleRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: row.date || '',
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      close: toNumber(row.close),
      volume: toNumber(row.volume),
    }))
    .filter((row) => row.date && row.close !== null)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function resampleCandlesByHours(candles = [], hours = 4) {
  const groups = new Map();
  for (const candle of candles) {
    const time = new Date(String(candle.date).replace(' ', 'T') + (String(candle.date).includes('Z') ? '' : 'Z'));
    if (Number.isNaN(time.getTime())) continue;
    const bucket = new Date(time);
    bucket.setUTCHours(Math.floor(bucket.getUTCHours() / hours) * hours, 0, 0, 0);
    const key = bucket.toISOString().slice(0, 16).replace('T', ' ');
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { date: key, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume || 0 });
    } else {
      existing.high = Math.max(existing.high ?? candle.high, candle.high ?? existing.high);
      existing.low = Math.min(existing.low ?? candle.low, candle.low ?? existing.low);
      existing.close = candle.close;
      existing.volume = (existing.volume || 0) + (candle.volume || 0);
    }
  }
  return normalizeHistoricalCandleRows([...groups.values()]);
}

async function fetchYahooCandles(symbol, options = {}) {
  const interval = normalizeChartInterval(options.interval);
  const config = CHART_INTERVALS[interval];
  const days = chartDaysForInterval(interval, options.days);
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', String(period1));
  url.searchParams.set('period2', String(period2));
  url.searchParams.set('interval', config.yahoo);
  url.searchParams.set('events', 'history');
  url.searchParams.set('includeAdjustedClose', 'true');
  if (['m1', 'm5', 'm15', 'm30', 'h1'].includes(interval)) {
    url.searchParams.set('includePrePost', 'true');
  }
  const payload = await fetchJsonWithRetry(url.toString(), { redirect: 'follow' });
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  if (!timestamps.length || !Array.isArray(quote.close)) {
    throw new Error(`Yahoo chart data unavailable for ${symbol}`);
  }
  const candles = normalizeHistoricalCandleRows(timestamps.map((timestamp, index) => ({
    date: formatChartDate(timestamp * 1000, interval === 'h4' ? 'h1' : interval),
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index],
  })));
  return config.resampleHours ? resampleCandlesByHours(candles, config.resampleHours) : candles;
}

function formatStooqDate(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

async function fetchStooqCandles(symbol, options = {}) {
  const interval = normalizeChartInterval(options.interval);
  const config = CHART_INTERVALS[interval];
  if (!config.stooq) {
    throw new Error(`Stooq fallback does not support ${config.label}`);
  }
  const days = chartDaysForInterval(interval, options.days);
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const url = new URL('https://stooq.com/q/d/l/');
  url.searchParams.set('s', `${symbol.toLowerCase()}.us`);
  url.searchParams.set('d1', formatStooqDate(start));
  url.searchParams.set('d2', formatStooqDate(end));
  url.searchParams.set('i', config.stooq);
  const csv = await fetchTextWithRetry(url.toString(), { redirect: 'follow' });
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1 || /No data/i.test(csv)) {
    throw new Error(`Stooq chart data unavailable for ${symbol}`);
  }
  return normalizeHistoricalCandleRows(lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { date, open, high, low, close, volume };
  }));
}

async function fetchUsHistoricalCandles(symbol, options = {}) {
  const interval = normalizeChartInterval(options.interval);
  const attempts = [
    ['Yahoo Finance chart', () => fetchYahooCandles(symbol, options)],
    ['Finnhub chart', () => fetchFinnhubCandles(symbol, options)],
  ];
  if (CHART_INTERVALS[interval]?.stooq) {
    attempts.push(['Stooq chart', () => fetchStooqCandles(symbol, options)]);
  }
  const errors = [];
  for (const [source, loader] of attempts) {
    try {
      const candles = await loader();
      if (candles.length) {
        return { source, candles, interval };
      }
      errors.push(`${source}: empty response`);
    } catch (error) {
      errors.push(`${source}: ${error.message}`);
    }
  }
  throw new Error(`Historical chart data unavailable for ${symbol}. ${errors.join(' | ')}`);
}

function normalizeFinnhubFundamentals(metrics = {}) {
  return {
    marketCapitalization: toNumber(metrics.marketCapitalization),
    peTTM: toNumber(metrics.peTTM),
    psTTM: toNumber(metrics.psTTM),
    pbQuarterly: toNumber(metrics.pbQuarterly),
    currentRatioQuarterly: toNumber(metrics.currentRatioQuarterly),
    quickRatioQuarterly: toNumber(metrics.quickRatioQuarterly),
    netMargin: toNumber(metrics.netMargin),
    operatingMargin: toNumber(metrics.operatingMarginTTM),
    roiTTM: toNumber(metrics.roiTTM),
    roeTTM: toNumber(metrics.roeTTM),
    epsTTM: toNumber(metrics.epsTTM),
    revenueGrowthTTMYoy: toNumber(metrics.revenueGrowthTTMYoy),
    epsGrowthTTMYoy: toNumber(metrics.epsGrowthTTMYoy),
    grossMarginTTM: toNumber(metrics.grossMarginTTM),
    debtToEquityQuarterly: toNumber(metrics.totalDebtToEquityQuarterly),
    week52High: toNumber(metrics['52WeekHigh']),
    week52Low: toNumber(metrics['52WeekLow']),
    beta: toNumber(metrics.beta),
  };
}

function extractLatestEarningsContext(earnings = [], earningsCalendar = {}) {
  const recent = Array.isArray(earnings) ? earnings.slice(0, 4).map((item) => ({
    period: item.period || '',
    quarter: item.quarter || null,
    year: item.year || null,
    actual: toNumber(item.actual),
    estimate: toNumber(item.estimate),
    surprise: toNumber(item.surprise),
    surprisePercent: toNumber(item.surprisePercent),
  })) : [];
  const next = earningsCalendar && Object.keys(earningsCalendar).length
    ? {
        date: earningsCalendar.date || '',
        epsActual: toNumber(earningsCalendar.epsActual),
        epsEstimate: toNumber(earningsCalendar.epsEstimate),
        revenueActual: toNumber(earningsCalendar.revenueActual),
        revenueEstimate: toNumber(earningsCalendar.revenueEstimate),
        hour: earningsCalendar.hour || '',
      }
    : null;
  return { recent, next };
}

async function fetchStockResearchBundle(ticker) {
  if (!hasFinnhubAccess()) {
    throw new Error('FINNHUB_API_KEY is not configured');
  }
  const warnings = [];
  const settled = await Promise.allSettled([
    fetchFinnhubQuote(ticker),
    fetchFinnhubCandles(ticker, 120),
    fetchFinnhubCompanyNews(ticker, isoDateDaysAgo(21)),
    fetchFinnhubJson('/stock/profile2', { symbol: ticker }),
    fetchFinnhubJson('/stock/metric', { symbol: ticker, metric: 'all' }),
    fetchFinnhubJson('/stock/earnings', { symbol: ticker, limit: 8 }),
    fetchFinnhubJson('/calendar/earnings', {
      from: new Date().toISOString().slice(0, 10),
      to: isoDateDaysAgo(-30),
      symbol: ticker,
      international: false,
    }),
  ]);

  const [quoteResult, candlesResult, newsResult, profileResult, metricResult, earningsResult, calendarResult] = settled;
  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
  const dailyTrend = candlesResult.status === 'fulfilled' ? candlesResult.value.slice(-30).reverse() : [];
  const news = newsResult.status === 'fulfilled' ? newsResult.value.slice(0, 6) : [];
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : {};
  let fundamentals = metricResult.status === 'fulfilled' ? normalizeFinnhubFundamentals(metricResult.value?.metric || {}) : {};
  const earningsCalendar =
    calendarResult.status === 'fulfilled' && Array.isArray(calendarResult.value?.earningsCalendar)
      ? calendarResult.value.earningsCalendar
      : [];
  const earnings = extractLatestEarningsContext(
    earningsResult.status === 'fulfilled' ? earningsResult.value : [],
    earningsCalendar[0] || null,
  );
  const rsi = computeRsiSeries([...dailyTrend].reverse(), 14);

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      const labels = ['quote', 'candles', 'news', 'profile', 'fundamentals', 'earnings', 'earnings_calendar'];
      warnings.push(`${labels[index]}: ${result.reason?.message || 'unavailable'}`);
    }
  });

  const needsFundamentalFallback =
    !fundamentals ||
    Object.values(fundamentals).every((value) => value === null || value === undefined);
  if (needsFundamentalFallback) {
    try {
      const googleFallback = await fetchGoogleFinanceFundamentalsFallback(ticker, quote?.price ?? null);
      fundamentals = {
        ...fundamentals,
        ...Object.fromEntries(Object.entries(googleFallback).filter(([, value]) => value !== null && value !== undefined)),
      };
      warnings.push('fundamentals: using Google Finance fallback due to missing Finnhub metrics.');
    } catch (error) {
      warnings.push(`fundamentals_fallback: ${error.message || 'Google Finance fallback unavailable'}`);
    }
  }
  const cleanedWarnings = sanitizeResearchWarnings(warnings);

  return {
    ticker,
    source: 'Finnhub REST',
    fetchedAt: nowTimestamp(),
    quote,
    dailyTrend,
    rsi,
    news,
    newsSummary: summarizeFinnhubNews(news),
    profile: {
      name: profile.name || '',
      exchange: profile.exchange || '',
      finnhubIndustry: profile.finnhubIndustry || '',
      ipo: profile.ipo || '',
      marketCapitalization: toNumber(profile.marketCapitalization),
      shareOutstanding: toNumber(profile.shareOutstanding),
      weburl: profile.weburl || '',
      logo: profile.logo || '',
    },
    fundamentals,
    earnings,
    warnings: cleanedWarnings,
  };
}

function buildOpenAiHoldingPayload(holding, usSnapshot, baseRecommendation, headlines, overrides = {}) {
  const allowedActions = getAllowedAiActions(baseRecommendation);
  const reasoningEffort = overrides.reasoningEffort || CONFIG.openaiReasoningEffort;
  const maxOutputTokens = overrides.maxOutputTokens || 1400;
  const researchBundle = overrides.researchBundle || null;
  return {
    model: CONFIG.openaiModel,
    instructions:
      'You are a cautious overnight swing-trading research assistant. You are given a normalized stock research bundle plus portfolio context. Respect that the user cannot do same-session round trips. Return JSON only. Build a deep per-stock report that explains what is most likely to happen next session, then map that view to one of the allowed actions. Use only the allowed actions. Prefer HOLD_OVERNIGHT or WATCH_ONLY when evidence is mixed. If the research bundle shows gaps or missing data, explicitly lower confidence.',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({
              objective: 'Use the supplied market data and portfolio context to generate a deep per-stock report and next-session action plan.',
              allowedActions,
              security: {
                ticker: holding.ticker,
                name: holding.name,
                livePrice: roundIfNumber(holding.livePrice, 2),
                movePct: roundIfNumber(holding.movePct, 2),
                moveBasis: holding.moveBasis,
                totalReturnPct: roundIfNumber(holding.totalReturnPct, 2),
                oneDayReturnPct: roundIfNumber(holding.oneDayReturnPct, 2),
                strength: holding.strength,
              },
              market: {
                session: getUsSessionLabel(),
                usRegime: usSnapshot?.regime || 'not available',
                breadth: roundIfNumber(usSnapshot?.breadth?.sectorsPositivePercent, 2),
                leadership: usSnapshot?.sectorLeadership?.leadershipStyle || 'not available',
                semisBreadth: usSnapshot?.semiconductors?.breadthLabel || 'not available',
              },
              baseRecommendation: {
                action: baseRecommendation.action,
                actionLabel: baseRecommendation.actionLabel,
                score: baseRecommendation.score,
                overnightRisk: baseRecommendation.overnightRisk?.level || 'not available',
                overnightRiskScore: baseRecommendation.overnightRisk?.score ?? null,
                riskFlags: baseRecommendation.riskFlags || [],
                currentEntry: roundIfNumber(baseRecommendation.entryPrice, 2),
                currentExit: roundIfNumber(baseRecommendation.exitPrice, 2),
                currentStop: roundIfNumber(baseRecommendation.stopLoss, 2),
                currentTarget1: roundIfNumber(baseRecommendation.target1, 2),
                currentTarget2: roundIfNumber(baseRecommendation.target2, 2),
              },
              headlines: (headlines || []).slice(0, 3).map((item) => item.title),
              requiredResearch: [
                'daily trend over recent weeks',
                'RSI context',
                'company overview / business context',
                'earnings context if available',
                'news sentiment if available',
              ],
              researchBundle,
            }),
          },
        ],
      },
    ],
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'overnight_signal',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['BUY_TODAY', 'HOLD_OVERNIGHT', 'WATCH_ONLY', 'REDUCE_BEFORE_CLOSE', 'SELL_NEXT_SESSION'],
            },
            confidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
            },
            summary: {
              type: 'string',
            },
            plan_summary: {
              type: 'string',
            },
            thesis: {
              type: 'string',
            },
            next_session_prediction: {
              type: 'string',
            },
            predicted_direction: {
              type: 'string',
              enum: ['up', 'flat_to_up', 'sideways', 'flat_to_down', 'down'],
            },
            expected_move_band: {
              type: 'string',
              enum: ['>3% down', '1-3% down', 'flat', '1-3% up', '>3% up'],
            },
            best_action_now: {
              type: 'string',
              enum: ['hold', 'buy_today', 'watch_only', 'reduce', 'sell_next_session'],
            },
            final_recommendation: {
              type: 'string',
            },
            buy_below: {
              type: ['number', 'null'],
            },
            add_zone_low: {
              type: ['number', 'null'],
            },
            add_zone_high: {
              type: ['number', 'null'],
            },
            reduce_zone_low: {
              type: ['number', 'null'],
            },
            reduce_zone_high: {
              type: ['number', 'null'],
            },
            exit_price: {
              type: ['number', 'null'],
            },
            invalidate_below: {
              type: ['number', 'null'],
            },
            support_level: {
              type: ['number', 'null'],
            },
            resistance_level: {
              type: ['number', 'null'],
            },
            conviction_explanation: {
              type: 'string',
            },
            risk_flags: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 4,
            },
            key_catalysts: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 5,
            },
            news_tone: {
              type: 'string',
              enum: ['bullish', 'mixed', 'bearish', 'unclear'],
            },
            catalyst_quality: {
              type: 'string',
              enum: ['strong', 'medium', 'weak'],
            },
            overnight_bias: {
              type: 'string',
              enum: ['favorable', 'neutral', 'risky'],
            },
          },
          required: ['action', 'confidence', 'summary', 'plan_summary', 'thesis', 'next_session_prediction', 'predicted_direction', 'expected_move_band', 'best_action_now', 'final_recommendation', 'buy_below', 'add_zone_low', 'add_zone_high', 'reduce_zone_low', 'reduce_zone_high', 'exit_price', 'invalidate_below', 'support_level', 'resistance_level', 'conviction_explanation', 'risk_flags', 'key_catalysts', 'news_tone', 'catalyst_quality', 'overnight_bias'],
        },
      },
    },
    reasoning: {
      effort: reasoningEffort,
    },
    max_output_tokens: maxOutputTokens,
    store: false,
  };
}

async function fetchOpenAiHoldingOverlay(holding, usSnapshot, baseRecommendation, headlines) {
  if (!CONFIG.openaiApiKey) {
    return null;
  }
  cleanupHotCaches();
  const cacheKey = buildAiCacheKey(holding, usSnapshot, baseRecommendation, headlines);
  const cached = aiSignalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const persisted = await loadPersistedAiSignalCacheEntry(cacheKey);
  if (persisted) {
    aiSignalCache.set(cacheKey, persisted);
    cleanupHotCaches();
    return persisted.value;
  }
  const researchBundle = await fetchFlexibleStockResearchBundle(holding.ticker, holding.name);

  async function runAttempt(overrides = {}) {
    const payload = buildOpenAiHoldingPayload(holding, usSnapshot, baseRecommendation, headlines, { ...overrides, researchBundle });
    const response = await fetchOpenAiResponse(payload);
    const outputText = extractOpenAiOutputText(response);
    return { payload, response, outputText };
  }

  let attempt = await runAttempt();
  let { response, outputText } = attempt;
  if (
    response?.status === 'incomplete' &&
    response?.incomplete_details?.reason === 'max_output_tokens' &&
    !outputText
  ) {
    attempt = await runAttempt({ reasoningEffort: 'minimal', maxOutputTokens: 900 });
    response = attempt.response;
    outputText = attempt.outputText;
  }

  if (response?.status && response.status !== 'completed') {
    const summary = summarizeOpenAiResponse(response, outputText);
    throw new Error(`OpenAI response not completed: ${JSON.stringify(summary)}`);
  }
  if (!outputText || (Array.isArray(outputText) && outputText.length === 0)) {
    const summary = summarizeOpenAiResponse(response, outputText);
    throw new Error(`OpenAI response returned no parseable text: ${JSON.stringify(summary)}`);
  }

  const overlay = extractFirstJsonObject(outputText);
  if (!overlay) {
    const summary = summarizeOpenAiResponse(response, outputText);
    throw new Error(`OpenAI JSON parse failed: no valid JSON object found. ${JSON.stringify(summary)}`);
  }
  overlay.research_bundle = {
    source: researchBundle.source,
    fetchedAt: researchBundle.fetchedAt,
    warnings: researchBundle.warnings,
  };
  aiSignalCache.set(cacheKey, {
    expiresAt: Date.now() + CONFIG.openaiSignalCacheMinutes * 60 * 1000,
    value: overlay,
  });
  cleanupHotCaches();
  await persistAiSignalCacheEntry(cacheKey, overlay, Date.now() + CONFIG.openaiSignalCacheMinutes * 60 * 1000);
  return overlay;
}

async function loadCachedAiHoldingOverlay(holding, usSnapshot, baseRecommendation, headlines) {
  cleanupHotCaches();
  const cacheKey = buildAiCacheKey(holding, usSnapshot, baseRecommendation, headlines);
  const cached = aiSignalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const persisted = await loadPersistedAiSignalCacheEntry(cacheKey);
  if (persisted) {
    aiSignalCache.set(cacheKey, persisted);
    cleanupHotCaches();
    return persisted.value;
  }
  return null;
}

function mergeAiRecommendation(baseRecommendation, overlay, holding, usSnapshot) {
  if (!overlay) {
    return baseRecommendation;
  }

  const allowedActions = getAllowedAiActions(baseRecommendation);
  const aiAction = allowedActions.includes(overlay.action) ? overlay.action : baseRecommendation.action;
  const shouldApply = overlay.confidence === 'high' && aiAction !== baseRecommendation.action;
  const finalAction = shouldApply ? aiAction : baseRecommendation.action;
  const tradePlan = buildOvernightTradePlan(finalAction, holding.livePrice ?? holding.lastPrice, holding.movePct, usSnapshot?.regime, holding.moveBasis);

  return {
    ...baseRecommendation,
    ...(shouldApply
      ? {
          action: finalAction,
          actionLabel: formatHoldingActionLabel(finalAction),
          ...tradePlan,
        }
      : {}),
    rationale: Array.isArray(baseRecommendation.rationale) ? baseRecommendation.rationale : [],
    riskFlags: [...new Set([
      ...(Array.isArray(baseRecommendation.riskFlags) ? baseRecommendation.riskFlags : []),
      ...(Array.isArray(overlay.risk_flags) ? overlay.risk_flags : []),
    ].filter(Boolean))],
    aiOverlay: {
      enabled: true,
      model: CONFIG.openaiModel,
      action: overlay.action,
      applied: shouldApply,
      confidence: overlay.confidence,
      summary: overlay.summary,
      planSummary: overlay.plan_summary,
      thesis: overlay.thesis,
      nextSessionPrediction: overlay.next_session_prediction,
      predictedDirection: overlay.predicted_direction,
      expectedMoveBand: overlay.expected_move_band,
      bestActionNow: overlay.best_action_now,
      finalRecommendation: overlay.final_recommendation,
      buyBelow: overlay.buy_below,
      addZoneLow: overlay.add_zone_low,
      addZoneHigh: overlay.add_zone_high,
      reduceZoneLow: overlay.reduce_zone_low,
      reduceZoneHigh: overlay.reduce_zone_high,
      exitPrice: overlay.exit_price,
      invalidateBelow: overlay.invalidate_below,
      supportLevel: overlay.support_level,
      resistanceLevel: overlay.resistance_level,
      convictionExplanation: overlay.conviction_explanation,
      keyCatalysts: overlay.key_catalysts,
      researchBundle: overlay.research_bundle || null,
      newsTone: overlay.news_tone,
      catalystQuality: overlay.catalyst_quality,
      overnightBias: overlay.overnight_bias,
      allowedActions,
      researchSummary: overlay.summary || overlay.plan_summary || overlay.thesis || '',
    },
  };
}

function getSectorResearchProfile(ticker, name = '') {
  const normalizedTicker = String(ticker || '').toUpperCase();
  if (STOCK_PROFILES[normalizedTicker]) {
    return STOCK_PROFILES[normalizedTicker];
  }
  const normalizedName = String(name || '').toUpperCase();
  const spenderTickers = new Set(['MSFT', 'META', 'ORCL', 'AMZN', 'GOOGL']);
  const takerTickers = new Set(['NVDA', 'AMD', 'AVGO', 'TSM', 'MU', 'SMCI', 'ANET', 'MRVL', 'ARM', 'ASML', 'VRT', 'CRWV']);
  const infraKeywords = /\bNETWORK|SEMI|CHIP|GPU|MEMORY|SERVER|DATA CENTER|HOLDINGS CO\b/i;
  const spenderKeywords = /\bSOFTWARE|CLOUD|PLATFORMS|INTERNET|CLASS A\b/i;
  const thesisBucket =
    takerTickers.has(normalizedTicker) || infraKeywords.test(normalizedName)
      ? 'capex_taker'
      : spenderTickers.has(normalizedTicker) || spenderKeywords.test(normalizedName)
        ? 'capex_spender'
        : 'other';
  const category =
    thesisBucket === 'capex_taker' ? 'quality' :
    thesisBucket === 'capex_spender' ? 'quality' :
    'speculative';
  return {
    name: name || normalizedTicker,
    symbol: getUsSymbolForTicker(normalizedTicker),
    role: thesisBucket === 'capex_taker' ? 'AI infrastructure candidate' : thesisBucket === 'capex_spender' ? 'AI platform / spender candidate' : 'Watchlist candidate',
    thesisBucket,
    category,
    riskPenalty: category === 'speculative' ? -1 : 0,
  };
}

function dedupeHeadlineItems(...groups) {
  const seen = new Set();
  return groups
    .flat()
    .filter(Boolean)
    .filter((item) => {
      const key = compactWhitespace(item?.title || item?.headline || '').toLowerCase();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function buildDeterministicSectorAiSummary(snapshot, portfolio = null) {
  const leaderText = (snapshot.leaders || []).map((item) => `${item.ticker} ${formatSignedValue(item.movePct, 2, '%')}`).join(', ') || 'not available';
  const laggardText = (snapshot.laggards || []).map((item) => `${item.ticker} ${formatSignedValue(item.movePct, 2, '%')}`).join(', ') || 'not available';
  const holdingTickers = new Set((portfolio?.holdings || []).map((item) => String(item?.ticker || '').toUpperCase()));
  const holdingLeaders = (snapshot.leaders || []).filter((item) => holdingTickers.has(item.ticker)).map((item) => item.ticker);
  const holdingLaggards = (snapshot.laggards || []).filter((item) => holdingTickers.has(item.ticker)).map((item) => item.ticker);
  const shiftTags = snapshot.shiftSignals?.length ? snapshot.shiftSignals : snapshot.currentStateTags || [];
  return {
    enabled: Boolean(CONFIG.openaiApiKey),
    source: CONFIG.openaiApiKey ? 'OpenAI + deterministic fallback' : 'Deterministic fallback',
    model: CONFIG.openaiModel,
    generatedAt: nowTimestamp(),
    summary: `Breadth is ${snapshot.sectorBreadth?.breadthLabel || 'unknown'} with ${(snapshot.capexTakers?.avgMovePct ?? 0) >= (snapshot.capexSpenders?.avgMovePct ?? 0) ? 'AI infra' : 'AI spenders'} leading.`,
    whatChanged: shiftTags.length ? `Shift tags: ${shiftTags.join(', ')}.` : 'No major shift tags fired yet.',
    leadership: `Leaders: ${leaderText}. Laggards: ${laggardText}.`,
    portfolioImpact:
      holdingLeaders.length || holdingLaggards.length
        ? `Held leaders: ${holdingLeaders.join(', ') || 'none'}. Held laggards: ${holdingLaggards.join(', ') || 'none'}.`
        : 'None of the current leaders or laggards are held right now.',
    watchNext: 'Watch whether relative strength and breadth stay aligned into the next U.S. session.',
  };
}

async function fetchOpenAiSectorSummary(snapshot, portfolio = null) {
  if (!CONFIG.openaiApiKey) {
    return buildDeterministicSectorAiSummary(snapshot, portfolio);
  }
  cleanupHotCaches();
  const cacheKey = `sector-intel::${JSON.stringify({
    shifts: snapshot.shiftSignals,
    state: snapshot.currentStateTags,
    leaders: snapshot.leaders,
    laggards: snapshot.laggards,
    breadth: snapshot.sectorBreadth,
    takers: snapshot.capexTakers,
    spenders: snapshot.capexSpenders,
  })}`;
  const cached = aiSignalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const persisted = await loadPersistedAiSignalCacheEntry(cacheKey);
  if (persisted) {
    aiSignalCache.set(cacheKey, persisted);
    cleanupHotCaches();
    return persisted.value;
  }

  const payload = {
    model: CONFIG.openaiModel,
    instructions:
      'You are a cautious market research assistant. Summarize the structured AI-sector snapshot. Return JSON only. Be short, factual, and risk-aware. Do not recommend trades directly.',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({
              marketSession: snapshot.marketSession,
              breadth: snapshot.sectorBreadth,
              shiftSignals: snapshot.shiftSignals,
              currentStateTags: snapshot.currentStateTags,
              leaders: snapshot.leaders,
              laggards: snapshot.laggards,
              capexTakers: snapshot.capexTakers,
              capexSpenders: snapshot.capexSpenders,
              benchmarks: snapshot.benchmarks,
              holdings: (portfolio?.holdings || []).map((item) => item.ticker),
            }),
          },
        ],
      },
    ],
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'sector_summary',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            what_changed: { type: 'string' },
            leadership: { type: 'string' },
            portfolio_impact: { type: 'string' },
            watch_next: { type: 'string' },
          },
          required: ['summary', 'what_changed', 'leadership', 'portfolio_impact', 'watch_next'],
        },
      },
    },
    reasoning: { effort: 'minimal' },
    max_output_tokens: 700,
    store: false,
  };

  try {
    const response = await fetchOpenAiResponse(payload);
    const outputText = extractOpenAiOutputText(response);
    const parsed = extractFirstJsonObject(outputText);
    if (!parsed) {
      throw new Error('No JSON object found in sector summary response');
    }
    const value = {
      enabled: true,
      source: 'OpenAI',
      model: CONFIG.openaiModel,
      generatedAt: nowTimestamp(),
      summary: parsed.summary,
      whatChanged: parsed.what_changed,
      leadership: parsed.leadership,
      portfolioImpact: parsed.portfolio_impact,
      watchNext: parsed.watch_next,
    };
    const expiresAt = Date.now() + CONFIG.openaiSignalCacheMinutes * 60 * 1000;
    aiSignalCache.set(cacheKey, { expiresAt, value });
    cleanupHotCaches();
    await persistAiSignalCacheEntry(cacheKey, value, expiresAt);
    return value;
  } catch (error) {
    return {
      ...buildDeterministicSectorAiSummary(snapshot, portfolio),
      enabled: true,
      source: 'Deterministic fallback',
      model: CONFIG.openaiModel,
      error: error.message,
    };
  }
}

async function fetchFlexibleStockResearchBundle(ticker, name = '') {
  const quote = await safeFetch(`FLEX_${ticker}_QUOTE`, () => fetchUsEquityQuoteCached(ticker));
  const historical = await safeFetch(`FLEX_${ticker}_YAHOO_DAILY`, () => fetchUsHistoricalCandles(ticker, { interval: 'd1', days: 180 }));
  const headlines = await safeFetch(`FLEX_${ticker}_HEADLINES`, () => fetchTickerHeadlinesCached(ticker, name));
  const dailyTrend = Array.isArray(historical?.candles) ? historical.candles.slice(-30).reverse() : [];
  const rsi = computeRsiSeries([...dailyTrend].reverse(), 14);
  const fundamentals = {
    marketCapitalization: toNumber(quote?.marketCap),
  };
  return {
    ticker,
    source: quote?.source || historical?.source || 'Yahoo Finance',
    fetchedAt: nowTimestamp(),
    quote,
    dailyTrend,
    rsi,
    news: Array.isArray(headlines) ? headlines : [],
    newsSummary: summarizeFinnhubNews([]),
    profile: {
      name: name || quote?.title || '',
      exchange: quote?.exchange || '',
      finnhubIndustry: '',
      ipo: '',
      marketCapitalization: toNumber(quote?.marketCap),
      shareOutstanding: null,
      weburl: '',
      logo: '',
    },
    fundamentals,
    earnings: { recent: [], next: null },
    warnings: sanitizeResearchWarnings([]),
  };
}

async function buildSectorIntelligencePayload(latestUs = null, portfolioStoreUs = null) {
  const persisted = await loadPersistedSectorIntelligenceSessionPayload();
  const priorSnapshot = persisted?.payload || persisted?.previousPayload || null;
  const seeds = [];
  const seen = new Set();
  for (const holding of portfolioStoreUs?.holdings || []) {
    const ticker = String(holding?.ticker || '').toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    seeds.push({ ticker, name: holding?.name || ticker, kind: 'holding' });
  }
  for (const candidate of CONFIG.usWishlistCandidates || []) {
    const ticker = String(candidate?.ticker || '').toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    seeds.push({ ticker, name: candidate?.name || ticker, kind: 'watchlist' });
  }
  for (const ticker of ['QQQ', 'SMH']) {
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    seeds.push({ ticker, name: ticker, kind: 'benchmark' });
  }

  const items = await Promise.all(
    seeds.map(async (seed) => {
      const profile = getSectorResearchProfile(seed.ticker, seed.name);
      const [quote, headlines, researchBundle] = await Promise.all([
        safeFetch(`SECTOR_${seed.ticker}_QUOTE`, () => fetchUsEquityQuoteCached(seed.ticker)),
        safeFetch(`SECTOR_${seed.ticker}_HEADLINES`, () => fetchTickerHeadlinesCached(seed.ticker, seed.name)),
        fetchFlexibleStockResearchBundle(seed.ticker, seed.name),
      ]);
      const display = chooseDisplayMove(quote);
      return {
        ticker: seed.ticker,
        name: seed.name,
        profile,
        quote: researchBundle?.quote?.price ? mergeUsEquityQuoteSources(quote, researchBundle.quote) : quote,
        displayPrice: display.lastPrice ?? quote?.price ?? researchBundle?.quote?.price ?? null,
        displayMovePct: display.movePct ?? quote?.pctChange ?? researchBundle?.quote?.pctChange ?? null,
        displayBasis: display.basis || 'regular',
        dailyTrend: Array.isArray(researchBundle?.dailyTrend) ? researchBundle.dailyTrend : [],
        rsi: Array.isArray(researchBundle?.rsi) ? researchBundle.rsi : [],
        news: dedupeHeadlineItems(headlines, researchBundle?.news || []),
        fundamentals: researchBundle?.fundamentals || {},
        earnings: researchBundle?.earnings || null,
        source: researchBundle?.source || 'research bundle',
      };
    }),
  );

  const snapshot = buildSectorIntelligenceSnapshot({
    items,
    priorSnapshot,
    marketSession: getUsSessionLabel(),
    updatedAt: nowTimestamp(),
  });
  snapshot.aiSummary = await fetchOpenAiSectorSummary(snapshot, portfolioStoreUs);
  await persistSectorIntelligenceSessionPayload(snapshot);
  return snapshot;
}

async function getCachedSectorIntelligencePayload(latestUs = null, portfolioStoreUs = null, date = new Date()) {
  const refreshIntervalMs = getUsRefreshIntervalMs(date) || 60 * 60 * 1000;
  const now = Date.now();
  if (sectorIntelligenceCache.payload && sectorIntelligenceCache.expiresAt > now) {
    return sectorIntelligenceCache.payload;
  }
  if (sectorIntelligenceCache.promise) {
    return sectorIntelligenceCache.promise;
  }
  sectorIntelligenceCache.promise = buildSectorIntelligencePayload(latestUs, portfolioStoreUs)
    .then((payload) => {
      sectorIntelligenceCache = {
        payload,
        expiresAt: Date.now() + Math.max(refreshIntervalMs, WATCHLIST_CACHE_TTL_MS),
        promise: null,
      };
      return payload;
    })
    .catch((error) => {
      sectorIntelligenceCache.promise = null;
      throw error;
  });
  return sectorIntelligenceCache.promise;
}

async function getCachedSwingTradeReport(options = {}) {
  const ttlMs = Math.max(60_000, Number(process.env.SWING_TRADE_CACHE_SECONDS || 300) * 1000);
  const now = Date.now();
  const force = Boolean(options.force);
  if (!force && swingTradeCache.payload && swingTradeCache.expiresAt > now) {
    return swingTradeCache.payload;
  }
  if (!force && swingTradeCache.promise) {
    return swingTradeCache.promise;
  }
  swingTradeCache.promise = buildSwingTradeReport(options)
    .then((payload) => {
      swingTradeCache = {
        payload,
        expiresAt: Date.now() + ttlMs,
        promise: null,
      };
      return payload;
    })
    .catch((error) => {
      swingTradeCache.promise = null;
      throw error;
    });
  return swingTradeCache.promise;
}

function startSwingTradeScan(options = {}) {
  if (swingTradeRunStatus.running && swingTradeCache.promise) {
    return { alreadyRunning: true, status: swingTradeRunStatus };
  }
  swingTradeRunStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  getCachedSwingTradeReport({ ...options, force: true })
    .then(() => {
      swingTradeRunStatus = {
        ...swingTradeRunStatus,
        running: false,
        completedAt: new Date().toISOString(),
        error: null,
      };
    })
    .catch((error) => {
      swingTradeRunStatus = {
        ...swingTradeRunStatus,
        running: false,
        completedAt: new Date().toISOString(),
        error: error.message,
      };
    });
  return { alreadyRunning: false, status: swingTradeRunStatus };
}

function indexSectorStocks(snapshot) {
  return Object.fromEntries((snapshot?.stocks || []).map((stock) => [String(stock.ticker || '').toUpperCase(), stock]));
}

function attachSectorResearchFields(entity = {}, sectorStock = null) {
  const aiOverlay = entity?.recommendation?.aiOverlay || entity?.aiOverlay || null;
  return {
    ...entity,
    technicalSnapshot: sectorStock?.technicalSnapshot || null,
    fundamentalSnapshot: sectorStock?.fundamentalSnapshot || null,
    newsDigest: sectorStock?.newsDigest || buildNewsDigest(entity?.headlines || []),
    sectorContext: sectorStock?.sectorContext || null,
    shiftAlignment: sectorStock?.shiftAlignment || null,
    researchQuality: sectorStock?.researchQuality || null,
    aiOverlay: aiOverlay
      ? {
          ...aiOverlay,
          researchSummary:
            aiOverlay.researchSummary ||
            aiOverlay.summary ||
            aiOverlay.planSummary ||
            aiOverlay.thesis ||
            aiOverlay.convictionExplanation ||
            '',
        }
      : null,
  };
}

function attachSectorResearchToPortfolio(portfolio = null, snapshot = null) {
  if (!portfolio?.holdings || !snapshot?.stocks) {
    return portfolio;
  }
  const stockIndex = indexSectorStocks(snapshot);
  return {
    ...portfolio,
    holdings: portfolio.holdings.map((holding) =>
      attachSectorResearchFields(holding, stockIndex[String(holding?.ticker || '').toUpperCase()] || null),
    ),
  };
}

function attachSectorResearchToWatchlistPayload(payload = null, snapshot = null) {
  if (!payload?.candidates || !snapshot?.stocks) {
    return payload;
  }
  const stockIndex = indexSectorStocks(snapshot);
  return {
    ...payload,
    candidates: payload.candidates.map((candidate) =>
      attachSectorResearchFields(candidate, stockIndex[String(candidate?.ticker || '').toUpperCase()] || null),
    ),
  };
}

function estimateSupportResistance(dailyTrend = [], currentPrice = null) {
  const recent = Array.isArray(dailyTrend) ? dailyTrend.slice(0, 10) : [];
  const lows = recent.map((item) => toNumber(item.low)).filter((value) => value !== null);
  const highs = recent.map((item) => toNumber(item.high)).filter((value) => value !== null);
  const support = lows.length ? Math.min(...lows) : currentPrice;
  const resistance = highs.length ? Math.max(...highs) : currentPrice;
  return {
    support: support !== null ? round(support, 2) : null,
    resistance: resistance !== null ? round(resistance, 2) : null,
  };
}

function computeConcentrationImpact(ticker, portfolio) {
  const holdings = Array.isArray(portfolio?.holdings) ? portfolio.holdings : [];
  const aiInfraTickers = new Set(['NVDA', 'AMD', 'AVGO', 'TSM', 'MU', 'SMCI', 'VRT', 'ARM', 'PLTR', 'CRWV']);
  const overlapCount = holdings.filter((item) => aiInfraTickers.has(String(item.ticker || '').toUpperCase())).length;
  const highOverlapTarget = aiInfraTickers.has(String(ticker || '').toUpperCase());
  if (highOverlapTarget && overlapCount >= 4) {
    return { level: 'high', score: -2, summary: 'Adds to an already concentrated AI/infrastructure book.' };
  }
  if (highOverlapTarget && overlapCount >= 2) {
    return { level: 'medium', score: -1, summary: 'Raises concentration in your existing AI-heavy portfolio.' };
  }
  return { level: 'low', score: 0, summary: 'Does not materially worsen concentration.' };
}

function mapHoldingActionToWatchlistAction(action, score) {
  if (action === 'BUY_TODAY' && score >= 4) return 'BUY_OPEN';
  if (action === 'BUY_TODAY' || action === 'HOLD_OVERNIGHT' || action === 'WATCH_ONLY') return 'BUY_PULLBACK_ONLY';
  if (action === 'REDUCE_BEFORE_CLOSE') return 'WATCH_NO_BUY';
  return 'SKIP';
}

function buildCandidateRecommendation(candidate, usSnapshot, portfolio, researchBundle) {
  const price = toNumber(candidate.livePrice);
  const movePct = toNumber(candidate.movePct);
  const rsiValue = toNumber(researchBundle?.rsi?.[0]?.RSI);
  const fundamentals = researchBundle?.fundamentals || {};
  const newsSummary = researchBundle?.newsSummary || {};
  const concentrationImpact = computeConcentrationImpact(candidate.ticker, portfolio);
  let score = 0;

  if (movePct !== null) {
    if (movePct >= 1) score += 1;
    else if (movePct <= -2) score -= 1;
  }
  if (rsiValue !== null) {
    if (rsiValue >= 45 && rsiValue <= 68) score += 1;
    else if (rsiValue > 75) score -= 1;
    else if (rsiValue < 35) score += 0;
  }
  if ((toNumber(fundamentals.revenueGrowthTTMYoy) || 0) >= 15) score += 1;
  if ((toNumber(fundamentals.epsGrowthTTMYoy) || 0) >= 10) score += 1;
  if ((toNumber(fundamentals.netMargin) || 0) > 0 || (toNumber(fundamentals.operatingMargin) || 0) > 0) score += 1;
  if (newsSummary.label === 'bullish') score += 1;
  if (newsSummary.label === 'bearish') score -= 1;
  score += concentrationImpact.score;
  if (usSnapshot?.regime === 'US RISK-OFF') score -= 1;

  const baseAction =
    score >= 4 ? 'BUY_TODAY' :
    score >= 2 ? 'WATCH_ONLY' :
    score >= 0 ? 'HOLD_OVERNIGHT' :
    'SELL_NEXT_SESSION';
  const tradePlan = buildOvernightTradePlan(baseAction, price, movePct, usSnapshot?.regime, candidate.moveBasis || 'regular');
  const levels = estimateSupportResistance(researchBundle?.dailyTrend, price);
  const watchlistAction = mapHoldingActionToWatchlistAction(baseAction, score);
  const gapLimit = price !== null ? round(price * 1.03, 2) : null;
  const fundingAction = concentrationImpact.level === 'high'
    ? 'Trim a lower-conviction AI/semi holding before adding this name.'
    : 'No trim required unless you want tighter position rotation.';

  return {
    action: baseAction,
    actionLabel: formatHoldingActionLabel(baseAction),
    wishlistAction: watchlistAction,
    score,
    confidence: Math.abs(score) >= 4 ? 'high' : Math.abs(score) >= 2 ? 'medium' : 'low',
    concentrationImpact,
    newsTone: newsSummary.label || 'unclear',
    catalystQuality: newsSummary.positiveCount > newsSummary.negativeCount ? 'strong' : newsSummary.averageScore !== null ? 'medium' : 'weak',
    buyBelow: tradePlan.entryPrice ?? price,
    addZoneLow: tradePlan.entryPrice !== null ? round(tradePlan.entryPrice * 0.985, 2) : null,
    addZoneHigh: tradePlan.target1 ?? null,
    stopLoss: levels.support !== null ? round(levels.support * 0.98, 2) : tradePlan.stopLoss,
    target1: levels.resistance !== null ? round(Math.max(levels.resistance, price || 0), 2) : tradePlan.target1,
    target2:
      levels.resistance !== null
        ? round(levels.resistance * (watchlistAction === 'BUY_OPEN' ? 1.08 : 1.05), 2)
        : tradePlan.target2,
    invalidateBelow: levels.support !== null ? round(levels.support * 0.97, 2) : tradePlan.stopLoss,
    supportLevel: levels.support,
    resistanceLevel: levels.resistance,
    gapRule: gapLimit !== null ? `Avoid new buys if the stock opens above $${gapLimit} without an early pullback.` : 'Wait for price discovery.',
    fundingAction,
    rationale: [
      concentrationImpact.summary,
      rsiValue !== null ? `RSI is ${round(rsiValue, 1)}.` : null,
      toNumber(fundamentals.revenueGrowthTTMYoy) !== null
        ? `Revenue growth is ${formatSignedValue(fundamentals.revenueGrowthTTMYoy, 1, '%')} YoY.`
        : null,
      researchBundle?.earnings?.next?.date ? `Next earnings date on file: ${researchBundle.earnings.next.date}.` : null,
    ].filter(Boolean),
  };
}

async function buildWatchlistAiPayload(usSnapshot, portfolio) {
  const candidates = await Promise.all(
    CONFIG.usWishlistCandidates.map(async (seed) => {
      const quote = await safeFetch(`WATCH_${seed.ticker}_QUOTE`, () => fetchUsEquityQuoteCached(seed.ticker));
      const headlines = await safeFetch(`WATCH_${seed.ticker}_HEADLINES`, () => fetchTickerHeadlinesCached(seed.ticker, seed.name));
      const display = chooseDisplayMove(quote);
      const candidate = {
        ticker: seed.ticker,
        name: seed.name,
        plannedAmount: seed.amount,
        livePrice: display.lastPrice ?? quote.price ?? null,
        movePct: display.movePct ?? quote.pctChange ?? null,
        moveAbs: display.moveAbs ?? quote.absChange ?? null,
        moveBasis: display.basis || 'regular',
        strength: classifyUsStrength(display.movePct ?? quote.pctChange),
        headlines: Array.isArray(headlines) ? headlines : [],
      };
      const researchBundle = await fetchFlexibleStockResearchBundle(seed.ticker, seed.name);
      const baseRecommendation = buildCandidateRecommendation(candidate, usSnapshot, portfolio, researchBundle);
      let recommendation = baseRecommendation;

      if (CONFIG.openaiApiKey) {
        try {
          const overlay = await fetchOpenAiHoldingOverlay(candidate, usSnapshot, baseRecommendation, candidate.headlines);
          recommendation = mergeAiRecommendation(baseRecommendation, overlay, candidate, usSnapshot);
          recommendation.wishlistAction = mapHoldingActionToWatchlistAction(recommendation.action, recommendation.score || baseRecommendation.score);
          recommendation.fundingAction = baseRecommendation.fundingAction;
          recommendation.concentrationImpact = baseRecommendation.concentrationImpact;
          recommendation.gapRule = baseRecommendation.gapRule;
        } catch (error) {
          recommendation = {
            ...baseRecommendation,
            aiOverlay: {
              enabled: true,
              model: CONFIG.openaiModel,
              error: error.message,
            },
          };
        }
      }

      return {
        ticker: seed.ticker,
        name: seed.name,
        plannedAmount: seed.amount,
        currentPrice: candidate.livePrice,
        movePct: candidate.movePct,
        moveBasis: candidate.moveBasis,
        strength: candidate.strength,
        researchSummary: {
          source: researchBundle.source,
          fetchedAt: researchBundle.fetchedAt,
          warnings: researchBundle.warnings,
        },
        financialSnapshot: researchBundle.fundamentals,
        earnings: researchBundle.earnings,
        newsTone: recommendation.aiOverlay?.newsTone || recommendation.newsTone || researchBundle.newsSummary?.label || 'unclear',
        catalystQuality: recommendation.aiOverlay?.catalystQuality || recommendation.catalystQuality || 'weak',
        concentrationImpact: recommendation.concentrationImpact || baseRecommendation.concentrationImpact,
        recommendation: recommendation.wishlistAction,
        planSummary: recommendation.aiOverlay?.planSummary || recommendation.aiOverlay?.summary || recommendation.rationale?.join(' ') || '',
        buyBelow: recommendation.aiOverlay?.buyBelow ?? recommendation.buyBelow,
        entryZoneLow: recommendation.aiOverlay?.addZoneLow ?? recommendation.addZoneLow,
        entryZoneHigh: recommendation.aiOverlay?.addZoneHigh ?? recommendation.addZoneHigh,
        stopLoss: recommendation.stopLoss,
        target1: recommendation.aiOverlay?.resistanceLevel ?? recommendation.target1,
        target2: recommendation.aiOverlay?.exitPrice ?? recommendation.target2,
        invalidateBelow: recommendation.aiOverlay?.invalidateBelow ?? recommendation.invalidateBelow,
        gapRule: recommendation.gapRule || baseRecommendation.gapRule,
        fundingAction: recommendation.fundingAction || baseRecommendation.fundingAction,
        confidence: recommendation.aiOverlay?.confidence || recommendation.confidence || 'low',
        headlines: candidate.headlines,
        recommendationDetail: recommendation,
      };
    }),
  );

  return {
    ok: true,
    updatedAt: nowTimestamp(),
    marketRegime: usSnapshot?.regime || 'not available',
    candidates,
  };
}

function buildWatchlistStocksResponse(payload) {
  return {
    ok: true,
    market: US,
    updatedAt: payload.updatedAt,
    marketRegime: payload.marketRegime,
    count: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    stocks: payload.candidates || [],
  };
}

function attachWatchlistSessionMeta(payload, options = {}) {
  const marketSession = options.marketSession || getUsSessionLabel();
  const marketOpen = options.marketOpen ?? isUsMarketOpen();
  const liveDataEnabled = options.liveDataEnabled ?? marketOpen;
  return {
    ...payload,
    marketOpen,
    marketSession,
    liveDataEnabled,
    stale: Boolean(options.stale),
    message: options.message || payload.message || null,
  };
}

async function buildConfiguredWatchlistCandidateFallback(usSnapshot) {
  const candidates = await Promise.all(
    CONFIG.usWishlistCandidates.map(async (seed) => {
      const quote = await safeFetch(`WATCH_FALLBACK_${seed.ticker}_QUOTE`, () => fetchUsEquityQuoteCached(seed.ticker));
      const display = chooseDisplayMove(quote);
      let researchBundle = {
        source: 'not available',
        fetchedAt: nowTimestamp(),
        warnings: ['Research bundle unavailable in closed-session fallback.'],
        fundamentals: {},
        earnings: null,
        newsSummary: { label: 'unclear' },
      };
      try {
        researchBundle = await fetchFlexibleStockResearchBundle(seed.ticker, seed.name);
      } catch (error) {
        researchBundle = {
          ...researchBundle,
          warnings: [error.message || 'Research bundle unavailable in closed-session fallback.'],
        };
      }
      return {
        ticker: seed.ticker,
        name: seed.name,
        plannedAmount: seed.amount,
        currentPrice: display.lastPrice ?? quote.price ?? null,
        movePct: display.movePct ?? quote.pctChange ?? null,
        moveBasis: display.basis || 'regular',
        strength: classifyUsStrength(display.movePct ?? quote.pctChange),
        researchSummary: {
          source: researchBundle.source,
          fetchedAt: researchBundle.fetchedAt,
          warnings: researchBundle.warnings,
        },
        financialSnapshot: researchBundle.fundamentals || {},
        earnings: researchBundle.earnings || null,
        newsTone: researchBundle.newsSummary?.label || 'not available',
        catalystQuality: 'not available',
        concentrationImpact: null,
        recommendation: 'WATCH',
        planSummary: 'Closed-market fallback. Prices are shown from the latest quote refresh; full analysis will return on the next live watchlist session refresh.',
        buyBelow: null,
        entryZoneLow: null,
        entryZoneHigh: null,
        stopLoss: null,
        target1: null,
        target2: null,
        invalidateBelow: null,
        gapRule: null,
        fundingAction: 'Wait for the next live refresh window to restore full watchlist analysis.',
        confidence: 'not available',
        headlines: [],
        recommendationDetail: null,
      };
    }),
  );

  const watchlistAiPayload = {
    ok: true,
    updatedAt: usSnapshot?.timestamp || nowTimestamp(),
    marketRegime: usSnapshot?.regime || 'not available',
    candidates,
  };
  const stocksPayload = buildWatchlistStocksResponse(watchlistAiPayload);
  return { watchlistAiPayload, stocksPayload };
}

async function buildLiveWatchlistPayloads() {
  const portfolioStore = await readPortfolioStore();
  const latestSnapshots = await readSnapshots();
  const latestUs = [...latestSnapshots].reverse().find((snapshot) => snapshot.market === US) || null;
  const portfolio = await buildLiveUsPortfolio(portfolioStore.US, latestUs);
  const sectorIntelligence = await getCachedSectorIntelligencePayload(latestUs, portfolioStore.US);
  const watchlistAiPayload = attachSectorResearchToWatchlistPayload(
    await buildWatchlistAiPayload(latestUs, portfolio),
    sectorIntelligence,
  );
  const stocksPayload = buildWatchlistStocksResponse(watchlistAiPayload);
  const payload = { watchlistAiPayload, stocksPayload, sectorIntelligence };
  await persistWatchlistSessionPayload(payload);
  return payload;
}

async function getWatchlistPayloadsForRequest(date = new Date()) {
  const marketOpen = isUsMarketOpen(date);
  const marketSession = getUsSessionLabel(date);
  const refreshIntervalMs = getUsRefreshIntervalMs(date);
  const now = Date.now();

  if (!refreshIntervalMs) {
    if (watchlistResponseCache.payload) {
      return {
        watchlistAiPayload: attachWatchlistSessionMeta(watchlistResponseCache.payload.watchlistAiPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this page is serving the last cached watchlist analysis.',
        }),
        stocksPayload: attachWatchlistSessionMeta(watchlistResponseCache.payload.stocksPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this dashboard is showing the last cached watchlist snapshot.',
        }),
      };
    }

    const persistedPayload = await loadPersistedWatchlistSessionPayload();
    if (persistedPayload?.watchlistAiPayload && persistedPayload?.stocksPayload) {
      return {
        watchlistAiPayload: attachWatchlistSessionMeta(persistedPayload.watchlistAiPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this page is showing the latest saved watchlist analysis.',
        }),
        stocksPayload: attachWatchlistSessionMeta(persistedPayload.stocksPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this dashboard is showing the latest saved watchlist analysis.',
        }),
      };
    }

    try {
      const livePayload = await buildLiveWatchlistPayloads();
      watchlistResponseCache = {
        expiresAt: Date.now() + WATCHLIST_CACHE_TTL_MS,
        payload: livePayload,
        promise: null,
      };
      return {
        watchlistAiPayload: attachWatchlistSessionMeta(livePayload.watchlistAiPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this page is showing the latest saved watchlist analysis.',
        }),
        stocksPayload: attachWatchlistSessionMeta(livePayload.stocksPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this dashboard is showing the latest saved watchlist analysis.',
        }),
      };
    } catch (error) {
      console.error('Closed-session watchlist rebuild failed:', error.message);
    }

    const latestSnapshots = await readSnapshots();
    const latestUs = [...latestSnapshots].reverse().find((snapshot) => snapshot.market === US) || null;
    if (latestUs) {
      const configuredFallback = await buildConfiguredWatchlistCandidateFallback(latestUs);
      await persistWatchlistSessionPayload(configuredFallback);
      return {
        watchlistAiPayload: attachWatchlistSessionMeta(configuredFallback.watchlistAiPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this page is showing your configured watchlist candidates until the next live refresh.',
        }),
        stocksPayload: attachWatchlistSessionMeta(configuredFallback.stocksPayload, {
          marketOpen,
          marketSession,
          liveDataEnabled: false,
          stale: true,
          message: 'The U.S. market is closed, so this dashboard is showing your configured watchlist candidates until the next live refresh.',
        }),
      };
    }

    const emptyPayload = {
      ok: true,
      updatedAt: nowTimestamp(),
      marketRegime: 'not available',
      candidates: [],
    };
    return {
      watchlistAiPayload: attachWatchlistSessionMeta(emptyPayload, {
        marketOpen,
        marketSession,
        liveDataEnabled: false,
        stale: true,
        message: 'The U.S. market is closed and no cached watchlist session is available yet.',
      }),
      stocksPayload: attachWatchlistSessionMeta(buildWatchlistStocksResponse(emptyPayload), {
        marketOpen,
        marketSession,
        liveDataEnabled: false,
        stale: true,
        message: 'The U.S. market is closed and no cached watchlist dashboard is available yet.',
      }),
    };
  }

  const attachLiveWatchlistPayload = (payload, options = {}) => ({
    watchlistAiPayload: attachWatchlistSessionMeta(payload.watchlistAiPayload, {
      marketOpen,
      marketSession,
      liveDataEnabled: true,
      stale: Boolean(options.stale),
      message: options.message,
    }),
    stocksPayload: attachWatchlistSessionMeta(payload.stocksPayload, {
      marketOpen,
      marketSession,
      liveDataEnabled: true,
      stale: Boolean(options.stale),
      message: options.message,
    }),
  });

  if (watchlistResponseCache.payload && watchlistResponseCache.expiresAt > now) {
    return attachLiveWatchlistPayload(watchlistResponseCache.payload);
  }

  const startRefresh = () => {
    if (!watchlistResponseCache.promise) {
      watchlistResponseCache.promise = buildLiveWatchlistPayloads()
        .then((payload) => {
          watchlistResponseCache = {
            expiresAt: Date.now() + Math.max(refreshIntervalMs, WATCHLIST_CACHE_TTL_MS),
            payload,
            promise: null,
          };
          return payload;
        })
        .catch((error) => {
          watchlistResponseCache.promise = null;
          console.error('Watchlist cache refresh failed:', error.message);
          throw error;
        });
    }
    return watchlistResponseCache.promise;
  };

  if (watchlistResponseCache.payload) {
    startRefresh().catch(() => {});
    return attachLiveWatchlistPayload(watchlistResponseCache.payload, {
      stale: true,
      message: 'Refreshing live watchlist data in the background.',
    });
  }

  const payload = await startRefresh();
  return attachLiveWatchlistPayload(payload);
}

function computeHoldingSignalScore(holding, usSnapshot) {
  let score = 0;
  const movePct = toNumber(holding.movePct);
  const totalReturnPct = toNumber(holding.totalReturnPct);
  const regime = usSnapshot?.regime || '';
  const breadth = toNumber(usSnapshot?.breadth?.sectorsPositivePercent);
  const leadership = usSnapshot?.sectorLeadership?.leadershipStyle || '';
  const semiBreadth = usSnapshot?.semiconductors?.breadthLabel || 'not available';

  if (movePct !== null) {
    if (movePct >= 2) score += 2;
    else if (movePct >= 0.4) score += 1;
    else if (movePct <= -2) score -= 2;
    else if (movePct <= -0.4) score -= 1;
  }

  if (totalReturnPct !== null) {
    if (totalReturnPct >= 4) score += 1;
    else if (totalReturnPct <= -3) score -= 1;
  }

  if (regime === 'US RISK-ON') score += 2;
  else if (regime === 'US NEUTRAL') score += 0;
  else if (regime === 'US RISK-OFF') score -= 2;

  if (breadth !== null) {
    if (breadth >= 55) score += 1;
    else if (breadth < 45) score -= 1;
  }

  if (isSemiTicker(holding.ticker)) {
    if (semiBreadth === 'strong') score += 1;
    if (semiBreadth === 'weak') score -= 2;
  }

  if (['tech-led', 'broad-based'].includes(leadership) && ['NVDA', 'AMD', 'MU', 'AVGO', 'AAPL', 'AMZN', 'META', 'GOOGL'].includes(holding.ticker)) {
    score += 1;
  }

  if (holding.strength === 'weak') score -= 2;
  else if (holding.strength === 'red') score -= 1;
  else if (holding.strength === 'green' || holding.strength === 'strong') score += 1;

  return score;
}

function buildTradePlan(action, livePrice, movePct, regime, basis = 'regular') {
  const price = toNumber(livePrice);
  const move = Math.abs(toNumber(movePct) || 0);
  if (price === null) {
    return {
      entryPrice: null,
      exitPrice: null,
      stopLoss: null,
      target1: null,
      target2: null,
      setup: 'No live price available',
    };
  }

  const stopPct = regime === 'US RISK-ON' ? 0.035 : regime === 'US NEUTRAL' ? 0.03 : 0.025;
  const targetPct1 = Math.max(0.03, Math.min(0.06, 0.03 + move / 200));
  const targetPct2 = Math.max(0.06, Math.min(0.1, targetPct1 * 1.8));
  const pullbackPct = basis === 'regular' ? 0.004 : 0.0075;

  if (action === 'BUY') {
    return {
      entryPrice: round(price * (1 - pullbackPct), 2),
      exitPrice: null,
      stopLoss: round(price * (1 - stopPct), 2),
      target1: round(price * (1 + targetPct1), 2),
      target2: round(price * (1 + targetPct2), 2),
      setup: 'Use a limit buy on a small pullback instead of chasing the current print.',
    };
  }

  if (action === 'SELL') {
    return {
      entryPrice: null,
      exitPrice: round(price, 2),
      stopLoss: null,
      target1: null,
      target2: null,
      setup: 'Use a limit sell near the current extended-hours price and do not wait for a perfect exit.',
    };
  }

  if (action === 'REDUCE') {
    return {
      entryPrice: null,
      exitPrice: round(price, 2),
      stopLoss: round(price * (1 - stopPct), 2),
      target1: round(price * (1 + targetPct1), 2),
      target2: null,
      setup: 'Trim a partial position now and keep a tighter stop on the remainder.',
    };
  }

  return {
    entryPrice: round(price * (1 - 0.015), 2),
    exitPrice: null,
    stopLoss: round(price * (1 - stopPct), 2),
    target1: round(price * (1 + targetPct1), 2),
    target2: round(price * (1 + targetPct2), 2),
    setup: 'Hold current size. Only add on a controlled dip or stronger confirmation.',
  };
}

function buildHoldingReasons(holding, usSnapshot, score, headlines) {
  const reasons = [];
  reasons.push(`Score ${score} with US regime ${usSnapshot?.regime || 'not available'}.`);
  reasons.push(`Current move is ${formatSignedValue(holding.movePct, 2, '%')} on a ${holding.moveBasis || 'regular'} basis.`);
  reasons.push(`Total return is ${formatSignedValue(holding.totalReturnPct, 2, '%')} on your position.`);
  if (isSemiTicker(holding.ticker)) {
    reasons.push(`Semi breadth is ${usSnapshot?.semiconductors?.breadthLabel || 'not available'}.`);
  }
  if (headlines?.[0]?.title) {
    reasons.push(`Top catalyst: ${headlines[0].title}`);
  }
  return reasons;
}

function buildHoldingRecommendation(holding, usSnapshot, headlines) {
  const baseScore = computeHoldingSignalScore(holding, usSnapshot);
  const news = computeHoldingNewsScore(holding, headlines);
  const score = baseScore + news.score;
  const overnightRisk = computeOvernightRisk(holding, usSnapshot, news.summary);
  const totalReturnPct = toNumber(holding.totalReturnPct);
  const movePct = toNumber(holding.movePct);
  const session = getUsSessionLabel();
  const profitable = totalReturnPct !== null && totalReturnPct > 0;
  const extended = movePct !== null && movePct >= 3;
  let action = 'HOLD_OVERNIGHT';

  if (score >= 5 && overnightRisk.score <= 2 && session !== 'near close' && !extended) {
    action = 'BUY_TODAY';
  } else if (score >= 4 && (session === 'near close' || extended || overnightRisk.score >= 3)) {
    action = 'WATCH_ONLY';
  } else if (score <= -4) {
    action = profitable ? 'REDUCE_BEFORE_CLOSE' : 'SELL_NEXT_SESSION';
  } else if (profitable && overnightRisk.score >= 4) {
    action = 'REDUCE_BEFORE_CLOSE';
  } else if (!profitable && overnightRisk.score >= 5) {
    action = 'SELL_NEXT_SESSION';
  }

  const conviction = score >= 5 || score <= -4 || overnightRisk.score >= 5 ? 'High' : Math.abs(score) >= 2 || overnightRisk.score >= 3 ? 'Medium' : 'Low';
  const tradePlan = buildOvernightTradePlan(action, holding.livePrice ?? holding.lastPrice, holding.movePct, usSnapshot?.regime, holding.moveBasis);

  return {
    action,
    actionLabel: formatHoldingActionLabel(action),
    conviction,
    score,
    baseScore,
    newsScore: news.score,
    signalBreakdown: {
      baseScore,
      newsScore: news.score,
      overnightRiskScore: overnightRisk.score,
      overnightRiskLevel: overnightRisk.level,
      session: session,
      profitable,
      extended,
      headlineSummary: news.summary,
    },
    overnightRisk,
    executionConstraint: 'No same-session round trip. New buys must be held into the next session.',
    rationale: buildHoldingReasons(holding, usSnapshot, score, headlines),
    riskFlags: [
      holding.moveBasis !== 'regular' ? `Trading on ${holding.moveBasis} liquidity.` : null,
      usSnapshot?.regime === 'US RISK-OFF' ? 'Macro regime is risk-off.' : null,
      isSemiTicker(holding.ticker) && usSnapshot?.semiconductors?.breadthLabel === 'weak' ? 'Semiconductor breadth is weak.' : null,
      news.summary.eventRiskCount ? 'Headline flow contains event-driven overnight risk.' : null,
      news.summary.lowCredibilityCount >= 2 ? 'Signal quality is diluted by speculative headlines.' : null,
    ].filter(Boolean),
    ...tradePlan,
  };
}

async function buildLiveUsPortfolio(portfolio, usSnapshot) {
  if (!portfolio || !Array.isArray(portfolio.holdings) || !portfolio.holdings.length) {
    return null;
  }

  const activeTradeDate = getCurrentUsTradingDate();
  const tradeDateLots = buildUsTradeDateLots(portfolio.orders, activeTradeDate);

  const quotePromises = portfolio.holdings.map((holding) =>
    safeFetch(`PORT_${holding.ticker}_QUOTE`, () => fetchUsEquityQuoteCached(holding.ticker)),
  );
  const headlinePromises = portfolio.holdings.map((holding) =>
    safeFetch(`PORT_${holding.ticker}_HEADLINES`, () => fetchTickerHeadlinesCached(holding.ticker, holding.name)),
  );

  const [quotes, headlinesList] = await Promise.all([Promise.all(quotePromises), Promise.all(headlinePromises)]);

  const holdings = portfolio.holdings.map((holding, index) => {
    const quote = quotes[index] || {};
    const quantity = toNumber(holding.quantity);
    const avgPrice = toNumber(holding.avgPrice);
    const importedInvested = toNumber(holding.invested);
    const investedRaw = importedInvested ?? (quantity !== null && avgPrice !== null ? quantity * avgPrice : null);
    const invested = investedRaw !== null ? round(investedRaw, 2) : null;
    const regularPrice = quote.price ?? toNumber(holding.lastPrice);
    const importedMovePct = toNumber(holding.movePct);
    const fallbackPreviousClose =
      regularPrice !== null && importedMovePct !== null && importedMovePct !== -100
        ? round(regularPrice / (1 + importedMovePct / 100), 4)
        : null;
    const previousClose = quote.previousClose ?? fallbackPreviousClose ?? null;
    const extendedPrice = quote.extended?.price ?? null;
    const importedValue = toNumber(holding.currentValue);
    const importedReturn = toNumber(holding.totalReturn);
    const importedReturnPct = toNumber(holding.totalReturnPct);
    const currentValueRaw = quantity !== null && regularPrice !== null ? quantity * regularPrice : importedValue;
    const currentValue = currentValueRaw !== null ? round(currentValueRaw, 2) : null;
    const actualReturn = currentValue !== null && invested !== null ? round(currentValue - invested, 2) : importedReturn;
    const actualReturnPct =
      actualReturn !== null && invested !== null && invested !== 0 ? round((actualReturn / invested) * 100, 2) : importedReturnPct;
    const tradeLots = tradeDateLots[String(holding.ticker || '').toUpperCase()] || null;
    const buyLots = Array.isArray(tradeLots?.buys) ? tradeLots.buys : [];
    let remainingHeldBuyQuantity = quantity ?? null;
    let todayBoughtQuantityRaw = 0;
    let todayBoughtValueBasisRaw = 0;
    if (remainingHeldBuyQuantity !== null && remainingHeldBuyQuantity > 0) {
      for (const lot of buyLots) {
        const lotQuantity = toNumber(lot?.quantity);
        const lotPrice = toNumber(lot?.price);
        if (lotQuantity === null || lotQuantity <= 0 || remainingHeldBuyQuantity <= 0) {
          continue;
        }
        const matchedQuantity = Math.min(remainingHeldBuyQuantity, lotQuantity);
        todayBoughtQuantityRaw += matchedQuantity;
        if (lotPrice !== null) {
          todayBoughtValueBasisRaw += matchedQuantity * lotPrice;
        } else if (regularPrice !== null) {
          todayBoughtValueBasisRaw += matchedQuantity * regularPrice;
        }
        remainingHeldBuyQuantity -= matchedQuantity;
      }
    }
    const heldQuantityAtPreviousCloseRaw =
      quantity !== null ? Math.max(0, quantity - todayBoughtQuantityRaw) : null;
    const heldQuantityAtPreviousClose = heldQuantityAtPreviousCloseRaw !== null ? round(heldQuantityAtPreviousCloseRaw, 6) : null;
    const todayBoughtQuantity = todayBoughtQuantityRaw ? round(todayBoughtQuantityRaw, 6) : 0;
    const previousCloseValueRaw =
      heldQuantityAtPreviousCloseRaw !== null && previousClose !== null ? heldQuantityAtPreviousCloseRaw * previousClose : null;
    const previousCloseValue = previousCloseValueRaw !== null ? round(previousCloseValueRaw, 2) : null;
    const overnightOneDayReturnRaw =
      heldQuantityAtPreviousCloseRaw !== null && regularPrice !== null && previousClose !== null
        ? heldQuantityAtPreviousCloseRaw * (regularPrice - previousClose)
        : null;
    const todayBoughtOneDayReturnRaw =
      todayBoughtQuantityRaw > 0 && regularPrice !== null
        ? todayBoughtQuantityRaw * regularPrice - todayBoughtValueBasisRaw
        : 0;
    const oneDayReturnRaw =
      overnightOneDayReturnRaw !== null || todayBoughtQuantityRaw > 0
        ? (overnightOneDayReturnRaw || 0) + todayBoughtOneDayReturnRaw
        : null;
    const oneDayReturn = oneDayReturnRaw !== null ? round(oneDayReturnRaw, 2) : null;
    const oneDayReturnPct =
      oneDayReturn !== null &&
      previousCloseValueRaw !== null &&
      todayBoughtValueBasisRaw + previousCloseValueRaw !== 0
        ? round((oneDayReturn / (previousCloseValueRaw + todayBoughtValueBasisRaw)) * 100, 2)
        : null;
    const extendedValueRaw = quantity !== null && extendedPrice !== null ? quantity * extendedPrice : null;
    const extendedValue = extendedValueRaw !== null ? round(extendedValueRaw, 2) : null;
    const headlines = Array.isArray(headlinesList[index]) ? headlinesList[index] : [];
    const display = chooseDisplayMove(quote);

    const enriched = {
      ...holding,
      avgPrice: avgPrice ?? toNumber(holding.avgPrice),
      investedRaw,
      currentValueRaw,
      extendedValueRaw,
      previousCloseValueRaw,
      sourceTitle: quote.title || holding.sourceTitle || '',
      previousClose,
      heldQuantityAtPreviousClose,
      todayBoughtQuantity,
      previousCloseValue,
      regularPrice: regularPrice ?? null,
      extendedPrice,
      extendedValue: extendedValue ?? null,
      livePrice: display.lastPrice ?? regularPrice ?? null,
      importedValue: importedValue ?? null,
      importedReturn: importedReturn ?? null,
      importedReturnPct: importedReturnPct ?? null,
      currentValue: currentValue ?? null,
      actualReturn: actualReturn ?? null,
      actualReturnPct: actualReturnPct ?? null,
      liveValue: currentValue ?? null,
      liveReturn: actualReturn ?? null,
      liveReturnPct: actualReturnPct ?? null,
      oneDayReturn,
      oneDayReturnPct,
      totalReturn: actualReturn ?? importedReturn ?? null,
      totalReturnPct: actualReturnPct ?? importedReturnPct ?? null,
      sessionMovePct: quote.pctChange ?? importedMovePct,
      sessionMoveAbs: quote.absChange ?? (previousClose !== null && regularPrice !== null ? round(regularPrice - previousClose, 2) : null),
      extendedMovePct: quote.extended?.pctChange ?? null,
      extendedMoveAbs: quote.extended?.absChange ?? null,
      movePct: display.movePct ?? quote.pctChange ?? toNumber(holding.movePct),
      moveAbs: display.moveAbs ?? quote.absChange ?? null,
      moveBasis: display.basis || holding.moveBasis || 'regular',
      strength: classifyUsStrength(quote.pctChange ?? display.movePct ?? toNumber(holding.movePct)),
      dayRange: quote.dayRange || '',
      headlines,
      catalyst: headlines[0]?.title || holding.note || 'no clear catalyst',
    };

    const recommendation = buildHoldingRecommendation(enriched, usSnapshot, headlines);

    return {
      ...enriched,
      recommendation,
    };
  });

  const aiEnhancedHoldings = await Promise.all(
    holdings.map(async (holding) => {
      const cachedOverlay = await loadCachedAiHoldingOverlay(holding, usSnapshot, holding.recommendation, holding.headlines);
      const recommendation = cachedOverlay
        ? mergeAiRecommendation(holding.recommendation, cachedOverlay, holding, usSnapshot)
        : {
            ...holding.recommendation,
            aiOverlay: {
              enabled: false,
              reason: CONFIG.openaiApiKey ? 'Run AI analysis on demand.' : 'OPENAI_API_KEY not configured',
            },
          };
      return {
        ...holding,
        recommendation,
      };
    }),
  );

  const computedInvestedValue = aiEnhancedHoldings.reduce(
    (sum, holding) => sum + (toNumber(holding.investedRaw) || toNumber(holding.invested) || 0),
    0,
  );
  const importedPortfolioValue = aiEnhancedHoldings.reduce((sum, holding) => sum + (toNumber(holding.importedValue) || 0), 0);
  const storedSummary = portfolio.summary || {};
  const storedInvestedValue = toNumber(storedSummary.investedValue);
  const investedValue = storedInvestedValue ?? round(computedInvestedValue, 2);
  const importedTotalReturns = round(importedPortfolioValue - investedValue, 2);
  const importedTotalReturnsPct = investedValue ? round((importedTotalReturns / investedValue) * 100, 2) : null;
  const currentPortfolioValue = aiEnhancedHoldings.reduce(
    (sum, holding) => sum + (toNumber(holding.currentValueRaw) || toNumber(holding.currentValue) || 0),
    0,
  );
  const currentTotalReturns = round(currentPortfolioValue - investedValue, 2);
  const currentTotalReturnsPct = investedValue ? round((currentTotalReturns / investedValue) * 100, 2) : null;
  const previousClosePortfolioValue = aiEnhancedHoldings.reduce(
    (sum, holding) => sum + (toNumber(holding.previousCloseValueRaw) || toNumber(holding.previousCloseValue) || 0),
    0,
  );
  const liveOneDayReturn = aiEnhancedHoldings.reduce((sum, holding) => sum + (toNumber(holding.oneDayReturn) || 0), 0);
  const liveOneDayReturnPct =
    previousClosePortfolioValue ? round((liveOneDayReturn / previousClosePortfolioValue) * 100, 2) : null;
  const storedBrokerPortfolioValue = toNumber(storedSummary.portfolioValue);
  const storedBrokerReturn = toNumber(storedSummary.totalReturns);
  const storedBrokerReturnPct = toNumber(storedSummary.totalReturnsPct);
  const storedBuyingPower = toNumber(storedSummary.buyingPower);

  const bestHolding = [...aiEnhancedHoldings].sort((a, b) => (toNumber(b.liveReturnPct) ?? -999) - (toNumber(a.liveReturnPct) ?? -999))[0] || null;
  const weakestHolding = [...aiEnhancedHoldings].sort((a, b) => (toNumber(a.liveReturnPct) ?? 999) - (toNumber(b.liveReturnPct) ?? 999))[0] || null;

  return {
    ...portfolio,
    isLive: true,
    source: 'live',
    importedUpdatedAt: portfolio.updatedAt || null,
    snapshotUpdatedAt: portfolio.updatedAt || null,
    updatedAt: nowTimestamp(),
    holdings: aiEnhancedHoldings,
    insights: {
      bestHolding: bestHolding ? `${bestHolding.ticker} ${formatSignedValue(bestHolding.liveReturnPct, 2, '%')}` : 'not available',
      weakestHolding: weakestHolding ? `${weakestHolding.ticker} ${formatSignedValue(weakestHolding.liveReturnPct, 2, '%')}` : 'not available',
      actionMix: aiEnhancedHoldings.reduce(
        (acc, holding) => {
          const action = holding.recommendation?.action || 'HOLD';
          acc[action] = (acc[action] || 0) + 1;
          return acc;
        },
        {},
      ),
    },
    summary: {
      ...portfolio.summary,
      holdingsCount: aiEnhancedHoldings.length,
      investedValue: round(investedValue, 2),
      portfolioValue: round(currentPortfolioValue, 2),
      totalReturns: currentTotalReturns,
      totalReturnsPct: currentTotalReturnsPct,
      buyingPower: storedBuyingPower ?? toNumber(portfolio.summary?.buyingPower) ?? null,
      snapshotPortfolioValue: storedBrokerPortfolioValue ?? round(importedPortfolioValue, 2),
      snapshotTotalReturns: storedBrokerReturn ?? importedTotalReturns,
      snapshotTotalReturnsPct: storedBrokerReturnPct ?? importedTotalReturnsPct,
      livePortfolioValue: round(currentPortfolioValue, 2),
      liveTotalReturns: currentTotalReturns,
      liveTotalReturnsPct: currentTotalReturnsPct,
      oneDayReturn: previousClosePortfolioValue ? round(liveOneDayReturn, 2) : null,
      oneDayReturnPct: liveOneDayReturnPct ?? null,
      liveVsImportedDelta: round(currentPortfolioValue - importedPortfolioValue, 2),
    },
  };
}

function buildWatchlistNote(holding) {
  if (!holding) {
    return 'Hold core winners; no trim trigger.';
  }
  if (holding.strength === 'weak') {
    return `${holding.ticker} is materially weaker than the rest. Do not add; trim if weakness persists.`;
  }
  if (holding.strength === 'red') {
    return `${holding.ticker} is lagging. Avoid adding and review for trim if relative weakness continues.`;
  }
  return 'Hold core winners; no trim trigger.';
}

function buildEngineReport(indSnapshot, usSnapshot, globalDecision, portfolio) {
  const ind = indSnapshot || {};
  const us = usSnapshot || {};
  const watchlistRows = Array.isArray(us.watchlist) && us.watchlist.length
    ? us.watchlist
        .map((item) => `${item.ticker} | ${formatSignedValue(item.movePct, 2, '%')} | ${item.strength || 'not available'} | ${item.note || 'not available'}`)
        .join('\n')
    : 'not available';
  const portfolioRows = Array.isArray(portfolio?.holdings) && portfolio.holdings.length
    ? portfolio.holdings
        .map(
          (item) =>
            `${item.ticker} | Qty ${formatValue(item.quantity, 6)} | Avg ${formatPortfolioMoney(item.avgPrice)} | Last ${formatPortfolioMoney(item.livePrice ?? item.lastPrice)} | Value ${formatPortfolioMoney(item.currentValue)} | P/L ${formatPortfolioMoney(item.totalReturn)} (${formatSignedValue(item.totalReturnPct, 2, '%')})`,
        )
        .join('\n')
    : 'not available';
  const recommendationRows = Array.isArray(portfolio?.holdings) && portfolio.holdings.length
    ? portfolio.holdings
        .map((item) => {
          const rec = item.recommendation || {};
          return `${item.ticker} | ${displayOrNA(rec.actionLabel || rec.action)} | Entry ${formatPortfolioMoney(rec.entryPrice)} | Exit ${formatPortfolioMoney(rec.exitPrice)} | Stop ${formatPortfolioMoney(rec.stopLoss)} | T1 ${formatPortfolioMoney(rec.target1)} | T2 ${formatPortfolioMoney(rec.target2)} | Review ${displayOrNA(rec.reviewWindow)} | ${Array.isArray(rec.rationale) ? rec.rationale[0] : 'not available'}`;
        })
        .join('\n')
    : 'not available';

  return [
    'IND Block:',
    `- Timestamp IST: ${displayOrNA(ind.timestamp)}`,
    `- Session: ${displayOrNA(ind.session)}`,
    `- PRE-OPEN: ${
      ind.preOpen?.available
        ? `Time ${displayOrNA(ind.preOpen.timestamp)} | Nifty ${formatValue(ind.preOpen.niftyIndicative)} / ${formatSignedValue(ind.preOpen.niftyPct, 2, '%')} / ${displayOrNA(ind.preOpen.niftyGap)} | Bank Nifty ${formatValue(ind.preOpen.bankIndicative)} / ${formatSignedValue(ind.preOpen.bankPct, 2, '%')} / ${displayOrNA(ind.preOpen.bankGap)} | breadth ${displayOrNA(ind.preOpen.breadthStyle)} | confidence ${displayOrNA(ind.preOpen.confidenceAdjustment)}`
        : 'not available'
    }`,
    `- Pre-open movers: ${
      ind.preOpen?.available
        ? `Top gainers ${Array.isArray(ind.preOpen.topGainers) && ind.preOpen.topGainers.length ? ind.preOpen.topGainers.join(', ') : 'not available'} | Top losers ${Array.isArray(ind.preOpen.topLosers) && ind.preOpen.topLosers.length ? ind.preOpen.topLosers.join(', ') : 'not available'}`
        : 'not available'
    }`,
    `- IND Regime: ${displayOrNA(ind.regime)}`,
    `- IND Score: ${ind.score === null || ind.score === undefined ? 'not available' : ind.score}`,
    `- Core: GiftNifty ${formatValue(ind.giftNifty)} / ${formatSignedValue(ind.giftNiftyPct, 2, '%')} | Nifty ${formatValue(ind.niftySpotPrevClose)} prev close / ${formatValue(ind.indices?.nifty50)} latest | BankNifty ${formatValue(ind.indices?.bankNifty)} / ${formatSignedValue(ind.indices?.bankNiftyPct, 2, '%')} | Midcap ${formatSignedValue(ind.indices?.midcapPct, 2, '%')} | Smallcap ${formatSignedValue(ind.indices?.smallcapPct, 2, '%')}`,
    `- Volatility & breadth: IndiaVIX ${formatValue(ind.indiaVix)} / ${displayOrNA(ind.indiaVixDirection)} | A-D ${formatValue(ind.advanceDecline)} | FII ${formatValue(ind.fiiNet)} | DII ${formatValue(ind.diiNet)} | MCAP ${formatValue(ind.marketCapChangeCr)}`,
    `- Derivatives: PCR Nifty ${formatValue(ind.niftyPcr)} / Bank ${formatValue(ind.bankNiftyPcr)} | OI Nifty ${formatValue(ind.niftyOiCr)} / Bank ${formatValue(ind.bankNiftyOiCr)} | Max Pain Nifty ${formatInteger(ind.niftyMaxPain)} / Bank ${formatInteger(ind.bankNiftyMaxPain)} | F&O turnover ${formatValue(ind.fnoTurnoverCr)}`,
    `- Macro: USDINR ${formatValue(ind.usdInr)} / ${formatSignedValue(ind.usdInrChange)} | Brent ${formatValue(ind.brent)} / ${formatSignedValue(ind.brentPct, 2, '%')} | Gold INR ${formatValue(ind.goldInr10g)} / ${formatSignedValue(ind.goldInrPct, 2, '%')} | India 10Y ${formatValue(ind.india10Y, 2, '%')} / ${formatSignedValue(ind.india10YBpChange, 1, ' bp')}`,
    `- Sector leadership: ${displayOrNA(ind.sectorLeadershipStyle)}`,
    `- India events: ${Array.isArray(ind.indiaEvents) && ind.indiaEvents.length ? ind.indiaEvents.join(' | ') : 'not available'}`,
    `- India summary: ${displayOrNA(ind.indiaSummary)}`,
    '',
    'US Block:',
    `- Timestamp IST: ${displayOrNA(us.timestamp)}`,
    `- Session: ${displayOrNA(us.session)}`,
    `- US Regime: ${displayOrNA(us.regime)}`,
    `- US Score: ${us.score === null || us.score === undefined ? 'not available' : us.score}`,
    `- Core: S&P ${formatValue(us.macro?.spFutures)} / ${formatSignedValue(us.macro?.spFuturesPct, 2, '%')} | Nasdaq ${formatValue(us.macro?.nasdaqFutures)} / ${formatSignedValue(us.macro?.nasdaqFuturesPct, 2, '%')} | Dow ${formatValue(us.macro?.dowFutures)} / ${formatSignedValue(us.macro?.dowFuturesPct, 2, '%')} | Russell ${formatValue(us.macro?.russell2000)} / ${formatSignedValue(us.macro?.russell2000Pct, 2, '%')} | SPY ${formatSignedValue(us.spy?.movePct, 2, '%')} | QQQ ${formatSignedValue(us.qqq?.movePct, 2, '%')}`,
    `- Volatility & macro: VIX ${formatValue(us.macro?.vix)} / ${displayOrNA(us.macro?.volatilityTrend)} | US10Y ${formatValue(us.macro?.us10y, 3, '%')} / ${formatSignedValue(us.macro?.us10yChangeBp, 1, ' bp')} | US2Y ${formatValue(us.macro?.us2y, 3, '%')} / ${formatSignedValue(us.macro?.us2yChangeBp, 1, ' bp')} | DXY ${formatValue(us.macro?.dxy, 3)} / ${formatSignedValue(us.macro?.dxyPct, 2, '%')} | Brent ${formatValue(us.macro?.brent)} / ${formatSignedValue(us.macro?.brentPct, 2, '%')} | WTI ${formatValue(us.macro?.wti)} / ${formatSignedValue(us.macro?.wtiPct, 2, '%')} | Gold ${formatValue(us.macro?.gold)} / ${formatSignedValue(us.macro?.goldPct, 2, '%')}`,
    `- Breadth: NYSE A-D ${formatValue(us.breadth?.nyseAdvanceDecline)} | Nasdaq A-D ${formatValue(us.breadth?.nasdaqAdvanceDecline)} | % sectors green ${formatValue(us.breadth?.sectorsPositivePercent, 0, '%')} | above 50DMA if available SPX ${formatValue(us.breadth?.spxAbove50Dma, 0)} / NDX ${formatValue(us.breadth?.ndxAbove50Dma, 0)}`,
    `- Semiconductors: SOX ${formatSignedValue(us.semiconductors?.SOX?.movePct, 2, '%')} | SMH ${formatSignedValue(us.semiconductors?.SMH?.movePct, 2, '%')} | AVGO ${formatSignedValue(us.semiconductors?.AVGO?.movePct, 2, '%')} | QCOM ${formatSignedValue(us.semiconductors?.QCOM?.movePct, 2, '%')} | AMD ${formatSignedValue(us.semiconductors?.AMD?.movePct, 2, '%')} | NVDA ${formatSignedValue(us.semiconductors?.NVDA?.movePct, 2, '%')} | MU ${formatSignedValue(us.semiconductors?.MU?.movePct, 2, '%')} | breadth label ${displayOrNA(us.semiconductors?.breadthLabel)}`,
    `- Intraday structure: VWAP status SPY ${displayOrNA(us.intraday?.spyVwapStatus)} / QQQ ${displayOrNA(us.intraday?.qqqVwapStatus)} | opening range ${displayOrNA(us.intraday?.openingRangeStatus)}`,
    `- Sector leadership: ${displayOrNA(us.sectorLeadership?.leadershipStyle)}`,
    '- Watchlist table:',
    'Ticker | Move | Strength | Note',
    watchlistRows,
    `- US events: ${Array.isArray(us.news?.pendingEvents) && us.news.pendingEvents.length ? us.news.pendingEvents.join(' | ') : 'not available'}`,
    `- US summary: ${displayOrNA(us.usSummary)}`,
    '',
    'US Portfolio:',
    `- Updated at: ${displayOrNA(portfolio?.updatedAt)}`,
    `- Source: ${displayOrNA(portfolio?.source)}`,
    `- Portfolio value: ${formatPortfolioMoney(portfolio?.summary?.portfolioValue)}`,
    `- Invested value: ${formatPortfolioMoney(portfolio?.summary?.investedValue)}`,
    `- Total return: ${formatPortfolioMoney(portfolio?.summary?.totalReturns)} (${formatSignedValue(portfolio?.summary?.totalReturnsPct, 2, '%')})`,
    `- Buying power: ${formatPortfolioMoney(portfolio?.summary?.buyingPower)}`,
    `- 1D holdings return: ${formatPortfolioMoney(portfolio?.summary?.oneDayReturn)} (${formatSignedValue(portfolio?.summary?.oneDayReturnPct, 2, '%')})`,
    `- Best holding: ${displayOrNA(portfolio?.insights?.bestHolding)}`,
    `- Weakest holding: ${displayOrNA(portfolio?.insights?.weakestHolding)}`,
    '- Holdings table:',
    'Ticker | Quantity | Avg | Last | Value | P/L',
    portfolioRows,
    '- Recommendation table:',
    'Ticker | Action | Entry | Exit | Stop | T1 | T2 | Reason',
    recommendationRows,
    '',
    'Global Decision:',
    `- Global Regime: ${displayOrNA(globalDecision.regime)}`,
    `- Confidence: ${displayOrNA(globalDecision.confidence)}`,
    `- Recommended stance: ${displayOrNA(globalDecision.recommendedStance)}`,
    `- Exact action for my current cash: ${displayOrNA(globalDecision.cashAction)}`,
    `- Exact action for my current holdings: ${displayOrNA(globalDecision.holdingsAction)}`,
    `- Exact action for India if market is closed: ${displayOrNA(globalDecision.indiaClosedAction)}`,
    `- Next 30 minutes: ${displayOrNA(globalDecision.nextThirtyMinutes)}`,
    '',
    `${displayOrNA(globalDecision.actionSummary)}`,
  ].join('\n');
}

function buildUsActionPlan(regime) {
  if (regime === 'US RISK-ON') {
    return {
      decision: 'Deploy now',
      actionPlan:
        'Deploy 15-20% of available cash today. Start with SPY, then add only 3-5% staggered buys into strongest names after confirmation.',
      nextStep: 'Next 30 minutes: begin with a small SPY starter only, then stagger adds if the first 15-60 minutes stay constructive.',
    };
  }
  if (regime === 'US NEUTRAL') {
    return {
      decision: 'Wait',
      actionPlan:
        'Wait 15-60 minutes after the open. Only buy if futures strength holds, VIX/yields calm down, and your watchlist turns broadly green.',
      nextStep: 'Next 30 minutes: preserve cash and wait for post-open confirmation before adding anything.',
    };
  }
  return {
    decision: 'Defensive only',
    actionPlan: 'Preserve cash. Do not add fresh risk today unless the regime improves materially after the open.',
    nextStep: 'Next 30 minutes: stay defensive and avoid new buys.',
  };
}

function pushSignal(bucket, value, positive, negative) {
  const n = toNumber(value);
  if (n === null) {
    return;
  }
  if (n >= positive) {
    bucket.push(1);
  } else if (n <= negative) {
    bucket.push(-1);
  }
}

function pushSignalReverse(bucket, value, positive, negative) {
  const n = toNumber(value);
  if (n === null) {
    return;
  }
  if (n <= positive) {
    bucket.push(1);
  } else if (n >= negative) {
    bucket.push(-1);
  }
}

function classifyIndiaRegime(snapshot) {
  let score = 0;
  let usableSignals = 0;
  const preOpenAvailable = snapshot.session === 'pre-open' && snapshot.preOpen?.available;
  const add = (condition) => {
    if (condition !== null && condition !== undefined) {
      usableSignals += 1;
    }
    if (condition === true) {
      score += 1;
    }
  };

  add(toNumber(snapshot.giftNiftyPct) !== null ? toNumber(snapshot.giftNiftyPct) > 0.4 : null);
  add(toNumber(snapshot?.indices?.bankNiftyPct) !== null ? toNumber(snapshot.indices.bankNiftyPct) > 0.5 : null);
  add(
    toNumber(snapshot?.indices?.midcapPct) !== null && toNumber(snapshot?.indices?.smallcapPct) !== null
      ? toNumber(snapshot.indices.midcapPct) > 0 && toNumber(snapshot.indices.smallcapPct) > 0
      : null,
  );
  add(snapshot.indiaVixDirection ? snapshot.indiaVixDirection === 'falling' || toNumber(snapshot.indiaVix) < 16 : null);
  add(toNumber(snapshot.advanceDecline) !== null ? toNumber(snapshot.advanceDecline) > 1.2 : null);
  add(toNumber(snapshot.fiiNet) !== null ? toNumber(snapshot.fiiNet) > 0 : null);
  add(toNumber(snapshot.brentPct) !== null ? toNumber(snapshot.brentPct) <= 0 : null);
  add(toNumber(snapshot.goldInrPct) !== null ? toNumber(snapshot.goldInrPct) <= 0 : null);

  if (toNumber(snapshot.fiiNet) !== null && toNumber(snapshot.fiiNet) <= -1000) {
    score -= 1;
  }
  if (snapshot.indiaVixDirection === 'rising' && toNumber(snapshot.indiaVixChange) !== null && toNumber(snapshot.indiaVixChange) >= 0.5) {
    score -= 1;
  }
  if (toNumber(snapshot.usdInrChange) !== null && toNumber(snapshot.usdInrChange) >= 0.2) {
    score -= 1;
  }
  if (toNumber(snapshot.brentPct) !== null && toNumber(snapshot.brentPct) >= 1) {
    score -= 1;
  }
  if (toNumber(snapshot.advanceDecline) !== null && toNumber(snapshot.advanceDecline) < 1) {
    score -= 1;
  }
  if (snapshot.sectorLeadershipStyle === 'Defensives-led') {
    score -= 1;
  }
  if (preOpenAvailable && snapshot.preOpen?.confidenceAdjustment === 'upgrade') {
    score += 1;
  }
  if (preOpenAvailable && snapshot.preOpen?.confidenceAdjustment === 'downgrade') {
    score -= 1;
  }

  let regime = 'IND RISK-OFF';
  if (score >= 4) {
    regime = 'IND RISK-ON';
  } else if (score >= 2) {
    regime = 'IND NEUTRAL';
  }
  if (preOpenAvailable && snapshot.preOpen?.cautiousNeutral && regime === 'IND RISK-ON') {
    regime = 'IND CAUTIOUS-NEUTRAL';
  }

  return {
    regime,
    score,
    usableSignals,
  };
}

function classifyUsRegime(snapshot) {
  let score = 0;
  let usableSignals = 0;
  const addSignal = (condition) => {
    if (condition !== null && condition !== undefined) {
      usableSignals += 1;
    }
    if (condition === true) {
      score += 1;
    }
  };

  const spPct = toNumber(snapshot?.macro?.spFuturesPct);
  const nqPct = toNumber(snapshot?.macro?.nasdaqFuturesPct);
  const vix = toNumber(snapshot?.macro?.vix);
  const vixTrend = snapshot?.macro?.volatilityTrend;
  const us10yBp = toNumber(snapshot?.macro?.us10yChangeBp);
  const dxyPct = toNumber(snapshot?.macro?.dxyPct);
  const nyseBreadth = toNumber(snapshot?.breadth?.nyseAdvanceDecline);
  const nasdaqBreadth = toNumber(snapshot?.breadth?.nasdaqAdvanceDecline);
  const semis = snapshot?.semiconductors?.breadthLabel;
  const spyVwap = snapshot?.intraday?.spyVwapStatus;
  const qqqVwap = snapshot?.intraday?.qqqVwapStatus;
  const positiveOrFlat = toNumber(snapshot?.watchlistSummary?.greenOrFlatCount);
  const breadthWeak = classifyUsBreadthWeak(snapshot?.breadth);
  const rallyNarrow = snapshot?.sectorLeadership?.leadershipStyle === 'tech-led' && breadthWeak;

  addSignal(spPct === null ? null : spPct > 0.3);
  addSignal(nqPct === null ? null : nqPct > 0.4);
  addSignal(vix === null && !vixTrend ? null : vixTrend === 'falling' || (vix !== null && vix < 18));
  addSignal(us10yBp === null || dxyPct === null ? null : us10yBp <= 0 && dxyPct <= 0.2);
  addSignal(nyseBreadth === null ? null : nyseBreadth > 1);
  addSignal(nasdaqBreadth === null ? null : nasdaqBreadth > 1);
  addSignal(semis === 'not available' ? null : semis === 'strong');
  addSignal(!spyVwap || !qqqVwap ? null : spyVwap === 'above' && qqqVwap === 'above');
  addSignal(positiveOrFlat === null ? null : positiveOrFlat >= 6);

  if (vixTrend === 'rising' && toNumber(snapshot?.macro?.vixPct) !== null && toNumber(snapshot.macro.vixPct) >= 5) {
    score -= 1;
  }
  if (us10yBp !== null && us10yBp >= 5) {
    score -= 1;
  }
  if (dxyPct !== null && dxyPct >= 0.3) {
    score -= 1;
  }
  if (semis === 'weak') {
    score -= 1;
  }
  if (breadthWeak) {
    score -= 1;
  }
  if (rallyNarrow) {
    score -= 1;
  }

  let regime = 'US RISK-OFF';
  if (score >= 5) {
    regime = 'US RISK-ON';
  } else if (score >= 3) {
    regime = 'US NEUTRAL';
  }

  return {
    regime,
    score,
    usableSignals,
    confidence: computeConfidence(score, usableSignals),
  };
}

function buildGlobalDecision(indSnapshot, usSnapshot, portfolio) {
  const indRegime = indSnapshot?.regime || 'not available';
  const usRegime = usSnapshot?.regime || 'not available';
  const indIsRiskOn = indRegime === 'IND RISK-ON';
  const indIsNeutral = indRegime === 'IND NEUTRAL' || indRegime === 'IND CAUTIOUS-NEUTRAL';
  const indIsRiskOff = indRegime === 'IND RISK-OFF';
  const usIsRiskOn = usRegime === 'US RISK-ON';
  const usIsNeutral = usRegime === 'US NEUTRAL';
  const usIsRiskOff = usRegime === 'US RISK-OFF';
  let regime = 'GLOBAL RISK-OFF';
  if (indIsRiskOn && usIsRiskOn) {
    regime = 'GLOBAL RISK-ON';
  } else if (
    (indIsRiskOn && usIsNeutral) ||
    (indIsNeutral && usIsRiskOn)
  ) {
    regime = 'GLOBAL NEUTRAL+';
  } else if (indIsNeutral && usIsNeutral) {
    regime = 'GLOBAL NEUTRAL';
  } else if ((indIsRiskOff && !usIsRiskOn) || (usIsRiskOff && !indIsRiskOn)) {
    regime = 'GLOBAL RISK-OFF';
  }

  let recommendedStance = 'DEFENSIVE ONLY';
  let cashAction = 'Deploy 0% of cash. Wait for better regime quality.';
  if (regime === 'GLOBAL NEUTRAL') {
    recommendedStance = 'WAIT';
    cashAction = 'Deploy 5-10% only if you want a small starter. Prefer SPY first.';
  } else if (regime === 'GLOBAL NEUTRAL+') {
    recommendedStance = 'STAGGERED BUY';
    cashAction = 'Deploy 10-20% in staggered tranches. Start with SPY; add single names only after confirmation.';
  } else if (regime === 'GLOBAL RISK-ON') {
    recommendedStance = 'DEPLOY NOW';
    cashAction = 'Deploy 15-25% in staggered tranches. SPY first, then strongest confirmed names without chasing sharp intraday moves.';
  }

  const semiBreadth = usSnapshot?.semiconductors?.breadthLabel || 'not available';
  if (semiBreadth === 'weak') {
    cashAction += ' Avoid adding to AMD/NVDA/MU while semis are weak.';
    if (recommendedStance === 'DEPLOY NOW') {
      recommendedStance = 'STAGGERED BUY';
    }
  } else if (semiBreadth === 'mixed' && recommendedStance !== 'DEFENSIVE ONLY') {
    cashAction += ' Semis are mixed, so prefer SPY over individual tech.';
  }

  const holdingsUniverse = Array.isArray(portfolio?.holdings) && portfolio.holdings.length ? portfolio.holdings : usSnapshot?.watchlist || [];
  const reduceCandidates = holdingsUniverse.filter((item) => item.recommendation?.action === 'REDUCE_BEFORE_CLOSE');
  const sellCandidates = holdingsUniverse.filter((item) => item.recommendation?.action === 'SELL_NEXT_SESSION');
  const buyCandidates = holdingsUniverse.filter((item) => item.recommendation?.action === 'BUY_TODAY');
  const weakHoldings = holdingsUniverse.filter((item) => item.strength === 'weak' || item.strength === 'red');
  let holdingsAction = 'Hold overnight. No same-session round trip; review again next session.';
  if (reduceCandidates.length) {
    holdingsAction = `Lock some profit before the close in ${reduceCandidates.map((item) => item.ticker).join(', ')}.`;
  } else if (sellCandidates.length) {
    holdingsAction = `Line up next-session exits for ${sellCandidates.map((item) => item.ticker).join(', ')} instead of forcing same-day churn.`;
  } else if (buyCandidates.length) {
    holdingsAction = `Only add today in ${buyCandidates.map((item) => item.ticker).join(', ')} if you are comfortable holding into the next session.`;
  } else if (weakHoldings.length) {
    holdingsAction = `${buildWatchlistNote(weakHoldings[0])}${weakHoldings.length > 1 ? ` Also review ${weakHoldings.slice(1).map((item) => item.ticker).join(', ')}.` : ''}`;
  }

  const indiaClosedAction =
    indSnapshot?.session === 'post-close'
      ? 'India closed; AMO only for tomorrow. If India stays strong, use broad Nifty / largecap exposure.'
      : 'India live. Prefer broad India ETF / Nifty ETF / largecap exposure over aggressive mid/smallcap chasing.';

  const breadthConfirmed =
    toNumber(usSnapshot?.breadth?.nyseAdvanceDecline) !== null &&
    toNumber(usSnapshot?.breadth?.nasdaqAdvanceDecline) !== null &&
    toNumber(usSnapshot?.breadth?.nyseAdvanceDecline) > 1 &&
    toNumber(usSnapshot?.breadth?.nasdaqAdvanceDecline) > 1;
  const semisConfirmed = semiBreadth === 'strong';
  const vwapConfirmed = usSnapshot?.intraday?.spyVwapStatus === 'above' && usSnapshot?.intraday?.qqqVwapStatus === 'above';
  const confidence = computeGlobalConfidence({
    breadthConfirmed,
    semisConfirmed,
    vwapConfirmed,
    usableSignals: (indSnapshot?.usableSignals || 0) + (usSnapshot?.usableSignals || 0),
    scoreMagnitude: Math.abs(toNumber(indSnapshot?.score) || 0) + Math.abs(toNumber(usSnapshot?.score) || 0),
  });
  const adjustedConfidence =
    indSnapshot?.session === 'pre-open' && indSnapshot?.preOpen?.confidenceAdjustment === 'downgrade' && confidence === 'High'
      ? 'Medium'
      : indSnapshot?.session === 'pre-open' && indSnapshot?.preOpen?.confidenceAdjustment === 'downgrade'
        ? 'Low'
        : confidence;

  return {
    regime,
    confidence: adjustedConfidence,
    recommendedStance,
    cashAction,
    holdingsAction,
    indiaClosedAction,
    nextThirtyMinutes:
      recommendedStance === 'DEPLOY NOW'
        ? 'Start with tranche one only. Add more only if confirmation still holds in 30 minutes.'
        : recommendedStance === 'STAGGERED BUY'
          ? 'Scale in with one small SPY tranche only after the next confirmation check.'
          : recommendedStance === 'WAIT'
            ? 'Wait for better confirmation on breadth, semis, and rates before any order.'
            : 'Stay defensive. No fresh deployment in the next 30 minutes.',
    actionSummary:
      recommendedStance === 'DEPLOY NOW'
        ? 'Action summary: deploy 15-25% now in staggered buys, SPY first.'
        : recommendedStance === 'STAGGERED BUY'
          ? 'Action summary: stagger 10-20% at most, SPY first, avoid weak semis.'
          : recommendedStance === 'WAIT'
            ? 'Action summary: wait with cash, at most use a small SPY starter if confirmation improves.'
            : 'Action summary: stay defensive, deploy 0%, and trim only materially weak holdings.',
  };
}

async function collectIndiaSnapshot(previous) {
  const [usdInr, brent, giftNifty, indiaVix, advanceDecline, fiiDii, headline, nseIndices, india10Y, indiaEventNews, usGold, preOpenNifty, preOpenBankNifty, preOpenAll] = await Promise.all([
    safeFetch('USDINR', fetchUsdInr),
    safeFetch('BRENT', fetchBrent),
    safeFetch('GIFT_NIFTY', fetchGiftNifty),
    safeFetch('INDIA_VIX', fetchIndiaVix),
    safeFetch('ADVANCE_DECLINE', fetchAdvanceDecline),
    safeFetch('FII_DII', fetchFiiDii),
    safeFetch('HEADLINE', fetchHeadline),
    safeFetch('NSE_ALL_INDICES', fetchNseAllIndicesData),
    safeFetch('INDIA_10Y', fetchIndiaBondYield),
    safeFetch('INDIA_EVENTS', () => fetchRssHeadlines(CONFIG.urls.googleNewsIndiaEvents, 6)),
    safeFetch('US_GOLD_FOR_INDIA', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.commodities.gold)),
    safeFetch('NSE_PREOPEN_NIFTY', () => fetchNsePreOpen('NIFTY')),
    safeFetch('NSE_PREOPEN_BANKNIFTY', () => fetchNsePreOpen('BANKNIFTY')),
    safeFetch('NSE_PREOPEN_ALL', () => fetchNsePreOpen('ALL')),
  ]);

  const nifty50 = readNseIndexSnapshot(getNseIndexRow(nseIndices, 'NIFTY 50'));
  const bankNifty = readNseIndexSnapshot(getNseIndexRow(nseIndices, 'NIFTY BANK'));
  const midcap = readNseIndexSnapshot(getNseIndexRow(nseIndices, 'NIFTY MIDCAP 100'));
  const smallcap = readNseIndexSnapshot(getNseIndexRow(nseIndices, 'NIFTY SMALLCAP 100'));
  const nifty500 = readNseIndexSnapshot(getNseIndexRow(nseIndices, 'NIFTY 500'));
  const sensex = readNseIndexSnapshot(getNseIndexRow(nseIndices, 'SENSEX'));

  const sectorRows = [
    ['Nifty Bank', 'NIFTY BANK'],
    ['Nifty IT', 'NIFTY IT'],
    ['Nifty FMCG', 'NIFTY FMCG'],
    ['Nifty Auto', 'NIFTY AUTO'],
    ['Nifty Pharma', 'NIFTY PHARMA'],
    ['Nifty Metal', 'NIFTY METAL'],
    ['Nifty PSU Bank', 'NIFTY PSU BANK'],
    ['Nifty Energy', 'NIFTY ENERGY'],
  ].map(([key, source]) => {
    const row = readNseIndexSnapshot(getNseIndexRow(nseIndices, source));
    return { key, pctChange: row.pctChange, level: row.level };
  });

  const goldUsd = toNumber(usGold.price);
  const goldUsdPrev = toNumber(usGold.previousClose);
  const goldInr10g =
    goldUsd !== null && toNumber(usdInr.value) !== null
      ? round((goldUsd * toNumber(usdInr.value) / 31.1035) * 10, 2)
      : null;
  const goldInrPrev =
    goldUsdPrev !== null && toNumber(usdInr.value) !== null
      ? round((goldUsdPrev * toNumber(usdInr.value) / 31.1035) * 10, 2)
      : null;
  const goldInrPct = computePercentChange(goldInr10g, goldInrPrev);
  const indiaVixDirection = classifyIndiaVixDirection(indiaVix.value, indiaVix.change);
  const leadershipStyle = classifyIndiaSectorLeadership(sectorRows);
  const preOpen = buildPreOpenBlock(
    preOpenNifty,
    preOpenBankNifty,
    preOpenAll,
    nifty50.previousClose ?? null,
    bankNifty.previousClose ?? null,
  );

  const snapshot = {
    market: INDIA,
    timestamp: nowTimestamp(),
    session: getIndiaSessionLabel(),
    giftNifty: giftNifty.value ?? null,
    giftNiftyPct: giftNifty.pctChange ?? computePercentChange(giftNifty.value, previous?.giftNifty),
    niftySpotPrevClose: nifty50.previousClose ?? null,
    indices: {
      nifty50: nifty50.level ?? null,
      bankNifty: bankNifty.level ?? null,
      bankNiftyPct: bankNifty.pctChange ?? null,
      midcapPct: midcap.pctChange ?? null,
      smallcapPct: smallcap.pctChange ?? null,
      nifty500Pct: nifty500.pctChange ?? null,
      sensexPct: sensex.pctChange ?? null,
      niftyHigh: nifty50.high ?? null,
      niftyLow: nifty50.low ?? null,
    },
    brent: brent.value ?? null,
    brentPct: brent.pctChange ?? computePercentChange(brent.value, previous?.brent),
    usdInr: usdInr.value ?? null,
    usdInrChange: usdInr.change ?? computeAbsoluteChange(usdInr.value, previous?.usdInr),
    indiaVix: indiaVix.value ?? null,
    indiaVixChange: indiaVix.change ?? computeAbsoluteChange(indiaVix.value, previous?.indiaVix),
    indiaVixDirection,
    advanceDecline: advanceDecline.ratio ?? null,
    fiiNet: fiiDii.fiiNet ?? null,
    diiNet: fiiDii.diiNet ?? null,
    marketCapChangeCr: null,
    fnoTurnoverCr: null,
    niftyPcr: null,
    bankNiftyPcr: null,
    niftyOiCr: null,
    bankNiftyOiCr: null,
    niftyMaxPain: null,
    bankNiftyMaxPain: null,
    niftyLevels: {
      yesterdayHigh: null,
      yesterdayLow: null,
      support: nifty50.low ?? null,
      resistance: nifty50.high ?? null,
    },
    goldInr10g,
    goldInrPct,
    india10Y: india10Y.value ?? null,
    india10YBpChange: india10Y.bpChange ?? null,
    sectors: sectorRows,
    sectorLeadershipStyle: leadershipStyle,
    preOpen,
    indiaEvents: Array.isArray(indiaEventNews) ? indiaEventNews.slice(0, 5).map((item) => item.title) : [],
    indiaSummary: '',
    headline: headline.headline || '',
    headlines: Array.isArray(headline.headlines) ? headline.headlines : [],
    regime: 'IND NEUTRAL',
  };

  const regimeResult = classifyIndiaRegime(snapshot);
  snapshot.regime = regimeResult.regime;
  snapshot.score = regimeResult.score;
  snapshot.usableSignals = regimeResult.usableSignals;
  snapshot.indiaSummary = buildIndiaSummaryLine(snapshot);
  return snapshot;
}

async function collectUsSnapshot() {
  const macroPromises = [
    safeFetch('US_SP_FUTURES', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.futures.sp)),
    safeFetch('US_NQ_FUTURES', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.futures.nasdaq)),
    safeFetch('US_DOW_FUTURES', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.futures.dow)),
    safeFetch('US_RUSSELL_FUTURES', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.futures.russell)),
    safeFetch('US_VIX', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.volatility.vix)),
    safeFetch('US_10Y', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.rates.us10y)),
    safeFetch('US_FRED_RATES', fetchFredRates),
    safeFetch('US_DXY', fetchUsDollarIndex),
    safeFetch('US_BRENT', () => fetchTradingEconomicsCommodity(CONFIG.urls.tradingEconomicsBrent)),
    safeFetch('US_WTI', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.commodities.wti)),
    safeFetch('US_GOLD', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.commodities.gold)),
    safeFetch('US_CALENDAR', fetchUsCalendar),
    safeFetch('US_NEWS', () => fetchRssHeadlines(CONFIG.urls.googleNewsUs, 8)),
    safeFetch('US_FED_NEWS', () => fetchRssHeadlines(CONFIG.urls.googleNewsFed, 3)),
    safeFetch('US_OIL_NEWS', () => fetchRssHeadlines(CONFIG.urls.googleNewsOil, 3)),
    safeFetch('US_EARNINGS', () => fetchRssHeadlines(CONFIG.urls.googleNewsUsEarnings, 5)),
  ];

  const watchlistPromises = CONFIG.usWatchlist.map((ticker) =>
    safeFetch(`US_${ticker}`, () => fetchUsEquityQuoteCached(ticker)),
  );
  const extraQuotePromises = [
    safeFetch('US_QQQ', () => fetchUsEquityQuoteCached('QQQ')),
    safeFetch('US_SOX', () => fetchGoogleFinanceQuote(CONFIG.usSymbols.indices.sox)),
    safeFetch('US_SMH', () => fetchUsEquityQuoteCached('SMH')),
    safeFetch('US_AVGO', () => fetchUsEquityQuoteCached('AVGO')),
    safeFetch('US_QCOM', () => fetchUsEquityQuoteCached('QCOM')),
  ];
  const sectorPromises = CONFIG.usSectors.map((sector) =>
    safeFetch(`US_${sector.symbol}_SECTOR`, () => fetchUsEquityQuoteCached(sector.symbol)),
  );
  const catalystPromises = CONFIG.usWatchlist.map((ticker) =>
    safeFetch(`US_${ticker}_NEWS`, () => fetchTickerCatalyst(ticker)),
  );

  const [
    spQuote,
    nqQuote,
    dowQuote,
    russellQuote,
    vixQuote,
    us10yQuote,
    fredRates,
    dxyQuote,
    brentQuote,
    wtiQuote,
    goldQuote,
    calendar,
    marketNews,
    fedNews,
    oilNews,
    earningsNews,
    watchlistQuotes,
    extraQuotes,
    sectorQuotes,
    catalysts,
  ] = await Promise.all([
    Promise.all(macroPromises).then((items) => items[0]),
    Promise.all(macroPromises).then((items) => items[1]),
    Promise.all(macroPromises).then((items) => items[2]),
    Promise.all(macroPromises).then((items) => items[3]),
    Promise.all(macroPromises).then((items) => items[4]),
    Promise.all(macroPromises).then((items) => items[5]),
    Promise.all(macroPromises).then((items) => items[6]),
    Promise.all(macroPromises).then((items) => items[7]),
    Promise.all(macroPromises).then((items) => items[8]),
    Promise.all(macroPromises).then((items) => items[9]),
    Promise.all(macroPromises).then((items) => items[10]),
    Promise.all(macroPromises).then((items) => items[11]),
    Promise.all(macroPromises).then((items) => items[12]),
    Promise.all(macroPromises).then((items) => items[13]),
    Promise.all(macroPromises).then((items) => items[14]),
    Promise.all(macroPromises).then((items) => items[15]),
    Promise.all(watchlistPromises),
    Promise.all(extraQuotePromises),
    Promise.all(sectorPromises),
    Promise.all(catalystPromises),
  ]);

  const sectorPerformance = CONFIG.usSectors
    .map((sector, index) => {
      const quote = sectorQuotes[index] || {};
      const display = chooseDisplayMove(quote);
      return {
        symbol: sector.symbol,
        name: sector.name,
        movePct: display.movePct,
        lastPrice: display.lastPrice,
      };
    })
    .sort((a, b) => (toNumber(b.movePct) ?? -999) - (toNumber(a.movePct) ?? -999));

  const watchlist = CONFIG.usWatchlist.map((ticker, index) => {
    const quote = watchlistQuotes[index] || {};
    const display = chooseDisplayMove(quote);
    return {
      ticker,
      lastPrice: display.lastPrice ?? quote.price ?? null,
      regularPrice: quote.price ?? null,
      extendedPrice: quote.extended?.price ?? null,
      previousClose: quote.previousClose ?? null,
      movePct: display.movePct,
      moveAbs: display.moveAbs,
      moveBasis: display.basis,
      regularMovePct: quote.pctChange ?? null,
      extendedMovePct: quote.extended?.pctChange ?? null,
      strength: classifyUsStrength(display.movePct),
      note: typeof catalysts[index] === 'string' ? catalysts[index] : 'no clear catalyst',
      sourceTitle: quote.title || '',
    };
  });
  const watchlistByTicker = Object.fromEntries(watchlist.map((item) => [item.ticker, item]));
  const watchlistQuoteByTicker = Object.fromEntries(
    CONFIG.usWatchlist.map((ticker, index) => [ticker, watchlistQuotes[index] || {}]),
  );

  const greenCount = watchlist.filter((item) => toNumber(item.movePct) !== null && toNumber(item.movePct) > 0).length;
  const greenOrFlatCount = watchlist.filter((item) => toNumber(item.movePct) !== null && toNumber(item.movePct) >= 0).length;
  const redTechLeaders = watchlist
    .filter((item) => ['NVDA', 'AMD', 'META', 'MSFT', 'AAPL'].includes(item.ticker))
    .every((item) => toNumber(item.movePct) !== null && toNumber(item.movePct) < 0);
  const qqqQuote = extraQuotes[0] || {};
  const soxQuote = extraQuotes[1] || {};
  const smhQuote = extraQuotes[2] || {};
  const avgoQuote = extraQuotes[3] || {};
  const qcomQuote = extraQuotes[4] || {};
  const spyQuote = watchlistQuoteByTicker.SPY || {};

  const spPct = computePercentChange(spQuote.price, spQuote.previousClose);
  const nqPct = computePercentChange(nqQuote.price, nqQuote.previousClose);
  const dowPct = computePercentChange(dowQuote.price, dowQuote.previousClose);
  const russellPct = computePercentChange(russellQuote.price, russellQuote.previousClose);
  const vixPct = computePercentChange(vixQuote.price, vixQuote.previousClose);

  const us10ySpot = toNumber(us10yQuote.price) !== null ? round(us10yQuote.price / 10, 3) : fredRates.us10y ?? null;
  const us10yPrev =
    toNumber(us10yQuote.previousClose) !== null ? round(us10yQuote.previousClose / 10, 3) : fredRates.us10yPrev ?? null;
  const us10yChangeBp = computeBasisPointChange(us10ySpot, us10yPrev);

  const us2ySpot = fredRates.us2y ?? null;
  const us2yChangeBp = computeBasisPointChange(fredRates.us2y, fredRates.us2yPrev);

  const wtiPct = computePercentChange(wtiQuote.price, wtiQuote.previousClose);
  const goldPct = computePercentChange(goldQuote.price, goldQuote.previousClose);
  const volatilityTrend = classifyVolatility(vixPct, vixQuote.price);

  const macro = {
    spFutures: spQuote.price ?? null,
    spFuturesPct: spPct,
    nasdaqFutures: nqQuote.price ?? null,
    nasdaqFuturesPct: nqPct,
    dowFutures: dowQuote.price ?? null,
    dowFuturesPct: dowPct,
    russell2000: russellQuote.price ?? null,
    russell2000Pct: russellPct,
    vix: vixQuote.price ?? null,
    vixPct,
    vixFrontMonth: null,
    volatilityTrend,
    us10y: us10ySpot,
    us10yChangeBp,
    us2y: us2ySpot,
    us2yChangeBp,
    dxy: dxyQuote.value ?? null,
    dxyPct: dxyQuote.pctChange ?? null,
    brent: brentQuote.value ?? null,
    brentPct: brentQuote.pctChange ?? null,
    wti: wtiQuote.price ?? null,
    wtiPct,
    gold: goldQuote.price ?? goldQuote.value ?? null,
    goldPct,
  };

  const watchlistSummary = {
    greenCount,
    greenOrFlatCount,
    redCount: watchlist.filter((item) => toNumber(item.movePct) !== null && toNumber(item.movePct) < 0).length,
    mostlyGreen: greenCount >= 5,
    techLeadersRedWhileFuturesGreen: (spPct ?? 0) > 0 && (nqPct ?? 0) > 0 && redTechLeaders,
  };

  const breadth = {
    nyseAdvanceDecline: null,
    nasdaqAdvanceDecline: null,
    sectorsPositivePercent: round(
      (sectorPerformance.filter((sector) => toNumber(sector.movePct) !== null && toNumber(sector.movePct) > 0).length /
        Math.max(sectorPerformance.length, 1)) *
        100,
      0,
    ),
    spxAbove50Dma: null,
    ndxAbove50Dma: null,
  };

  const semiconductors = {
    SOX: { level: soxQuote.price ?? null, movePct: computePercentChange(soxQuote.price, soxQuote.previousClose) },
    SMH: { level: smhQuote.price ?? null, movePct: computePercentChange(smhQuote.price, smhQuote.previousClose) },
    AVGO: { level: avgoQuote.price ?? null, movePct: computePercentChange(avgoQuote.price, avgoQuote.previousClose) },
    QCOM: { level: qcomQuote.price ?? null, movePct: computePercentChange(qcomQuote.price, qcomQuote.previousClose) },
    AMD: { level: watchlistQuoteByTicker.AMD?.price ?? null, movePct: watchlistByTicker.AMD?.movePct ?? null },
    NVDA: { level: watchlistQuoteByTicker.NVDA?.price ?? null, movePct: watchlistByTicker.NVDA?.movePct ?? null },
    MU: { level: watchlistQuoteByTicker.MU?.price ?? null, movePct: watchlistByTicker.MU?.movePct ?? null },
  };
  semiconductors.breadthLabel = classifySemiBreadth(semiconductors);

  const intraday = {
    spyVwapStatus: 'not available',
    qqqVwapStatus: 'not available',
    first15High: 'not available',
    first15Low: 'not available',
    first60High: 'not available',
    first60Low: 'not available',
    openingRangeStatus: 'not available',
  };

  const sectorLeadershipStyle = classifyLeadershipStyle(sectorPerformance);
  const regimeResult = classifyUsRegime({
    macro,
    watchlistSummary,
    breadth,
    semiconductors,
    intraday,
    sectorLeadership: { leadershipStyle: sectorLeadershipStyle },
  });
  const action = buildUsActionPlan(regimeResult.regime);

  return {
    market: US,
    timestamp: nowTimestamp(),
    session: getUsSessionLabel(),
    regime: regimeResult.regime,
    confidence: regimeResult.confidence,
    score: regimeResult.score,
    usableSignals: regimeResult.usableSignals,
    macro,
    spy: {
      price: spyQuote.price ?? null,
      movePct: watchlistByTicker.SPY?.movePct ?? null,
    },
    qqq: {
      price: qqqQuote.price ?? null,
      movePct: computePercentChange(qqqQuote.price, qqqQuote.previousClose),
    },
    breadth,
    semiconductors,
    intraday,
    sectorLeadership: {
      breadth:
        sectorPerformance.filter((sector) => toNumber(sector.movePct) !== null && toNumber(sector.movePct) > 0).length +
        '/' +
        sectorPerformance.length +
        ' sectors green',
      leaders: sectorPerformance.slice(0, 5).map((sector) => `${sector.symbol} ${round(toNumber(sector.movePct) ?? 0, 2)}%`),
      laggards: sectorPerformance.slice(-5).reverse().map((sector) => `${sector.symbol} ${round(toNumber(sector.movePct) ?? 0, 2)}%`),
      leadershipStyle: sectorLeadershipStyle,
      sectors: sectorPerformance,
    },
    watchlist,
    watchlistSummary,
    news: {
      macro: Array.isArray(marketNews) ? marketNews.slice(0, 6) : [],
      fed: Array.isArray(fedNews) ? fedNews.slice(0, 3) : [],
      oil: Array.isArray(oilNews) ? oilNews.slice(0, 3) : [],
      earnings: Array.isArray(earningsNews) ? earningsNews.slice(0, 4) : [],
      pendingEvents: Array.isArray(calendar.pending) && calendar.pending.length ? calendar.pending : calendar.all || [],
    },
    breadthApprox: `${watchlistSummary.greenCount}/${watchlist.length} watchlist green`,
    usSummary: buildUsSummaryLine({
      macro,
      breadth,
      semiconductors,
      sectorLeadership: { leadershipStyle: sectorLeadershipStyle },
    }),
    decision: action.decision,
    actionPlan: action.actionPlan,
    nextThirtyMinutes: action.nextStep,
  };
}

async function sendTelegramAlert(message) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
    return;
  }
  await fetch(`https://api.telegram.org/bot${encodeURIComponent(CONFIG.telegramBotToken)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CONFIG.telegramChatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });
}

async function maybeSendRegimeAlert(snapshot) {
  const state = await readState();
  const previousRegime = state.lastRegimeByMarket?.[snapshot.market] || null;
  if (snapshot.regime && snapshot.regime !== previousRegime) {
    await sendTelegramAlert(
      `[${snapshot.market}] market regime changed\nFrom: ${previousRegime || 'UNKNOWN'}\nTo: ${snapshot.regime}\nTime: ${snapshot.timestamp}`,
    );
  }
  await writeState({
    lastRegimeByMarket: {
      ...(state.lastRegimeByMarket || {}),
      [snapshot.market]: snapshot.regime,
    },
  });
}

async function collectAndStoreSnapshots(trigger = 'scheduler', market = 'ALL') {
  if (isCollecting) {
    throw new Error('Collection already running');
  }

  const normalizedMarket = String(market || 'ALL').toUpperCase();
  const markets =
    normalizedMarket === INDIA || normalizedMarket === US ? [normalizedMarket] : [INDIA, US];

  isCollecting = true;
  try {
    const snapshots = await readSnapshots();
    const latestByMarket = Object.fromEntries(
      [INDIA, US].map((code) => [
        code,
        [...snapshots].reverse().find((snapshot) => snapshot.market === code) || null,
      ]),
    );

    const collected = [];
    for (const marketCode of markets) {
      let snapshot;
      if (marketCode === INDIA) {
        snapshot = await collectIndiaSnapshot(latestByMarket[INDIA]);
      } else {
        snapshot = await collectUsSnapshot();
      }
      snapshots.push({ ...snapshot, trigger });
      collected.push(snapshot);
      await maybeSendRegimeAlert(snapshot);
      console.log(`Snapshot stored for ${marketCode} at ${snapshot.timestamp} (${trigger})`);
    }

    const archivedSnapshots = await readSnapshotArchive();
    const { hot, archived } = partitionSnapshotsForRetention(snapshots);
    if (archived.length) {
      await writeSnapshotArchive(archivedSnapshots.concat(archived));
    }
    await writeSnapshots(hot);
    invalidateEngineCache({ clearLiveRequestCaches: trigger !== 'scheduler' });
    return collected;
  } finally {
    isCollecting = false;
  }
}

function startScheduler() {
  const scheduleRun = async () => {
    if (isCollecting) {
      return;
    }
    const now = new Date();
    const marketsToCollect = [INDIA, US].filter((marketCode) => shouldCollectMarketNow(marketCode, now));
    for (const marketCode of marketsToCollect) {
      try {
        await collectAndStoreSnapshots('scheduler', marketCode);
      } catch (error) {
        console.error(`Scheduled collection failed for ${marketCode}:`, error.message);
      }
    }
    try {
      await captureIndMoneyNetworthSnapshot({ force: false });
    } catch (error) {
      console.error('Scheduled INDmoney snapshot failed:', error.message);
    }
  };

  const queueNextRun = () => {
    const nextRun = getNextAlignedRunDate();
    const delayMs = Math.max(0, nextRun.getTime() - Date.now());
    collectTimer = null;
    collectStarterTimer = setTimeout(async () => {
      await scheduleRun();
      queueNextRun();
    }, delayMs);
    collectTimer = collectStarterTimer;
  };

  scheduleRun().catch((error) => {
    console.error('Initial scheduled collection check failed:', error.message);
  });
  queueNextRun();
}

async function bootstrap() {
  await ensureFiles();
  await compactSnapshotStorage();
  await prunePersistedAiSignalStore();
  cleanupHotCaches();
  cleanupIndMoneyDashboardSessions();
  cleanupIndMoneyOauthStates();

  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch((error) => {
      console.error('Request failed:', error.message);
      jsonResponse(res, 500, { ok: false, error: error.message });
    });
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`Market dashboard listening on http://${CONFIG.host}:${CONFIG.port}`);
  });

  const snapshots = await readSnapshots();
  const hasIndia = snapshots.some((snapshot) => snapshot.market === INDIA);
  const hasUs = snapshots.some((snapshot) => snapshot.market === US);
  if (!hasIndia || !hasUs) {
    collectAndStoreSnapshots('bootstrap', !hasIndia && !hasUs ? 'ALL' : !hasIndia ? INDIA : US).catch((error) => {
      console.error('Initial collection failed:', error.message);
    });
  }

  startScheduler();

  const shutdown = () => {
    if (collectStarterTimer) {
      clearTimeout(collectStarterTimer);
      collectStarterTimer = null;
    }
    if (collectTimer) {
      clearInterval(collectTimer);
      collectTimer = null;
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const SKIP_SERVER_BOOTSTRAP = process.env.SERVER_NO_BOOTSTRAP === '1' || process.env.SKIP_BOOTSTRAP === '1';

if (!SKIP_SERVER_BOOTSTRAP) {
  bootstrap().catch((error) => {
    console.error('Bootstrap failed:', error);
    process.exit(1);
  });
}
