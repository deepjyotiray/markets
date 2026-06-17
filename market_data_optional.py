"""
Optional Python version for local runs or GitHub Actions.

Purpose:
- Fetch, store, classify, and alert.
- Append-only writes to Google Sheets via a service account.
- No trading logic, no brokerage integration, no order placement.

Environment variables:
- ALPHA_VANTAGE_API_KEY
- GOOGLE_SERVICE_ACCOUNT_JSON
- GOOGLE_SHEET_ID
- GOOGLE_SHEET_NAME (optional, defaults to MarketData)
- TELEGRAM_BOT_TOKEN (optional)
- TELEGRAM_CHAT_ID (optional)
"""

from __future__ import annotations

import html
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import requests
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


CONFIG = {
    "sheet_name": os.getenv("GOOGLE_SHEET_NAME", "MarketData"),
    "timezone_label": "Asia/Kolkata",
    "max_retries": 3,
    "retry_backoff_seconds": 1.5,
    "min_signals_for_regime": 4,
    "user_agent": "MarketDataPythonBot/1.0",
    "headers": [
        "Timestamp",
        "GiftNifty",
        "GiftNiftyPct",
        "Brent",
        "BrentPct",
        "USDINR",
        "USDINRChange",
        "IndiaVIX",
        "IndiaVIXChange",
        "AdvanceDecline",
        "FIINet",
        "DIINet",
        "Headline",
        "Regime",
    ],
    "thresholds": {
        "gift_pos": 0.25,
        "gift_neg": -0.25,
        "brent_pos": -1.0,
        "brent_neg": 1.0,
        "usd_pos": -0.15,
        "usd_neg": 0.15,
        "vix_pos": -0.5,
        "vix_neg": 0.5,
        "ad_pos": 1.2,
        "ad_neg": 0.9,
        "risk_on_score": 3,
        "defensive_score": -3,
    },
    "urls": {
        "alpha_vantage": "https://www.alphavantage.co/query",
        "google_news_rss": "https://news.google.com/rss/search?q=Indian%20stock%20market&hl=en-IN&gl=IN&ceid=IN:en",
        "gift_1": "https://www.moneycontrol.com/indian-indices/-4993351.html",
        "gift_2": "https://www.moneycontrol.com/indian-indices/-4902491.html",
        "fii_dii": "https://www.moneycontrol.com/markets/fii-dii-data/cash/",
        "market_news": "https://www.moneycontrol.com/news/tags/market.html",
        "nse_home": "https://www.nseindia.com/",
        "nse_all_indices": "https://www.nseindia.com/api/allIndices",
        "nse_market_status": "https://www.nseindia.com/api/marketStatus",
        "nse_breadth_page": "https://www.nseindia.com/market-data/decline",
        "vix_fallback": "https://www.moneycontrol.com/india/indexfno/indiavix-17.html",
    },
}


@dataclass
class Snapshot:
    timestamp: str
    gift_nifty: Optional[float]
    gift_nifty_pct: Optional[float]
    brent: Optional[float]
    brent_pct: Optional[float]
    usd_inr: Optional[float]
    usd_inr_change: Optional[float]
    india_vix: Optional[float]
    india_vix_change: Optional[float]
    advance_decline: Optional[float]
    fii_net: Optional[float]
    dii_net: Optional[float]
    headline: str
    regime: str

    def to_row(self) -> List[Any]:
        return [
            self.timestamp,
            self.gift_nifty,
            self.gift_nifty_pct,
            self.brent,
            self.brent_pct,
            self.usd_inr,
            self.usd_inr_change,
            self.india_vix,
            self.india_vix_change,
            self.advance_decline,
            self.fii_net,
            self.dii_net,
            self.headline,
            self.regime,
        ]


SESSION = requests.Session()
SESSION.headers.update({"User-Agent": CONFIG["user_agent"], "Accept-Language": "en-US,en;q=0.9"})


def main() -> None:
    ensure_header_row()
    previous = get_last_row_object()
    snapshot = collect_snapshot(previous)
    append_row(snapshot.to_row())
    maybe_send_regime_alert(snapshot.regime, previous, snapshot)
    logging.info("Appended snapshot with regime=%s", snapshot.regime)


