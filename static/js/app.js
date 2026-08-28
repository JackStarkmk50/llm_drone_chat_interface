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

// ── RC tuning ────────────────────────────────────────────────
// The server centres every channel if no refresh arrives within its deadman
// window. POST /rc defaults to a 3 s window (RC_DEADMAN_HTTP_S) because a
// manual curl has no heartbeat — far too long to leave a stick latched if this
// page dies mid-command. So rcMove() heartbeats at 5 Hz and asks for a 0.5 s
// window explicitly, matching what the webapp's socket path uses.
const RC_HEARTBEAT_MS = 200;
const RC_DEADMAN_S    = 0.5;
const RC_MAX_DUR_S    = 8.0;   // ceiling on a single LLM-issued nudge, seconds

// ── RC CALIBRATION — EDIT THESE AFTER A TEST FLIGHT ──────────
// "forward 1 metre" / "turn right 90°" are OPEN-LOOP: the aircraft is not told
// a distance, only how long to hold a stick. These numbers turn metres and
// degrees into seconds. They are only valid for the Pixhawk params they were
// measured under (LOIT_SPEED, LOIT_BRK_DELAY, PILOT_Y_RATE, PILOT_SPEED_UP);
// change a param → refly → re-measure. Procedure: README "Calibrating rc_move".
const RC_CAL = {
  MPS:        0.5,   // m/s  — groundspeed plateau during a hold (flights.html → groundspeed)
  OVERSHOOT:  0.4,   // m    — coasted after release (LOIT_BRK_DELAY); final − MPS×hold
  MPS_Z:      0.3,   // m/s  — climb/descent rate during throttle hold (rangefinder delta / s)
  YAW_DPS:    60,    // °/s  — yaw rate during a yaw hold (heading delta / s)
  PWM_OFFSET: 150,   // stick offset from 1500 sent as /rc "value"; server DIR_MAP default = 150
  MAX_DIST_M: 2.0,   // cap on one distance request
  MAX_ALT_M:  1.0,   // cap on one up/down request
  MAX_ANGLE:  180,   // cap on one rotation request
  SETTLE_S:   1.5    // wait after release before measuring (covers the coast)
};

