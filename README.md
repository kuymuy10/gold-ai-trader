# Gold AI Trader

**GOLD AI TRADER** is a full-stack TypeScript algorithmic XAUUSD (Gold) trading workspace combining multi-timeframe **EMA STOCHASTIC PRO** analysis (`H1 / M15 / M5 / M1`), **Smart Money Concepts (SMC)** structure detection, an **All-Session Dynamic Spread Filter**, **Gemini AI Trade Approval**, **TickerAll MT5 Master Feed** streaming, and **Multi-Broker MT5** execution support (**XM**, **Exness**, **Weltrade Cent**, and other MT5 brokers across Demo and Live accounts).

## Key Features

- **EMA STOCHASTIC PRO Strategy Engine**
  - Multi-timeframe trend and entry confirmation across **H1** (EMA 50/200), **M15** (EMA 9/21 + market structure), and **M5** (EMA 9/21 pullback, Stochastic `14,3,3` crossover, ATR 14, and confirmation candles).
  - Four independent setups: Bullish/Bearish Trend Continuation and Bullish/Bearish Reversal (liquidity sweep + confirmed CHoCH + OB/FVG retracement).
- **All-Session Dynamic Spread Filter**
  - All-session weekday trading across Asian, London, New York, and Off-Peak windows.
  - Real-time Bid/Ask spread classification (`NORMAL`, `ELEVATED`, `HIGH`, `EXCESSIVE`, `ABNORMAL`, or `DATA_UNAVAILABLE`) using symbol-specific `digits`, `pointSize`, `contractSize`, recent 1H/24H percentiles, and net Risk-to-Reward after estimated spread, commission, and slippage costs.
- **Multi-Broker MT5 & Live/Demo Support**
  - Supports **Standard (USD, 100 oz/lot)**, **Cent USD (1 oz/lot)**, **Cent USC (100 cent-oz/lot, e.g., Weltrade/Exness Cent)**, and **ECN / Raw / Zero / Pro (USD)** MT5 accounts.
  - Supports **Demo** simulation and **Live** account execution via each trader's verified `Broker Bridge Webhook URL` with idempotent order tracking (`FILLED`, `DEMO_SIMULATED`, `EXECUTION_UNAVAILABLE`).
- **Independent Gemini AI Trade Approver**
  - Evaluates 14 technical, spread, volatility, news, and account-risk criteria before execution while strictly honoring hard risk and quote-freshness safeguards.

## Project Structure

```text
.
├── server.ts                  # Express + Vite/static production server listening on process.env.PORT
├── server/                    # TickerAll execution adapter, Gemini approver, history fetcher, store & auth
├── src/
│   ├── App.tsx                # Main React workspace & Firebase cloud backup sync
│   ├── components/            # Dashboard, Strategy Settings, Broker Connection, Execution Gate, Admin UI
│   ├── lib/                   # Firebase client & Firestore synchronization helpers
│   ├── types/                 # Shared TypeScript interfaces
│   └── utils/                 # EMA Stochastic Pro, Dynamic Spread, and risk-sizing engines
├── tests/                     # Automated strategy, spread, multi-broker, and execution unit tests
├── index.html                 # Vite entry HTML
├── package.json               # Dependencies and build/start scripts
├── .env.example               # Environment variable template (no real secrets)
├── firestore.rules            # Hardened Firestore security rules
└── firebase-blueprint.json    # Firestore data model blueprint
```

## Environment Setup

Copy `.env.example` to `.env` and fill in your own secrets (never commit `.env`):

```bash
cp .env.example .env
```

Available environment variables:

- `PORT` — HTTP port the server binds to (defaults to `3000`).
- `GEMINI_API_KEY` — Server-side Google Gemini API key for the AI Trade Approver.
- `APP_URL` — Public base URL where the app is hosted.
- `TICKERALL_BASE_URL` — Base URL for the TickerAll MT5 market data API.
- `TICKERALL_API_KEY` — Fallback server-side TickerAll API key (can also be configured in `/admin`).
- `ADMIN_PASSWORD` — Admin PIN/password for `/admin`.
- `KEY_ENCRYPTION_SECRET` — 32-byte secret for encrypting stored broker keys at rest.

## Running Locally & in Production

Install dependencies:

```bash
npm install
```

Development mode (Express API + Vite middleware on `http://localhost:3000`):

```bash
npm run dev
```

Production build & start (serves compiled `dist/` bundle and binds to `process.env.PORT`):

```bash
npm run build
npm start
```

Run tests and checks:

```bash
npm run lint
npx tsx tests/emaStochasticPro.test.ts
npx tsx firestore.rules.test.ts
```
