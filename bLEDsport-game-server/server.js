// LED Arch Game — multiplayer server
// Run: bun server.js [--debug] [--gamepad ./innext-controller.json]

const fs = require('fs');
const path = require('path');

const CONFIG_SCHEMA = {
  // Game Rules (pre-match only)
  winsNeeded:       { default: 3,     min: 1, max: 10, step: 1, category: 'gameRules', live: false },
  respawnMs:        { default: 2000,  min: 500, max: 5000, step: 250, category: 'gameRules', live: false },
  randomSpawns:     { default: false, category: 'gameRules', live: false },
  spectatorInteraction: { default: true, category: 'gameRules', live: false },
  victoryDurationMs:{ default: 5000,  min: 2000, max: 10000, step: 500, category: 'gameRules', live: false },
  idleResetMs:      { default: 60000, min: 10000, max: 300000, step: 5000, category: 'gameRules', live: false },

  // Movement
  dashDistance:      { default: 5,     min: 1, max: 20, step: 1, category: 'movement', live: true },
  dashRegenMs:      { default: 3000,  min: 500, max: 10000, step: 250, category: 'movement', live: true },
  tickMs:           { default: 16,    min: 8, max: 100, step: 4, category: 'movement', live: false },
  momentumTicks:    { default: 0,     min: 0, max: 12, step: 1, category: 'movement', live: true },
  momentumIntervalMs:{ default: 60,   min: 16, max: 200, step: 4, category: 'movement', live: true },

  // Bombs
  bombWidth:        { default: 5,     min: 1, max: 15, step: 1, category: 'bombs', live: true },
  bombFuseMs:       { default: 3000,  min: 500, max: 10000, step: 250, category: 'bombs', live: true },
  bombExplodeRadius:{ default: 8,     min: 2, max: 30, step: 1, category: 'bombs', live: true },
  bombExplodeFrames:{ default: 10,    min: 3, max: 20, step: 1, category: 'bombs', live: true },
  bombCooldownMs:   { default: 0,  min: 0, max: 5000, step: 250, category: 'bombs', live: true },
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
  pewPewDestroysWalls: { default: false, category: 'pewPew', live: true },

  // Portals
  portalsEnabled:   { default: true,  category: 'portals', live: true },
  portalsMoving:    { default: false, category: 'portals', live: true },
  portalMoveIntervalMs: { default: 15000, min: 5000, max: 60000, step: 1000, category: 'portals', live: true },
  portalMomentum:   { default: 4,     min: 0, max: 12, step: 1, category: 'portals', live: true },
  portalsAnywhere:  { default: false, category: 'portals', live: true },

  // Walls
  randomWallsEnabled:   { default: false, category: 'walls', live: true },
  randomWallSpawnMs:    { default: 10000, min: 3000, max: 30000, step: 1000, category: 'walls', live: true },
  randomWallSize:       { default: 5,   min: 1, max: 15, step: 1, category: 'walls', live: true },
  randomWallMaxCount:   { default: 3,   min: 1, max: 8, step: 1, category: 'walls', live: true },
  sweeperEnabled:       { default: false, category: 'walls', live: true },
  sweeperSize:          { default: 3,   min: 1, max: 10, step: 1, category: 'walls', live: true },
  sweeperSpeed:         { default: 0.25, min: 0.1, max: 2.0, step: 0.05, category: 'walls', live: true },
  sweeperLethal:        { default: true, category: 'walls', live: true },
  bombsDestroyWalls:    { default: true, category: 'walls', live: true },
  dashThroughWalls:     { default: true, category: 'walls', live: true },

  // Powerups
  powerupSpawnMinMs:    { default: 4000, min: 1000, max: 20000, step: 500, category: 'powerups', live: true },
  powerupSpawnMaxMs:    { default: 8000, min: 2000, max: 30000, step: 500, category: 'powerups', live: true },
  powerupMaxCount:      { default: 1,   min: 0, max: 5, step: 1, category: 'powerups', live: true },

  // Display
  ledBrightness:        { default: 255, min: 10, max: 255, step: 5, category: 'display', live: true },
};

// Build gameConfig from defaults
const gameConfig = {};
for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
  gameConfig[key] = schema.default;
}

// --- Config preset system ---
let activePreset = 'classic';
let configBroadcastTimer = null;

const PRESETS_DIR = path.resolve(__dirname, 'presets');

function getPresetList() {
  try {
    return fs.readdirSync(PRESETS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

function loadPreset(name) {
  const filePath = path.join(PRESETS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
      if (key in data) {
        gameConfig[key] = data[key];
      }
    }
    activePreset = name;
    return true;
  } catch (err) {
    console.log(`Failed to load preset "${name}":`, err.message);
    return false;
  }
}

function savePreset(name) {
  // Sanitize name: alphanumeric, dashes, underscores only
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!safeName) return false;
  const filePath = path.join(PRESETS_DIR, `${safeName}.json`);
  try {
    fs.mkdirSync(PRESETS_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(gameConfig, null, 2));
    activePreset = safeName;
    return true;
  } catch (err) {
    console.log(`Failed to save preset "${safeName}":`, err.message);
    return false;
  }
}

function deletePreset(name) {
  if (name === 'classic') return false; // protect classic
  const filePath = path.join(PRESETS_DIR, `${name}.json`);
  try {
    fs.unlinkSync(filePath);
    if (activePreset === name) activePreset = null;
    return true;
  } catch (err) {
    console.log(`Failed to delete preset "${name}":`, err.message);
    return false;
  }
}

function randomizeConfig() {
  const isPlaying = gamePhase === 'playing';
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    // Skip non-live settings during active gameplay
    if (isPlaying && !schema.live) continue;
    if (typeof schema.default === 'boolean') {
      gameConfig[key] = Math.random() < 0.5;
    } else if (schema.min !== undefined && schema.max !== undefined) {
      const range = schema.max - schema.min;
      const steps = Math.round(range / (schema.step || 1));
      const randomSteps = Math.floor(Math.random() * (steps + 1));
      gameConfig[key] = schema.min + randomSteps * (schema.step || 1);
      // Clamp to max in case of floating point
      gameConfig[key] = Math.min(schema.max, gameConfig[key]);
      // Round to step precision for floats
      if (schema.step && schema.step < 1) {
        const decimals = String(schema.step).split('.')[1]?.length || 0;
        gameConfig[key] = Number(gameConfig[key].toFixed(decimals));
      }
    }
  }
  // Enforce powerupSpawnMinMs <= powerupSpawnMaxMs
  if (gameConfig.powerupSpawnMinMs > gameConfig.powerupSpawnMaxMs) {
    const temp = gameConfig.powerupSpawnMinMs;
    gameConfig.powerupSpawnMinMs = gameConfig.powerupSpawnMaxMs;
    gameConfig.powerupSpawnMaxMs = temp;
  }
  activePreset = null;
}

function applyConfigUpdate(category, key, value) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) return false;
  if (schema.category !== category) return false;
  // Block non-live settings during gameplay
  if (gamePhase === 'playing' && !schema.live) return false;
  // Validate value type
  if (typeof schema.default === 'boolean') {
    gameConfig[key] = !!value;
  } else {
    const num = Number(value);
    if (isNaN(num)) return false;
    const clamped = Math.max(schema.min, Math.min(schema.max, num));
    gameConfig[key] = clamped;
  }
  activePreset = null;
  return true;
}

