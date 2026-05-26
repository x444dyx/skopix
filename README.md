# Skopix

Record tests by using your app. Replay them anywhere.

**[skopix.ayteelabs.com](https://skopix.ayteelabs.com)**

---

## Install

```bash
npm install -g skopix
npx playwright install chromium
```

---

## Quick Start

### Solo mode
```bash
skopix dashboard
```
Open `http://localhost:9000` and start recording.

### Team mode (one command)
Add to `~/.skopix.env` once:
```
SKOPIX_SECRET_KEY=your-secret
SKOPIX_AGENT_EMAIL=your@email.com
SKOPIX_AGENT_PASSWORD=yourpassword
```
Then:
```bash
skopix start
```
Starts the dashboard + agent in one command. Teammates connect via `http://YOUR-IP:9000`.

### Teammates — connect as agent
```bash
skopix agent --server http://HOST-IP:9000 --key "your-secret"
```

---

## Configure AI

```bash
skopix init
```
Choose Gemini, OpenAI, or Ollama (local — no API key needed).

Or set manually in `~/.skopix.env`:
```
SKOPIX_PROVIDER=gemini
GEMINI_API_KEY=your-key
```

---

## All Commands

| Command | Description |
|---|---|
| `skopix start` | Start dashboard + agent (team mode) |
| `skopix dashboard` | Start dashboard (solo mode) |
| `skopix dashboard --team --host 0.0.0.0` | Start dashboard in team mode |
| `skopix agent --server URL --key SECRET` | Connect as agent to a shared server |
| `skopix init` | Configure AI provider and API keys |
| `skopix config --set KEY=value` | Set a config value |
| `skopix config --list` | List all config values |

---

## Data & Backup

All data lives in `~/.skopix/` — tests, suites, sessions, credentials.

Backup:
```bash
node skopix-backup.js
```
Restore:
```bash
node skopix-restore.js
```
Download backup scripts from this repo.

---

## Remote Access

Expose your dashboard to remote teammates using [Portix](https://portix.dev):
```bash
portix 9000 --name skopix
```

---

## Export to Playwright

Every recorded test generates a `.spec.js` / `.spec.ts` file. Download it from the test editor and run it anywhere with:
```bash
npx playwright test
```
No Skopix needed to run exported tests.

---

## Environment Variables

| Variable | Description |
|---|---|
| `SKOPIX_SECRET_KEY` | Required for team mode |
| `SKOPIX_PROVIDER` | AI provider: `gemini`, `openai`, `ollama` |
| `GEMINI_API_KEY` | Google Gemini API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OLLAMA_MODEL` | Ollama model name (e.g. `llama3.1`) |
| `SKOPIX_AGENT_EMAIL` | Auto-agent login email |
| `SKOPIX_AGENT_PASSWORD` | Auto-agent login password |
| `BASE_URL` | Override base URL for exported Playwright tests |
| `TEST_PASSWORD` | Password used in exported Playwright tests |

---

Built by [Aytee Labs](https://ayteelabs.com)
