# Game Config UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the spectator/player browser view with a local game master config dashboard, make all game constants configurable via WebSocket, add presets, and implement new mechanics (walls, moving portals, momentum).

**Architecture:** A `gameConfig` object in `server.js` replaces all hardcoded constants. The game loop reads from it each tick. A new `index.html` serves as a config dashboard with sliders/toggles + live arch view. Presets stored as JSON files in `presets/`.

**Tech Stack:** Bun runtime, vanilla JS (server + client), WebSocket, HTML Canvas, DDP over UDP to WLED.

**Spec:** `docs/superpowers/specs/2026-06-09-game-config-ui-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `bLEDsport-game-server/server.js` | Modify | Replace constants with `gameConfig`, add config WS handlers, add wall/portal/momentum mechanics, add preset load/save, extend binary protocol |
| `bLEDsport-game-server/index.html` | Rewrite | Config dashboard UI with sliders, toggles, preset bar, live arch canvas, scoreboard |
| `bLEDsport-game-server/presets/classic.json` | Create | Stock preset with all default values |
| `bledsport-external/index.html` | Modify | Decode new binary fields (walls, sweeper, portals), render them |

---

## Task 1: Extract constants into `gameConfig` object

**Files:**
- Modify: `bLEDsport-game-server/server.js:1-38` (constants), `:162-165` (game state constants)

This is the foundation — replace all hardcoded `const` values with a `gameConfig` object, then replace every reference throughout the file.

- [ ] **Step 1: Define the `gameConfig` object and schema metadata**

Replace lines 1-38 and 162-165 constants with a `gameConfig` object and a `CONFIG_SCHEMA` that defines min/max/step/category/liveAdjustable for each parameter. Keep the old constant names as comments for reference during migration.

```javascript
// At top of server.js, after the opening comment:

const CONFIG_SCHEMA = {
  // Game Rules (pre-match only)
  winsNeeded:       { default: 3,     min: 1, max: 10, step: 1, category: 'gameRules', live: false },
  playerWidth:      { default: 1,     min: 1, max: 5,  step: 1, category: 'gameRules', live: false },
  respawnMs:        { default: 2000,  min: 500, max: 5000, step: 250, category: 'gameRules', live: false },
  randomSpawns:     { default: false, category: 'gameRules', live: false },
  spectatorInteraction: { default: true, category: 'gameRules', live: false },
  victoryDurationMs:{ default: 5000,  min: 2000, max: 10000, step: 500, category: 'gameRules', live: false },
  idleResetMs:      { default: 60000, min: 10000, max: 300000, step: 5000, category: 'gameRules', live: false },

  // Movement
  dashDistance:      { default: 5,     min: 1, max: 20, step: 1, category: 'movement', live: true },
  dashRegenMs:      { default: 3000,  min: 500, max: 10000, step: 250, category: 'movement', live: true },
  momentumTicks:    { default: 0,     min: 0, max: 12, step: 1, category: 'movement', live: true },
  momentumIntervalMs:{ default: 60,   min: 16, max: 200, step: 4, category: 'movement', live: true },

  // Bombs
  bombWidth:        { default: 5,     min: 1, max: 15, step: 1, category: 'bombs', live: true },
  bombFuseMs:       { default: 3000,  min: 500, max: 10000, step: 250, category: 'bombs', live: true },
  bombExplodeRadius:{ default: 8,     min: 2, max: 30, step: 1, category: 'bombs', live: true },
  bombExplodeFrames:{ default: 10,    min: 3, max: 20, step: 1, category: 'bombs', live: true },
  bombCooldownMs:   { default: 1000,  min: 0, max: 5000, step: 250, category: 'bombs', live: true },
  bombKickSpeed:    { default: 0.5,   min: 0.1, max: 2.0, step: 0.1, category: 'bombs', live: true },
  bombLeavesFlames: { default: false, category: 'bombs', live: true },
  flameDurationMs:  { default: 3000,  min: 500, max: 10000, step: 250, category: 'bombs', live: true },
  flameSpread:      { default: 1,     min: 0, max: 10, step: 1, category: 'bombs', live: true },

  // Shield
  shieldDurationMs: { default: 1000,  min: 250, max: 5000, step: 250, category: 'shield', live: true },
  shieldCooldownMs: { default: 5000,  min: 500, max: 15000, step: 250, category: 'shield', live: true },

  // Pew-Pew
  pewPewCooldownMs: { default: 5000,  min: 500, max: 15000, step: 250, category: 'pewPew', live: true },
  waveSpeed:        { default: 2,     min: 1, max: 5, step: 1, category: 'pewPew', live: true },
  waveMaxRadius:    { default: 12,    min: 4, max: 40, step: 1, category: 'pewPew', live: true },

  // Portals
  portalsEnabled:   { default: true,  category: 'portals', live: true },
  portalsMoving:    { default: false, category: 'portals', live: true },
  portalMoveIntervalMs: { default: 15000, min: 5000, max: 60000, step: 1000, category: 'portals', live: true },
  portalMomentum:   { default: 4,     min: 0, max: 12, step: 1, category: 'portals', live: true },

  // Walls
  cornerWallsEnabled:   { default: false, category: 'walls', live: true },
  cornerWallMaxSize:    { default: 6,   min: 2, max: 15, step: 1, category: 'walls', live: true },
  cornerWallGrowMs:     { default: 5000, min: 1000, max: 30000, step: 1000, category: 'walls', live: true },
  randomWallsEnabled:   { default: false, category: 'walls', live: true },
  randomWallSpawnMs:    { default: 10000, min: 3000, max: 30000, step: 1000, category: 'walls', live: true },
  randomWallSize:       { default: 5,   min: 1, max: 15, step: 1, category: 'walls', live: true },
  randomWallMaxCount:   { default: 3,   min: 1, max: 8, step: 1, category: 'walls', live: true },
  sweeperEnabled:       { default: false, category: 'walls', live: true },
  sweeperSize:          { default: 3,   min: 1, max: 10, step: 1, category: 'walls', live: true },
  sweeperSpeed:         { default: 0.25, min: 0.1, max: 2.0, step: 0.05, category: 'walls', live: true },
  sweeperLethal:        { default: true, category: 'walls', live: true },

  // Powerups
  powerupSpawnMinMs:    { default: 4000, min: 1000, max: 20000, step: 500, category: 'powerups', live: true },
  powerupSpawnMaxMs:    { default: 8000, min: 2000, max: 30000, step: 500, category: 'powerups', live: true },
  powerupMaxCount:      { default: 1,   min: 0, max: 5, step: 1, category: 'powerups', live: true },
};

