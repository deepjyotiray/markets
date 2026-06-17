# New Laptop Bootstrap Prompt

Use this prompt in Codex on the new laptop:

```text
Clone and run the GitHub repo deepjyotiray/markets from scratch on this laptop.

Context:
- Repo URL: git@github.com:deepjyotiray/markets.git
- Target folder: ~/Documents/Market
- This is a Node app started with `npm start`
- Run tests with `npm test`
- Health endpoint should be http://127.0.0.1:4012/health

What I need you to do:
1. Clone the repo into ~/Documents/Market if it is not already there.
2. Create `.env.local` from `.env.example`.
3. Stop and show me the exact env vars I still need to fill manually, but do not invent secret values.
4. Install dependencies with `npm install`.
5. Run `npm test`.
6. Start the app and verify `/health`.
7. If INDmoney MCP is needed, tell me whether I should restore `~/.codex/indmoney-mcp-market-auth.json` or run `npm run indmoney:auth`.
8. If the WhatsApp secure-agent is required, tell me exactly what local service must be running and which env vars point to it.
9. If there are any machine-specific files or state folders missing, list them clearly.

Constraints:
- Do not commit secrets.
- Prefer the simplest path that gets the app running locally.
- Make only minimal changes unless something is broken.
```

## Manual files to bring over

- `~/.codex/indmoney-mcp-market-auth.json` if you want INDmoney MCP without re-auth.
- Your real `.env.local` values, especially API keys and local secrets.
- Optional: the repo `data/` contents if you want existing cached history and alert state.