// Which side of 1500 each direction sits on — mirrors server DIR_MAP exactly.
const RC_SIGN = {
  forward: -1, backward: +1, right: +1, left: -1,
  yaw_right: +1, yaw_left: -1, throttle_up: +1, throttle_down: -1
};
const RC_YAW_DIRS = new Set(['yaw_left', 'yaw_right']);
const RC_THR_DIRS = new Set(['throttle_up', 'throttle_down']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Tool Definitions ─────────────────────────────────────────
// Every tool below maps to a route that exists in new_api_server_1.py as of
// this file's last sync (2026-08-25 against the 2026-08-18 server). /move and /yaw are deliberately absent: they were
// removed on 2026-08-07 with the GUIDED-mode primitives and now answer 410.

const TOOLS = [
  // ── Status ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: 'Get current drone status: mode, armed state, altitude, rangefinder distance, battery voltage, GPS fix, satellites, attitude.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_param',
      description: 'Read one ArduPilot parameter by name, e.g. EK3_SRC1_POSXY, THR_DZ, RNGFND1_TYPE, FLOW_TYPE. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Parameter name, uppercase' }
        },
        required: ['name']
      }
    }
  },

  // ── Arming ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'arm_drone',
      description: 'Switch to LOITER and arm the motors. Returns immediately; arming completes in the background (up to 15 s).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disarm_drone',
      description: 'Disarm the motors safely.',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ── Flight ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'takeoff',
      description: 'Arm (if needed) and climb to an ABSOLUTE altitude above the floor using rangefinder feedback. Also the right tool when already flying and the user names a height ("go to 2 m", "climb to 1.5 m height"). Only climbs — to go lower use rc_move throttle_down. Blocks until the altitude is reached (or fails), so the next command is safe to send afterwards.',
      parameters: {
        type: 'object',
        properties: {
          altitude: { type: 'number', description: 'Target altitude in metres. Server rejects below 0.5 or above 10.' }
        },
        required: ['altitude']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'land',
      description: 'Switch to LAND mode and descend at the current position.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rtl',
      description: 'Return to launch point. Requires a 3D GPS fix; the server rejects this without one.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hold',
      description: 'Cancel any active movement, waypoint navigation or mission and hold position. Centres all RC channels.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'emergency_stop',
      description: 'EMERGENCY STOP: cancels every running command (takeoff, mission, waypoints, stick hold), centres the sticks, switches to LAND and disarms once on the ground. Motors stay on until touchdown — it does not drop the aircraft. Use for "emergency", "stop everything", "abort".',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_mode',
      description: 'Set the flight mode.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['STABILIZE', 'ALTHOLD', 'LOITER', 'GUIDED', 'GUIDED_NOGPS',
                   'LAND', 'RTL', 'AUTO', 'POSHOLD'],
            description: 'Flight mode name. LOITER is the normal flight mode for this aircraft.'
          }
        },
        required: ['mode']
      }
    }
  },

  // ── Manual RC ──────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'rc_move',
      description: 'Move, climb, descend or rotate the aircraft by holding an RC stick. Use for ANY directional request: "forward", "back/reverse", "left/right/strafe/slide", "up/ascend/climb/higher", "down/descend/lower", "turn/rotate/spin/yaw/pivot left or right, clockwise (=right) or anticlockwise/counter-clockwise (=left)". Give ONE of duration_s, distance_m or angle_deg. Distances and angles are converted to a timed hold using calibrated speeds; the result reports the measured movement when the EKF is available.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['forward', 'backward', 'left', 'right',
                   'yaw_left', 'yaw_right', 'throttle_up', 'throttle_down'],
            description: 'forward/backward/left/right = horizontal, relative to the nose. throttle_up/throttle_down = climb/descend. yaw_right = clockwise/turn right, yaw_left = anticlockwise/turn left.'
          },
          duration_s: {
            type: 'number',
            description: 'Hold time in seconds when the user gives a time ("for 2 seconds"). Default 1.0 if nothing else is given. Max 8.'
          },
          distance_m: {
            type: 'number',
            description: 'Metres when the user gives a distance ("forward 1 metre", "up half a metre"). Max 2 horizontal, 1 vertical. Not for yaw.'
          },
          angle_deg: {
            type: 'number',
            description: 'Degrees when the user gives a rotation ("turn right 90 degrees", "rotate 180"). Only for yaw_left / yaw_right. Max 180.'
          }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rc_center',
      description: 'Centre all RC channels immediately, stopping any stick input. Does not change flight mode.',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ── Waypoint navigation ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'nav_goto',
      description: 'Fly to an absolute point in metres from the ARM POINT: +x east, +y north. ONLY when the user gives coordinates or says waypoint/go to point. For "forward 1 m" style directional requests use rc_move. Blocks until the waypoint is reached or aborted.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Metres east of the arm point (negative = west)' },
          y: { type: 'number', description: 'Metres north of the arm point (negative = south)' },
          z: { type: 'number', description: 'Optional target altitude in metres; omit to hold current altitude' },
          replace: { type: 'boolean', description: 'true (default) replaces the queue; false appends' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'nav_queue',
      description: 'Queue several waypoints to fly in order.',
      parameters: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            description: 'Ordered list of points, each {"x": metres east, "y": metres north, "z": optional altitude}',
            items: { type: 'object' }
          }
        },
        required: ['points']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'nav_status',
      description: 'Get waypoint navigation state: active, current target, queue length, position.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'nav_abort',
      description: 'Abort waypoint navigation and clear the queue.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short reason string for the log' }
        }
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'nav_clear',
      description: 'Drop queued waypoints but let the current leg finish. Use nav_abort to stop moving now.',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ── Missions ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_mission',
      description: 'Run a sequence of steps in a background thread. Valid cmd values are ONLY: takeoff, land, hold, hover. Directional steps do not exist — use nav_queue for a multi-point flight.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered steps. takeoff takes "altitude", hover takes "duration", land and hold take no arguments. Example: [{"cmd":"takeoff","altitude":1.5},{"cmd":"hover","duration":5},{"cmd":"land"}]',
            items: { type: 'object' }
          }
        },
        required: ['steps']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mission_status',
      description: 'Get mission state: active, current_step, steps_done, last_result, error.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_mission',
      description: 'Cancel the running mission.',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ── Flight log & camera ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'flight_current',
      description: 'Get the flight currently being recorded, if any.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'flights_list',
      description: 'List recorded flights, newest first.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many to return (default 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'camera_start',
      description: 'Start the camera capture pipeline.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'camera_stop',
      description: 'Stop the camera capture pipeline.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const SYSTEM = `You are a drone flight controller assistant. You control a real indoor quadcopter through tool calls.