// Build gameConfig from defaults
const gameConfig = {};
for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
  gameConfig[key] = schema.default;
}

// Keep non-configurable constants
const NUM_LEDS = 192;
const TICK_MS = 16;
const PORTAL_GLOW_SIZE = 3;
const POWERUP_TYPES = ['blast'];
```

- [ ] **Step 2: Replace all constant references in server.js**

Search-and-replace every old constant with its `gameConfig.*` equivalent. Key replacements:

| Old | New |
|-----|-----|
| `WINS_NEEDED` | `gameConfig.winsNeeded` |
| `VICTORY_DURATION_MS` | `gameConfig.victoryDurationMs` |
| `IDLE_RESET_MS` | `gameConfig.idleResetMs` |
| `WAVE_SPEED` | `gameConfig.waveSpeed` |
| `WAVE_MAX` | `gameConfig.waveMaxRadius` |
| `PLAYER_WIDTH` | `gameConfig.playerWidth` |
| `DASH_REGEN_MS` | `gameConfig.dashRegenMs` |
| `RESPAWN_MS` | `gameConfig.respawnMs` |
| `BOMB_COOLDOWN_MS` | `gameConfig.bombCooldownMs` |
| `BLAST_COOLDOWN_MS` | `gameConfig.pewPewCooldownMs` |
| `SHIELD_DURATION_MS` | `gameConfig.shieldDurationMs` |
| `SHIELD_COOLDOWN_MS` | `gameConfig.shieldCooldownMs` |
| `POWERUP_SPAWN_MIN` | `gameConfig.powerupSpawnMinMs` |
| `POWERUP_SPAWN_MAX` | `gameConfig.powerupSpawnMaxMs` |
| `POWERUP_MAX` | `gameConfig.powerupMaxCount` |
| `BOMB_WIDTH` | `gameConfig.bombWidth` |
| `BOMB_FUSE_MS` | `gameConfig.bombFuseMs` |
| `BOMB_EXPLODE_RADIUS` | `gameConfig.bombExplodeRadius` |
| `BOMB_EXPLODE_FRAMES` | `gameConfig.bombExplodeFrames` |
| `BOMB_KICK_SPEED` | `gameConfig.bombKickSpeed` |
| `GOD_FIRE_DURATION_MS` | `gameConfig.flameDurationMs` |
| `GOD_FIRE_SPREAD` | `gameConfig.flameSpread` |
| `PORTAL_MOMENTUM` | `gameConfig.portalMomentum` |
| `PORTAL_MOMENTUM_MS` | `gameConfig.momentumIntervalMs` |
| `const step = wantsDash ? 5 : 1` (line 405) | `const step = wantsDash ? gameConfig.dashDistance : 1` |

Also delete the old `const` declarations that are now in `gameConfig`.

- [ ] **Step 3: Verify server starts with `--debug` flag**

Run: `cd bLEDsport-game-server && bun server.js --debug`

Expected: Server starts, prints "LED Arch Game server running on http://localhost:80" (or whatever port). No errors about undefined variables. Game loop ticks without errors. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "refactor: extract hardcoded constants into gameConfig object"
```

---

## Task 2: Add config WebSocket handlers and preset system

**Files:**
- Modify: `bLEDsport-game-server/server.js` (WS message handler, new functions)
- Create: `bLEDsport-game-server/presets/classic.json`

- [ ] **Step 1: Add preset directory and classic.json**

Create `bLEDsport-game-server/presets/classic.json` containing all default values:

```json
{
  "winsNeeded": 3,
  "playerWidth": 1,
  "respawnMs": 2000,
  "randomSpawns": false,
  "spectatorInteraction": true,
  "victoryDurationMs": 5000,
  "idleResetMs": 60000,
  "dashDistance": 5,
  "dashRegenMs": 3000,
  "momentumTicks": 0,
  "momentumIntervalMs": 60,
  "bombWidth": 5,
  "bombFuseMs": 3000,
  "bombExplodeRadius": 8,
  "bombExplodeFrames": 10,
  "bombCooldownMs": 1000,
  "bombKickSpeed": 0.5,
  "bombLeavesFlames": false,
  "flameDurationMs": 3000,
  "flameSpread": 1,
  "shieldDurationMs": 1000,
  "shieldCooldownMs": 5000,
  "pewPewCooldownMs": 5000,
  "waveSpeed": 2,
  "waveMaxRadius": 12,
  "portalsEnabled": true,
  "portalsMoving": false,
  "portalMoveIntervalMs": 15000,
  "portalMomentum": 4,
  "cornerWallsEnabled": false,
  "cornerWallMaxSize": 6,
  "cornerWallGrowMs": 5000,
  "randomWallsEnabled": false,
  "randomWallSpawnMs": 10000,
  "randomWallSize": 5,
  "randomWallMaxCount": 3,
  "sweeperEnabled": false,
  "sweeperSize": 3,
  "sweeperSpeed": 0.25,
  "sweeperLethal": true,
  "powerupSpawnMinMs": 4000,
  "powerupSpawnMaxMs": 8000,
  "powerupMaxCount": 1
}
```

