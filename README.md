# Beast Agent

> **fast, light and resourceful** — a local agent shell for Windows. It chats, runs commands, writes files, searches the web, and is fully controllable from WhatsApp.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![electron](https://img.shields.io/badge/electron-40-47848F)

**Website:** [beast.algokod.com](https://beast.algokod.com) · **AlgoKod:** [algokod.com](https://algokod.com)

Beast Agent is a personal AI agent that runs on your machine and connects to **any OpenAI-compatible provider**. Define all your models in a single `config.yaml`; Beast handles the rest.

## ✨ Features

- **Multi-provider** — unlimited models from config.yaml; instant switching in the picker, role-based models (vision / terminal / coding / subagent)
- **FALLOUT chain** ⚛ — if a model fails, Beast automatically moves to the next provider and resumes where it left off
- **CEO mode** — the talking agent does no work itself; it delegates orders to parallel agents with a live monitoring panel
- **WhatsApp integration** — pair via QR; DMs + groups (@mention), voice notes auto-transcribed by local Whisper, replies can be sent as voice notes too
- **Slash commands** — `/new`, `/open`, `/change`, `/think`, `/rule`, `/allow`, `/block`, `/backup`, `/approve` and more
- **Event center** — IMAP IDLE email watching, file-change watching, price feed (Binance), webhook inputs
- **Cron + watchers** — scheduled tasks, file/web/battery watchers
- **Web search chain** — TinyFish (free, used first if a key is set) → built-in browser (direct Google) → python multi-engine (DDG/Bing/Mojeek) → Exa
- **Approval gate** — optional confirmation for risky actions (commands / file deletion-modification): default OFF (everything free), when ON the agent asks (`/approve`, `/approve always`, `/deny`)
- **Provider-based limits** — per-provider max input token limit with context compression
- **Encrypted backups** — all data is AES-256 encrypted and signed with your machine's unique **Beast Code**
- **Dashboard** — session history, message statistics, cost tracking
- **Full TR/EN interface** — everything switches language instantly
- **/health** — `http://127.0.0.1:8788/health` liveness endpoint from the moment the app boots

## 📦 Download

### Installer (recommended)
Grab `BeastAgent-Setup-x.x.x.exe` from the [Releases](../../releases) page. After install, Beast starts automatically with Windows (lives in the tray).

### npm
```bash
npm install -g beast-agent
```
Then run `beast-agent` from any terminal. On first launch Beast creates a desktop shortcut and registers itself for auto-start.

### From source
```bash
git clone https://github.com/algokodcom/beast-agent.git
cd beast-agent
npm install
npm start
```

> Requirements: Node.js 18+, Windows 10/11. Python and ffmpeg are optional — Beast installs missing tooling itself.

## ⚙️ Configuration

1. Copy `config.example.yaml` → `config.yaml` and add your providers:
```yaml
defaultSelection: openrouter::anthropic/claude-3.5-sonnet
providers:
  - id: openrouter
    name: OpenRouter
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-or-...
    models:
      - anthropic/claude-3.5-sonnet
      - gpt-4o
```
2. You can also provide API keys via `.env`: copy `.env.example` → `.env`
3. On first launch, Settings → Provider pulls your models automatically.

All app data lives under `%APPDATA%\beast` (sessions, memory, WhatsApp pairing, encrypted settings).

## 🗣️ Usage

| Where | What it does |
|---|---|
| Chat | Give it a task — it works on its own with tools (files, commands, web, python, browser) |
| WhatsApp | Add your number to the allow list, control the agent from your phone |
| Tray | Closing the window doesn't kill it — Beast keeps living in the tray |

Type `/help` in the chat to see every command.

## 🔒 Security & Privacy

- Everything runs **locally**: sessions, memory and logs stay on your disk
- API keys are never sent to the renderer in plaintext — masking is applied
- Backups are AES-256 encrypted + signed with the Beast Code — only your machine can restore them
- The approval gate is **off by default**; enable it from the Security tab if you want

## 🧪 Development

```bash
npm test        # engine + tool tests (node --test)
npm run dist    # NSIS + portable build
```

## 📄 License

[MIT](LICENSE) © 2026 algokodcom (AlgoKod)
