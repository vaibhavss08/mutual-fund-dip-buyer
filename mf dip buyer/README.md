# MF Dip Buyer

![Node.js](https://img.shields.io/badge/Node.js-18+-brightgreen) ![SQLite](https://img.shields.io/badge/SQLite-3-lightgrey) ![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-MV3-yellow)

**Portfolio-aware dip scanner and mutual fund buy recommender.**

Import your mutual fund portfolio, identify which underlying stocks are dipping, and get deterministic fund-level allocation recommendations routed to your strongest existing exposures.

---

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

---

## How It Works

The app runs a five-step pipeline on your portfolio:

1. **Import portfolio** — via manual text entry or the companion Chrome extension.
2. **Resolve schemes** — scheme names are fuzzy-matched against the AMFI fund database.
3. **Fetch live prices** — equity holdings are looked up via Yahoo Finance; dip percentage is calculated for each stock.
4. **Rank dipping stocks** — candidates are filtered by the active risk-mode threshold, then scored by dip magnitude and portfolio exposure.
5. **Allocate capital** — the allocation engine routes capital to the optimal fund in your portfolio for each selected dip.

For the full scoring and routing logic, see [`../ALLOCATION_LOGIC.md`](../ALLOCATION_LOGIC.md).

---

## Three Risk Profiles

| Mode | Min Dip | Top Stocks | Description |
|------|---------|-----------|-------------|
| **Aggressive** | 0.5% | 5 | Maximum market participation — any meaningful move qualifies |
| **Balanced** | 1.0% | 4 | Default — meaningful dips only |
| **Conservative** | 2.0% | 3 | Only significant dips in core holdings |

Each mode also adjusts the blend of dip magnitude vs. existing exposure when computing stock scores. Aggressive weights dip size more heavily (70/30); Conservative weights existing exposure more heavily (30/70); Balanced is an even split (50/50).

---

## Input Formats

### Manual Text

One fund per line in the format:

```
ICICI Prudential Flexicap Fund - Growth | 250000
Parag Parikh Flexi Cap Fund | 400000
HDFC Flexi Cap Fund | 350000
```

The `| amount` portion is optional. Without amounts, all funds are weighted equally.

### Chrome Extension

The companion extension scrapes your portfolio from supported broker pages and sends it directly to the local server. See the [Chrome Extension](#chrome-extension) section below.

---

## Chrome Extension

The `extension/` directory contains a Manifest V3 Chrome extension that scrapes portfolio data from broker pages (IndMoney, MFCentral, Zerodha Coin, Groww) and sends it to the local server.

### Browser Compatibility

| Browser | Status |
|---------|--------|
| Chrome, Edge, Brave, Opera, Vivaldi | Fully supported |
| Firefox | Not guaranteed — MV3 + `chrome.scripting` compatibility varies by version |
| Safari | Not supported directly — requires Apple Safari Web Extension conversion via Xcode |

### Share as a Portable Extension

```bash
cd extension
zip -r ../mf-dip-buyer-extension.zip . -x "*.DS_Store"
```

Send `mf-dip-buyer-extension.zip` to the recipient. They extract it, then load it as an unpacked extension via the browser's Extensions page (Developer mode required). They then update `extension/config.properties` with your server's `BACKEND_BASE_URL` and reload the extension.

> Note: `.crx` sideloading is restricted in most Chromium browsers. ZIP + Load unpacked is the most reliable local-share method.

---

## Configuration

| File | Key | Purpose |
|------|-----|---------|
| `config/app.properties` | `SERVER_HOST` | Display host used in startup URL logs |
| `config/app.properties` | `SERVER_PORT` | Port the Node server listens on (default: 3000) |
| `extension/config.properties` | `BACKEND_BASE_URL` | Full base URL the extension posts data to |

After changing extension config, reload the unpacked extension in Chrome.

---

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/search-schemes` | `GET` | Search fund scheme names |
| `/api/analyze` | `POST` | Run full dip analysis on portfolio text |
| `/api/matcher/stocks/search` | `GET` | Autocomplete search across 926 NSE stocks |
| `/api/matcher/search` | `POST` | Match selected stocks to portfolio funds, then external funds |
| `/api/ext-stash` | `POST` | Receive portfolio text from Chrome extension |
| `/api/ext-get` | `GET` | Retrieve stashed extension data |

---

## Architecture

```
server.js          HTTP server, all API routes, analysis pipeline
stock-data.js      SQLite access layer (926 stocks, 544 funds)
stock-optimizer.js Fund scoring + bundle optimization (3 strategies)
public/
  index.html       Dashboard shell
  app.js           Frontend logic (dip scanner + buy recommendations)
  styles.css       All styles
extension/         Chrome extension (MV3)
config/            Server configuration
../shared-data/    Shared database and generated data (read-only)
```

---

## Data Sources

| Data | Source |
|------|--------|
| Scheme lookup + live holdings | Adityaraj Capital API |
| Live stock prices | Yahoo Finance |
| Stock + fund database | Shared SQLite (`../shared-data/mf_matcher.db`) |

---

## Database

The shared database at `../shared-data/mf_matcher.db` contains:

| Table | Rows | Contents |
|-------|------|----------|
| `stocks` | 926 | NSE symbols, names, sectors, market cap tier |
| `mutual_funds` | 544 | Scheme names, categories, AMCs, AUM |
| `holdings` | 19,618 | Fund–stock relationships with portfolio weights |

Holdings are stored in full for every included fund — not truncated to top 10. The database covers a representative fund universe (at most 2 schemes per AMC and broad category); it is not every raw scheme from the fetched catalog.

To refresh the database, run the pipeline in [`../scripts/data-pipeline/`](../scripts/data-pipeline/REFRESH_GUIDE.md).
