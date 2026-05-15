# PM Panel

An internal product-management dashboard that consolidates competitor research,
release feeds, feature matrices, customer-ticket triage (SPOC) and AI-assisted
analysis into a single web UI.

It runs as a small Node.js + Express server with a vanilla-React (Babel
in-browser) frontend and a local SQLite database — no build step required.

---

## Features

- **Dashboard** — at-a-glance metrics across all data sources.
- **Trends** — analyst feeds (Gartner, Forrester, etc.) parsed and clustered.
- **Report** — generate periodic write-ups from the collected data.
- **Feed** — ingest RSS / Atom / web sources via `lib/ingest.js`.
- **Releases** — track product releases per vendor.
- **Matrix** — feature-by-product capability matrix with bulk import.
- **Gaps** — surface missing or weak coverage vs. competitors.
- **SPOC** — daily customer-ticket sheet from Zoho WorkDrive: download,
  dedupe by Ticket ID, per-person read tracker, dashboard, AI tools.
  Live progress bar while syncing.
- **Settings** — AI key, scheduler, SPOC config, "me" picker.

---

## Tech stack

| Layer    | Tool                                     |
| -------- | ---------------------------------------- |
| Server   | Node.js (LTS), Express 5                 |
| DB       | SQLite via `better-sqlite3`              |
| Ingest   | `xlsx`, `cheerio`, `rss-parser`          |
| Browser  | `playwright` (Chromium, headless)        |
| Frontend | React 18 via Babel-standalone, vanilla CSS |
| Tests    | _none yet_                                |

---

## Requirements

- **Node.js 22 LTS** (recommended). Node 24 also works but `better-sqlite3`
  prebuilds for it lag — if `npm install` fails with `node-gyp` errors, use
  Node 22 or install the Visual Studio C++ Build Tools.
- **npm 10+** (ships with modern Node).
- **Windows / macOS / Linux** — tested on Windows 10/11.
- **Chromium** for Playwright (auto-downloaded by `npx playwright install`).

---

## Quick start

```powershell
# 1. Clone
git clone https://github.com/<your-username>/pm-panel.git
cd pm-panel\server

# 2. Install deps
npm install

# 3. Install the Chromium binary used by SPOC's headless downloader
npx playwright install chromium

# 4. Run
node index.js
```

Then open <http://localhost:4000>.

> On first launch the SQLite file and required tables are created automatically.

### Windows convenience scripts

- `server\setup.bat` — installs deps + Chromium in one go.
- `server\pm-panel.bat` — starts the server.

### Linux / macOS

- `server/setup.sh`
- `server/pm-panel.sh`

---

## Configuration

All runtime config is via environment variables (optional):

| Variable          | Default                                              | Purpose                                   |
| ----------------- | ---------------------------------------------------- | ----------------------------------------- |
| `PORT`            | `4000`                                               | HTTP port                                 |
| `SPOC_INBOX_DIR`  | `~/pm-panel/spoc-inbox`                              | Folder watched for SPOC spreadsheets      |
| `SPOC_KEEP_FILES` | _(unset)_                                            | If set, keep XLSX files after import      |

The SPOC download URL and the AI key are configured in the **Settings** UI and
persisted in the `settings` table of the SQLite DB.

---

## Project layout

```
server/
├── index.js              Express app, routes, scheduler hooks
├── db.js                 SQLite bootstrap
├── lib/
│   ├── analyzer.js       feature extraction, scoring
│   ├── chat-tools.js     tool definitions exposed to the LLM
│   ├── ingest.js         RSS / web ingest
│   ├── llm.js            chat-completions client
│   ├── spoc.js           SPOC sheet download + parse + dedup
│   ├── trends.js         analyst-feed processing
│   └── ...
├── public/
│   ├── index.html        Babel-standalone bootstrap
│   ├── app.jsx           single-file React app
│   └── styles.css
├── package.json
├── setup.bat / setup.sh
└── pm-panel.bat / pm-panel.sh

spoc-inbox/                Local-only, ignored by git
```

---

## SPOC sync (daily ticket import)

1. Configure the Zoho WorkDrive external-share **Download URL** under
   **Settings → SPOC**.
2. Click **Import now**. A live progress bar shows each stage:
   `Downloading → Scanning → Hashing → Parsing → Writing`.
3. Rows are deduped by **Ticket ID** (or row hash) so the same ticket
   reappearing across days collapses to one entry.
4. Each tracked person can mark rows **read / unread**; overrides survive
   re-imports.

The scheduler also runs the import once a day at 00:10.

---

## Database

`better-sqlite3` opens a single file. Schema is created lazily by each module
(`spoc.js`, `ingest.js`, …). The DB and any `.xlsx` files in `spoc-inbox/` are
git-ignored — see `.gitignore`.

---

## Development notes

- **No bundler.** `app.jsx` is loaded directly via `<script type="text/babel">`
  in `index.html`. Just edit and refresh.
- **API conventions.** All endpoints live under `/api/*`. The generic
  `crud(resource, table, fields)` helper at the top of `index.js` covers most
  CRUD; specialised routes are added below it.
- **AI tools.** New chat tools go in `lib/chat-tools.js` and are auto-exposed
  to the assistant.

---

## Troubleshooting

| Symptom                                           | Fix                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `npm install` fails on `better-sqlite3 / node-gyp` | Switch to Node 22 LTS, or install **VS 2022 C++ Build Tools**.       |
| `Executable doesn't exist at .../chrome-headless-shell.exe` | Run `npx playwright install chromium` in `server/`.                  |
| `npm ERR! primordials is not defined`             | Stale global npm in `%APPDATA%\npm`. Delete it and reinstall Node.   |
| SPOC sync "no download event fired"               | The share URL likely changed or requires login — re-copy from Zoho.  |
| Port `4000` in use                                | `set PORT=4100` (Windows) or `PORT=4100` (bash) before starting.     |

---

## License

ISC — see `server/package.json`.

Internal use only unless explicitly opened up.
