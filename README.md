# Drone AI Chat Interface

Natural language drone control. Type commands like "take off to 3 metres" — the LLM translates them into API calls to your drone server.

---

## Prerequisites

- [Ollama](https://ollama.com) installed (for local LLM) **or** any OpenAI-compatible API key
- Drone API server running (Flask app on Raspberry Pi or local machine)
- A modern browser (Chrome / Firefox / Edge)

---

## 1 — Pull a model (Ollama)

Open a terminal and run:

```bash
ollama pull qwen2.5:7b
```

`qwen2.5:7b` is recommended — best tool-calling accuracy at 7B size, needs ~5 GB RAM.

Other options:

| Model | RAM needed | Notes |
|---|---|---|
| `qwen2.5:7b` | ~5 GB | Best tool calling at 7B |
| `llama3.1:8b` | ~5 GB | Good general purpose |
| `qwen2.5:14b` | ~10 GB | Better reasoning |
| `llama3.3:70b` | ~45 GB | Very capable, needs high-end GPU |

---

## 2 — Allow browser access to Ollama (required)

Ollama blocks requests from browser pages by default. You must set `OLLAMA_ORIGINS=*` before starting it.

### Windows

**Temporary (current session only):**
```powershell
$env:OLLAMA_ORIGINS = "*"
ollama serve
```

**Permanent (survives reboots):**
```powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "*", "User")
```
Then restart Ollama from the Start menu or tray icon.

### macOS / Linux

**Temporary:**
```bash
OLLAMA_ORIGINS="*" ollama serve
```

**Permanent (add to shell profile):**
```bash
echo 'export OLLAMA_ORIGINS="*"' >> ~/.bashrc   # or ~/.zshrc
source ~/.bashrc
```

> **Why is this needed?**
> Browsers enforce CORS — they block JavaScript from calling APIs on different origins unless the server explicitly allows it. Ollama's default allowlist only includes `localhost` accessed from `localhost`. Opening `index.html` as a `file://` page (or from GitHub Pages) has a different origin, so Ollama rejects the request with a CORS error that shows as "Failed to fetch" in the chat.

---

## 3 — Serve the page

### Option A — Open directly (simplest)

Double-click `index.html` or drag it into your browser. Works fine as long as `OLLAMA_ORIGINS=*` is set.

### Option B — Local HTTP server (more reliable)

```bash
# Python
cd llm_chat
python -m http.server 8080

# Node (if you have npx)
npx serve llm_chat
```

Then open `http://localhost:8080` in your browser.

---

## 4 — Configure in the UI

Fill in the top bar and click **CONNECT**:

| Field | What to enter |
|---|---|
| **Drone URL** | Your Pi's ngrok URL (`https://abc123.ngrok-free.app`) or local IP (`http://192.168.x.x:5000`) |
| **LLM Mode** | `OLLAMA` for local model, `API` for OpenAI-compatible online service |
| **LLM URL** | `http://localhost:11434` for Ollama, or your API base URL |
| **Model** | `qwen2.5:7b` or whatever you pulled |
| **API Key** | Only needed in `API` mode (Groq, OpenRouter, OpenAI, etc.) |

Settings are saved automatically in `localStorage` — no need to re-enter after refresh.

---

## 5 — Using online APIs instead of Ollama

Switch LLM Mode to **API** in the UI. Any OpenAI-compatible endpoint works:

| Provider | LLM URL | Good models |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` (free tier) |
| OpenRouter | `https://openrouter.ai/api/v1` | many options |

No `OLLAMA_ORIGINS` setup needed for online APIs.

---

## 6 — Example commands

```
take off to 3 meters
move forward 2 metres
rotate right 90 degrees
what is the battery level?
land now
return to home
hold position
emergency stop
set mode to LOITER
set mode to GUIDED_NOGPS
```

The LLM understands natural phrasing — you don't need to use exact keywords.

> **Move speed:** The server enforces **0.2–0.3 m/s** for all move commands (indoor AI safety limit). The LLM defaults to 0.3 m/s. Asking for higher speeds returns a 400 error from the drone server.

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Status dot shows **OFFLINE** | Drone server not reachable | Check ngrok is running, Pi server is up |
| Status dot shows **TIMEOUT** | Server too slow to respond | ngrok tunnel may have lapsed, restart it |
| Chat shows **Failed to fetch** | Ollama CORS blocked | Set `OLLAMA_ORIGINS=*` and restart Ollama (Step 2) |
| Chat shows **Ollama HTTP 404** | Wrong model name | Run `ollama list` to see pulled models, fix the Model field |
| Chat shows **Ollama HTTP 500** | Model not pulled | Run `ollama pull qwen2.5:7b` |
| LLM responds but doesn't call tools | Model too small / wrong prompt | Use `qwen2.5:7b` or larger; avoid tiny models like `phi3:mini` |
| Drone shows online but command fails | Drone not armed / no GPS | Check the dashboard for status before commanding |
| Drone API CORS blocked from GitHub Pages | ngrok intercepts requests without bypass header | Drone API calls already include `ngrok-skip-browser-warning` header automatically. Ensure the Pi server has `after_request` CORS hook (see server docs). |
| Move command returns HTTP 400 | Speed out of range | Server enforces 0.2–0.3 m/s. LLM uses 0.3 m/s default. |

---

## Project structure

```
llm_chat/
├── index.html          # main page
├── README.md           # this file
└── static/
    ├── css/style.css   # all styles
    └── js/app.js       # LLM logic, tool calling, drone API
```

The interface is fully static — no backend, no build step. The browser talks directly to Ollama and the drone API.