- [ ] **Step 2: Add config helper functions to server.js**

Add these after the `gameConfig` initialization, before the game state section:

```javascript
const fs = require('fs');
const PRESETS_DIR = path.resolve(__dirname, 'presets');

let activePreset = 'classic';
let configBroadcastTimer = null;

function getPresetList() {
  try {
    return fs.readdirSync(PRESETS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch { return ['classic']; }
}

function loadPreset(name) {
  const filePath = path.join(PRESETS_DIR, `${name}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, val] of Object.entries(data)) {
      if (key in CONFIG_SCHEMA) {
        gameConfig[key] = val;
      }
    }
    activePreset = name;
  } catch (err) {
    console.log(`Failed to load preset ${name}:`, err.message);
  }
}

function savePreset(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const filePath = path.join(PRESETS_DIR, `${safeName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(gameConfig, null, 2));
  return safeName;
}

function deletePreset(name) {
  if (name === 'classic') return false;
  const filePath = path.join(PRESETS_DIR, `${name}.json`);
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
}

function randomizeConfig() {
  const isPlaying = gamePhase === 'playing';
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if (isPlaying && !schema.live) continue; // skip pre-match settings during game
    if (typeof schema.default === 'boolean') {
      gameConfig[key] = Math.random() > 0.5;
    } else if (schema.min !== undefined) {
      const steps = Math.round((schema.max - schema.min) / (schema.step || 1));
      const randomStep = Math.floor(Math.random() * (steps + 1));
      gameConfig[key] = schema.min + randomStep * (schema.step || 1);
    }
  }
  // Enforce powerupSpawnMin <= powerupSpawnMax
  if (gameConfig.powerupSpawnMinMs > gameConfig.powerupSpawnMaxMs) {
    gameConfig.powerupSpawnMaxMs = gameConfig.powerupSpawnMinMs;
  }
  activePreset = null;
}

function applyConfigUpdate(category, key, value) {
  if (!(key in CONFIG_SCHEMA)) return false;
  const schema = CONFIG_SCHEMA[key];
  if (schema.category !== category) return false;
  if (gamePhase === 'playing' && !schema.live) return false;
  // Validate
  if (typeof schema.default === 'boolean') {
    gameConfig[key] = !!value;
  } else {
    const num = Number(value);
    if (isNaN(num)) return false;
    gameConfig[key] = Math.max(schema.min, Math.min(schema.max, num));
  }
  activePreset = null; // mark as custom
  return true;
}

function broadcastConfig() {
  // Debounce: max ~10/sec
  if (configBroadcastTimer) return;
  configBroadcastTimer = setTimeout(() => {
    configBroadcastTimer = null;
    const msg = JSON.stringify({
      type: 'config_state',
      config: gameConfig,
      schema: CONFIG_SCHEMA,
      presets: getPresetList(),
      activePreset,
    });
    for (const ws of clients.keys()) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }, 100);
}
```

- [ ] **Step 3: Add config message handlers to WebSocket `message` handler**

In the `websocket.message()` handler (around line 1110), add config message handling before the existing input handling:

```javascript
// Config messages (any client can configure)
if (input.type === 'config_update') {
  if (applyConfigUpdate(input.category, input.key, input.value)) {
    broadcastConfig();
  }
  return;
}
if (input.type === 'load_preset') {
  loadPreset(input.name);
  broadcastConfig();
  return;
}
if (input.type === 'save_preset') {
  savePreset(input.name);
  broadcastConfig();
  return;
}
if (input.type === 'delete_preset') {
  deletePreset(input.name);
  broadcastConfig();
  return;
}
if (input.type === 'randomize') {
  randomizeConfig();
  broadcastConfig();
  return;
}
if (input.type === 'reset_presets') {
  // Delete all custom presets, restore to classic defaults
  const presets = getPresetList();
  for (const name of presets) {
    if (name !== 'classic') deletePreset(name);
  }
  loadPreset('classic');
  broadcastConfig();
  return;
}
```

Also send `config_state` on WebSocket open (in the `open` handler):

```javascript
open(ws) {
  clients.set(ws, null);
  // Send current config state immediately
  ws.send(JSON.stringify({
    type: 'config_state',
    config: gameConfig,
    schema: CONFIG_SCHEMA,
    presets: getPresetList(),
    activePreset,
  }));
  console.log('Client connected');
},
```

- [ ] **Step 4: Add `spectatorInteraction` gate to god bomb handlers**

In both god bomb handlers (local WS around line 1132 and external around line 1059), add:

```javascript
if (!gameConfig.spectatorInteraction) return;
```

- [ ] **Step 5: Update `spawnPos()` to support `randomSpawns`**

```javascript
function spawnPos() {
  if (gameConfig.randomSpawns) {
    // Random spawn with safety distance
    const allOccupied = [
      ...bombs.map(b => b.pos),
      ...[...players.values()].map(p => p.pos),
    ];
    for (let attempt = 0; attempt < 50; attempt++) {
      const pos = Math.floor(Math.random() * NUM_LEDS);
      if (!allOccupied.some(o => Math.abs(o - pos) < 10)) return pos;
    }
    return Math.floor(Math.random() * NUM_LEDS);
  }
  // Classic: fixed candidates
  const taken = [...players.values()].map(p => p.pos);
  const candidates = [0, 48, 96, 144, 191];
  for (const c of candidates) {
    if (!taken.some(t => Math.abs(t - c) < 20)) return c;
  }
  return Math.floor(Math.random() * NUM_LEDS);
}
```

- [ ] **Step 6: Add `bombLeavesFlames` logic to bomb explosion cleanup**

In the bomb explosion fire-spawn section (around line 688), change the condition from only god bombs to also include regular bombs when configured:

```javascript
// Spawn fire from bombs when they finish exploding
for (const b of bombs) {
  if (b.exploding && b.explodeFrame > gameConfig.bombExplodeFrames) {
    if (b.godBomb || gameConfig.bombLeavesFlames) {
      for (let d = -gameConfig.flameSpread; d <= gameConfig.flameSpread; d++) {
        const fPos = b.pos + d;
        if (fPos >= 0 && fPos < NUM_LEDS) {
          fires.push({ pos: fPos, placedAt: now });
        }
      }
    }
  }
}
```

- [ ] **Step 7: Verify config messages work**

Run: `cd bLEDsport-game-server && bun server.js --debug`

Open browser to `http://localhost:80/`, open dev tools console, connect via WebSocket:

```javascript
const ws = new WebSocket('ws://localhost:80/ws');
ws.onmessage = e => { const d = JSON.parse(e.data); if (d.type === 'config_state') console.log('Config:', d); };
// Wait for connection, then:
ws.send(JSON.stringify({ type: 'config_update', category: 'bombs', key: 'bombWidth', value: 10 }));
ws.send(JSON.stringify({ type: 'load_preset', name: 'classic' }));
ws.send(JSON.stringify({ type: 'randomize' }));
```

Expected: Config state messages come back with updated values. No errors in server console.

- [ ] **Step 8: Commit**

```bash
git add bLEDsport-game-server/server.js bLEDsport-game-server/presets/classic.json
git commit -m "feat: add config WebSocket handlers and preset system"
```

---

## Task 3: Implement wall mechanics in game loop

**Files:**
- Modify: `bLEDsport-game-server/server.js` (game state, tick function, movement collision, rendering)

- [ ] **Step 1: Add wall state variables**

After the existing game state variables (around line 180):

```javascript
// Wall state
let cornerWalls = [
  { pos: ZONES[1].start, currentSize: 0, lastGrowAt: 0 }, // LED 58 (left/top boundary)
  { pos: ZONES[1].end, currentSize: 0, lastGrowAt: 0 },   // LED 134 (top/right boundary)
];
let randomWalls = []; // { pos, size }
let lastRandomWallSpawn = 0;
let sweeper = { pos: 0, dir: 1 };
```

- [ ] **Step 2: Add wall collision helper**

Add a function to check if a position is blocked by any wall:

```javascript
function isWallAt(pos) {
  // Corner walls
  if (gameConfig.cornerWallsEnabled) {
    for (const w of cornerWalls) {
      if (w.currentSize === 0) continue;
      const half = Math.floor(w.currentSize / 2);
      if (pos >= w.pos - half && pos <= w.pos + half) return true;
    }
  }
  // Random walls
  if (gameConfig.randomWallsEnabled) {
    for (const w of randomWalls) {
      const half = Math.floor(w.size / 2);
      if (pos >= w.pos - half && pos <= w.pos + half) return true;
    }
  }
  // Sweeper (barrier mode only — lethal is handled separately)
  if (gameConfig.sweeperEnabled && !gameConfig.sweeperLethal) {
    const sStart = Math.floor(sweeper.pos);
    const sEnd = sStart + gameConfig.sweeperSize - 1;
    if (pos >= sStart && pos <= sEnd) return true;
  }
  return false;
}

function isSweeperAt(pos) {
  if (!gameConfig.sweeperEnabled) return false;
  const sStart = Math.floor(sweeper.pos);
  const sEnd = sStart + gameConfig.sweeperSize - 1;
  return pos >= sStart && pos <= sEnd;
}
```

- [ ] **Step 3: Add wall checks to movement**

In `handleInput` for `input.type === 'move'` (around line 401), after computing `newPos`, add wall collision checks:

```javascript
// After computing newPos but before applying it:
// Block movement into walls
if (isWallAt(newPos)) return;

// Check lethal sweeper
if (gameConfig.sweeperEnabled && gameConfig.sweeperLethal && isSweeperAt(newPos)) {
  hitPlayer(player, null, now);
  return;
}
```

Also add wall checks to `pushChain` — the target position in pushChain (line 336) should be blocked by walls:

```javascript
// In pushChain, after computing targetPos:
if (isWallAt(targetPos)) return true; // wall blocks push
if (gameConfig.sweeperEnabled && gameConfig.sweeperLethal && isSweeperAt(targetPos)) return true;
```

And in bomb kick sliding (around line 670), add wall collision to stop kicked bombs:

```javascript
// In the kick sliding loop, after computing newPos:
if (isWallAt(newPos)) {
  b.kickDir = 0;
  break;
}
```

- [ ] **Step 4: Add wall tick logic to the playing phase**

In the `tick()` function playing phase (after respawns, around line 629), add wall update logic:

```javascript
// Corner walls — grow over time
if (gameConfig.cornerWallsEnabled) {
  for (const w of cornerWalls) {
    if (w.currentSize < gameConfig.cornerWallMaxSize && now - w.lastGrowAt >= gameConfig.cornerWallGrowMs) {
      w.currentSize++;
      w.lastGrowAt = now;
    }
  }
}

// Random walls — spawn on timer
if (gameConfig.randomWallsEnabled) {
  if (randomWalls.length < gameConfig.randomWallMaxCount && now - lastRandomWallSpawn >= gameConfig.randomWallSpawnMs) {
    const allOccupied = [
      ...randomWalls.map(w => w.pos),
      ...cornerWalls.map(w => w.pos),
      ...[...players.values()].map(p => p.pos),
      ...bombs.map(b => b.pos),
    ];
    for (let attempt = 0; attempt < 50; attempt++) {
      const pos = 10 + Math.floor(Math.random() * (NUM_LEDS - 20));
      if (!allOccupied.some(o => Math.abs(o - pos) < 10)) {
        randomWalls.push({ pos, size: gameConfig.randomWallSize });
        lastRandomWallSpawn = now;
        break;
      }
    }
  }
}

// Sweeper wall — move and check kills
if (gameConfig.sweeperEnabled) {
  sweeper.pos += sweeper.dir * gameConfig.sweeperSpeed;
  if (sweeper.pos <= 0 || sweeper.pos >= NUM_LEDS - 1) {
    sweeper.dir *= -1;
    sweeper.pos = Math.max(0, Math.min(NUM_LEDS - 1, sweeper.pos));
  }
  const sStart = Math.floor(sweeper.pos);
  const sEnd = sStart + gameConfig.sweeperSize - 1;

  if (gameConfig.sweeperLethal) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      if (p.pos >= sStart && p.pos <= sEnd) {
        hitPlayer(p, null, now);
      }
    }
  }

  // Destroy bombs the sweeper passes over
  bombs = bombs.filter(b => {
    if (b.exploding) return true;
    return !(b.pos >= sStart && b.pos <= sEnd);
  });
}
```

- [ ] **Step 5: Add momentum check to wall collisions**

In the portal momentum section of player updates (around line 605), add wall blocking:

```javascript
// Portal/skating momentum
if (p.momentum > 0 && p.alive && now - p.lastMomentumTime >= gameConfig.momentumIntervalMs) {
  const nextPos = wrapPos(p.pos + p.momentumDir);
  if (isWallAt(nextPos)) {
    p.momentum = 0; // wall stops momentum
  } else if (gameConfig.sweeperEnabled && gameConfig.sweeperLethal && isSweeperAt(nextPos)) {
    hitPlayer(p, null, now);
    p.momentum = 0;
  } else {
    p.pos = nextPos;
    p.momentum--;
    p.lastMomentumTime = now;
  }
}
```

- [ ] **Step 6: Reset walls on game start/reset**

In `startGame()`:
```javascript
cornerWalls.forEach(w => { w.currentSize = 0; w.lastGrowAt = Date.now(); });
randomWalls = [];
lastRandomWallSpawn = Date.now();
sweeper.pos = 0;
sweeper.dir = 1;
```

In `resetGame()`:
```javascript
cornerWalls.forEach(w => { w.currentSize = 0; w.lastGrowAt = 0; });
randomWalls = [];
sweeper.pos = 0;
sweeper.dir = 1;
```

- [ ] **Step 7: Add wall rendering**

In the render section of `tick()` (around line 712), after portal glow and before powerups:

```javascript
// Corner walls (orange)
if (gameConfig.cornerWallsEnabled) {
  for (const w of cornerWalls) {
    if (w.currentSize === 0) continue;
    const half = Math.floor(w.currentSize / 2);
    for (let d = -half; d <= half; d++) {
      const led = w.pos + d;
      if (led >= 0 && led < NUM_LEDS) {
        pixels[led] = [200, 120, 20]; // orange
      }
    }
  }
}

// Random walls (orange)
if (gameConfig.randomWallsEnabled) {
  for (const w of randomWalls) {
    const half = Math.floor(w.size / 2);
    for (let d = -half; d <= half; d++) {
      const led = w.pos + d;
      if (led >= 0 && led < NUM_LEDS) {
        pixels[led] = [200, 120, 20]; // orange
      }
    }
  }
}

// Sweeper wall
if (gameConfig.sweeperEnabled) {
  const sStart = Math.floor(sweeper.pos);
  for (let i = 0; i < gameConfig.sweeperSize; i++) {
    const led = sStart + i;
    if (led >= 0 && led < NUM_LEDS) {
      if (gameConfig.sweeperLethal) {
        // Red pulsing
        const pulse = 0.5 + 0.5 * Math.sin(animTime * 8);
        pixels[led] = [Math.round(255 * pulse), 0, 0];
      } else {
        // Gray/stone
        pixels[led] = [100, 100, 90];
      }
    }
  }
}
```

- [ ] **Step 8: Add walls to broadcast state**

In the `broadcast()` call in the playing phase tick (around line 838), add wall data to the state message:

```javascript
broadcast({
  type: 'state',
  gamePhase: 'playing',
  players: serializePlayers(),
  waves: serializeWaves(),
  powerups: powerups.map(p => ({ pos: p.pos, type: p.type })),
  bombs: bombs.map(b => ({ pos: b.pos, owner: b.owner, width: b.width, exploding: b.exploding, explodeFrame: b.explodeFrame, godBomb: b.godBomb || false })),
  fires: fires.map(f => ({ pos: f.pos, age: (Date.now() - f.placedAt) / gameConfig.flameDurationMs })),
  cornerWalls: cornerWalls.map(w => ({ pos: w.pos, size: w.currentSize })),
  randomWalls: randomWalls.map(w => ({ pos: w.pos, size: w.size })),
  sweeper: gameConfig.sweeperEnabled ? { pos: Math.floor(sweeper.pos), size: gameConfig.sweeperSize, lethal: gameConfig.sweeperLethal } : null,
  animTime,
});
```

- [ ] **Step 9: Verify walls work**

Run: `bun server.js --debug`

Use WebSocket console to enable walls:
```javascript
ws.send(JSON.stringify({ type: 'config_update', category: 'walls', key: 'cornerWallsEnabled', value: true }));
ws.send(JSON.stringify({ type: 'config_update', category: 'walls', key: 'sweeperEnabled', value: true }));
```

Expected: No errors. State messages include wall data. Corner walls grow over time in state updates. Sweeper position changes each tick.

- [ ] **Step 10: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: implement wall mechanics (corner, random, sweeper)"
```

---

## Task 4: Implement moving portals and configurable momentum

**Files:**
- Modify: `bLEDsport-game-server/server.js`

- [ ] **Step 1: Add portal state**

After the wall state variables:

```javascript
// Portal state (moving portals)
const PORTAL_LANDMARKS = [0, ZONES[1].start, ZONES[1].end, NUM_LEDS - 1]; // [0, 58, 134, 191]
let portalA = { pos: 0 };
let portalB = { pos: NUM_LEDS - 1 };
let lastPortalMoveAt = 0;
let portalBlinking = false;
```

- [ ] **Step 2: Add portal teleport function (keep `wrapPos` intact)**

**Important:** Do NOT modify `wrapPos` — it is called by `pushChain`, bomb pushing, and bomb kick sliding, all of which rely on the wrap-around behavior. Instead, add a separate `checkPortalTeleport` function and modify only the move handler's portal logic.

```javascript
function checkPortalTeleport(pos, dir) {
  if (!gameConfig.portalsEnabled) return null;
  if (pos === portalA.pos) return { dest: portalB.pos, momentum: Math.max(gameConfig.portalMomentum, gameConfig.momentumTicks) };
  if (pos === portalB.pos) return { dest: portalA.pos, momentum: Math.max(gameConfig.portalMomentum, gameConfig.momentumTicks) };
  return null;
}
```

Then update the move handler. Replace the existing portal/wrapping logic in `handleInput` move section. The key change: instead of wrapping at edges, check portal teleportation explicitly. Stepping onto a portal LED triggers teleportation.

```javascript
// In the move handler, replace the wrapping + portal logic:
let newPos = player.pos + delta;

// Check if we walked off the edge
if (newPos < 0 || newPos >= NUM_LEDS) {
  // Check portal at current position (standing at edge, trying to walk off)
  const portal = checkPortalTeleport(player.pos, delta > 0 ? 1 : -1);
  if (portal) {
    player.pos = portal.dest;
    player.momentum = portal.momentum;
    player.momentumDir = delta > 0 ? 1 : -1;
    player.lastMomentumTime = now;
    return;
  }
  return; // edge of arch, no portal, can't move
}

// Check portal at new position (for non-edge portals when portalsMoving is true)
const portal = checkPortalTeleport(newPos, delta > 0 ? 1 : -1);
if (portal) {
  player.pos = portal.dest;
  player.momentum = portal.momentum;
  player.momentumDir = delta > 0 ? 1 : -1;
  player.lastMomentumTime = now;
  return;
}

// Wall check
if (isWallAt(newPos)) return;
if (gameConfig.sweeperEnabled && gameConfig.sweeperLethal && isSweeperAt(newPos)) {
  hitPlayer(player, null, now);
  return;
}
```

**Note on portal behavior change:** In classic mode (portals at 0 and 191), this changes teleportation from "walk past the edge and wrap" to "stand at edge and walk off to teleport." The result is functionally the same — pressing left at LED 0 teleports you to LED 191. But the implementation path is different. Bomb pushing and kick sliding still use the original `wrapPos` wrapping behavior, which is correct (bombs aren't affected by portal positions).

- [ ] **Step 3: Add skating momentum to move handler**

After the normal movement is applied (after the dash/walk logic), add skating momentum:

```javascript
// Apply skating momentum (if configured)
if (gameConfig.momentumTicks > 0 && !throughPortal) {
  player.momentum = gameConfig.momentumTicks;
  player.momentumDir = delta > 0 ? 1 : -1;
  player.lastMomentumTime = now;
}
// NOTE: With D-pad repeat firing every TICK_MS (16ms), each repeat also triggers momentum.
// This means skating mode creates continuous sliding movement — intentional per spec.
// If it feels too fast, tuning knobs are momentumTicks and momentumIntervalMs.
```
```

- [ ] **Step 4: Add moving portal tick logic**

In the playing phase tick, add portal movement:

```javascript
// Moving portals
if (gameConfig.portalsEnabled && gameConfig.portalsMoving) {
  const timeSinceMove = now - lastPortalMoveAt;
  const interval = gameConfig.portalMoveIntervalMs;

  // Blink warning 2 seconds before move
  portalBlinking = timeSinceMove >= interval - 2000;

  if (timeSinceMove >= interval) {
    // Pick new landmark pair (different from current, A != B)
    const available = PORTAL_LANDMARKS.filter(l => l !== portalA.pos && l !== portalB.pos);
    if (available.length >= 2) {
      const shuffled = available.sort(() => Math.random() - 0.5);
      portalA.pos = shuffled[0];
      portalB.pos = shuffled[1];
    } else if (available.length === 1) {
      // One new position, keep one old
      const keepOld = Math.random() > 0.5 ? portalA.pos : portalB.pos;
      portalA.pos = available[0];
      portalB.pos = keepOld;
    }
    lastPortalMoveAt = now;
    portalBlinking = false;
  }
} else {
  portalBlinking = false;
}
```

- [ ] **Step 5: Update portal rendering to use dynamic positions**

Replace the hardcoded portal glow rendering (around line 715) with:

```javascript
// Portal glow (dynamic positions)
if (gameConfig.portalsEnabled) {
  const portalPulse = portalBlinking
    ? (Math.sin(animTime * 15) > 0 ? 0.6 : 0.1)  // fast blink when about to move
    : 0.3 + 0.3 * Math.sin(animTime * 4);
  const portalSwirl = 0.15 * Math.sin(animTime * 7);

  for (let d = 0; d < PORTAL_GLOW_SIZE; d++) {
    const fade = (1 - d / PORTAL_GLOW_SIZE) * portalPulse;
    const swirl2 = portalSwirl * (1 - d / PORTAL_GLOW_SIZE);

    // Portal A (orange)
    const aLed = portalA.pos + d * (portalA.pos === 0 ? 1 : -1);
    if (aLed >= 0 && aLed < NUM_LEDS) {
      pixels[aLed] = [Math.round(255*(fade+swirl2)), Math.round(140*(fade+swirl2)), Math.round(20*fade)];
    }
    // Portal B (blue)
    const bLed = portalB.pos + d * (portalB.pos === NUM_LEDS - 1 ? -1 : 1);
    if (bLed >= 0 && bLed < NUM_LEDS) {
      pixels[bLed] = [Math.round(20*fade), Math.round(100*(fade+swirl2)), Math.round(255*(fade+swirl2))];
    }
  }
}
```

- [ ] **Step 6: Add portal positions to broadcast and reset**

In the broadcast state message, add portal data:
```javascript
portalA: portalA.pos,
portalB: portalB.pos,
portalBlinking,
```

In `startGame()` and `resetGame()`:
```javascript
portalA.pos = 0;
portalB.pos = NUM_LEDS - 1;
lastPortalMoveAt = Date.now();
portalBlinking = false;
```

- [ ] **Step 7: Verify portals and momentum**

Run server, use WebSocket to enable moving portals and skating:
```javascript
ws.send(JSON.stringify({ type: 'config_update', category: 'portals', key: 'portalsMoving', value: true }));
ws.send(JSON.stringify({ type: 'config_update', category: 'portals', key: 'portalMoveIntervalMs', value: 5000 }));
ws.send(JSON.stringify({ type: 'config_update', category: 'movement', key: 'momentumTicks', value: 6 }));
```

Expected: Portal positions change in state messages every 5 seconds. `portalBlinking` goes true 2 seconds before. No errors.

- [ ] **Step 8: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: implement moving portals and configurable momentum/skating"
```

---

## Task 5: Extend binary protocol for external server

**Files:**
- Modify: `bLEDsport-game-server/server.js` (`packStateForExternal` function)

- [ ] **Step 1: Extend `packStateForExternal` to include walls and portals**

After the fire data section (around line 1002) and before the victory section, add:

```javascript
// Corner walls
const activeCornerWalls = cornerWalls.filter(w => w.currentSize > 0);
buf[off++] = activeCornerWalls.length;
for (const w of activeCornerWalls) {
  buf[off++] = w.pos & 0xFF;
  buf[off++] = w.currentSize & 0xFF;
}

// Random walls
buf[off++] = randomWalls.length & 0xFF;
for (const w of randomWalls) {
  buf[off++] = w.pos & 0xFF;
  buf[off++] = w.size & 0xFF;
}

// Sweeper
const sweeperFlags = (gameConfig.sweeperEnabled ? 1 : 0) | (gameConfig.sweeperLethal ? 2 : 0);
buf[off++] = sweeperFlags;
if (gameConfig.sweeperEnabled) {
  buf[off++] = Math.floor(sweeper.pos) & 0xFF;
  buf[off++] = gameConfig.sweeperSize & 0xFF;
}

// Portal positions
buf[off++] = portalA.pos & 0xFF;
buf[off++] = portalB.pos & 0xFF;
```

**Replace** the existing buffer size calculation (lines 943-949 in server.js) with:

```javascript
const activeCornerWallCount = cornerWalls.filter(w => w.currentSize > 0).length;
const size = 2
  + playerCount * 8
  + waveCount * 4
  + 1 + bombCount * 4
  + 1 + powerupCount
  + 1 + fireCount * 2
  + 1 + activeCornerWallCount * 2  // corner walls
  + 1 + randomWalls.length * 2     // random walls
  + 1 + (gameConfig.sweeperEnabled ? 2 : 0)  // sweeper
  + 2                               // portal positions
  + (phase === 2 ? 3 + 1 + nameBytes.length : 0);
```

- [ ] **Step 2: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: extend binary protocol with wall and portal data"
```

---

## Task 6: Build the config UI (index.html rewrite)

**Files:**
- Rewrite: `bLEDsport-game-server/index.html`

This is the largest task — a full rewrite of the 494-line `index.html`. The new page is a config dashboard with live arch view.

- [ ] **Step 1: Write the new index.html**

Rewrite `bLEDsport-game-server/index.html` with:

**Structure:**
- Two-panel CSS Grid layout: left config panel (scrollable), right live view (fixed)
- WebSocket connection to `/ws`
- On `config_state` message: populate all controls from `config` values, rebuild preset buttons from `presets` list
- On `game_state` message: update canvas rendering and scoreboard
- Slider `input` events: debounced (100ms), send `config_update` message
- Toggle clicks: send `config_update` immediately
- Preset button clicks: send `load_preset`
- Save button: prompt for name, send `save_preset`
- Randomize button: send `randomize`

**Key sections of the HTML:**

1. **CSS** — dark theme matching the mockup (see brainstorm mockup for exact styles)
2. **Preset bar** — dynamically populated from `config_state.presets`
3. **Config categories** — generated from `config_state.schema` grouped by category
4. **Canvas** — 288x400 arch rendering, same LED layout math as current code
5. **Scoreboard** — player list with color dots and scores
6. **Game status** — phase indicator

**Important implementation details:**
- Controls are generated dynamically from `CONFIG_SCHEMA` sent by server — no hardcoded sliders
- Each slider/toggle has a `data-key` attribute matching the config key
- When server sends `config_state`, all controls update to match (handles multi-client sync)
- PRE-MATCH controls get `disabled` attribute when `gamePhase !== 'waiting'`
- Canvas renders walls (orange), sweeper (red/gray), and dynamic portal positions
- The arch rendering code from the current `index.html` can be reused for the canvas — just remove the player HUD and keyboard input parts

The full HTML file should be ~400-500 lines. Write it as a single self-contained file (inline CSS and JS, no external deps).

- [ ] **Step 2: Verify the config UI works end-to-end**

Run: `bun server.js --debug`
Open: `http://localhost:80/`

Expected:
- See preset bar with "Classic" highlighted
- See all config categories with sliders at default values
- Moving a slider updates the value display and sends to server
- Clicking "Randomize" changes all sliders to random values
- Live view canvas shows the arch with idle animation
- If you connect a second browser tab, slider changes in one are reflected in the other

- [ ] **Step 3: Commit**

```bash
git add bLEDsport-game-server/index.html
git commit -m "feat: rewrite index.html as config dashboard UI"
```

---

## Task 7: Update external server spectator view

**Files:**
- Modify: `bledsport-external/index.html` (`unpackState` function, rendering)

- [ ] **Step 1: Update `unpackState` to decode new binary fields**

In the external server's `index.html`, after the fire decoding section in `unpackState()`, add:

```javascript
// Corner walls
const cornerWallCount = buf[off++] || 0;
state.cornerWalls = [];
for (let i = 0; i < cornerWallCount; i++) {
  state.cornerWalls.push({ pos: buf[off++], size: buf[off++] });
}

// Random walls
const randomWallCount = buf[off++] || 0;
state.randomWalls = [];
for (let i = 0; i < randomWallCount; i++) {
  state.randomWalls.push({ pos: buf[off++], size: buf[off++] });
}

// Sweeper
const sweeperFlags = buf[off++] || 0;
state.sweeper = null;
if (sweeperFlags & 1) {
  state.sweeper = {
    pos: buf[off++],
    size: buf[off++],
    lethal: !!(sweeperFlags & 2),
  };
}

// Portal positions
state.portalA = buf[off++] || 0;
state.portalB = buf[off++] || 191;
```

Add safety: wrap the new decoding in a try/catch or check `off < buf.length` before reading, so old game servers that don't send wall data don't crash the spectator.

- [ ] **Step 2: Add wall and portal rendering to spectator view**

In the drawing function, add wall rendering (same colors as game server):

```javascript
// Corner walls (orange)
for (const w of (gameState.cornerWalls || [])) {
  const half = Math.floor(w.size / 2);
  for (let d = -half; d <= half; d++) {
    const led = w.pos + d;
    if (led >= 0 && led < 192) setPixel(led, [200, 120, 20]);
  }
}

// Random walls (orange)
for (const w of (gameState.randomWalls || [])) {
  const half = Math.floor(w.size / 2);
  for (let d = -half; d <= half; d++) {
    const led = w.pos + d;
    if (led >= 0 && led < 192) setPixel(led, [200, 120, 20]);
  }
}

// Sweeper
if (gameState.sweeper) {
  const s = gameState.sweeper;
  for (let i = 0; i < s.size; i++) {
    const led = s.pos + i;
    if (led >= 0 && led < 192) {
      if (s.lethal) {
        const pulse = 0.5 + 0.5 * Math.sin(gameState.animTime * 8);
        setPixel(led, [Math.round(255 * pulse), 0, 0]);
      } else {
        setPixel(led, [100, 100, 90]);
      }
    }
  }
}
```

Update the portal glow rendering to use `gameState.portalA` and `gameState.portalB` instead of hardcoded 0/191.

- [ ] **Step 3: Commit**

```bash
cd /Users/georgemandis/Projects/recurse/2026/bLEDsport/bledsport-external
git add index.html
git commit -m "feat: render walls, sweeper, and dynamic portals in spectator view"
```

---

## Task 8: Final integration and manual testing

**Files:**
- All modified files

- [ ] **Step 1: Full integration test**

Start game server: `cd bLEDsport-game-server && bun server.js --debug`

Open config UI at `http://localhost:80/`:
1. Verify all categories render with correct defaults
2. Move sliders — values update
3. Click Randomize — all values scramble
4. Click Classic — all values reset to defaults
5. Click "+ Save Preset" — enter name "test" — verify it appears in preset bar
6. Click "test" preset — loads saved values
7. Delete "test" preset

- [ ] **Step 2: Test with gamepad (if available)**

Start server with gamepad: `bun server.js --debug --gamepad ./innext-controller.json`

1. Press Start on gamepad — player joins, game starts
2. While playing, change bomb radius via config UI — should take effect on next bomb
3. Enable sweeper — verify it appears on the LED output / live view
4. Enable corner walls — verify they grow
5. Enable moving portals — verify they shift positions

- [ ] **Step 3: Test pre-match locking**

While a game is in progress:
1. Verify `winsNeeded`, `playerWidth`, `respawnMs`, `randomSpawns` sliders are disabled in UI
2. Verify sending `config_update` for those keys via WS console returns no change
3. Verify Randomize skips pre-match settings

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete game config UI with presets, walls, portals, momentum"
```

---

## Summary

| Task | Description | Key Files |
|------|------------|-----------|
| 1 | Extract constants into gameConfig | server.js |
| 2 | Config WS handlers + presets | server.js, presets/classic.json |
| 3 | Wall mechanics (corner, random, sweeper) | server.js |
| 4 | Moving portals + configurable momentum | server.js |
| 5 | Extend binary protocol | server.js |
| 6 | Config UI (index.html rewrite) | index.html |
| 7 | External server spectator updates | bledsport-external/index.html |
| 8 | Integration testing | All |

Tasks 1-5 are sequential (each builds on the previous). Task 6 can start after Task 2 for the config controls, but wall/sweeper/portal rendering in the canvas depends on Tasks 3-4 state data being present in the broadcast. Recommend doing Tasks 1-5 first, then Task 6. Task 7 can start after Task 5. Task 8 is last.