def collect_snapshot(previous: Optional[Dict[str, Any]]) -> Snapshot:
    usd = safe_fetch(fetch_usd_inr)
    brent = safe_fetch(fetch_brent)
    gift = safe_fetch(fetch_gift_nifty)
    vix = safe_fetch(fetch_india_vix)
    breadth = safe_fetch(fetch_advance_decline)
    fii_dii = safe_fetch(fetch_fii_dii)
    headline = safe_fetch(fetch_headline)

    gift_value = gift.get("value")
    brent_value = brent.get("value")
    usd_value = usd.get("value")
    vix_value = vix.get("value")

    snapshot = Snapshot(
        timestamp=datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M:%S"),
        gift_nifty=gift_value,
        gift_nifty_pct=gift.get("pct_change", compute_percent_change(gift_value, get_prev(previous, "GiftNifty"))),
        brent=brent_value,
        brent_pct=brent.get("pct_change", compute_percent_change(brent_value, get_prev(previous, "Brent"))),
        usd_inr=usd_value,
        usd_inr_change=usd.get("change", compute_absolute_change(usd_value, get_prev(previous, "USDINR"))),
        india_vix=vix_value,
        india_vix_change=vix.get("change", compute_absolute_change(vix_value, get_prev(previous, "IndiaVIX"))),
        advance_decline=breadth.get("ratio"),
        fii_net=fii_dii.get("fii_net"),
        dii_net=fii_dii.get("dii_net"),
        headline=headline.get("headline", ""),
        regime="NEUTRAL",
    )
    snapshot.regime = classify_regime(snapshot)
    return snapshot


def fetch_usd_inr() -> Dict[str, Optional[float]]:
    api_key = get_required_env("ALPHA_VANTAGE_API_KEY")
    data = fetch_json(
        f"{CONFIG['urls']['alpha_vantage']}?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=INR&apikey={api_key}"
    )
    node = data.get("Realtime Currency Exchange Rate", {})
    return {"value": to_number(node.get("5. Exchange Rate")), "change": None}


def fetch_brent() -> Dict[str, Optional[float]]:
    api_key = get_required_env("ALPHA_VANTAGE_API_KEY")
    data = fetch_json(f"{CONFIG['urls']['alpha_vantage']}?function=BRENT&interval=daily&apikey={api_key}")
    if isinstance(data.get("data"), list) and data["data"]:
        latest = data["data"][0]
        previous = data["data"][1] if len(data["data"]) > 1 else None
        value = to_number(latest.get("value"))
        return {"value": value, "pct_change": compute_percent_change(value, to_number((previous or {}).get("value")))}
    raise RuntimeError("Unexpected Brent payload")


def fetch_gift_nifty() -> Dict[str, Optional[float]]:
    for key in ("gift_1", "gift_2"):
        html_text = fetch_text(CONFIG["urls"][key])
        parsed = parse_gift_nifty_from_html(html_text)
        if parsed.get("value") is not None:
            return parsed
    raise RuntimeError("Gift Nifty parse failed")


def fetch_india_vix() -> Dict[str, Optional[float]]:
    try:
        payload = fetch_nse_json(CONFIG["urls"]["nse_all_indices"])
        parsed = parse_india_vix_from_nse(payload)
        if parsed.get("value") is not None:
            return parsed
    except Exception as exc:
        logging.warning("NSE VIX fetch failed: %s", exc)
    return parse_india_vix_from_html(fetch_text(CONFIG["urls"]["vix_fallback"]))


def fetch_advance_decline() -> Dict[str, Optional[float]]:
    for url in (CONFIG["urls"]["nse_market_status"], CONFIG["urls"]["nse_all_indices"]):
        try:
            parsed = parse_advance_decline_from_json(fetch_nse_json(url))
            if parsed.get("ratio") is not None:
                return parsed
        except Exception as exc:
            logging.warning("Advance/decline JSON fetch failed for %s: %s", url, exc)
    parsed = parse_advance_decline_from_html(fetch_text(CONFIG["urls"]["nse_breadth_page"]))
    if parsed.get("ratio") is not None:
        return parsed
    return parse_advance_decline_from_html(fetch_text(CONFIG["urls"]["market_news"]))


def fetch_fii_dii() -> Dict[str, Optional[float]]:
    html_text = fetch_text(CONFIG["urls"]["fii_dii"])
    match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html_text, flags=re.I | re.S)
    if not match:
        raise RuntimeError("Missing __NEXT_DATA__")
    payload = json.loads(match.group(1))
    rows = (((payload or {}).get("props") or {}).get("pageProps") or {}).get("FiiDiiData", {}).get("fiiDiiData", [])
    latest = rows[0]
    return {"fii_net": to_number(latest.get("fiiNet")), "dii_net": to_number(latest.get("diiNet"))}


def fetch_headline() -> Dict[str, str]:
    rss_text = fetch_text(CONFIG["urls"]["google_news_rss"])
    match = re.search(r"<item>[\s\S]*?<title>(.*?)</title>", rss_text, flags=re.I)
    if match:
        title = html.unescape(match.group(1))
        title = re.sub(r"\s*-\s*[^-]+$", "", title).strip()
        return {"headline": title}
    html_text = fetch_text(CONFIG["urls"]["market_news"])
    match = re.search(r"<h2[^>]*>\s*<a[^>]*>([^<]+)</a>", html_text, flags=re.I)
    return {"headline": html.unescape(match.group(1)).strip() if match else ""}


