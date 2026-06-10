// ── Config ───────────────────────────────────────────────────

const cfg = {
  droneUrl: localStorage.getItem('dc_droneUrl') || '',
  llmMode:  localStorage.getItem('dc_llmMode')  || 'ollama',
  llmUrl:   localStorage.getItem('dc_llmUrl')   || 'http://localhost:11434',
  model:    localStorage.getItem('dc_model')    || 'qwen2.5:7b',
  apiKey:   localStorage.getItem('dc_apiKey')   || ''
};

let history = []; // conversation history sent to LLM
let busy    = false;
let thinkEl = null;

// ── Tool Definitions ─────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: 'Get current drone status: mode, armed state, altitude, battery voltage, GPS fix, satellites',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'arm_drone',
      description: 'Arm the drone motors. Requires GUIDED mode and GPS fix >= 3.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disarm_drone',
      description: 'Disarm the drone motors safely',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'takeoff',
      description: 'Arm the drone and take off to a specified altitude in meters',
      parameters: {
        type: 'object',
        properties: {
          altitude: { type: 'number', description: 'Target altitude in meters (0.5 – 10)' }
        },
        required: ['altitude']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'land',
      description: 'Land the drone at its current position',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rtl',
      description: 'Return to launch point. Requires GPS fix.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hold',
      description: 'Hold current position. Uses LOITER if GPS available, ALTHOLD otherwise.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move',
      description: 'Move the drone in a direction for a given distance at a given speed',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['forward', 'backward', 'left', 'right', 'up', 'down'],
            description: 'Direction to move'
          },
          distance: { type: 'number', description: 'Distance in meters' },
          speed:    { type: 'number', description: 'Speed in m/s (default: 0.5)' }
        },
        required: ['direction', 'distance']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'yaw',
      description: 'Rotate the drone left or right by a number of degrees',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['left', 'right'] },
          degrees:   { type: 'number', description: 'Degrees to rotate (1 – 360)' },
          speed:     { type: 'number', description: 'Rotation speed in deg/s (default: 30)' }
        },
        required: ['direction', 'degrees']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_mode',
      description: 'Set the drone flight mode',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['STABILIZE', 'ALTHOLD', 'LOITER', 'GUIDED', 'LAND', 'RTL', 'AUTO', 'POSHOLD'],
            description: 'Flight mode name'
          }
        },
        required: ['mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'emergency_stop',
      description: 'EMERGENCY: immediately land and disarm the drone',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const SYSTEM = `You are a drone flight controller AI. You control a real quadcopter via tool calls.
When the user gives a flight command, call the appropriate tool(s). After executing, reply in one concise sentence confirming what happened and any relevant info.
Safety rules: warn if battery < 11V, GPS fix < 3, or command seems dangerous. Refuse clearly unsafe commands.
Never fabricate tool results.`;

// ── Drone API ────────────────────────────────────────────────

const DRONE_HEADERS = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true'  // bypass ngrok interstitial page
};

async function droneCall(endpoint, body = null) {
  const base   = cfg.droneUrl.replace(/\/+$/, '');
  const method = body === null ? 'GET' : 'POST';
  const opts   = { method, headers: { ...DRONE_HEADERS } };
  if (body !== null) opts.body = JSON.stringify(body);
  const r = await fetch(base + endpoint, opts);
  if (!r.ok) throw new Error(`Drone API ${r.status}`);
  return r.json();
}

async function executeTool(name, args) {
  if (!cfg.droneUrl) return JSON.stringify({ error: 'Drone URL not configured' });
  try {
    let data;
    switch (name) {
      case 'get_status':     data = await droneCall('/status'); break;
      case 'arm_drone':      data = await droneCall('/arm', {}); break;
      case 'disarm_drone':   data = await droneCall('/disarm', {}); break;
      case 'takeoff':        data = await droneCall('/takeoff', { altitude: args.altitude }); break;
      case 'land':           data = await droneCall('/land', {}); break;
      case 'rtl':            data = await droneCall('/rtl', {}); break;
      case 'hold':           data = await droneCall('/hold', {}); break;
      case 'move':           data = await droneCall('/move', { direction: args.direction, distance: args.distance, speed: args.speed ?? 0.5 }); break;
      case 'yaw':            data = await droneCall('/yaw', { direction: args.direction, degrees: args.degrees, speed: args.speed ?? 30 }); break;
      case 'set_mode':       data = await droneCall('/mode', { mode: args.mode }); break;
      case 'emergency_stop': data = await droneCall('/emergency', {}); break;
      default: return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    return JSON.stringify(data);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

// ── LLM API ──────────────────────────────────────────────────

function parseArgs(a) {
  if (typeof a === 'object' && a !== null) return a;
  try { return JSON.parse(a || '{}'); } catch { return {}; }
}

async function callLLM(msgs) {
  const headers = { 'Content-Type': 'application/json' };

  if (cfg.llmMode === 'ollama') {
    const r = await fetch(cfg.llmUrl.replace(/\/+$/, '') + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages: msgs, tools: TOOLS, stream: false })
    });
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
    const d   = await r.json();
    const msg = d.message ?? {};
    // Normalize tool_calls to OpenAI format (arguments as JSON string, id added)
    if (msg.tool_calls?.length) {
      msg.tool_calls = msg.tool_calls.map((tc, i) => ({
        id:   (tc.function?.name ?? 'tool') + '_' + i,
        type: 'function',
        function: {
          name:      tc.function?.name ?? '',
          arguments: typeof tc.function?.arguments === 'object'
            ? JSON.stringify(tc.function.arguments)
            : (tc.function?.arguments ?? '{}')
        }
      }));
    }
    return msg;

  } else {
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    const r = await fetch(cfg.llmUrl.replace(/\/+$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages: msgs, tools: TOOLS })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`LLM API HTTP ${r.status}${txt ? ' — ' + txt.slice(0, 150) : ''}`);
    }
    const d = await r.json();
    return d.choices[0].message;
  }
}

