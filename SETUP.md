# Market Data Setup

This file covers the legacy India/macroeconomic collectors. They still use `ALPHA_VANTAGE_API_KEY`.

For the U.S. stock dashboard research flow in `server.js`, set `FINNHUB_API_KEY` in `.env` or `.env.local`.

## Google Apps Script version

1. Open a Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Paste the contents of `market_data.gs` into a single script file.
4. In Apps Script, open `Project Settings -> Script properties` and add:
   - `ALPHA_VANTAGE_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Save the project and reload the Google Sheet.
6. Use the custom menu `Market Tools -> Setup Sheet`.
7. Run `Market Tools -> Fetch Data Now` once and approve permissions.
8. Use `Market Tools -> Create Triggers` to create the daily polling trigger.

## Notes

- The script only appends rows to `MarketData`; it never overwrites history.
- Telegram alerts are sent only when `Regime` changes.
- If a source is unavailable, the script fails gracefully and stores blank cells for that metric instead of deleting prior data.
- NSE and public market pages can change HTML or block bot traffic; the script includes fallbacks and retry logic, but scrape-based fields should still be monitored periodically.

## Optional Python version

Install dependencies:

```bash
pip install requests google-api-python-client google-auth
```

Set environment variables:

- `ALPHA_VANTAGE_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SHEET_NAME` (optional, defaults to `MarketData`)
- `TELEGRAM_BOT_TOKEN` (optional)
- `TELEGRAM_CHAT_ID` (optional)

Service account setup:

1. Create a Google Cloud service account.
2. Enable the Google Sheets API.
3. Download the JSON key and store its full JSON content in `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. Share the target Google Sheet with the service account email address.

GitHub Actions tip:

- Store the env vars as repository secrets.
- Run the Python script on a schedule using a cron workflow.