def classify_regime(snapshot: Snapshot) -> str:
    thresholds = CONFIG["thresholds"]
    signals: List[int] = []
    push_signal(signals, snapshot.gift_nifty_pct, thresholds["gift_pos"], thresholds["gift_neg"])
    push_signal_reverse(signals, snapshot.brent_pct, thresholds["brent_pos"], thresholds["brent_neg"])
    push_signal_reverse(signals, snapshot.usd_inr_change, thresholds["usd_pos"], thresholds["usd_neg"])
    push_signal_reverse(signals, snapshot.india_vix_change, thresholds["vix_pos"], thresholds["vix_neg"])
    push_signal(signals, snapshot.advance_decline, thresholds["ad_pos"], thresholds["ad_neg"])
    push_signal(signals, snapshot.fii_net, 0.01, -0.01)
    push_signal(signals, snapshot.dii_net, 0.01, -0.01)

    if len(signals) < CONFIG["min_signals_for_regime"]:
        return "NEUTRAL"

    score = sum(signals)
    if score >= thresholds["risk_on_score"]:
        return "RISK_ON"
    if score <= thresholds["defensive_score"]:
        return "DEFENSIVE"
    return "NEUTRAL"


def maybe_send_regime_alert(new_regime: str, previous: Optional[Dict[str, Any]], snapshot: Snapshot) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return

    old_regime = (previous or {}).get("Regime")
    if new_regime == old_regime or not new_regime:
        return

    requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={
            "chat_id": chat_id,
            "text": f"Market regime changed\nFrom: {old_regime or 'UNKNOWN'}\nTo: {new_regime}\nTime: {snapshot.timestamp}\nHeadline: {snapshot.headline or 'n/a'}",
            "disable_web_page_preview": True,
        },
        timeout=20,
    ).raise_for_status()


def ensure_header_row() -> None:
    values = sheet_values(f"{CONFIG['sheet_name']}!A1:N1")
    if not values:
        append_range(f"{CONFIG['sheet_name']}!A1:N1", [CONFIG["headers"]])


def get_last_row_object() -> Optional[Dict[str, Any]]:
    values = sheet_values(f"{CONFIG['sheet_name']}!A:N")
    if len(values) <= 1:
        return None
    headers = values[0]
    row = values[-1]
    return {headers[i]: row[i] if i < len(row) else None for i in range(len(headers))}


def append_row(row: List[Any]) -> None:
    append_range(f"{CONFIG['sheet_name']}!A:N", [row])


def sheet_values(range_name: str) -> List[List[Any]]:
    service = sheets_service()
    response = service.spreadsheets().values().get(
        spreadsheetId=get_required_env("GOOGLE_SHEET_ID"),
        range=range_name,
    ).execute()
    return response.get("values", [])


def append_range(range_name: str, values: List[List[Any]]) -> None:
    service = sheets_service()
    service.spreadsheets().values().append(
        spreadsheetId=get_required_env("GOOGLE_SHEET_ID"),
        range=range_name,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": values},
    ).execute()


def sheets_service():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    credentials = Credentials.from_service_account_info(json.loads(get_required_env("GOOGLE_SERVICE_ACCOUNT_JSON")), scopes=scopes)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def fetch_nse_json(url: str) -> Dict[str, Any]:
    fetch_text(CONFIG["urls"]["nse_home"])
    response = SESSION.get(url, headers={"Referer": "https://www.nseindia.com/"}, timeout=20)
    response.raise_for_status()
    return response.json()


def fetch_json(url: str) -> Dict[str, Any]:
    return json.loads(fetch_text(url))


def fetch_text(url: str) -> str:
    last_error: Optional[Exception] = None
    for attempt in range(1, CONFIG["max_retries"] + 1):
        try:
            response = SESSION.get(url, timeout=20)
            if response.status_code == 200:
                return response.text
            if response.status_code in (403, 429) or response.status_code >= 500:
                time.sleep(CONFIG["retry_backoff_seconds"] * attempt)
                continue
            response.raise_for_status()
        except Exception as exc:
            last_error = exc
            time.sleep(CONFIG["retry_backoff_seconds"] * attempt)
    raise RuntimeError(f"Fetch failed for {url}: {last_error}")