function broadcastConfig() {
  if (configBroadcastTimer) clearTimeout(configBroadcastTimer);
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

// Keep non-configurable constants
const NUM_LEDS = 192;
const TICK_MS = () => gameConfig.tickMs; // ~60fps by default
const PORTAL_GLOW_SIZE = 3;
const POWERUP_TYPES = ['blast'];

const PLAYER_COLORS = [
  [0, 200, 255],   // cyan
  [255, 80, 200],  // pink
  [0, 255, 80],    // green
  [255, 200, 0],   // gold
  [255, 0, 0],     // red
  [0, 0, 255],     // blue
  [255, 255, 255], // white
  [255, 100, 0],   // orange
  [180, 0, 255],   // purple
  [0, 255, 200],   // teal
  [255, 0, 100],   // hot pink
  [100, 255, 0],   // lime
  [255, 50, 50],   // coral
  [0, 150, 255],   // sky blue
  [255, 180, 200], // salmon
  [200, 255, 0],   // chartreuse
  [255, 0, 200],   // magenta
  [0, 255, 255],   // aqua
  [255, 255, 100], // pale yellow
  [150, 100, 255], // lavender
  [255, 120, 60],  // tangerine
  [0, 200, 150],   // jade
  [220, 220, 220], // silver
  [255, 60, 150],  // rose
];

const ZONES = [
  { name: 'left',  start: 0,   end: 57  },
  { name: 'top',   start: 58,  end: 134 },
  { name: 'right', start: 135, end: 191 },
];

// --- Debug mode ---
const DEBUG = process.argv.includes('--debug');
if (DEBUG) console.log('DEBUG MODE: WLED output disabled');

// --- Speech (cross-platform TTS) ---
const { execFile, execFileSync, spawn: nodeSpawn } = require('child_process');
const IS_MAC = process.platform === 'darwin';

function detectTTS() {
  try {
    if (IS_MAC) return 'say'; // built-in on macOS
    execFileSync('which', ['espeak-ng']);
    return 'espeak-ng';
  } catch { return null; }
}
const TTS_ENGINE = detectTTS();
if (TTS_ENGINE) console.log(`TTS enabled (${TTS_ENGINE})`);

function speak(text) {
  if (!TTS_ENGINE) return;
  if (TTS_ENGINE === 'say') {
    const rate = 150 + Math.floor(Math.random() * 100); // 150-250 wpm
    execFile('say', ['-r', String(rate), text], (err) => {});
  } else {
    const pitch = 20 + Math.floor(Math.random() * 70);
    const speed = 120 + Math.floor(Math.random() * 100);
    const variant = Math.floor(Math.random() * 5) + 1;
    execFile('espeak-ng', [
      '-p', String(pitch),
      '-s', String(speed),
      '-v', `en+m${variant}`,
      text,
    ], (err) => {});
  }
}

// --- Music (cross-platform) ---
let musicProc = null;

function detectMusicPlayer() {
  if (IS_MAC) return 'afplay'; // built-in on macOS
  try { execFileSync('which', ['mpg123']); return 'mpg123'; }
  catch { return null; }
}
const MUSIC_PLAYER = detectMusicPlayer();
if (MUSIC_PLAYER) console.log(`Music enabled (${MUSIC_PLAYER})`);

function musicPlay(file) {
  if (!MUSIC_PLAYER) return;
  musicStop();
  const filePath = path.resolve(__dirname, 'assets', file);
  if (MUSIC_PLAYER === 'afplay') {
    musicProc = nodeSpawn('afplay', [filePath], { stdio: 'ignore' });
  } else {
    musicProc = nodeSpawn('mpg123', ['-o', 'pulse', '--loop', '-1', '--quiet', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  musicProc.on('error', (err) => { musicProc = null; });
  musicProc.on('exit', () => { musicProc = null; });
}

function musicStop() {
  if (!musicProc) return;
  musicProc.kill();
  musicProc = null;
}

// --- WLED connection (DDP over UDP) ---
const WLED_HOST = '10.100.3.132';
const WLED_DDP_PORT = 4048;
const dgram = require('node:dgram');
let ddpSocket = null;
let ddpSeq = 0;

function connectWled() {
  if (DEBUG) return;
  ddpSocket = dgram.createSocket('udp4');
  ddpSocket.on('error', (err) => {
    console.log('DDP socket error:', err.message);
  });
  console.log(`WLED DDP ready → ${WLED_HOST}:${WLED_DDP_PORT}`);
}

function sendToWled(pixels) {
  if (!ddpSocket) return;
  const pixelCount = NUM_LEDS;
  const dataLen = pixelCount * 3;
  ddpSeq = (ddpSeq % 15) + 1;

  // 10-byte DDP header + RGB data
  const buf = Buffer.alloc(10 + dataLen);
  buf[0] = 0x41; // VER1 (0x40) | PUSH (0x01) — version 1, push (last packet)
  buf[1] = ddpSeq;
  buf[2] = 0x01; // data type: RGB, 8 bits per channel
  buf[3] = 0x01; // source ID
  buf.writeUInt32BE(0, 4); // data offset (0 — single packet)
  buf.writeUInt16BE(dataLen, 8); // data length

  // Fill RGB pixel data (scaled by brightness)
  const bri = gameConfig.ledBrightness / 255;
  for (let i = 0; i < pixelCount; i++) {
    const off = 10 + i * 3;
    const c = pixels[i];
    if (c) {
      buf[off]     = Math.max(0, Math.min(255, Math.round(c[0] * bri)));
      buf[off + 1] = Math.max(0, Math.min(255, Math.round(c[1] * bri)));
      buf[off + 2] = Math.max(0, Math.min(255, Math.round(c[2] * bri)));
    }
    // else stays 0,0,0 (black) from Buffer.alloc
  }

  ddpSocket.send(buf, WLED_DDP_PORT, WLED_HOST);
}

// --- Game state ---

let gamePhase = 'waiting'; // 'waiting' | 'playing' | 'victory'
let victoryStart = 0;
let victoryColor = [255, 255, 255];
let victoryPlayerName = '';
let lastInputTime = Date.now();

let nextPlayerId = 1;
const players = new Map();
let waves = [];
let powerups = [];  // {pos, type, spawnTime}
let bombs = [];     // {pos, owner, placedAt, width, exploding, explodeFrame}
let explosions = []; // {center, radius, frame, maxFrames}
let fires = [];      // {pos, placedAt} — from Hand of God bombs
let animTime = 0;
let lastPowerupSpawn = Date.now();
let nextPowerupDelay = randomBetween(gameConfig.powerupSpawnMinMs, gameConfig.powerupSpawnMaxMs);

// Wall state
let randomWalls = []; // { pos, size }
let lastRandomWallSpawn = 0;
let sweeper = { pos: 0, dir: 1 };

// Portal state (moving portals)
const PORTAL_LANDMARKS = [0, ZONES[1].start, ZONES[1].end, NUM_LEDS - 1]; // [0, 58, 134, 191]
let portalA = { pos: 0 };
let portalB = { pos: NUM_LEDS - 1 };
let lastPortalMoveAt = 0;
let portalBlinking = false;

function resetGame() {
  gamePhase = 'waiting';
  waves = [];
  powerups = [];
  bombs = [];
  explosions = [];
  fires = [];
  // Remove all players — they must press Start/Join again
  players.clear();
  // Reset browser clients to spectator
  for (const [ws, id] of clients.entries()) {
    if (id) {
      clients.set(ws, null);
      ws.send(JSON.stringify({ type: 'reset' }));
    }
  }
  // Reset gamepad players
  if (globalThis.padPlayers) globalThis.padPlayers.clear();
  lastPowerupSpawn = Date.now();
  lastInputTime = Date.now();
  randomWalls = [];
  sweeper.pos = 0;
  sweeper.dir = 1;
  portalA.pos = 0;
  portalB.pos = NUM_LEDS - 1;
  lastPortalMoveAt = Date.now();
  portalBlinking = false;
  musicStop();
  console.log('Game reset — waiting for players');
}

function startGame() {
  if (players.size < 1) return;
  gamePhase = 'playing';
  // Reset scores and respawn everyone
  for (const p of players.values()) {
    p.score = 0;
    p.alive = true;
    p.pos = spawnPos();
    p.lastDelta = 0;
    p.hasDash = true;
    p.shieldActive = false;
    p.bombMaxCharges = 1;
    p.bombCharges = 1;
    p.bombLastUsed = [];
    p.blastMaxCharges = 0;
    p.blastCharges = 0;
    p.blastLastUsed = [];
    p.shieldLastUsed = 0;
    p.momentum = 0;
  }
  waves = [];
  powerups = [];
  bombs = [];
  fires = [];
  lastPowerupSpawn = Date.now();
  lastInputTime = Date.now();
  randomWalls = [];
  lastRandomWallSpawn = Date.now();
  sweeper.pos = 0;
  sweeper.dir = 1;
  portalA.pos = 0;
  portalB.pos = NUM_LEDS - 1;
  lastPortalMoveAt = Date.now();
  portalBlinking = false;
  speak('fight');
  musicPlay('fight.mp3');
  console.log(`Game started with ${players.size} players`);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function spawnPos() {
  const taken = [
    ...[...players.values()].map(p => p.pos),
    ...bombs.map(b => b.pos),
  ];

  if (gameConfig.randomSpawns) {
    // Random position with safety distance from players/bombs
    for (let attempt = 0; attempt < 50; attempt++) {
      const pos = Math.floor(Math.random() * NUM_LEDS);
      if (!taken.some(t => Math.abs(t - pos) < 10)) return pos;
    }
    return Math.floor(Math.random() * NUM_LEDS);
  }

  // Fixed candidate positions
  const candidates = [0, 48, 96, 144, 191];
  for (const c of candidates) {
    if (!taken.some(t => Math.abs(t - c) < 20)) return c;
  }
  return Math.floor(Math.random() * NUM_LEDS);
}

function randomPowerupPos() {
  const allOccupied = [
    ...powerups.map(p => p.pos),
    ...bombs.map(b => b.pos),
    ...[...players.values()].map(p => p.pos),
  ];
  for (let attempt = 0; attempt < 50; attempt++) {
    const pos = 5 + Math.floor(Math.random() * (NUM_LEDS - 10));
    if (!allOccupied.some(o => Math.abs(o - pos) < 8)) return pos;
  }
  return Math.floor(Math.random() * NUM_LEDS);
}

function createPlayer(id) {
  const colorIndex = (id - 1) % PLAYER_COLORS.length;
  return {
    id,
    pos: spawnPos(),
    color: PLAYER_COLORS[colorIndex],
    colorIndex,
    width: 1,
    alive: true,
    respawnAt: 0,
    score: 0,
    name: `P${id}`,
    lastDelta: 0,
    lastMoveTime: 0,
    hasDash: true,
    lastDashTime: 0,
    // Abilities
    bombCharges: 1,
    bombMaxCharges: 1,
    bombLastUsed: [],      // timestamps of each charge used
    blastCharges: 0,
    blastMaxCharges: 0,
    blastLastUsed: [],
    shieldActive: false,
    shieldActiveUntil: 0,
    shieldLastUsed: 0,
    // Portal momentum
    momentum: 0,       // remaining forced moves
    momentumDir: 0,    // direction of forced moves
    lastMomentumTime: 0,
  };
}

// --- Portal wrapping ---
function wrapPos(pos) {
  if (pos < 0) return NUM_LEDS - 1;
  if (pos >= NUM_LEDS) return 0;
  return pos;
}

function checkPortalTeleport(pos, dir) {
  if (!gameConfig.portalsEnabled) return null;
  if (pos === portalA.pos) return { dest: portalB.pos, momentum: Math.max(gameConfig.portalMomentum, gameConfig.momentumTicks) };
  if (pos === portalB.pos) return { dest: portalA.pos, momentum: Math.max(gameConfig.portalMomentum, gameConfig.momentumTicks) };
  return null;
}

function getZone(pos) {
  return ZONES.find(z => pos >= z.start && pos <= z.end) || ZONES[0];
}

// --- Wall collision helpers ---
function isWallAt(pos) {
  if (gameConfig.randomWallsEnabled) {
    for (const w of randomWalls) {
      const half = Math.floor(w.size / 2);
      if (pos >= w.pos - half && pos <= w.pos + half) return true;
    }
  }
  if (gameConfig.sweeperEnabled && !gameConfig.sweeperLethal) {
    const sStart = Math.floor(sweeper.pos);
    const sEnd = sStart + gameConfig.sweeperSize - 1;
    if (pos >= sStart && pos <= sEnd) return true;
  }
  return false;
}

function isStaticWallAt(pos) {
  if (gameConfig.randomWallsEnabled) {
    for (const w of randomWalls) {
      const half = Math.floor(w.size / 2);
      if (pos >= w.pos - half && pos <= w.pos + half) return true;
    }
  }
  return false;
}

function hasWallBetween(from, to) {
  if (from === to) return false;
  const dir = to > from ? 1 : -1;
  for (let p = from + dir; p !== to; p += dir) {
    if (isStaticWallAt(p)) return true;
  }
  return false;
}

function isSweeperAt(pos) {
  if (!gameConfig.sweeperEnabled) return false;
  const sStart = Math.floor(sweeper.pos);
  const sEnd = sStart + gameConfig.sweeperSize - 1;
  return pos >= sStart && pos <= sEnd;
}

function playersOverlap(a, b) {
  return a.pos === b.pos;
}

function getDelta(dir, pos) {
  const zone = getZone(pos);
  if (zone.name === 'left') {
    if (dir === 'up') return 1;
    if (dir === 'down') return -1;
    // Corner carry-over: just crossed in from top zone going right-to-left
    if (dir === 'left' && pos === ZONES[0].end) return -1;
  } else if (zone.name === 'top') {
    if (dir === 'right') return 1;
    if (dir === 'left') return -1;
    // Corner carry-over: just crossed in from left zone going left-to-right
    if (dir === 'up' && pos === ZONES[1].start) return 1;
    // Corner carry-over: just crossed in from right zone going right-to-left
    if (dir === 'up' && pos === ZONES[1].end) return -1;
  } else { // right zone
    if (dir === 'up') return -1;
    if (dir === 'down') return 1;
    // Corner carry-over: just crossed in from top zone going left-to-right
    if (dir === 'right' && pos === ZONES[2].start) return 1;
  }
  return 0;
}

// --- Collision: recursive push chain ---
function pushChain(pusher, dir, originId, visited = new Set()) {
  visited.add(pusher.id);
  for (const other of players.values()) {
    if (visited.has(other.id) || !other.alive) continue;
    if (!playersOverlap(pusher, other)) continue;
    const otherResisting = (other.lastDelta !== 0 && other.lastDelta === -dir);
    if (otherResisting) return true;
    const targetPos = wrapPos(pusher.pos + dir);
    if (isWallAt(targetPos)) return true; // wall blocks push
    const oldOtherPos = other.pos;
    other.pos = targetPos;
    const chainBlocked = pushChain(other, dir, originId, visited);
    if (chainBlocked) {
      other.pos = oldOtherPos;
      return true;
    }
  }
  return false;
}

function hitPlayer(player, attackerId, now) {
  if (gamePhase !== 'playing') return; // game already ended
  if (player.shieldActive) return; // shield absorbs the hit

  player.alive = false;
  player.respawnAt = now + gameConfig.respawnMs;
  player.shieldActive = false;
  const attacker = players.get(attackerId);
  if (attacker && attacker !== player) attacker.score++;

  const phrase = DEATH_PHRASES[Math.floor(Math.random() * DEATH_PHRASES.length)];
  speak(`${player.name}, ${phrase}`);

  // Check for winner
  if (attacker && attacker !== player && attacker.score >= gameConfig.winsNeeded) {
    gamePhase = 'victory';
    victoryStart = now;
    victoryColor = attacker.color;
    victoryPlayerName = attacker.name;
    speak(`${attacker.name} wins`);
    console.log(`${attacker.name} wins!`);
  }
}

// --- Input handling ---
function handleInput(playerId, input) {
  const player = players.get(playerId);
  if (!player) return;
  if (gamePhase !== 'playing') return; // only accept input during gameplay
  const now = Date.now();
  lastInputTime = now;

  if (input.type === 'move') {
    if (!player.alive) return;
    if (player.momentum > 0) return; // locked during portal momentum
    const wantsDash = input.shift && player.hasDash;
    const step = wantsDash ? gameConfig.dashDistance : 1;
    const delta = getDelta(input.dir, player.pos) * step;
    if (delta === 0) return;

    player.lastDelta = delta > 0 ? 1 : -1;
    player.lastMoveTime = now;
    let newPos = player.pos + delta;

    // Check if we walked off the edge
    if (newPos < 0 || newPos >= NUM_LEDS) {
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

    // Wall collision checks
    const hitWall = isWallAt(newPos);
    const hitLethalSweeper = gameConfig.sweeperEnabled && gameConfig.sweeperLethal && isSweeperAt(newPos);

    if (wantsDash && gameConfig.dashThroughWalls && (hitWall || isSweeperAt(newPos))) {
      // Dash through: find the far side of the wall/sweeper
      const dir = delta > 0 ? 1 : -1;
      let landPos = newPos;
      while (landPos >= 0 && landPos < NUM_LEDS && (isWallAt(landPos) || isSweeperAt(landPos))) {
        landPos += dir;
      }
      // Consume dash regardless
      player.hasDash = false;
      player.lastDashTime = now;
      if (landPos >= 0 && landPos < NUM_LEDS) {
        player.pos = landPos;
      }
      // If landing is off-strip, player just stays put (dash consumed)
    } else if (hitWall) {
      return;
    } else if (hitLethalSweeper) {
      hitPlayer(player, null, now);
      return;
    } else if (wantsDash) {
      player.pos = newPos;
      player.hasDash = false;
      player.lastDashTime = now;
    } else {
      const oldPos = player.pos;
      player.pos = newPos;
      const bumpDir = delta > 0 ? 1 : -1;
      const blocked = pushChain(player, bumpDir, playerId);
      if (blocked) player.pos = oldPos;
    }

    // Apply skating momentum (if configured)
    if (gameConfig.momentumTicks > 0) {
      player.momentum = gameConfig.momentumTicks;
      player.momentumDir = delta > 0 ? 1 : -1;
      player.lastMomentumTime = now;
    }

    // Push bombs when walking into them
    const moveDir = delta > 0 ? 1 : -1;
    for (const b of bombs) {
      if (b.exploding) continue;
      if (b.pos === player.pos) {
        b.pos = wrapPos(b.pos + moveDir);
      }
    }

    // Check power-up pickup
    for (let i = powerups.length - 1; i >= 0; i--) {
      if (powerups[i].pos === player.pos) {
        const pu = powerups.splice(i, 1)[0];
        if (pu.type === 'blast') {
          player.blastMaxCharges++;
          player.blastCharges++;
        }
      }
    }
  }

  if (input.type === 'bomb') {
    if (!player.alive) return;
    // Cooldown check — unlimited bombs, one at a time per cooldown
    if (player.bombLastUsed.length > 0 && now - player.bombLastUsed[player.bombLastUsed.length - 1] < gameConfig.bombCooldownMs) return;
    player.bombLastUsed = [now]; // reset to just this placement
    bombs.push({
      pos: player.pos,
      owner: playerId,
      placedAt: now,
      width: gameConfig.bombWidth,
      exploding: false,
      explodeFrame: 0,
    });
  }

  if (input.type === 'blast') {
    if (!player.alive) return;
    player.blastLastUsed = player.blastLastUsed.filter(t => now - t < gameConfig.pewPewCooldownMs);
    const available = player.blastMaxCharges - player.blastLastUsed.length;
    if (available <= 0) return;
    waves.push({ owner: playerId, center: player.pos, radius: 0, maxRadius: gameConfig.waveMaxRadius });
    player.blastLastUsed.push(now);
    speak(BLAST_PHRASES[Math.floor(Math.random() * BLAST_PHRASES.length)]);
  }

  if (input.type === 'shield') {
    if (!player.alive) return;
    if (player.shieldActive) return;
    if (now - player.shieldLastUsed < gameConfig.shieldCooldownMs) return;
    player.shieldActive = true;
    player.shieldActiveUntil = now + gameConfig.shieldDurationMs;
  }

  if (input.type === 'kick') {
    if (!player.alive) return;
    const dir = input.dir ? getDelta(input.dir, player.pos) : player.lastDelta;
    if (!dir) return;
    // Find a non-exploding bomb adjacent to the player
    const bomb = bombs.find(b => !b.exploding && Math.abs(b.pos - player.pos) <= 1);
    if (!bomb) return;
    bomb.kickDir = dir;
    bomb.kickProgress = 0;
  }

  // Legacy: browser 'fire' uses whatever the player last picked up (backwards compat)
  if (input.type === 'fire') {
    handleInput(playerId, { type: 'blast' });
  }

  if (input.type === 'cycle_color') {
    player.colorIndex = (player.colorIndex + 1) % PLAYER_COLORS.length;
    player.color = PLAYER_COLORS[player.colorIndex];
  }

  if (input.type === 'name') {
    player.name = String(input.name).slice(0, 12);
  }
}

// --- Game tick ---
function tick() {
  const now = Date.now();
  animTime += 0.03;

  // --- Victory phase ---
  if (gamePhase === 'victory') {
    const elapsed = now - victoryStart;
    if (elapsed >= gameConfig.victoryDurationMs) {
      resetGame();
      return;
    }
    // Victory animation: expanding waves in winner's color
    const pixels = new Array(NUM_LEDS).fill(null);
    const t = elapsed / 1000;
    const [cr, cg, cb] = victoryColor;
    for (let i = 0; i < NUM_LEDS; i++) {
      const wave1 = Math.sin(t * 6 + i * 0.15);
      const wave2 = Math.sin(t * 4 - i * 0.1);
      const bri = 0.3 + 0.7 * Math.max(0, (wave1 + wave2) / 2);
      pixels[i] = [Math.round(cr * bri), Math.round(cg * bri), Math.round(cb * bri)];
    }
    sendToWled(pixels);
    broadcast({
      type: 'state',
      gamePhase: 'victory',
      victoryColor,
      victoryPlayerName,
      players: serializePlayers(),
      waves: [], powerups: [], bombs: [], animTime,
    });
    return;
  }

  // --- Waiting phase ---
  if (gamePhase === 'waiting') {
    // Idle animation: gentle portal glow, rainbow idle
    const pixels = new Array(NUM_LEDS).fill(null);
    // Portal glow (dynamic positions)
    if (gameConfig.portalsEnabled) {
      const portalPulse = portalBlinking
        ? (Math.sin(animTime * 15) > 0 ? 0.6 : 0.1)
        : 0.3 + 0.3 * Math.sin(animTime * 4);
      const portalSwirl = 0.15 * Math.sin(animTime * 7);

      for (let d = 0; d < PORTAL_GLOW_SIZE; d++) {
        const fade = (1 - d / PORTAL_GLOW_SIZE) * portalPulse;
        const swirl2 = portalSwirl * (1 - d / PORTAL_GLOW_SIZE);

        // Portal A (orange)
        const aDir = portalA.pos === 0 ? 1 : -1;
        const aLed = portalA.pos + d * aDir;
        if (aLed >= 0 && aLed < NUM_LEDS) {
          pixels[aLed] = [Math.round(255*(fade+swirl2)), Math.round(140*(fade+swirl2)), Math.round(20*fade)];
        }
        // Portal B (blue)
        const bDir = portalB.pos === NUM_LEDS - 1 ? -1 : 1;
        const bLed = portalB.pos + d * bDir;
        if (bLed >= 0 && bLed < NUM_LEDS) {
          pixels[bLed] = [Math.round(20*fade), Math.round(100*(fade+swirl2)), Math.round(255*(fade+swirl2))];
        }
      }
    }
    // Gentle rainbow idle
    for (let i = PORTAL_GLOW_SIZE; i < NUM_LEDS - PORTAL_GLOW_SIZE; i++) {
      const hue = (animTime * 0.3 + i / NUM_LEDS) % 1;
      const bri = 0.05 + 0.03 * Math.sin(animTime * 2 + i * 0.1);
      const [r, g, b] = hslToRgb(hue, 1, bri);
      pixels[i] = [r, g, b];
    }
    sendToWled(pixels);
    broadcast({
      type: 'state',
      gamePhase: 'waiting',
      players: serializePlayers(),
      waves: [], powerups: [], bombs: [], animTime,
    });
    return;
  }

  // --- Playing phase ---
  // Idle timeout
  if (now - lastInputTime >= gameConfig.idleResetMs) {
    console.log('No input for 60s — resetting');
    speak('game over, no activity');
    resetGame();
    return;
  }

  // Spawn power-ups
  if (now - lastPowerupSpawn >= nextPowerupDelay && powerups.length < gameConfig.powerupMaxCount) {
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    powerups.push({ pos: randomPowerupPos(), type, spawnTime: now });
    lastPowerupSpawn = now;
    nextPowerupDelay = randomBetween(gameConfig.powerupSpawnMinMs, gameConfig.powerupSpawnMaxMs);
  }

  // Player updates
  for (const p of players.values()) {
    if (p.lastDelta !== 0 && now - p.lastMoveTime > 200) p.lastDelta = 0;
    if (!p.hasDash && p.alive && now - p.lastDashTime >= gameConfig.dashRegenMs) p.hasDash = true;
    // Portal momentum
    if (p.momentum > 0 && p.alive && now - p.lastMomentumTime >= gameConfig.momentumIntervalMs) {
      const nextPos = wrapPos(p.pos + p.momentumDir);
      if (isWallAt(nextPos)) {
        p.momentum = 0;
      } else if (gameConfig.sweeperEnabled && gameConfig.sweeperLethal && isSweeperAt(nextPos)) {
        hitPlayer(p, null, now);
        p.momentum = 0;
      } else {
        p.pos = nextPos;
        p.momentum--;
        p.lastMomentumTime = now;
      }
    }
    // Shield expiration
    if (p.shieldActive && now >= p.shieldActiveUntil) {
      p.shieldActive = false;
      p.shieldLastUsed = now;
    }
    if (!p.alive && now >= p.respawnAt) {
      p.alive = true;
      p.pos = spawnPos();
      p.lastDelta = 0;
      p.hasDash = true;
      p.shieldActive = false;
      p.bombMaxCharges = 1;
      p.bombCharges = 1;
      p.bombLastUsed = [];
      p.blastMaxCharges = 0;
      p.blastCharges = 0;
      p.blastLastUsed = [];
      p.shieldLastUsed = 0;
    }
  }

  // Random walls
  if (gameConfig.randomWallsEnabled) {
    if (randomWalls.length < gameConfig.randomWallMaxCount && now - lastRandomWallSpawn >= gameConfig.randomWallSpawnMs) {
      const allOccupied = [
        ...randomWalls.map(w => w.pos),
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

  // Sweeper wall
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
    } else {
      // Barrier mode: push players and bombs ahead of the sweeper
      let shouldReverse = false;
      const pushPos = sweeper.dir > 0 ? sEnd + 1 : sStart - 1;

      for (const p of players.values()) {
        if (!p.alive) continue;
        if (p.pos >= sStart && p.pos <= sEnd) {
          if (pushPos < 0 || pushPos >= NUM_LEDS || isWallAt(pushPos)) {
            shouldReverse = true;
            break;
          }
          p.pos = pushPos;
        }
      }

      if (!shouldReverse) {
        for (const b of bombs) {
          if (b.exploding) continue;
          if (b.pos >= sStart && b.pos <= sEnd) {
            if (pushPos < 0 || pushPos >= NUM_LEDS || isWallAt(pushPos)) {
              shouldReverse = true;
              break;
            }
            b.pos = pushPos;
          }
        }
      }

      if (shouldReverse) {
        sweeper.dir *= -1;
        sweeper.pos = Math.max(0, Math.min(NUM_LEDS - 1, sweeper.pos));
      }
    }

    // Destroy non-exploding bombs the sweeper passes over (lethal mode only)
    if (gameConfig.sweeperLethal) bombs = bombs.filter(b => {
      if (b.exploding) return true;
      return !(b.pos >= sStart && b.pos <= sEnd);
    });
  }

  // Moving portals
  if (gameConfig.portalsEnabled && gameConfig.portalsMoving) {
    const timeSinceMove = now - lastPortalMoveAt;
    const interval = gameConfig.portalMoveIntervalMs;

    portalBlinking = timeSinceMove >= interval - 2000;

    if (timeSinceMove >= interval) {
      if (gameConfig.portalsAnywhere) {
        // Pick two random positions with minimum distance of 20 LEDs apart
        const MIN_DIST = 20;
        for (let attempt = 0; attempt < 50; attempt++) {
          const a = Math.floor(Math.random() * NUM_LEDS);
          const b = Math.floor(Math.random() * NUM_LEDS);
          if (Math.abs(a - b) >= MIN_DIST && !isWallAt(a) && !isWallAt(b)) {
            portalA.pos = a;
            portalB.pos = b;
            break;
          }
        }
      } else {
        const available = PORTAL_LANDMARKS.filter(l => l !== portalA.pos && l !== portalB.pos);
        if (available.length >= 2) {
          const shuffled = available.sort(() => Math.random() - 0.5);
          portalA.pos = shuffled[0];
          portalB.pos = shuffled[1];
        } else if (available.length === 1) {
          const keepOld = Math.random() > 0.5 ? portalA.pos : portalB.pos;
          portalA.pos = available[0];
          portalB.pos = keepOld;
        }
      }
      lastPortalMoveAt = now;
      portalBlinking = false;
    }
  } else {
    portalBlinking = false;
  }

  // Advance waves
  for (const w of waves) {
    w.radius += gameConfig.waveSpeed;
    const r = Math.round(w.radius);
    for (const p of players.values()) {
      if (!p.alive || p.id === w.owner) continue;
      if (Math.abs(p.pos - w.center) >= r - 1 && Math.abs(p.pos - w.center) <= r + 1) {
        hitPlayer(p, w.owner, now);
      }
    }
    // Chip walls at the wave front
    if (gameConfig.pewPewDestroysWalls) {
      for (const frontPos of [w.center + r, w.center - r]) {
        if (frontPos < 0 || frontPos >= NUM_LEDS) continue;
        for (let i = randomWalls.length - 1; i >= 0; i--) {
          const rw = randomWalls[i];
          const half = Math.floor(rw.size / 2);
          if (frontPos >= rw.pos - half && frontPos <= rw.pos + half) {
            rw.size--;
            if (rw.size <= 0) randomWalls.splice(i, 1);
          }
        }
      }
    }
  }
  waves = waves.filter(w => w.radius <= w.maxRadius);

  // Advance bombs
  for (const b of bombs) {
    if (b.exploding) {
      b.explodeFrame++;
      // Check explosion hits (walls block the blast)
      const r = Math.round(b.explodeFrame * (gameConfig.bombExplodeRadius / gameConfig.bombExplodeFrames));
      for (const p of players.values()) {
        if (!p.alive) continue;
        if (Math.abs(p.pos - b.pos) <= r && !hasWallBetween(b.pos, p.pos)) {
          hitPlayer(p, b.owner, now);
        }
      }
      // Chip away at walls within explosion radius
      if (gameConfig.bombsDestroyWalls) {
        for (let i = randomWalls.length - 1; i >= 0; i--) {
          const w = randomWalls[i];
          const half = Math.floor(w.size / 2);
          for (let d = -half; d <= half; d++) {
            if (Math.abs((w.pos + d) - b.pos) <= r) {
              w.size--;
              if (w.size <= 0) randomWalls.splice(i, 1);
              break;
            }
          }
        }
      }
    } else {
      const elapsed = now - b.placedAt;
      const progress = Math.min(1, elapsed / gameConfig.bombFuseMs);
      b.width = Math.max(1, Math.round(gameConfig.bombWidth * (1 - progress)));
      if (elapsed >= gameConfig.bombFuseMs) {
        b.exploding = true;
        b.explodeFrame = 0;
      }
      // Kick sliding
      if (b.kickDir) {
        b.kickProgress = (b.kickProgress || 0) + gameConfig.bombKickSpeed;
        while (b.kickProgress >= 1) {
          b.kickProgress -= 1;
          const newPos = wrapPos(b.pos + b.kickDir);
          // Stop if it hits a wall
          if (isWallAt(newPos)) { b.kickDir = 0; break; }
          // Stop if it hits a player
          let hitPlayer = false;
          for (const p of players.values()) {
            if (p.alive && p.pos === newPos) {
              hitPlayer = true;
              break;
            }
          }
          if (hitPlayer) {
            b.kickDir = 0;
            break;
          }
          b.pos = newPos;
        }
      }
    }
  }
  // Spawn fire from god bombs when they finish exploding
  for (const b of bombs) {
    if (b.exploding && b.explodeFrame > gameConfig.bombExplodeFrames && (b.godBomb || gameConfig.bombLeavesFlames)) {
      for (let d = -gameConfig.flameSpread; d <= gameConfig.flameSpread; d++) {
        const fPos = b.pos + d;
        if (fPos >= 0 && fPos < NUM_LEDS) {
          fires.push({ pos: fPos, placedAt: now });
        }
      }
    }
  }
  bombs = bombs.filter(b => !(b.exploding && b.explodeFrame > gameConfig.bombExplodeFrames));

  // Expire fires and check fire collisions
  fires = fires.filter(f => now - f.placedAt < gameConfig.flameDurationMs);
  for (const f of fires) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      if (p.pos === f.pos) {
        hitPlayer(p, null, now);
      }
    }
  }

  // --- Render ---
  const pixels = new Array(NUM_LEDS).fill(null);

  // Portal glow (dynamic positions)
  if (gameConfig.portalsEnabled) {
    const portalPulse = portalBlinking
      ? (Math.sin(animTime * 15) > 0 ? 0.6 : 0.1)
      : 0.3 + 0.3 * Math.sin(animTime * 4);
    const portalSwirl = 0.15 * Math.sin(animTime * 7);

    for (let d = 0; d < PORTAL_GLOW_SIZE; d++) {
      const fade = (1 - d / PORTAL_GLOW_SIZE) * portalPulse;
      const swirl2 = portalSwirl * (1 - d / PORTAL_GLOW_SIZE);

      // Portal A (orange) — glow extends inward from portal position
      const aDir = portalA.pos === 0 ? 1 : -1;
      const aLed = portalA.pos + d * aDir;
      if (aLed >= 0 && aLed < NUM_LEDS) {
        pixels[aLed] = [Math.round(255*(fade+swirl2)), Math.round(140*(fade+swirl2)), Math.round(20*fade)];
      }
      // Portal B (blue) — glow extends inward
      const bDir = portalB.pos === NUM_LEDS - 1 ? -1 : 1;
      const bLed = portalB.pos + d * bDir;
      if (bLed >= 0 && bLed < NUM_LEDS) {
        pixels[bLed] = [Math.round(20*fade), Math.round(100*(fade+swirl2)), Math.round(255*(fade+swirl2))];
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
          pixels[led] = [200, 120, 20];
        }
      }
    }
  }

  // Sweeper wall
  if (gameConfig.sweeperEnabled) {
    const sStart = Math.floor(sweeper.pos);
    const sEnd = sStart + gameConfig.sweeperSize - 1;
    if (gameConfig.sweeperLethal) {
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 8);
      for (let i = sStart; i <= sEnd; i++) {
        if (i >= 0 && i < NUM_LEDS) {
          pixels[i] = [Math.round(255 * pulse), 0, 0];
        }
      }
    } else {
      for (let i = sStart; i <= sEnd; i++) {
        if (i >= 0 && i < NUM_LEDS) {
          pixels[i] = [100, 100, 90];
        }
      }
    }
  }

  // Power-ups: rainbow gradient oscillation
  for (const pu of powerups) {
    const hue = (animTime * 2 + pu.pos * 0.02) % 1;
    const shimmer = 0.6 + 0.4 * Math.sin(animTime * 5 + pu.pos * 0.5);
    const [r, g, b] = hslToRgb(hue, 1, 0.4 * shimmer);
    pixels[pu.pos] = [r, g, b];
    // Small glow around it
    for (let d = 1; d <= 1; d++) {
      const h2 = (hue + d * 0.15) % 1;
      const [r2, g2, b2] = hslToRgb(h2, 1, 0.15 * shimmer);
      if (pu.pos - d >= 0) pixels[pu.pos - d] = [r2, g2, b2];
      if (pu.pos + d < NUM_LEDS) pixels[pu.pos + d] = [r2, g2, b2];
    }
  }

  // Bombs
  for (const b of bombs) {
    if (b.exploding && b.explodeFrame > 0) {
      // Explosion: expanding white-red flash (stops at walls)
      // Note: skip explodeFrame 0 (render as ticking bomb) to avoid a sudden
      // pixel transition that crashes certain WLED firmware on ESP32
      const r = Math.round(b.explodeFrame * (gameConfig.bombExplodeRadius / gameConfig.bombExplodeFrames));
      const fade = 1 - b.explodeFrame / gameConfig.bombExplodeFrames;
      // Expand in each direction, stopping when hitting a wall
      for (const sign of [1, -1]) {
        for (let d = 0; d <= r; d++) {
          const led = b.pos + d * sign;
          if (led < 0 || led >= NUM_LEDS) break;
          if (d > 0 && isStaticWallAt(led)) break;
          const dist = d / (r + 1);
          const bri = fade * (1 - dist * 0.5);
          pixels[led] = [Math.round(255 * bri), Math.round(100 * bri * fade), 0];
        }
      }
    } else {
      // Ticking bomb: bright red center, dimmer red countdown pixels, all pulsing
      const half = Math.floor(b.width / 2);
      const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(animTime * 10));
      for (let d = -half; d <= half; d++) {
        const led = b.pos + d;
        if (led >= 0 && led < NUM_LEDS) {
          const bri = d === 0 ? 255 : 120;
          pixels[led] = [Math.round(bri * pulse), 0, 0];
        }
      }
    }
  }

  // Fires (Hand of God)
  for (const f of fires) {
    const age = (now - f.placedAt) / gameConfig.flameDurationMs;
    const fadeOut = 1 - age * 0.5; // fade to 50% brightness
    const flicker = 0.6 + 0.4 * Math.sin(animTime * 15 + f.pos * 3);
    const bri = fadeOut * flicker;
    if (f.pos >= 0 && f.pos < NUM_LEDS) {
      pixels[f.pos] = [Math.round(255 * bri), Math.round(80 * bri), 0];
    }
  }

  // Waves
  for (const w of waves) {
    const r = Math.round(w.radius);
    const hue = (animTime * 3) % 1;
    const owner = players.get(w.owner);
    const wColor = owner ? owner.color : [255, 255, 255];
    const [hr, hg, hb] = hslToRgb(hue, 1, 0.5);
    const mix = (a, b) => Math.round(a * 0.5 + b * 0.5);
    const c = [mix(hr, wColor[0]), mix(hg, wColor[1]), mix(hb, wColor[2])];
    const p1 = w.center + r;
    const p2 = w.center - r;
    if (p1 >= 0 && p1 < NUM_LEDS) pixels[p1] = c;
    if (p2 >= 0 && p2 < NUM_LEDS) pixels[p2] = c;
  }

  // Explosions (visual only, from old list — kept for posterity but bombs handle their own)

  // Players
  for (const p of players.values()) {
    if (!p.alive) {
      const flash = Math.sin(animTime * 10) > 0;
      if (flash) pixels[p.pos] = [80, 0, 0];
      continue;
    }
    // Shield glow
    if (p.shieldActive) {
      for (let d = -1; d <= 1; d++) {
        const led = p.pos + d;
        if (led >= 0 && led < NUM_LEDS && d !== 0) {
          const shimmer = 0.5 + 0.5 * Math.sin(animTime * 6 + d);
          pixels[led] = [
            Math.round(200 * shimmer),
            Math.round(220 * shimmer),
            Math.round(255 * shimmer),
          ];
        }
      }
    }
    // Player pixel (pulse when no powerup, solid when armed)
    const recharging = !p.hasDash;
    const pulse = recharging ? 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(animTime * 8)) : 1;
    pixels[p.pos] = [
      Math.round(p.color[0] * pulse),
      Math.round(p.color[1] * pulse),
      Math.round(p.color[2] * pulse),
    ];
  }

  sendToWled(pixels);
  broadcast({
    type: 'state',
    gamePhase: 'playing',
    players: serializePlayers(),
    waves: serializeWaves(),
    powerups: powerups.map(p => ({ pos: p.pos, type: p.type })),
    bombs: bombs.map(b => ({ pos: b.pos, owner: b.owner, width: b.width, exploding: b.exploding, explodeFrame: b.explodeFrame, godBomb: b.godBomb || false })),
    fires: fires.map(f => ({ pos: f.pos, age: (Date.now() - f.placedAt) / gameConfig.flameDurationMs })),
    randomWalls: randomWalls.map(w => ({ pos: w.pos, size: w.size })),
    sweeper: gameConfig.sweeperEnabled ? { pos: Math.floor(sweeper.pos), size: gameConfig.sweeperSize, lethal: gameConfig.sweeperLethal } : null,
    portalA: portalA.pos,
    portalB: portalB.pos,
    portalBlinking,
    animTime,
  });
}

function serializePlayers() {
  const now = Date.now();
  return [...players.values()].map(p => {
    const bombReady = p.bombLastUsed.length === 0 || now - p.bombLastUsed[p.bombLastUsed.length - 1] >= gameConfig.bombCooldownMs;
    const blastReady = p.blastMaxCharges - p.blastLastUsed.filter(t => now - t < gameConfig.pewPewCooldownMs).length;
    const shieldReady = !p.shieldActive && (now - p.shieldLastUsed >= gameConfig.shieldCooldownMs);
    return {
      id: p.id, pos: p.pos, color: p.color, width: p.width,
      hasDash: p.hasDash, alive: p.alive, score: p.score, name: p.name,
      shieldActive: p.shieldActive,
      bombReady,
      blastCharges: blastReady, blastMax: p.blastMaxCharges,
      shieldReady,
    };
  });
}

function serializeWaves() {
  return waves.map(w => ({ owner: w.owner, center: w.center, radius: w.radius, maxRadius: w.maxRadius }));
}

// --- HSL helper ---
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// --- WebSocket server ---
const clients = new Map();

let lastExternalBuf = null;

// Binary protocol for external server:
//
// Header (2 bytes):
//   [0] gamePhase: 0=waiting, 1=playing, 2=victory
//   [1] hi nibble = playerCount (0-4), lo nibble = waveCount (0-15)
//
// Per player (8 bytes):
//   [0] pos         [1] colorR  [2] colorG  [3] colorB
//   [4] flags (bit0=alive, bit1=shieldActive, bit2=hasDash)
//   [5] score       [6] id      [7] blastCharges | blastMax<<4
//
// Per wave (4 bytes):
//   [0] center  [1] radius  [2] owner  [3] maxRadius
//
// Then:
//   [1 byte] bombCount
//   Per bomb (4 bytes): [0] pos  [1] width  [2] explodeFrame  [3] flags (bit0=exploding, bit1=godBomb, bits4-7=owner)
//
//   [1 byte] powerupCount
//   Per powerup (1 byte): pos
//
//   [1 byte] fireCount
//   Per fire (2 bytes): [0] pos  [1] age (0-255 scaled from 0.0-1.0)
//
// If gamePhase == 2 (victory), appended:
//   [3 bytes] victoryColor RGB
//   [1 byte] nameLen
//   [nameLen bytes] victoryPlayerName (UTF-8)

function packStateForExternal(msg) {
  const players = msg.players || [];
  const waves = msg.waves || [];
  const bombs = msg.bombs || [];
  const powerups = msg.powerups || [];
  const fires = msg.fires || [];

  const playerCount = Math.min(players.length, 4);
  const waveCount = Math.min(waves.length, 15);
  const bombCount = Math.min(bombs.length, 255);
  const powerupCount = Math.min(powerups.length, 255);
  const fireCount = Math.min(fires.length, 255);

  const phase = msg.gamePhase === 'waiting' ? 0 : msg.gamePhase === 'playing' ? 1 : 2;
  const victoryName = phase === 2 ? (msg.victoryPlayerName || '') : '';
  const nameBytes = Buffer.from(victoryName, 'utf8');

  const randomWalls = msg.randomWalls || [];
  const sweeperMsg = msg.sweeper || null;
  const portalA = { pos: msg.portalA !== undefined ? msg.portalA : 0 };
  const portalB = { pos: msg.portalB !== undefined ? msg.portalB : 0 };

  const size = 2
    + playerCount * 8
    + waveCount * 4
    + 1 + bombCount * 4
    + 1 + powerupCount
    + 1 + fireCount * 2
    + 1 + randomWalls.length * 2     // random walls
    + 1 + (sweeperMsg ? 2 : 0)       // sweeper
    + 2                               // portal positions
    + (phase === 2 ? 3 + 1 + nameBytes.length : 0);

  const buf = Buffer.alloc(size);
  let off = 0;

  // Header
  buf[off++] = phase;
  buf[off++] = (playerCount << 4) | waveCount;

  // Players
  for (let i = 0; i < playerCount; i++) {
    const p = players[i];
    buf[off++] = p.pos & 0xFF;
    buf[off++] = p.color[0];
    buf[off++] = p.color[1];
    buf[off++] = p.color[2];
    buf[off++] = (p.alive ? 1 : 0) | (p.shieldActive ? 2 : 0) | (p.hasDash ? 4 : 0);
    buf[off++] = p.score & 0xFF;
    buf[off++] = p.id & 0xFF;
    buf[off++] = (p.blastCharges & 0x0F) | ((p.blastMax & 0x0F) << 4);
  }

  // Waves
  for (let i = 0; i < waveCount; i++) {
    const w = waves[i];
    buf[off++] = w.center & 0xFF;
    buf[off++] = Math.round(w.radius) & 0xFF;
    buf[off++] = (w.owner || 0) & 0xFF;
    buf[off++] = w.maxRadius & 0xFF;
  }

  // Bombs
  buf[off++] = bombCount;
  for (let i = 0; i < bombCount; i++) {
    const b = bombs[i];
    buf[off++] = b.pos & 0xFF;
    buf[off++] = b.width & 0xFF;
    buf[off++] = b.explodeFrame & 0xFF;
    buf[off++] = (b.exploding ? 1 : 0) | (b.godBomb ? 2 : 0) | (((b.owner || 0) & 0x0F) << 4);
  }

  // Powerups
  buf[off++] = powerupCount;
  for (let i = 0; i < powerupCount; i++) {
    buf[off++] = powerups[i].pos & 0xFF;
  }

  // Fires
  buf[off++] = fireCount;
  for (let i = 0; i < fireCount; i++) {
    const f = fires[i];
    buf[off++] = f.pos & 0xFF;
    buf[off++] = Math.round(Math.min(1, Math.max(0, f.age)) * 255);
  }

  // Random walls
  buf[off++] = randomWalls.length & 0xFF;
  for (const w of randomWalls) {
    buf[off++] = w.pos & 0xFF;
    buf[off++] = w.size & 0xFF;
  }

  // Sweeper
  const sweeperFlags = (sweeperMsg ? 1 : 0) | (sweeperMsg && sweeperMsg.lethal ? 2 : 0);
  buf[off++] = sweeperFlags;
  if (sweeperMsg) {
    buf[off++] = Math.floor(sweeperMsg.pos) & 0xFF;
    buf[off++] = sweeperMsg.size & 0xFF;
  }

  // Portal positions
  buf[off++] = portalA.pos & 0xFF;
  buf[off++] = portalB.pos & 0xFF;

  // Victory
  if (phase === 2) {
    const vc = msg.victoryColor || [255, 255, 255];
    buf[off++] = vc[0];
    buf[off++] = vc[1];
    buf[off++] = vc[2];
    buf[off++] = nameBytes.length;
    nameBytes.copy(buf, off);
    off += nameBytes.length;
  }

  return buf;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === 1) ws.send(data);
  }
  // Forward binary to external server only when spectators are watching and state changes
  if (externalWs && externalWs.readyState === 1 && externalSpectatorCount > 0) {
    const buf = packStateForExternal(msg);
    if (!lastExternalBuf || !buf.equals(lastExternalBuf)) {
      lastExternalBuf = buf;
      externalWs.send(buf);
    }
  }
}

