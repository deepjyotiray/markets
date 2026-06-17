module.exports = {
  apps: [
    {
      name: 'market-dashboard-web',
      cwd: '/Users/deepjyotiray/Documents/Market',
      script: 'server.js',
      interpreter: 'node',
      env: {
        HOST: '127.0.0.1',
        PORT: '4012',
        TZ: 'Asia/Kolkata',
        PUBLIC_BASE_URL: 'https://markets.healthymealspot.com',
        INDMONEY_MCP_ENABLED: 'true',
        INDMONEY_MCP_SOURCE_PRIORITY: 'mcp_first',
        INDMONEY_MCP_CACHE_SECONDS: '30',
        INDMONEY_MCP_AUTH_PATH: '/Users/deepjyotiray/.codex/indmoney-mcp-market-auth.json',
        COLLECT_INTERVAL_MINUTES: '15',
        TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
        TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
        TRUTH_SOCIAL_ALERT_RECIPIENT: '+919594614752,+917206703790',
        TRUTH_SOCIAL_ALERT_SOURCE: 'chrome_api',
        TRUTH_SOCIAL_ACCOUNT_HANDLE: 'realDonaldTrump',
        TRUTH_SOCIAL_ALERTS_POLL_SECONDS: '3',
        TRUTH_SOCIAL_BROWSER_FETCH_LIMIT: '100',
        TRUTH_SOCIAL_CHROME_RELOAD_MIN_SECONDS: '15',
        TRUTH_SOCIAL_RSS_URL: 'https://trumpstruth.org/feed',
        TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'seed_only',
        WHATSAPP_AGENT_URL: 'http://127.0.0.1:3001/send',
        WHATSAPP_AGENT_SECRET: 'eb7760e9390b26503a5fd18393371b0b7913be999cde5e94'
      }
    },
    {
      name: 'market-dashboard-truth-social',
      cwd: '/Users/deepjyotiray/Documents/Market',
      script: 'scripts/truth-social-alerts-worker.mjs',
      interpreter: 'node',
      env: {
        HOST: '127.0.0.1',
        PORT: '4012',
        TZ: 'Asia/Kolkata',
        PUBLIC_BASE_URL: 'https://markets.healthymealspot.com',
        INDMONEY_MCP_ENABLED: 'true',
        INDMONEY_MCP_SOURCE_PRIORITY: 'mcp_first',
        INDMONEY_MCP_CACHE_SECONDS: '30',
        INDMONEY_MCP_AUTH_PATH: '/Users/deepjyotiray/.codex/indmoney-mcp-market-auth.json',
        COLLECT_INTERVAL_MINUTES: '15',
        TRUTH_SOCIAL_ALERTS_ENABLED: 'true',
        TRUTH_SOCIAL_ALERTS_DRY_RUN: 'false',
        TRUTH_SOCIAL_ALERT_RECIPIENT: '+919594614752,+917206703790',
        TRUTH_SOCIAL_ALERT_SOURCE: 'chrome_api',
        TRUTH_SOCIAL_ACCOUNT_HANDLE: 'realDonaldTrump',
        TRUTH_SOCIAL_ALERTS_POLL_SECONDS: '3',
        TRUTH_SOCIAL_BROWSER_FETCH_LIMIT: '100',
        TRUTH_SOCIAL_CHROME_RELOAD_MIN_SECONDS: '15',
        TRUTH_SOCIAL_RSS_URL: 'https://trumpstruth.org/feed',
        TRUTH_SOCIAL_ALERT_BOOTSTRAP_MODE: 'seed_only',
        WHATSAPP_AGENT_URL: 'http://127.0.0.1:3001/send',
        WHATSAPP_AGENT_SECRET: 'eb7760e9390b26503a5fd18393371b0b7913be999cde5e94'
      }
    },
    {
      name: 'market-dashboard-portfolio-alerts',
      cwd: '/Users/deepjyotiray/Documents/Market',
      script: 'scripts/portfolio-alerts-worker.mjs',
      interpreter: 'node',
      env: {
        HOST: '127.0.0.1',
        PORT: '4012',
        TZ: 'Asia/Kolkata',
        PUBLIC_BASE_URL: 'https://markets.healthymealspot.com',
        INDMONEY_MCP_ENABLED: 'true',
        INDMONEY_MCP_SOURCE_PRIORITY: 'mcp_first',
        INDMONEY_MCP_CACHE_SECONDS: '30',
        INDMONEY_MCP_AUTH_PATH: '/Users/deepjyotiray/.codex/indmoney-mcp-market-auth.json',
        COLLECT_INTERVAL_MINUTES: '15',
        WHATSAPP_AGENT_URL: 'http://127.0.0.1:3001/send',
        WHATSAPP_AGENT_SECRET: 'eb7760e9390b26503a5fd18393371b0b7913be999cde5e94'
      }
    }
  ]
};