def parse_gift_nifty_from_html(html_text: str) -> Dict[str, Optional[float]]:
    snippet = slice_around(html_text, r"(GIFT\s*NIFTY|SGX\s*NIFTY)", 2500)
    value = (
        extract_first_number(snippet, r"(?:last|ltp|price|close|current)[^0-9-]*([+-]?\d[\d,]*\.?\d*)")
        or extract_first_number(snippet, r'"pricecurrent":"([+-]?\d[\d,]*\.?\d*)"')
    )
    pct_change = (
        extract_first_number(snippet, r"([+-]?\d[\d,]*\.?\d*)\s*%")
        or extract_first_number(snippet, r'"changePercent":"([+-]?\d[\d,]*\.?\d*)"')
    )
    return {"value": value, "pct_change": pct_change}


def parse_india_vix_from_nse(payload: Dict[str, Any]) -> Dict[str, Optional[float]]:
    for row in payload.get("data", []):
        label = str(row.get("index") or row.get("key") or row.get("name") or "").upper()
        if "INDIA VIX" in label:
            return {
                "value": to_number(row.get("last") or row.get("lastPrice") or row.get("price")),
                "change": to_number(row.get("variation") or row.get("change") or row.get("pointChange")),
            }
    return {"value": None, "change": None}


def parse_india_vix_from_html(html_text: str) -> Dict[str, Optional[float]]:
    snippet = slice_around(html_text, r"INDIA\s*VIX", 2200)
    return {
        "value": extract_first_number(snippet, r'"pricecurrent":"([+-]?\d[\d,]*\.?\d*)"'),
        "change": extract_first_number(snippet, r'"priceChange":"([+-]?\d[\d,]*\.?\d*)"'),
    }


def parse_advance_decline_from_json(payload: Any) -> Dict[str, Optional[float]]:
    stack = [payload]
    while stack:
        current = stack.pop()
        if isinstance(current, list):
            stack.extend(current)
        elif isinstance(current, dict):
            advances = to_number(current.get("advances") or current.get("advance") or current.get("adv"))
            declines = to_number(current.get("declines") or current.get("decline") or current.get("dec"))
            if advances is not None and declines not in (None, 0):
                return {"ratio": round(advances / declines, 2)}
            stack.extend(current.values())
    return {"ratio": None}


def parse_advance_decline_from_html(html_text: str) -> Dict[str, Optional[float]]:
    advances = extract_first_number(html_text, r"Advances?[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)")
    declines = extract_first_number(html_text, r"Declines?[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)")
    if advances is not None and declines not in (None, 0):
        return {"ratio": round(advances / declines, 2)}
    return {"ratio": extract_first_number(html_text, r"Advance[^A-Za-z0-9]{0,20}Decline[^0-9]{0,20}([+-]?\d[\d,]*\.?\d*)")}


def safe_fetch(fn):
    try:
        return fn() or {}
    except Exception as exc:
        logging.warning("%s failed: %s", fn.__name__, exc)
        return {}


def compute_percent_change(current: Optional[float], previous: Any) -> Optional[float]:
    current_num = to_number(current)
    previous_num = to_number(previous)
    if current_num is None or previous_num in (None, 0):
        return None
    return round(((current_num - previous_num) / previous_num) * 100, 2)


def compute_absolute_change(current: Optional[float], previous: Any) -> Optional[float]:
    current_num = to_number(current)
    previous_num = to_number(previous)
    if current_num is None or previous_num is None:
        return None
    return round(current_num - previous_num, 2)


def get_prev(previous: Optional[Dict[str, Any]], key: str) -> Any:
    return (previous or {}).get(key)


def push_signal(bucket: List[int], value: Optional[float], positive: float, negative: float) -> None:
    number = to_number(value)
    if number is None:
        return
    if number >= positive:
        bucket.append(1)
    elif number <= negative:
        bucket.append(-1)


def push_signal_reverse(bucket: List[int], value: Optional[float], positive: float, negative: float) -> None:
    number = to_number(value)
    if number is None:
        return
    if number <= positive:
        bucket.append(1)
    elif number >= negative:
        bucket.append(-1)


def to_number(value: Any) -> Optional[float]:
    if value in ("", None):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = str(value).replace(",", "").replace("%", "").strip()
    if cleaned in ("", "-", "--"):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def extract_first_number(text: str, pattern: str) -> Optional[float]:
    match = re.search(pattern, text, flags=re.I | re.S)
    return to_number(match.group(1)) if match else None


def slice_around(text: str, pattern: str, radius: int) -> str:
    match = re.search(pattern, text, flags=re.I)
    if not match:
        return text[:radius]
    start = max(0, match.start() - radius)
    end = min(len(text), match.start() + radius)
    return text[start:end]


def get_required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


if __name__ == "__main__":
    main()