// --- External server relay ---
const EXTERNAL_SERVER_URL = process.env.EXTERNAL_SERVER_URL || '';
const EXTERNAL_SERVER_KEY = process.env.EXTERNAL_SERVER_KEY || 'bledsport';
let externalSpectatorCount = 0;
let externalWs = null;
let externalReconnectTimer = null;

function connectExternal() {
  if (!EXTERNAL_SERVER_URL) return;
  const url = `${EXTERNAL_SERVER_URL}/ws/game?key=${EXTERNAL_SERVER_KEY}`;
  console.log(`Connecting to external server: ${EXTERNAL_SERVER_URL}`);
  try {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      externalWs = ws;
      console.log('External server connected');
    };
    ws.onmessage = (e) => {
      try {
        const input = JSON.parse(e.data);
        if (input.type === 'spectators') {
          externalSpectatorCount = input.count || 0;
          console.log(`External spectators: ${externalSpectatorCount}`);
          if (externalSpectatorCount > 0) lastExternalBuf = null; // force next send
          return;
        }
        if (input.type === 'god_bomb') {
          if (!gameConfig.spectatorInteraction) return;
          if (gamePhase !== 'playing') return;
          const pos = Math.round(input.pos);
          if (pos < 0 || pos >= NUM_LEDS) return;
          bombs.push({
            pos,
            owner: null,
            placedAt: Date.now(),
            width: gameConfig.bombWidth,
            exploding: false,
            explodeFrame: 0,
            godBomb: true,
          });
        }
      } catch {}
    };
    ws.onclose = () => {
      externalWs = null;
      externalSpectatorCount = 0;
      console.log('External server disconnected — reconnecting in 3s');
      clearTimeout(externalReconnectTimer);
      externalReconnectTimer = setTimeout(connectExternal, 3000);
    };
    ws.onerror = () => { ws.close(); };
  } catch (err) {
    console.log('External server connection error:', err.message);
    clearTimeout(externalReconnectTimer);
    externalReconnectTimer = setTimeout(connectExternal, 3000);
  }
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 80,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file('./index.html'));
    }
    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      // Start as spectator — no player until they send { type: 'join' }
      clients.set(ws, null);
      ws.send(JSON.stringify({ type: 'spectating' }));
      // Send full config state to new client
      ws.send(JSON.stringify({
        type: 'config_state',
        config: gameConfig,
        schema: CONFIG_SCHEMA,
        presets: getPresetList(),
        activePreset,
      }));
      console.log('Spectator connected');
    },
    message(ws, msg) {
      try {
        const input = JSON.parse(msg);

        // --- Config message handlers ---
        if (input.type === 'config_update') {
          applyConfigUpdate(input.category, input.key, input.value);
          broadcastConfig();
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
          // Delete all non-classic presets
          const presets = getPresetList();
          for (const name of presets) {
            if (name !== 'classic') deletePreset(name);
          }
          loadPreset('classic');
          broadcastConfig();
          return;
        }

        // --- Game message handlers ---
        if (input.type === 'join') {
          if (gamePhase === 'victory') return;
          if (clients.get(ws)) return; // already joined
          if (players.size >= 4) return; // max 4 players
          const id = nextPlayerId++;
          const player = createPlayer(id);
          players.set(id, player);
          clients.set(ws, id);
          ws.send(JSON.stringify({ type: 'welcome', id, color: player.color }));
          console.log(`Player ${id} joined (${players.size} total)`);
          speak(`${player.name} has joined`);
          startGame(); // restart round with all current players
          return;
        }
        if (input.type === 'start_game') {
          if (gamePhase === 'waiting' && players.size >= 1) startGame();
          return;
        }
        // Hand of God — spectators only
        if (input.type === 'god_bomb') {
          if (!gameConfig.spectatorInteraction) return;
          const id = clients.get(ws);
          if (id) return; // players can't use this
          if (gamePhase !== 'playing') return;
          const pos = Math.round(input.pos);
          if (pos < 0 || pos >= NUM_LEDS) return;
          bombs.push({
            pos,
            owner: null,
            placedAt: Date.now(),
            width: gameConfig.bombWidth,
            exploding: false,
            explodeFrame: 0,
            godBomb: true,
          });
          speak(GOD_PHRASES[Math.floor(Math.random() * GOD_PHRASES.length)]);
          return;
        }
        const id = clients.get(ws);
        if (!id) return; // spectator, ignore game inputs
        handleInput(id, input);
      } catch {}
    },
    close(ws) {
      const id = clients.get(ws);
      if (id) {
        players.delete(id);
        console.log(`Player ${id} left (${players.size} total)`);
      }
      clients.delete(ws);
    },
  },
});

