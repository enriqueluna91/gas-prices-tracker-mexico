# Gasolina MX — Gas Prices Tracker (Mexico)

Interactive choropleth map showing daily fuel prices across Mexico's 32 states.
Data sourced from the CNE (Comisión Nacional de Energía) public API.

## Architecture

```
GitHub Actions (daily at 7am CST)
  → scrapes CNE API → SQLite
  → exports state averages → JSON
  → deploys static site → GitHub Pages
```

## Project structure

```
├── .github/workflows/     GitHub Actions CI/CD
│   └── update-prices.yml
├── scripts/
│   ├── cne_precios.py     Daily price scraper
│   ├── export_prices.py   SQLite → JSON exporter
│   └── cne_precios.db     SQLite database (auto-committed)
├── site/                  Static site (deployed to GitHub Pages)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── data/
│       ├── mexico_states.geojson
│       └── prices.json    Generated daily
├── inputs/
│   └── cne_context.md     API reverse-engineering notes
└── requirements.txt
```

## Run locally

```bash
pip install -r requirements.txt

# Scrape today's prices
python scripts/cne_precios.py

# Export to JSON
python scripts/export_prices.py

# Preview the map
cd site && python -m http.server 8080
# Open http://localhost:8080
```

## Deploy

The site auto-deploys via GitHub Actions. To set up:

1. Push this repo to GitHub
2. Go to **Settings → Pages → Source** and select **GitHub Actions**
3. (Optional) Add a custom domain under **Settings → Pages → Custom domain**
4. The workflow runs daily at 7:00 AM CST, or trigger manually from **Actions → Run workflow**

## Data source

- API: `api-reportediario.cne.gob.mx` (CNE public API, no auth required)
- Coverage: 32 states, ~12,000+ gas stations
- Fuel types: Regular, Premium, Diésel
