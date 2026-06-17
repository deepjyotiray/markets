# Market Dashboard

Local market dashboard service for `markets.healthymealspot.com`.

## What it does

- Collects public market inputs on a schedule.
- Stores append-only snapshots in `data/snapshots.json`.
- Serves a dashboard and JSON API from a local Node server.
- Sends Telegram alerts only when the market regime changes.
- Does not place trades or connect to brokers.

## Required environment variables

- `FINNHUB_API_KEY` for U.S. stock quote, news, earnings, and fundamentals research

## Optional environment variables

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (defaults to `gpt-5`)
- `OPENAI_REASONING_EFFORT` (defaults to `minimal`)
- `OPENAI_SIGNAL_CACHE_MINUTES` (defaults to `15`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `PORT` (defaults to `4012`)
- `COLLECT_INTERVAL_MINUTES` (defaults to `30`)

## Local env file

The server auto-loads environment variables from:

- `.env`
- `.env.local`

Recommended place to store your OpenAI key for this project:

- [`.env.local`](/Users/deepjyotiray/Documents/Market/.env.local)

Example:

```bash
FINNHUB_API_KEY=your_finnhub_api_key
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5
OPENAI_REASONING_EFFORT=minimal
```

Successful on-demand AI reviews are cached in:

- [`data/ai-signals.json`](/Users/deepjyotiray/Documents/Market/data/ai-signals.json)

They persist across server restarts and page reloads until the cache expires.

The on-demand deep report uses:

- Finnhub REST APIs for the research/data bundle
- OpenAI Responses API for reasoning over that bundle

Notes:

- The legacy India macro collectors in `market_data.gs` and `market_data_optional.py` still use `ALPHA_VANTAGE_API_KEY`.
- The U.S. stock dashboard path (`/api/portfolio-ai` and `/api/watchlist-ai`) no longer depends on Alpha Vantage.

## Endpoints

- `/` dashboard
- `/health`
- `/api/latest`
- `/api/market-data`
- `/api/collect-now`
- `/api/portfolio-ai`
- `/api/watchlist-ai`
- `/api/portfolio-alerts/status`
- `/api/portfolio-alerts/run`
- `/api/indmoney/networth`
- `/api/indmoney/holdings/:assetType`
- `/api/indmoney/allocation/:assetType/:breakdownBy`
- `/api/indmoney/watchlist`
- `/api/indmoney/sips`
- `/api/indmoney/us-stocks?symbols=NVDA,MU&segments=analyst,news`
- `/api/indmoney/indian/lookup?names=HDFC%20Bank,NIFTY%2050`
- `/api/indmoney/indian/details?keys=INDS01992,INDI00012`
- `/api/indmoney/indian/ohlc?key=INDS01992&interval=1day&lookback=14d`
- `/api/indmoney/indian/options?key=INDI00012&strikes=5`
- `/api/indmoney/indian/greeks?key=<option_ind_key>&lookback=1d`
- `/api/indmoney/mf/category?categories=nifty-50-index-funds&size=5`
- `/api/indmoney/mf/details?fundIds=5536&includes=holdings,asset_allocation`

## Portfolio alert engine

The repo now includes a modular WhatsApp portfolio alert engine under [`src/portfolio-alerts`](/Users/deepjyotiray/Documents/Market/src/portfolio-alerts).

Key behaviors:

- Uses the latest [`data/portfolio.json`](/Users/deepjyotiray/Documents/Market/data/portfolio.json) snapshot as the source of truth.
- Uses INDmoney MCP as the preferred live portfolio, quote, analyst, and news source when an MCP client bridge is available.
- Falls back to the latest [`data/portfolio.json`](/Users/deepjyotiray/Documents/Market/data/portfolio.json) snapshot, Google Finance quotes, and Google News RSS.
- Uses Finnhub only as an optional earnings-calendar provider when `FINNHUB_API_KEY` is present.
- Never places trades. Every alert is suggestion-only and requires user confirmation.
- Supports dry-run mode and live WhatsApp delivery through the existing local secure-agent bridge.
- Persists alert state in [`data/portfolio-alert-state.json`](/Users/deepjyotiray/Documents/Market/data/portfolio-alert-state.json).

INDmoney MCP controls:

```bash
INDMONEY_MCP_ENABLED=true
INDMONEY_MCP_SOURCE_PRIORITY=mcp_first
INDMONEY_MCP_CACHE_SECONDS=30
```

Portfolio alert polling (all values are seconds):

```bash
PORTFOLIO_ALERTS_POLL_SECONDS=60
PORTFOLIO_ALERTS_POLL_SECONDS_PRE_MARKET=30
PORTFOLIO_ALERTS_POLL_SECONDS_REGULAR=30
PORTFOLIO_ALERTS_POLL_SECONDS_POST_MARKET=30
PORTFOLIO_ALERTS_POLL_SECONDS_CLOSED=300
```

Keep `PORTFOLIO_ALERT_PREMARKET_ENABLED` and `PORTFOLIO_ALERT_POSTMARKET_ENABLED` set to `true` if you want alert generation in those sessions as requested.
```

The Node runtime expects an INDmoney MCP client bridge to be exposed as `globalThis.__INDMONEY_MCP_CLIENT__` or passed into the alert config as `providers.indmoneyMcpClient`. If that bridge is unavailable, the alert engine automatically uses the existing JSON/Google fallback path and the read-only INDmoney API endpoints return `503` instead of mutating state.

To authorize the built-in Streamable HTTP bridge:

```bash
npm run indmoney:auth
npm run indmoney:smoke
```

The auth helper opens INDmoney OAuth in your browser and saves tokens to `~/.codex/indmoney-mcp-market-auth.json` with user-only file permissions. You can override that path with `INDMONEY_MCP_AUTH_PATH`, or provide a short-lived token directly with `INDMONEY_MCP_BEARER_TOKEN`.

Useful commands:

```bash
npm test
npm run alerts:once
npm run alerts:live-once
```

Enable the scheduled runtime by setting:

```bash
PORTFOLIO_ALERTS_ENABLED=true
PORTFOLIO_ALERTS_DRY_RUN=true
PORTFOLIO_ALERT_RECIPIENT=+919594614752
WHATSAPP_AGENT_SECRET=<same secret used by the running secure-agent>
```

## Truth Social alert runtime

The repo also includes a dedicated Truth Social watcher under [`src/truth-social-alerts`](/Users/deepjyotiray/Documents/Market/src/truth-social-alerts) that polls [trumpstruth.org/feed](https://trumpstruth.org/feed) and forwards new Trump posts to WhatsApp through the same local secure-agent bridge.

Controls:

```bash
TRUTH_SOCIAL_ALERTS_ENABLED=true
TRUTH_SOCIAL_ALERTS_DRY_RUN=true
TRUTH_SOCIAL_ALERT_RECIPIENT=+919594614752
TRUTH_SOCIAL_ALERT_SOURCE=browser
TRUTH_SOCIAL_ACCOUNT_HANDLE=realDonaldTrump
TRUTH_SOCIAL_ALERTS_POLL_SECONDS=5
TRUTH_SOCIAL_RSS_URL=https://trumpstruth.org/feed
TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE=seed_only
WHATSAPP_AGENT_SECRET=<same secret used by the running secure-agent>
```

`TRUTH_SOCIAL_ALERT_SOURCE=browser` uses a real Chromium session to obtain Truth Social's anonymous access token and poll the live account statuses endpoint directly, which is much fresher than the public RSS mirror and more reliable than scraping a user-managed Chrome tab.

`TRUTH_SOCIAL_ALERT_SOURCE=chrome_api` keeps the watcher inside your existing Google Chrome session. It reads the active Truth Social auth state from the Chrome tab, then calls the live statuses API directly from Node. This avoids the extra Chromium window while staying much more reliable than DOM scraping. It requires that Chrome already be signed in to Truth Social.

`TRUTH_SOCIAL_ALERT_SOURCE=chrome` uses the Google Chrome Truth Social tab via AppleScript and page-side JavaScript. If the tab is missing, the service will reopen `https://truthsocial.com/@realDonaldTrump` automatically. For this mode, Chrome needs the one-time setting `View > Developer > Allow JavaScript from Apple Events` enabled.

Bootstrap modes:

- `seed_only`: start tracking from the latest post without sending one immediately
- `send_latest_once`: send the current latest post once on first startup, then continue normally
- `replay_unseen`: send every currently visible feed item on first startup

Useful commands:

```bash
npm run truthsocial:once
npm run truthsocial:live-once
```

Optional authenticated runtime endpoints:

- `/api/truth-social-alerts/status`
- `/api/truth-social-alerts/run`