## Core rule
When the user gives ANY flight command, navigation request, or asks about drone state — call the appropriate tool immediately. Never describe what you would do. Do it.

## How to respond
1. Pick the tool(s) from the user's message.
2. Call them.
3. After the result, reply in 1-2 short sentences with what happened and the key figures (altitude, battery, mode).

## This aircraft
GPS-denied indoor quadcopter. LOITER is the normal flight mode. The companion computer flies it by streaming RC channel overrides at 20 Hz — there is no GUIDED-mode setpoint path on this airframe.

## Moving the drone — pick the right tool
- ANY directional request → rc_move. Map the words to a direction:
  - forward / ahead / straight → forward
  - back / backward / reverse / retreat → backward
  - left / strafe left / slide left → left ; right / strafe right / slide right → right
  - up / ascend / climb / rise / higher → throttle_up
  - down / descend / lower / sink → throttle_down
  - "go to X m height" / "climb to X m" / "altitude X m" (an absolute height, not "up by") → takeoff with altitude X, even if already flying. If X is BELOW the current altitude → rc_move throttle_down with distance_m = current − X (call get_status first for the current rangefinder height).
  - turn right / rotate right / clockwise / spin right / yaw right → yaw_right
  - turn left / rotate left / anticlockwise / counter-clockwise / spin left / yaw left → yaw_left
- Then pass exactly one amount: seconds → duration_s ; metres/cm/feet (convert to metres) → distance_m ; degrees → angle_deg. Nothing given → omit all (1 s default). "a bit"/"slightly" → duration_s 0.5.
- rc_move is open-loop. Report the "measured" field from the result as what actually happened; if it is unavailable say the movement was not measured. Never claim an exact distance that was not measured.
- nav_goto / nav_queue ONLY when the user gives coordinates or explicitly says waypoint / "go to point". They are absolute metres from the arm point (+x east, +y north), not relative to the nose.
- takeoff, nav_goto and nav_queue block until finished — do not poll get_status while waiting; just make the next call after they return.

