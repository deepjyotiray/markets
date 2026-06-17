#!/usr/bin/env python3

import asyncio
import json
import os
import sys
from html.parser import HTMLParser

from playwright.async_api import async_playwright


BOOTSTRAP_URL = os.environ.get("TRUTH_SOCIAL_BROWSER_BOOTSTRAP_URL", "https://truthsocial.com/")
HEADED = os.environ.get("TRUTH_SOCIAL_BROWSER_HEADED", "true").lower() in {"1", "true", "yes", "on"}


class HtmlToTextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "p", "div"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"p", "div"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if data:
            self.parts.append(data)

    def get_text(self):
        return " ".join(" ".join(self.parts).split())


def strip_html(value):
    parser = HtmlToTextParser()
    parser.feed(value or "")
    text = parser.get_text().strip()
    return text or "[Media-only post]"


class TruthSocialBridge:
    def __init__(self):
        self.playwright = None
        self.browser = None
        self.page = None
        self.token = None
        self.account_ids = {}

    async def write_json(self, payload):
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()

    async def on_response(self, response):
        if "/api/v1/pepe/registrations" not in response.url:
            return
        try:
            payload = await response.json()
            token = payload.get("access_token")
            if token:
                self.token = token
        except Exception:
            return

    async def start(self):
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=not HEADED)
        self.page = await self.browser.new_page(viewport={"width": 1280, "height": 900})
        self.page.on("response", self.on_response)
        await self.refresh_session()
        await self.write_json({"type": "ready"})

    async def refresh_session(self):
        self.token = None
        await self.page.goto(BOOTSTRAP_URL, wait_until="networkidle", timeout=60000)
        for _ in range(30):
            if self.token:
                return
            await self.page.wait_for_timeout(250)
        raise RuntimeError("Timed out waiting for Truth Social anonymous token")

    async def lookup_account_id(self, acct):
        if acct in self.account_ids:
            return self.account_ids[acct]
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        lookup = await self.page.evaluate(
            """async ({ acct, headers }) => {
              const res = await fetch('/api/v1/accounts/lookup?' + new URLSearchParams({ acct }).toString(), {
                headers,
                credentials: 'include',
              });
              const text = await res.text();
              let json = null;
              try { json = JSON.parse(text); } catch {}
              return { status: res.status, text, json };
            }""",
            {"acct": acct, "headers": headers},
        )
        if lookup["status"] != 200 or not lookup.get("json", {}).get("id"):
            raise RuntimeError(f"Account lookup failed: HTTP {lookup['status']}")
        account_id = lookup["json"]["id"]
        self.account_ids[acct] = account_id
        return account_id

    async def fetch_statuses_once(self, acct, limit):
        account_id = await self.lookup_account_id(acct)
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        result = await self.page.evaluate(
            """async ({ accountId, headers, limit }) => {
              const params = new URLSearchParams({
                exclude_replies: 'true',
                only_replies: 'false',
                with_muted: 'true',
                limit: String(limit),
              });
              const res = await fetch(`/api/v1/accounts/${accountId}/statuses?${params.toString()}`, {
                headers,
                credentials: 'include',
              });
              const text = await res.text();
              let json = null;
              try { json = JSON.parse(text); } catch {}
              return { status: res.status, text, json };
            }""",
            {"accountId": account_id, "headers": headers, "limit": limit},
        )
        if result["status"] != 200 or not isinstance(result.get("json"), list):
            raise RuntimeError(f"Statuses fetch failed: HTTP {result['status']}")
        statuses = []
        for item in result["json"]:
            statuses.append(
                {
                    "id": item.get("id"),
                    "created_at": item.get("created_at"),
                    "url": item.get("url"),
                    "content": item.get("content"),
                    "content_text": strip_html(item.get("content")),
                    "reblog": item.get("reblog"),
                }
            )
        return {"account_id": account_id, "statuses": statuses}

    async def fetch_statuses(self, acct, limit):
        try:
            return await self.fetch_statuses_once(acct, limit)
        except Exception:
            self.account_ids.pop(acct, None)
            await self.refresh_session()
            return await self.fetch_statuses_once(acct, limit)

    async def stop(self):
        if self.browser:
            await self.browser.close()
            self.browser = None
        if self.playwright:
            await self.playwright.stop()
            self.playwright = None


async def main():
    bridge = TruthSocialBridge()
    await bridge.start()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            message = json.loads(line)
            request_id = message.get("id")
            command = message.get("command")
            try:
                if command == "fetch_statuses":
                    result = await bridge.fetch_statuses(
                        message.get("acct", "realDonaldTrump"),
                        int(message.get("limit", 20)),
                    )
                    await bridge.write_json({"id": request_id, "ok": True, "result": result})
                else:
                    raise RuntimeError(f"Unsupported command: {command}")
            except Exception as error:
                await bridge.write_json({"id": request_id, "ok": False, "error": str(error)})
    finally:
        await bridge.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
