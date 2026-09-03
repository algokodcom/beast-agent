# Beast Agent

> **fast, light and resourceful** — a local agent shell for Windows. It chats, runs commands, writes files, searches the web, and is fully controllable from WhatsApp.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![electron](https://img.shields.io/badge/electron-40-47848F)

> [!IMPORTANT]
> **This is a desktop app — it must be installed GLOBALLY:**
> ```bash
> npm install -g beast-agent
> ```
> ⚠️ The npm sidebar box (`npm i beast-agent`) performs a **local** install — the `beast-agent` command will NOT be on your PATH and the app won't start. If you already installed locally, either re-run the command above, or launch with `npx beast-agent`. Global install also sets up the desktop shortcut and Windows startup automatically on first launch.

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
- **MCP desteği** — Model Context Protocol server bağla (filesystem, git, fetch, memory + binlerce topluluk server'ı); araçlar `mcp__server__tool` adıyla modele açılır, Ayarlar → MCP'den yönetilir
- **Skills** — `%APPDATA%\beast\skills\<ad>\SKILL.md` ile ajanına yetenek öğret; Superpowers metodoloji paketi (planlama, TDD, paralel ajan disiplini, doğrulama) builtin gelir
- **Web search chain** — TinyFish (free, used first if a key is set) → built-in browser (direct Google) → python multi-engine (DDG/Bing/Mojeek) → Exa
- **Approval gate** — optional confirmation for risky actions (commands / file deletion-modification): default OFF (everything free), when ON the agent asks (`/approve`, `/approve always`, `/deny`)
- **Provider-based limits** — per-provider max input token limit with context compression
- **Encrypted backups** — all data is AES-256 encrypted and signed with your machine's unique **Beast Code**
- **Dashboard** — session history, message statistics, cost tracking
- **Full TR/EN interface** — everything switches language instantly
- **/health** — `http://127.0.0.1:8788/health` liveness endpoint from the moment the app boots

## 📦 Download & Install — 2 commands, ready

```bash
npm install -g beast-agent
```

Then start it:

```bash
beast-agent
```

That's it — the app window opens. On first launch Beast also creates a **desktop shortcut** and registers itself to **start with Windows** (lives in the tray). Later updates: close the app and run `beast update` (or `beast-agent update`).

## ⚙️ Configuration

### Recommended: OpenCode Zen (free tier, no credit card)

Get a key at [opencode.ai/auth](https://opencode.ai/auth), then copy `config.example.yaml` → `config.yaml`:

```yaml
defaultSelection: opencode::glm-5.2
providers:
  - id: opencode
    name: OpenCode Zen
    baseUrl: https://opencode.ai/zen/v1
    apiKey: <your-key>
    models:
      - glm-5.2
      - kimi-k2.7-code
      - deepseek-v4-flash-free
      - big-pickle
      - minimax-m3
```

> Free models include `deepseek-v4-flash-free`, `big-pickle`, `mimo-v2.5-free`, `nemotron-3-ultra-free`. If you have an **OpenCode Go** subscription, use the same config with `baseUrl: https://opencode.ai/zen/go/v1`.

### Any other OpenAI-compatible provider

OpenRouter, Zhipu, Ollama, OpenAI — anything that speaks `/v1/chat/completions` works:

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

API keys can also go into `.env` (copy `.env.example` → `.env`). On first launch, Settings → Provider pulls your models automatically.

All app data lives under `%APPDATA%\beast` (sessions, memory, WhatsApp pairing, encrypted settings).

## 🗣️ Usage

| Where | What it does |
|---|---|
| Chat | Give it a task — it works on its own with tools (files, commands, web, python, browser) |
| WhatsApp | Add your number to the allow list, control the agent from your phone |
| Tray | Closing the window doesn't kill it — Beast keeps living in the tray |

Type `/help` in the chat to see every command.

## 🗑️ Uninstall

```bash
beast-agent uninstall
```

This removes the app (package, startup registration, desktop shortcut) but **keeps all your personal data** — `config.yaml`, `.env`, sessions, memory, WhatsApp pairing and encrypted backups stay in `%APPDATA%\beast`. Reinstall later with `npm install -g beast-agent` and everything is exactly where you left it.

To wipe everything instead, delete the `%APPDATA%\beast` folder after uninstalling.

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