// Build assistant message for history (format varies by LLM mode)
function mkAssistantMsg(reply) {
  if (cfg.llmMode === 'ollama') {
    return {
      role: 'assistant',
      content: reply.content || '',
      tool_calls: reply.tool_calls.map(tc => ({
        function: {
          name:      tc.function.name,
          arguments: parseArgs(tc.function.arguments) // Ollama expects object
        }
      }))
    };
  }
  return { role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls };
}

// Build tool result message for history
function mkToolMsg(tc, result) {
  return cfg.llmMode === 'openai'
    ? { role: 'tool', tool_call_id: tc.id, content: result }
    : { role: 'tool', content: result };
}

// ── Chat Logic ───────────────────────────────────────────────

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  busy = true;
  setSendEnabled(false);

  addUserBubble(text);
  history.push({ role: 'user', content: text });
  showThinking();

  try {
    const msgs = [{ role: 'system', content: SYSTEM }, ...history];

    // Tool-call loop — max 6 rounds to prevent infinite loops
    for (let round = 0; round < 6; round++) {
      const reply = await callLLM(msgs);

      if (reply.tool_calls?.length) {
        hideThinking();

        // Store assistant tool_call message
        const aMsg = mkAssistantMsg(reply);
        msgs.push(aMsg);
        history.push(aMsg);

        // Execute each tool, collect results
        for (const tc of reply.tool_calls) {
          const name = tc.function.name;
          const args = parseArgs(tc.function.arguments);

          showToolCall(name, args);
          const result = await executeTool(name, args);
          showToolResult(result);

          const tMsg = mkToolMsg(tc, result);
          msgs.push(tMsg);
          history.push(tMsg);
        }

        // Show thinking for next LLM call
        showThinking();

      } else {
        // Final natural language response
        hideThinking();
        if (reply.content) {
          addAIBubble(reply.content);
          history.push({ role: 'assistant', content: reply.content });
        }
        break;
      }
    }
  } catch (e) {
    hideThinking();
    addError(e.message);
  }

  busy = false;
  setSendEnabled(true);
}

// ── DOM Helpers ──────────────────────────────────────────────

const $    = id => document.getElementById(id);
const chat = ()  => $('chat-inner');
const area = ()  => $('chat-area');

function scrollEnd() {
  const a = area();
  a.scrollTop = a.scrollHeight;
}

function hhmm() {
  return new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/\n/g, '<br>');
}

function addUserBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg-row user';
  el.innerHTML = `
    <div class="msg-avatar av-user">YOU</div>
    <div class="msg-col">
      <div class="msg-bubble">${esc(text)}</div>
      <div class="msg-time">${hhmm()}</div>
    </div>`;
  chat().appendChild(el);
  scrollEnd();
}

function addAIBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg-row ai';
  el.innerHTML = `
    <div class="msg-avatar av-ai">AI</div>
    <div class="msg-col">
      <div class="msg-bubble">${esc(text)}</div>
      <div class="msg-time">${hhmm()}</div>
    </div>`;
  chat().appendChild(el);
  scrollEnd();
}

function showThinking() {
  hideThinking();
  const el = document.createElement('div');
  el.className = 'thinking-row';
  el.innerHTML = `
    <div class="msg-avatar av-ai">AI</div>
    <div class="thinking-bubble">
      PROCESSING<span class="dots"><span>.</span><span>.</span><span>.</span></span>
    </div>`;
  chat().appendChild(el);
  thinkEl = el;
  scrollEnd();
}

