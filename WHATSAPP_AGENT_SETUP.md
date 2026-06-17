# WhatsApp Agent Setup Prompt

Use this prompt in Codex on the new laptop if you want live WhatsApp delivery for portfolio alerts and the Truth Social worker.

```text
Set up a local WhatsApp agent on this laptop using Baileys, then wire this Market repo to it.

Context:
- Main repo path: ~/Documents/Market
- Main repo uses a local HTTP bridge, not Baileys directly
- Expected endpoint: POST http://127.0.0.1:3001/send
- Expected auth header: x-secret: <WHATSAPP_AGENT_SECRET>
- Expected JSON payload:
  {
    "phone": "+919594614752",
    "message": "text to send",
    "threadId": "optional-thread-key-or-null",
    "quotedMessage": "optional-message-id-or-null",
    "mediaPath": "/absolute/path/to/file-or-null"
  }
- Expected response body should be JSON and include:
  {
    "ok": true,
    "messageRef": "provider-message-id-or-null"
  }

What I need you to do:
1. Create a small local Node service for WhatsApp delivery using Baileys.
2. Keep it minimal: one process, one /send endpoint, local-only bind on 127.0.0.1:3001.
3. Store auth/session state on disk so the WhatsApp login survives restarts.
4. Protect the endpoint with an x-secret header checked against an env var.
5. Accept text-only sends and media sends using the provided mediaPath.
6. If quotedMessage is present, reply to that message in WhatsApp.
7. Return JSON with at least { ok, messageRef }.
8. Add a README with exact start, login, and restart steps.
9. Add a simple health endpoint at GET /health.
10. Add a tiny smoke test command using curl.
11. Start the service locally and stop only if blocked on QR login.
12. Then wire ~/Documents/Market/.env.local to use it with:
    - WHATSAPP_AGENT_URL=http://127.0.0.1:3001/send
    - WHATSAPP_AGENT_SECRET=<same secret used by the agent>
13. Explain any manual step needed for the first QR pair.

Implementation constraints:
- Use Node.js only.
- Prefer built-in modules plus Baileys; avoid extra dependencies unless truly needed.
- Keep the code small and readable.
- Bind only to 127.0.0.1, not 0.0.0.0.
- Use absolute media paths as provided; do not copy files unless necessary.
- If the session exists already, reuse it instead of forcing a new QR login.
- Do not commit secrets or auth state to git.

After setup, verify all of this:
1. GET /health returns ok.
2. POST /send can send a test WhatsApp message.
3. quotedMessage replies work if possible.
4. mediaPath sends an image if a sample file is available.
5. ~/Documents/Market can use the agent without code changes beyond env vars.

Important wiring details from the Market repo:
- Portfolio alerts call WHATSAPP_AGENT_URL with x-secret and payload { phone, message, threadId, quotedMessage, mediaPath }.
- Truth Social alerts use the same endpoint and may pass mediaPath for downloaded post media.
- The repo expects response.messageRef and stores it for threaded follow-ups.
- Dry-run mode exists in the Market repo, but for this task I want the live path working.
```

## How This Repo Is Wired

This repo does not talk to WhatsApp Web directly. It talks to a local HTTP bridge.

### Portfolio alerts

- Caller: [`src/portfolio-alerts/whatsapp.js`](/Users/deepjyotiray/Documents/Market/src/portfolio-alerts/whatsapp.js)
- Config source: [`src/portfolio-alerts/config.js`](/Users/deepjyotiray/Documents/Market/src/portfolio-alerts/config.js)
- Runtime caller: [`src/portfolio-alerts/runtime.js`](/Users/deepjyotiray/Documents/Market/src/portfolio-alerts/runtime.js)

Behavior:

- Sends `POST` to `WHATSAPP_AGENT_URL`
- Adds header `x-secret: WHATSAPP_AGENT_SECRET`
- Sends JSON:
  - `phone`
  - `message`
  - `threadId`
  - `quotedMessage`
  - `mediaPath`
- Expects a JSON response and uses `messageRef` for follow-up replies

### Truth Social worker

- Config source: [`src/truth-social-alerts/config.js`](/Users/deepjyotiray/Documents/Market/src/truth-social-alerts/config.js)
- Runtime caller: [`src/truth-social-alerts/runtime.js`](/Users/deepjyotiray/Documents/Market/src/truth-social-alerts/runtime.js)

Behavior:

- Uses the same WhatsApp agent endpoint
- May download post media to a temp file and pass that absolute path as `mediaPath`
- Stores returned `messageRef` values for reply chaining

### Required env vars in this repo

These go in `~/Documents/Market/.env.local` on the new laptop:

```bash
WHATSAPP_AGENT_URL=http://127.0.0.1:3001/send
WHATSAPP_AGENT_SECRET=choose_a_long_random_secret
PORTFOLIO_ALERT_RECIPIENT=+919594614752
TRUTH_SOCIAL_ALERT_RECIPIENT=+919594614752
```

For live sends, also make sure:

```bash
PORTFOLIO_ALERTS_DRY_RUN=false
TRUTH_SOCIAL_ALERTS_DRY_RUN=false
```

### What must survive migration

- The Baileys agent codebase, if it already exists separately
- The Baileys auth/session files, if you want to avoid QR pairing again
- The same `WHATSAPP_AGENT_SECRET`, unless you also update `.env.local`

### Minimal smoke test

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H 'Content-Type: application/json' \
  -H 'x-secret: YOUR_SECRET' \
  -d '{"phone":"+919594614752","message":"test from new laptop","threadId":null,"quotedMessage":null,"mediaPath":null}'
```