## Available actions
- Status / battery / altitude / mode → get_status
- Read an ArduPilot parameter → get_param
- Arm / disarm → arm_drone / disarm_drone
- Take off → takeoff (0.5 to 10 metres)
- Land → land
- Return home → rtl (needs GPS)
- Stop and hold → hold
- Stop stick input only → rc_center
- Move / climb / descend / rotate by time, distance or angle → rc_move
- Fly to absolute coordinates / waypoint → nav_goto ; several points → nav_queue
- Navigation state → nav_status ; stop navigating → nav_abort ; drop queued points only → nav_clear
- Scripted sequence → run_mission (takeoff, land, hold, hover ONLY)
- Mission state → mission_status ; stop → cancel_mission
- Recorded flights → flight_current / flights_list
- Camera → camera_start / camera_stop (the live feed opens in the page's camera panel)
- Emergency / stop everything / abort → emergency_stop (cancels all, lands under control, disarms on the ground)

## Safety rules
- Battery below 13.2 V: warn the user before executing (4S pack minimum).
- RTL needs a 3D GPS fix. Takeoff and navigation do not — they use the rangefinder and the EKF.
- Refuse commands that would obviously crash or damage the aircraft.
- Never invent a tool result. Report only what the tool returned.
- If a tool returns an error, say what the error was. Do not retry the same call more than once.`;


// ── Drone API ────────────────────────────────────────────────

const DRONE_HEADERS = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true'  // bypass ngrok interstitial page
};

/**
 * Returns the parsed body on success AND on failure.
 *
 * The old version threw on !res.ok before reading the body, which discarded
 * exactly the part worth keeping: the server answers a removed route with 410
 * and a "use_instead" pointer, and rejects bad arguments with 400 and the
 * reason. Throwing first meant the model only ever saw "Drone API 410" and had
 * no way to correct itself.
 */
async function droneCall(endpoint, body = null, method = null) {
  const base = cfg.droneUrl.replace(/\/+$/, '');
  const verb = method || (body === null ? 'GET' : 'POST');
  // GET omits Content-Type (no body) to avoid a CORS preflight
  const headers = verb === 'GET'
    ? { 'ngrok-skip-browser-warning': 'true' }
    : { ...DRONE_HEADERS };
  const opts = { method: verb, headers };
  if (body !== null) opts.body = JSON.stringify(body);

  const res  = await fetch(base + endpoint, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text.slice(0, 300) || `HTTP ${res.status}` };
  }

  if (!res.ok) return { success: false, http_status: res.status, ...data };
  return data;
}

/**
 * Hold an RC stick, then release.
 *
 * Duration comes from one of: duration_s (as given), distance_m (÷ RC_CAL.MPS,
 * minus the coast the aircraft adds after release) or angle_deg (÷ YAW_DPS).
 * Everything is open-loop; the only feedback is the before/after snapshot
 * reported in the result so the model can tell the user what really happened.
 *
 * The server centres the channel if no refresh arrives inside the deadman
 * window, so a held command has to be re-sent. Heartbeat at 5 Hz with an
 * explicit 0.5 s window; if this page dies mid-nudge the aircraft centres
 * half a second later instead of coasting for the 3 s HTTP default.
 */
function rcPlanDuration(direction, args) {
  const isYaw = RC_YAW_DIRS.has(direction);
  const isThr = RC_THR_DIRS.has(direction);
  const notes = [];
  let dur, basis;

  if (isYaw && args.angle_deg != null) {
    let a = Math.abs(Number(args.angle_deg));
    if (a > RC_CAL.MAX_ANGLE) { notes.push(`angle capped ${a}→${RC_CAL.MAX_ANGLE}°`); a = RC_CAL.MAX_ANGLE; }
    dur = a / RC_CAL.YAW_DPS;
    basis = `${a}° at ${RC_CAL.YAW_DPS}°/s (calibrated)`;
  } else if (!isYaw && args.distance_m != null) {
    let d = Math.abs(Number(args.distance_m));
    const cap = isThr ? RC_CAL.MAX_ALT_M : RC_CAL.MAX_DIST_M;
    if (d > cap) { notes.push(`distance capped ${d}→${cap} m`); d = cap; }
    if (isThr) {
      dur = d / RC_CAL.MPS_Z;
      basis = `${d} m at ${RC_CAL.MPS_Z} m/s vertical (calibrated)`;
    } else {
      dur = (d - RC_CAL.OVERSHOOT) / RC_CAL.MPS;
      basis = `${d} m at ${RC_CAL.MPS} m/s minus ${RC_CAL.OVERSHOOT} m coast (calibrated)`;
      if (dur < 0.2) notes.push(`requested distance is within the ${RC_CAL.OVERSHOOT} m coast; using minimum tap`);
    }
  } else {
    dur = args.duration_s != null ? Number(args.duration_s) : 1.0;
    basis = `${dur} s as requested`;
    if (args.angle_deg != null)    notes.push('angle_deg ignored: not a yaw direction');
    if (args.distance_m != null)   notes.push('distance_m ignored for yaw; use angle_deg');
  }

  if (!Number.isFinite(dur)) dur = 1.0;
  if (dur > RC_MAX_DUR_S) { notes.push(`hold capped at ${RC_MAX_DUR_S} s`); dur = RC_MAX_DUR_S; }
  dur = Math.max(0.2, dur);
  return { dur, basis, notes };
}

// EKF position + heading + rangefinder, or null for any part that is missing.
async function rcSnapshot() {
  const out = { x: null, y: null, yaw: null, alt: null };
  try {
    const n = await droneCall('/nav/status');
    const p = n && n.position;
    if (p && p.src === 'ekf') { out.x = p.x; out.y = p.y; out.yaw = p.yaw; }
  } catch { /* nav optional */ }
  try {
    const st = await droneCall('/status');
    if (st && typeof st.rangefinder === 'number') out.alt = st.rangefinder;
    if (out.yaw == null && st && typeof st.yaw === 'number') out.yaw = st.yaw;
  } catch { /* status optional */ }
  return out;
}

function rcMeasure(before, after) {
  const m = {};
  if (before.x != null && after.x != null)
    m.moved_m = +Math.hypot(after.x - before.x, after.y - before.y).toFixed(2);
  if (before.yaw != null && after.yaw != null) {
    let d = (after.yaw - before.yaw) * 180 / Math.PI;
    d = ((d + 540) % 360) - 180;                 // wrap to −180..180
    m.turned_deg = +d.toFixed(0);                // + = clockwise (ArduPilot yaw)
  }
  if (before.alt != null && after.alt != null)
    m.alt_change_m = +(after.alt - before.alt).toFixed(2);
  return Object.keys(m).length ? m : 'unavailable (no EKF position)';
}

// Small models sometimes ignore the enum: "Forward", "up", "turn right",
// "clockwise". Fold the common variants before rejecting.
const RC_DIR_ALIAS = {
  ahead: 'forward', straight: 'forward', front: 'forward',
  back: 'backward', backwards: 'backward', reverse: 'backward', retreat: 'backward',
  up: 'throttle_up', ascend: 'throttle_up', climb: 'throttle_up', rise: 'throttle_up', higher: 'throttle_up',
  down: 'throttle_down', descend: 'throttle_down', lower: 'throttle_down', sink: 'throttle_down',
  clockwise: 'yaw_right', cw: 'yaw_right', turn_right: 'yaw_right', rotate_right: 'yaw_right', spin_right: 'yaw_right', right_turn: 'yaw_right',
  anticlockwise: 'yaw_left', counterclockwise: 'yaw_left', counter_clockwise: 'yaw_left', ccw: 'yaw_left',
  turn_left: 'yaw_left', rotate_left: 'yaw_left', spin_left: 'yaw_left', left_turn: 'yaw_left'
};
function normalizeDirection(d) {
  const k = String(d ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (k in RC_SIGN) return k;
  if (k in RC_DIR_ALIAS) return RC_DIR_ALIAS[k];
  return k;
}

async function rcMove(direction, args = {}) {
  direction = normalizeDirection(direction);
  if (!(direction in RC_SIGN))
    return { success: false, message: `Unknown direction: ${direction}`, directions: Object.keys(RC_SIGN) };

  const { dur, basis, notes } = rcPlanDuration(direction, args);
  const value  = 1500 + RC_SIGN[direction] * RC_CAL.PWM_OFFSET;
  const before = await rcSnapshot();
  const end    = Date.now() + dur * 1000;
  let last = null;

  try {
    while (Date.now() < end) {
      last = await droneCall('/rc', {
        action: 'move', direction, value, deadman: RC_DEADMAN_S
      });
      if (last && last.success === false) return last;  // bad direction, not connected…
      await sleep(RC_HEARTBEAT_MS);
    }
  } finally {
    // Release even if the loop threw, so a network blip cannot leave a stick
    // latched waiting on the deadman.
    try { await droneCall('/rc', { action: 'move', direction, release: true }); }
    catch { /* deadman is the backstop */ }
  }

  await sleep(RC_CAL.SETTLE_S * 1000);           // let the coast finish
  const after = await rcSnapshot();

  return {
    success: true,
    message: `${direction} held ${dur.toFixed(1)} s (${basis}), released`,
    direction, duration_s: +dur.toFixed(2), pwm: value,
    measured: rcMeasure(before, after),
    ...(notes.length ? { notes } : {})
  };
}

/**
 * POST /takeoff returns as soon as the climb thread starts. If the model's
 * next call (a nudge, a waypoint) goes out immediately it fights the takeoff
 * throttle loop for the same channel. So block here until the rangefinder
 * reads the target, the aircraft disarms (takeoff failed → LAND) or 40 s pass.
 */
async function takeoffAndWait(altitude) {
  const target0 = Number(altitude);
  try {
    const pre = await droneCall('/status');
    if (pre && pre.armed && typeof pre.rangefinder === 'number' && pre.rangefinder > target0 + 0.2)
      return { success: false,
               message: `Already at ${pre.rangefinder} m — takeoff only climbs. Use rc_move throttle_down distance_m ${(pre.rangefinder - target0).toFixed(1)} to descend to ${target0} m.`,
               rangefinder: pre.rangefinder };
  } catch { /* server will validate */ }

  const res = await droneCall('/takeoff', { altitude });
  if (!res || res.success === false) return res;

  const target = Number(altitude);
  const t0 = Date.now();
  let stable = 0, lastAlt = null, armedSeen = false;

  while (Date.now() - t0 < 40000) {
    await sleep(500);
    let st;
    try { st = await droneCall('/status'); } catch { continue; }
    if (!st || typeof st.rangefinder !== 'number') continue;
    lastAlt = st.rangefinder;
    if (st.armed) armedSeen = true;
    if (armedSeen && !st.armed)
      return { success: false, message: `Takeoff aborted — aircraft disarmed at ${lastAlt} m`, rangefinder: lastAlt };
    if (!armedSeen && Date.now() - t0 > 15000)
      return { success: false, message: 'Takeoff failed — aircraft never armed within 15 s (check pre-arm messages / safety switch / battery)', rangefinder: lastAlt };
    if (Math.abs(lastAlt - target) <= 0.2) { if (++stable >= 4) break; }   // 2 s inside band
    else stable = 0;
  }

  // Server neutralises throttle then settles TAKEOFF_SETTLE_S (2 s) while
  // still holding its command lock. Wait it out so a follow-up arm/takeoff
  // cannot bounce off a 409 and a nudge does not land mid-coast.
  if (stable >= 4) {
    await sleep(2000);
    try { const st = await droneCall('/status'); if (st && typeof st.rangefinder === 'number') lastAlt = st.rangefinder; } catch { /* keep last */ }
  }

  const reached = lastAlt != null && Math.abs(lastAlt - target) <= 0.2;
  return {
    ...res,
    success: true,
    message: reached
      ? `Takeoff complete — holding at ${lastAlt} m (target ${target} m)`
      : `Takeoff still in progress after 40 s — rangefinder ${lastAlt} m, target ${target} m. Check status before the next command.`,
    rangefinder: lastAlt, reached
  };
}

/**
 * Same reasoning for waypoints: /nav/goto accepts instantly, the flight takes
 * seconds. Poll until nav reports something other than "flying".
 */
async function navAndWait(endpoint, body) {
  const res = await droneCall(endpoint, body);
  if (!res || res.success === false) return res;

  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 90000) {
    await sleep(500);
    try { last = await droneCall('/nav/status'); } catch { continue; }
    if (last && last.state && last.state !== 'flying') break;
  }
  if (!last) return res;
  return {
    ...res,
    message: last.state === 'flying'
      ? `Still navigating after 90 s (${last.distance_m} m to go)`
      : `Navigation ${last.state}${last.reason ? ' — ' + last.reason : ''}`,
    state: last.state, reason: last.reason, reached: last.reached,
    position: last.position, distance_m: last.distance_m
  };
}

async function executeTool(name, args) {
  if (!cfg.droneUrl) return JSON.stringify({ error: 'Drone URL not configured' });
  try {
    let data;
    switch (name) {
      // Status
      case 'get_status':     data = await droneCall('/status'); break;
      case 'get_param':      data = await droneCall('/param?name=' + encodeURIComponent(args.name || '')); break;

      // Arming
      case 'arm_drone':      data = await droneCall('/arm', {}); break;
      case 'disarm_drone':   data = await droneCall('/disarm', {}); break;

      // Flight
      case 'takeoff':        data = await takeoffAndWait(args.altitude); break;
      case 'land':           data = await droneCall('/land', {}); break;
      case 'rtl':            data = await droneCall('/rtl', {}); break;
      case 'hold':           data = await droneCall('/hold', {}); break;
      case 'emergency_stop': data = await droneCall('/emergency', {}); break;
      case 'set_mode':       data = await droneCall('/mode', { mode: args.mode }); break;

      // Manual RC
      case 'rc_move':        data = await rcMove(args.direction, args); break;
      case 'rc_center':      data = await droneCall('/rc', { action: 'hold' }); break;

      // Waypoint navigation
      case 'nav_goto':       data = await navAndWait('/nav/goto', {
                               x: args.x, y: args.y,
                               ...(args.z != null ? { z: args.z } : {}),
                               ...(args.replace != null ? { replace: args.replace } : {})
                             }); break;
      case 'nav_queue':      data = await navAndWait('/nav/queue', { points: args.points }); break;
      case 'nav_status':     data = await droneCall('/nav/status'); break;
      case 'nav_abort':      data = await droneCall('/nav/abort', { reason: args.reason || 'operator' }); break;
      case 'nav_clear':      data = await droneCall('/nav/clear', {}); break;

      // Missions
      case 'run_mission':    data = await droneCall('/mission', { steps: args.steps }); break;
      case 'mission_status': data = await droneCall('/mission/status'); break;
      case 'cancel_mission': data = await droneCall('/mission/cancel', {}); break;

      // Flight log & camera
      case 'flight_current': data = await droneCall('/flights/current'); break;
      case 'flights_list':   data = await droneCall('/flights?limit=' + (args.limit ?? 10)); break;
      case 'camera_start':   data = await camStart(); break;
      case 'camera_stop':    data = await camStop(); break;

      default: return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    return JSON.stringify(data);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

// ── Camera Panel ─────────────────────────────────────────────
// Same MJPEG path the webapp's settings page uses: POST /camera/start, then
// point an <img> at GET /camera/stream. The tools camera_start / camera_stop
// route through here so an LLM-issued "show me the camera" opens the panel.
//
// Note on ngrok: <img> cannot send the ngrok-skip-browser-warning header, so
// on a free ngrok tunnel the stream request may hit the interstitial page and
// fail with onerror. Local IP or a paid/static ngrok domain streams fine.

let camActive = false;

function camEls() {
  return {
    panel: $('cam-panel'), open: $('cam-open'), state: $('cam-state'),
    toggle: $('cam-toggle'), img: $('cam-img'), ph: $('cam-placeholder')
  };
}

function camSetState(label, cls) {
  const { state, toggle, open } = camEls();
  if (state) {
    state.textContent = label;
    state.className   = 'cam-state' + (cls ? ' ' + cls : '');
  }
  if (toggle) {
    toggle.textContent = camActive ? 'STOP' : 'START';
    toggle.classList.toggle('stop', camActive);
  }
  if (open) open.classList.toggle('live', camActive);
}

function camShowPanel(show) {
  const { panel } = camEls();
  if (panel) panel.classList.toggle('hidden', !show);
}

function camDetach() {
  const { img, ph } = camEls();
  if (!img) return;
  img.onerror = null;
  img.onload  = null;
  img.src = '';
  img.classList.remove('live');
  if (ph) ph.style.display = '';
}

async function camStart() {
  if (!cfg.droneUrl) return { success: false, message: 'Drone URL not configured' };
  camShowPanel(true);
  camSetState('STARTING', 'busy');

  const res = await droneCall('/camera/start', {});
  if (!res || res.success === false) {
    camActive = false;
    camSetState('ERR', 'err');
    const { ph } = camEls();
    if (ph) ph.textContent = (res && res.message) ? String(res.message).toUpperCase() : 'CAMERA UNAVAILABLE';
    return res;
  }

  const { img, ph } = camEls();
  if (!img) return res;                       // no panel in this page — tool still worked
  camActive = true;
  img.onerror = () => {
    if (!camActive) return;
    camActive = false;
    camDetach();
    if (ph) ph.textContent = 'STREAM FAILED — CHECK URL / NGROK';
    camSetState('ERR', 'err');
  };
  img.onload = () => { if (camActive) camSetState('LIVE', 'live'); };
  img.src = cfg.droneUrl + '/camera/stream?t=' + Date.now();
  img.classList.add('live');
  if (ph) ph.style.display = 'none';
  camSetState('LIVE', 'live');
  return res;
}

async function camStop() {
  camActive = false;
  camDetach();
  const { ph } = camEls();
  if (ph) ph.textContent = 'STREAM OFFLINE';
  camSetState('STOPPING', 'busy');

  let res;
  try {
    res = await droneCall('/camera/stop', {});
  } catch (e) {
    res = { success: false, message: e.message };
  }
  // 409 = flight video recording in progress; server keeps the camera on.
  // The <img> is already detached locally either way.
  camSetState(res && res.http_status === 409 ? 'REC' : 'OFF',
              res && res.http_status === 409 ? 'busy' : '');
  return res;
}

function camInit() {
  const { open, toggle, panel } = camEls();
  if (!open || !panel) return;
  open.addEventListener('click', () => camShowPanel(panel.classList.contains('hidden')));
  $('cam-close')?.addEventListener('click', () => camShowPanel(false));
  toggle?.addEventListener('click', async () => {
    toggle.disabled = true;
    try { camActive ? await camStop() : await camStart(); }
    finally { toggle.disabled = false; }
  });
  camSetState('OFF', '');
}

// ── LLM API ──────────────────────────────────────────────────

function parseArgs(a) {
  if (typeof a === 'object' && a !== null) return a;
  try { return JSON.parse(a || '{}'); } catch { return {}; }
}

async function callLLM(msgs) {
  const headers = { 'Content-Type': 'application/json' };

  if (cfg.llmMode === 'ollama') {
    let r;
    try {
      r = await fetch(cfg.llmUrl.replace(/\/+$/, '') + '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: cfg.model, messages: msgs, tools: TOOLS, stream: false })
      });
    } catch (e) {
      const hint = e.message.toLowerCase().includes('fetch')
        ? ' — Ollama CORS blocked. Fix: run  $env:OLLAMA_ORIGINS="*"  then restart Ollama.'
        : '';
      throw new Error(e.message + hint);
    }
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

function kvRows(obj, skip = []) {
  const SKIP = new Set(skip);
  return Object.entries(obj)
    .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined)
    .slice(0, 10)
    .map(([k, v]) => {
      const display = typeof v === 'boolean' ? (v ? 'YES' : 'NO')
                    : typeof v === 'number'  ? String(v)
                    : String(v).length > 40  ? String(v).slice(0, 40) + '…'
                    : String(v);
      return `<div class="kv-row"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(display)}</span></div>`;
    }).join('');
}

function showToolCall(name, args) {
  const el = document.createElement('div');
  el.className = 'tool-chip call';
  const body = Object.keys(args).length ? `<div class="chip-body">${kvRows(args)}</div>` : '';
  el.innerHTML = `
    <div class="chip-head">
      <span class="chip-ico call">⚡</span>
      <span class="chip-tag call">CALL</span>
      <span class="chip-fn">${esc(name)}</span>
    </div>
    ${body}`;
  chat().appendChild(el);
  scrollEnd();
}

function showToolResult(resultStr) {
  let ok = true, msg = '', extra = {};

  try {
    const d = JSON.parse(resultStr);
    ok  = d.success !== false && !d.error;
    msg = d.message || d.error || '';
    // everything except success/message/error goes to extra kv grid
    const SKIP = ['success', 'message', 'error'];
    Object.entries(d).forEach(([k, v]) => { if (!SKIP.includes(k)) extra[k] = v; });
  } catch {
    ok  = false;
    msg = resultStr.length > 160 ? resultStr.slice(0, 160) + '…' : resultStr;
  }

  const el = document.createElement('div');
  el.className = `tool-chip result ${ok ? 'ok' : 'fail'}`;
  const bodyHtml = Object.keys(extra).length ? `<div class="chip-body">${kvRows(extra)}</div>` : '';
  el.innerHTML = `
    <div class="chip-head">
      <span class="chip-ico ${ok ? 'ok' : 'fail'}">${ok ? '✓' : '✗'}</span>
      <span class="chip-tag ${ok ? 'ok' : 'fail'}">${ok ? 'OK' : 'ERR'}</span>
      ${msg ? `<span class="chip-msg">${esc(msg)}</span>` : ''}
    </div>
    ${bodyHtml}`;
  chat().appendChild(el);
  scrollEnd();
}

function addNote(msg) {
  const el = document.createElement('div');
  el.className = 'tool-chip note';
  el.innerHTML = `
    <div class="chip-head">
      <span class="chip-ico call">!</span>
      <span class="chip-tag call">SERVER</span>
      <span class="chip-msg">${esc(msg)}</span>
    </div>`;
  chat().appendChild(el);
  scrollEnd();
}

function addError(msg) {
  const el = document.createElement('div');
  el.className = 'tool-chip error';
  el.innerHTML = `
    <div class="chip-head">
      <span class="chip-ico fail">✗</span>
      <span class="chip-tag fail">ERR</span>
      <span class="chip-msg">${esc(msg)}</span>
    </div>`;
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

  if (camActive) camStop();
  if (cfg.droneUrl) checkDroneConn();
}

async function checkDroneConn() {
  setDot('');
  $('dot-label').textContent = 'CHECKING';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10s — ngrok + Pi can be slow

  try {
    const r = await fetch(cfg.droneUrl + '/health', {
      headers: { 'ngrok-skip-browser-warning': 'true' },
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
      try { reportServerCaps(await r.json()); } catch { /* body optional */ }
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

/**
 * /health carries "nav" and "tracker" blocks once the vehicle is connected.
 * Both are optional on the server (an import or init failure disables one
 * without stopping the flight server), and when disabled the matching tools
 * answer 404 — so say so up front instead of letting the model find out
 * mid-command.
 */
let _capsReported = '';
function reportServerCaps(h) {
  if (!h || typeof h !== 'object') return;
  const notes = [];
  if (h.connected === false) notes.push('Drone server up, Pixhawk not connected yet');
  if (h.nav && h.nav.available === false)
    notes.push('Waypoint navigation DISABLED on server' + (h.nav.error ? ' — ' + h.nav.error : '') + '. nav_goto / nav_queue will fail; use rc_move.');
  if (h.tracker && h.tracker.available === false)
    notes.push('Flight tracker DISABLED on server — flight_current / flights_list will fail.');
  const key = notes.join('|');
  if (!notes.length || key === _capsReported) return;
  _capsReported = key;
  notes.forEach(addNote);
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
  camInit();
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