function hideThinking() {
  if (thinkEl) { thinkEl.remove(); thinkEl = null; }
}

function showToolCall(name, args) {
  const el  = document.createElement('div');
  el.className = 'tool-chip call';
  const str = Object.keys(args).length ? JSON.stringify(args) : '';
  el.innerHTML = `
    <span class="chip-ico call">⚡</span>
    <span class="chip-tag call">CALL</span>
    <span class="chip-name">${esc(name)}</span>
    ${str ? `<span class="chip-args">${esc(str)}</span>` : ''}`;
  chat().appendChild(el);
  scrollEnd();
}

function showToolResult(result) {
  const el  = document.createElement('div');
  el.className = 'tool-chip result';
  const str = result.length > 220 ? result.slice(0, 220) + '…' : result;
  el.innerHTML = `
    <span class="chip-ico result">✓</span>
    <span class="chip-tag result">RESULT</span>
    <span class="chip-args">${esc(str)}</span>`;
  chat().appendChild(el);
  scrollEnd();
}

function addError(msg) {
  const el = document.createElement('div');
  el.className = 'tool-chip error';
  el.innerHTML = `<span class="chip-ico">✗</span> ${esc(msg)}`;
  chat().appendChild(el);
  scrollEnd();
}

function setSendEnabled(on) {
  const inp = $('user-input');
  $('send-btn').disabled = !on || !inp.value.trim();
}

// ── Config UI ────────────────────────────────────────────────

function applyMode(mode) {
  cfg.llmMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  $('apikey-group').style.display = mode === 'openai' ? 'flex' : 'none';
}

function saveConfig() {
  cfg.droneUrl = $('inp-drone').value.trim().replace(/\/+$/, '');
  cfg.llmUrl   = $('inp-llmurl').value.trim().replace(/\/+$/, '');
  cfg.model    = $('inp-model').value.trim();
  cfg.apiKey   = $('inp-apikey').value.trim();

  localStorage.setItem('dc_droneUrl', cfg.droneUrl);
  localStorage.setItem('dc_llmMode',  cfg.llmMode);
  localStorage.setItem('dc_llmUrl',   cfg.llmUrl);
  localStorage.setItem('dc_model',    cfg.model);
  localStorage.setItem('dc_apiKey',   cfg.apiKey);

  if (cfg.droneUrl) checkDroneConn();
}

async function checkDroneConn() {
  setDot('');
  $('dot-label').textContent = 'CHECKING';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10s — ngrok + Pi can be slow

  try {
    const r = await fetch(cfg.droneUrl + '/health', {
      headers: { ...DRONE_HEADERS },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        // ngrok warning page slipped through — header not honoured yet
        setDot('err');
        $('dot-label').textContent = 'NOT JSON';
        return;
      }
      setDot('on');
      $('dot-label').textContent = 'ONLINE';
    } else {
      setDot('err');
      $('dot-label').textContent = `HTTP ${r.status}`;
    }
  } catch (e) {
    clearTimeout(timer);
    setDot('err');
    $('dot-label').textContent = e.name === 'AbortError' ? 'TIMEOUT' : 'OFFLINE';
  }
}

function setDot(state) {
  $('conn-dot').className   = 'conn-dot'  + (state ? ' ' + state : '');
  $('dot-label').className  = 'dot-label' + (state ? ' ' + state : '');
}

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Restore config
  $('inp-drone').value  = cfg.droneUrl;
  $('inp-llmurl').value = cfg.llmUrl;
  $('inp-model').value  = cfg.model;
  $('inp-apikey').value = cfg.apiKey;
  applyMode(cfg.llmMode);
  if (cfg.droneUrl) checkDroneConn();

  // Mode toggle
  document.querySelectorAll('.mode-btn').forEach(b =>
    b.addEventListener('click', () => applyMode(b.dataset.mode))
  );

  // Save on connect
  $('btn-connect').addEventListener('click', saveConfig);
  ['inp-drone', 'inp-llmurl', 'inp-model', 'inp-apikey'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveConfig(); })
  );

  // Send button
  $('send-btn').addEventListener('click', () => {
    const inp  = $('user-input');
    const text = inp.value.trim();
    if (!text || busy) return;
    inp.value = '';
    inp.style.height = '';
    sendMessage(text);
  });

  // Enter = send, Shift+Enter = newline
  $('user-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('send-btn').click();
    }
  });

  // Auto-resize textarea
  $('user-input').addEventListener('input', function () {
    this.style.height = '';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    $('send-btn').disabled = busy || !this.value.trim();
  });

  // Hint clicks
  document.querySelectorAll('.hint').forEach(h =>
    h.addEventListener('click', () => {
      $('user-input').value = h.dataset.cmd;
      $('user-input').dispatchEvent(new Event('input'));
      $('user-input').focus();
    })
  );
});