// --- Gamepad support ---
// Collect all --gamepad args (supports multiple controller types)
const gamepadMappings = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--gamepad' && process.argv[i + 1]) {
    gamepadMappings.push(process.argv[++i]);
  }
}

if (gamepadMappings.length > 0) {
  const { discoverGamepads } = require('./gamepad.ts');

  // Discover pads for each mapping, assign globally unique indices
  const allPads = [];
  for (const mappingPath of gamepadMappings) {
    const pads = discoverGamepads(mappingPath);
    if (pads.length === 0) {
      console.log('No gamepads found for mapping:', mappingPath);
    }
    for (const pad of pads) {
      pad.index = allPads.length; // globally unique index
      allPads.push(pad);
    }
  }

  // Track which pad index is bound to which player id (global for resetGame access)
  globalThis.padPlayers = new Map();
  const padPlayers = globalThis.padPlayers;
  const padDpadIntervals = new Map(); // pad.index -> { dir: intervalId }

  function startDpadRepeat(pad, dir) {
    let intervals = padDpadIntervals.get(pad.index);
    if (!intervals) { intervals = {}; padDpadIntervals.set(pad.index, intervals); }
    if (intervals[dir]) return; // already repeating

    const playerId = padPlayers.get(pad.index);
    if (!playerId) return;

    // Fire immediately
    handleInput(playerId, { type: 'move', dir, shift: false });
    // Then repeat
    intervals[dir] = setInterval(() => {
      const pid = padPlayers.get(pad.index);
      if (pid) handleInput(pid, { type: 'move', dir, shift: false });
    }, TICK_MS());
  }

  function stopDpadRepeat(pad, dir) {
    const intervals = padDpadIntervals.get(pad.index);
    if (!intervals || !intervals[dir]) return;
    clearInterval(intervals[dir]);
    delete intervals[dir];
  }

  for (const pad of allPads) {
    console.log(`Gamepad ${pad.index} (${pad.mapping.device.product}) ready — press Start to join`);

    pad.on('press', (button) => {
      const playerId = padPlayers.get(pad.index);

      // Start = join and restart round with all players
      if (button === 'start') {
        if (gamePhase === 'victory') return;
        if (!playerId) {
          if (players.size >= 4) return; // max 4 players
          // Join
          const id = nextPlayerId++;
          const player = createPlayer(id);
          player.name = `Pad${pad.index + 1}`;
          players.set(id, player);
          padPlayers.set(pad.index, id);
          console.log(`Gamepad ${pad.index} joined as Player ${id} (${players.size} total)`);
          speak(`${player.name} has joined`);
          startGame(); // restart round with all current players
        }
        return;
      }

      if (!playerId) return; // not joined yet

      // Select = cycle color
      if (button === 'select') handleInput(playerId, { type: 'cycle_color' });

      // D-pad → move with hold repeat
      if (button === 'dpad_up') startDpadRepeat(pad, 'up');
      if (button === 'dpad_down') startDpadRepeat(pad, 'down');
      if (button === 'dpad_left') startDpadRepeat(pad, 'left');
      if (button === 'dpad_right') startDpadRepeat(pad, 'right');

      // A = blast
      if (button === 'a') handleInput(playerId, { type: 'blast' });

      // B = bomb
      if (button === 'b') handleInput(playerId, { type: 'bomb' });

      // X = shield
      if (button === 'x') handleInput(playerId, { type: 'shield' });

      // Y = kick bomb in held d-pad direction
      if (button === 'y') {
        const held = pad.state.buttons;
        const dir = held.dpad_up ? 'up' : held.dpad_down ? 'down' : held.dpad_left ? 'left' : held.dpad_right ? 'right' : null;
        handleInput(playerId, { type: 'kick', dir });
      }

      // L or R = dash in held d-pad direction
      if (button === 'l' || button === 'r') {
        const held = pad.state.buttons;
        const dir = held.dpad_up ? 'up' : held.dpad_down ? 'down' : held.dpad_left ? 'left' : held.dpad_right ? 'right' : null;
        if (dir) handleInput(playerId, { type: 'move', dir, shift: true });
      }
    });

    pad.on('release', (button) => {
      // Stop d-pad repeat on release
      if (button === 'dpad_up') stopDpadRepeat(pad, 'up');
      if (button === 'dpad_down') stopDpadRepeat(pad, 'down');
      if (button === 'dpad_left') stopDpadRepeat(pad, 'left');
      if (button === 'dpad_right') stopDpadRepeat(pad, 'right');
    });

    pad.on('disconnect', () => {
      // Clean up all repeat intervals
      const intervals = padDpadIntervals.get(pad.index);
      if (intervals) {
        for (const dir of Object.keys(intervals)) clearInterval(intervals[dir]);
        padDpadIntervals.delete(pad.index);
      }
      const playerId = padPlayers.get(pad.index);
      if (playerId) {
        players.delete(playerId);
        padPlayers.delete(pad.index);
        console.log(`Gamepad ${pad.index} disconnected, Player ${playerId} removed`);
      }
    });
  }
}

setInterval(tick, TICK_MS());
connectWled();
connectExternal();
console.log(`LED Arch Game server running on http://localhost:${server.port}`);
