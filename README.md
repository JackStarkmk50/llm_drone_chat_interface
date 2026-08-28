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
take off to 1.5 meters
fly to 2 metres north and 1 metre east
queue waypoints: 1 east, then 2 north, then back to the start
move forward 1 metre
move left / move right / go back 50 cm
turn right 90 degrees  /  rotate anticlockwise 45
nudge left for half a second
yaw right for 1 second
go up 0.5 m  /  descend half a metre
go to 2 m height          (absolute — uses takeoff, works while flying, climbs only)
what is the battery level?
what is EK3_SRC1_POSXY set to?
hold position
land now
return to home
emergency stop            (cancels everything, controlled LAND, disarm on touchdown)
set mode to LOITER
run a mission: take off to 1.5m, hover 5 seconds, land
check mission status
cancel the mission
show the current flight recording
start the camera
```

The LLM understands natural phrasing — you don't need to use exact keywords.

---

## Two ways to move — the LLM picks

This airframe has no GUIDED-mode setpoint path. The companion computer flies it by streaming RC channel overrides at 20 Hz, so there are two distinct movement tools:

| Tool | Endpoint | Use when |
|---|---|---|
| `nav_goto` / `nav_queue` | `/nav/goto`, `/nav/queue` | A **distance or position** is asked for — "2 metres north", "go back to the start". Closed loop, metres east/north of the arm point. |
| `rc_move` | `/rc` | A **nudge** is asked for — "a bit left", "yaw right". A timed stick hold, not a distance. |

`rc_move` heartbeats at 5 Hz for the requested duration and then releases. It asks the server for a 0.5 s deadman window, so if the browser tab dies mid-nudge the aircraft centres half a second later rather than coasting for the 3 s default that `POST /rc` uses.

`rc_move` accepts one of `duration_s` ("forward 2 seconds"), `distance_m` ("forward 1 metre", "up half a metre") or `angle_deg` ("turn right 90"). Distances and angles are **open-loop**: converted to a hold time using the calibration constants below, then the result reports what the EKF measured (`measured.moved_m`, `turned_deg`, `alt_change_m`) so the model tells you what really happened.

Caps per call: 8 s hold, 2 m horizontal, 1 m vertical, 180°.

`takeoff`, `nav_goto` and `nav_queue` block until the manoeuvre finishes (rangefinder at target / nav state leaves `flying`), so "take off to 1.5 m and then move forward 1 m" runs in order instead of fighting the takeoff throttle loop.

### Calibrating rc_move

Constants live at the top of `static/js/app.js` in `RC_CAL`:

| Constant | Meaning | How to measure |
|---|---|---|
| `MPS` | m/s during a horizontal hold | groundspeed plateau |
| `OVERSHOOT` | metres coasted after release | final displacement − `MPS` × hold time |
| `MPS_Z` | m/s during a throttle hold | rangefinder change ÷ hold time |
| `YAW_DPS` | °/s during a yaw hold | heading change ÷ hold time |
| `PWM_OFFSET` | stick offset sent as `/rc value` | keep 150 unless you want slower |

Quick steps:

1. **Tame the Pixhawk first** (webapp → Settings → Parameters, or Mission Planner): `LOIT_SPEED` → `100` (cm/s; default dump shows 500 = 1.5 m/s at 30 % stick, too fast indoors), `LOIT_BRK_DELAY` → `0.2`. Read `PILOT_Y_RATE` and `PILOT_SPEED_UP` for reference.
2. Take off to 1 m. In chat: `forward for 2 seconds`. Repeat 3×. Also `turn right for 2 seconds` and `ascend for 2 seconds` once each.
3. Open `webapp/flights.html` → the flight → track. Read: `groundspeed` plateau during each forward hold → `MPS`; total displacement of one hold − (`MPS` × 2) → `OVERSHOOT`; heading change ÷ 2 → `YAW_DPS`; altitude change ÷ 2 → `MPS_Z`. (The chat's own `measured` field in each tool result gives the same numbers without opening the tracker.)
4. Edit the numbers in `RC_CAL`, reload the page. Done.
5. Changed `LOIT_SPEED` / `LOIT_BRK_DELAY` / `PILOT_*` later? Repeat 2–4.

> **Removed endpoints:** `/move` and `/yaw` were deleted on 2026-08-07 with the GUIDED primitives. The server answers them `410` with a pointer to `/rc`. No tool calls them any more.

> **Missions are limited:** `run_mission` accepts `takeoff`, `land`, `hold`, `hover` only. The directional mission steps went away with `/move`. Use `nav_queue` for a multi-point flight.

> **Without GPS:** takeoff and waypoint navigation work without a GPS fix — the server uses rangefinder altitude and the EKF position estimate. Only RTL requires GPS.

> **Optional subsystems:** waypoint navigation (`/nav/*`) and the flight tracker (`/flights/*`) are optional on the server — if either fails to import or initialise, the flight server still starts without it. The chat page reads `/health` on CONNECT and posts a `SERVER` note in the chat when one is disabled, so you know before the model tries `nav_goto` or `flights_list`.

---

## Camera panel

The `▣` button (top right, under the config bar) opens a camera panel. It uses the same path as the webapp: `POST /camera/start`, then an `<img>` pointed at `GET /camera/stream` (MJPEG). The `camera_start` / `camera_stop` tools route through the same panel, so "start the camera" in chat opens the feed.

`camera_stop` can answer `409` while a flight video is being recorded — the server keeps the camera on and the panel shows `REC`. The feed is detached locally either way.

> **ngrok caveat:** an `<img>` cannot send the `ngrok-skip-browser-warning` header, so on a free ngrok tunnel the stream request can hit the interstitial page and fail (`STREAM FAILED`). A LAN IP or a static ngrok domain streams fine.

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
| Tool result shows `http_status: 410` | Client is calling a removed endpoint | The response body carries `use_instead`. If you see this, a tool in `app.js` is out of sync with the server. |
| Takeoff returns "Min altitude is 0.5m" | Server clamps to 0.5–10 m | Ask for an altitude in range. |
| Takeoff returns "Battery too low (4S min 13.2v)" | Pack below 13.2 V | Charge. The check is in `/takeoff`, not in the chat app. |
| `nav_goto` / `flights_list` returns `http_status: 404` | Subsystem disabled on the server | Check the `SERVER` note posted at connect, and the Pi console for `[nav] DISABLED` / `[tracker] DISABLED`. |
| Camera panel shows `STREAM FAILED` | `<img>` blocked by ngrok interstitial, or camera not open | Use a LAN IP / static ngrok domain; check `/camera/start` result in the chat. |
| `nav_goto` returns "x and y required" | Model sent a direction instead of coordinates | Rephrase as a position: "2 metres north of the arm point". |
| "forward 1 m" moved a different distance | Calibration stale or params changed | Re-run "Calibrating rc_move". Compare `measured.moved_m` in the tool result to what was asked. |
| LLM picks the wrong tool | 24 tools is a lot for a 7B model | Use `qwen2.5:14b`, or trim tools you don't need from `TOOLS` in `app.js`. |

---

## Project structure

```
llm_chat/
├── index.html          # main page
├── README.md           # this file
└── static/
    ├── css/style.css   # all styles (incl. camera panel)
    └── js/app.js       # LLM logic, tool calling, drone API, camera panel
```

The interface is fully static — no backend, no build step. The browser talks directly to Ollama and the drone API.
