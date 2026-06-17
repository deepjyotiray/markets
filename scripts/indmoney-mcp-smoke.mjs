#!/usr/bin/env node
import { createIndMoneyMcpProvider } from '../src/portfolio-alerts/indmoney-mcp.js';

const provider = createIndMoneyMcpProvider({ cacheSeconds: 0 });
if (!provider.isAvailable()) {
  console.error('INDmoney MCP provider is not available. Run npm run indmoney:auth or set INDMONEY_MCP_BEARER_TOKEN.');
  process.exit(1);
}

const snapshot = await provider.networthSnapshot();
console.log(JSON.stringify({
  ok: true,
  total_networth: snapshot?.total_networth ?? null,
  investment_count: Array.isArray(snapshot?.investments) ? snapshot.investments.length : 0,
}, null, 2));
