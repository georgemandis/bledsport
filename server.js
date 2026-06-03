// LED Arch Game — multiplayer server
// Run: bun server.js

const NUM_LEDS = 192;
const WAVE_SPEED = 2;
const WAVE_MAX = 12;
const PLAYER_WIDTH = 1;
const DASH_REGEN_MS = 3000;
const TICK_MS = 33; // ~30fps
const RESPAWN_MS = 2000;

// Power-up spawning
const POWERUP_SPAWN_MIN = 4000;  // ms
const POWERUP_SPAWN_MAX = 8000;
const POWERUP_MAX = 5;           // max on field at once
const POWERUP_TYPES = ['blast', 'bomb', 'shield'];

// Bomb config
const BOMB_WIDTH = 5;
const BOMB_FUSE_MS = 3000;       // shrinks over this time
const BOMB_EXPLODE_RADIUS = 8;
const BOMB_EXPLODE_FRAMES = 10;

const PLAYER_COLORS = [
  [0, 200, 255],   // cyan
  [255, 80, 200],  // pink
  [0, 255, 80],    // green
  [255, 200, 0],   // gold
];

const ZONES = [
  { name: 'left',  start: 0,   end: 57  },
  { name: 'top',   start: 58,  end: 134 },
  { name: 'right', start: 135, end: 191 },
];

// --- Debug mode ---
const DEBUG = process.argv.includes('--debug');
if (DEBUG) console.log('DEBUG MODE: WLED output disabled');

// --- WLED connection ---
const WLED_WS_URL = 'ws://10.100.3.132/ws';
const LED_START = 1;
let wledWs = null;
let wledReady = false;

function connectWled() {
  if (DEBUG) return;
  try {
    wledWs = new WebSocket(WLED_WS_URL);
    wledWs.onopen = () => { wledReady = true; console.log('WLED connected'); };
    wledWs.onclose = () => { wledReady = false; setTimeout(connectWled, 2000); };
    wledWs.onerror = () => { wledReady = false; wledWs.close(); };
  } catch (e) {
    console.log('WLED connection failed, retrying...');
    setTimeout(connectWled, 2000);
  }
}

function sendToWled(pixels) {
  if (!wledWs || !wledReady) return;
  const colors = [0, NUM_LEDS, '000000'];
  for (let i = 0; i < NUM_LEDS; i++) {
    const c = pixels[i];
    if (!c) continue;
    const hex = c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
    colors.push(i, hex);
  }
  wledWs.send(JSON.stringify({
    on: true, bri: 255, transition: 0, ps: -1, pl: -1, lor: 1,
    seg: [
      { id: 0, start: LED_START, stop: LED_START + NUM_LEDS, frz: true, fx: 0, i: colors },
      { id: 1, stop: 0 }
    ]
  }));
}

// --- Game state ---
let nextPlayerId = 1;
const players = new Map();
let waves = [];
let powerups = [];  // {pos, type, spawnTime}
let bombs = [];     // {pos, owner, placedAt, width, exploding, explodeFrame}
let explosions = []; // {center, radius, frame, maxFrames}
let animTime = 0;
let lastPowerupSpawn = Date.now();
let nextPowerupDelay = randomBetween(POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function spawnPos() {
  const taken = [...players.values()].map(p => p.pos);
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
    width: PLAYER_WIDTH,
    alive: true,
    respawnAt: 0,
    score: 0,
    name: `P${id}`,
    lastDelta: 0,
    lastMoveTime: 0,
    hasDash: true,
    lastDashTime: 0,
    // Power-ups (picked up, one at a time)
    powerup: null,  // 'blast' | 'bomb' | 'shield' | null
    hasShield: false,
  };
}

function getZone(pos) {
  return ZONES.find(z => pos >= z.start && pos <= z.end) || ZONES[0];
}

function playersOverlap(a, b) {
  return a.pos === b.pos;
}

function getDelta(dir, pos) {
  const zone = getZone(pos);
  if (zone.name === 'left') {
    if (dir === 'up') return 1;
    if (dir === 'down') return -1;
  } else if (zone.name === 'top') {
    if (dir === 'right') return 1;
    if (dir === 'left') return -1;
  } else {
    if (dir === 'up') return -1;
    if (dir === 'down') return 1;
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
    const targetPos = pusher.pos + dir;
    const clampedPos = Math.max(0, Math.min(NUM_LEDS - 1, targetPos));
    if (clampedPos !== targetPos) return true;
    const oldOtherPos = other.pos;
    other.pos = clampedPos;
    const chainBlocked = pushChain(other, dir, originId, visited);
    if (chainBlocked) {
      other.pos = oldOtherPos;
      return true;
    }
  }
  return false;
}

// --- Hit a player (from wave or explosion) ---
function hitPlayer(player, attackerId, now) {
  if (player.hasShield) {
    player.hasShield = false;
    return; // shield absorbs the hit
  }
  player.alive = false;
  player.respawnAt = now + RESPAWN_MS;
  player.powerup = null;
  player.hasShield = false;
  const attacker = players.get(attackerId);
  if (attacker) attacker.score++;
}

// --- Input handling ---
function handleInput(playerId, input) {
  const player = players.get(playerId);
  if (!player) return;

  if (input.type === 'move') {
    if (!player.alive) return;
    const wantsDash = input.shift && player.hasDash;
    const step = wantsDash ? 5 : 1;
    const delta = getDelta(input.dir, player.pos) * step;
    if (delta === 0) return;

    player.lastDelta = delta > 0 ? 1 : -1;
    player.lastMoveTime = Date.now();
    const newPos = Math.max(0, Math.min(NUM_LEDS - 1, player.pos + delta));

    if (wantsDash) {
      player.pos = newPos;
      player.hasDash = false;
      player.lastDashTime = Date.now();
    } else {
      const oldPos = player.pos;
      player.pos = newPos;
      const bumpDir = delta > 0 ? 1 : -1;
      const blocked = pushChain(player, bumpDir, playerId);
      if (blocked) player.pos = oldPos;
    }

    // Check power-up pickup
    for (let i = powerups.length - 1; i >= 0; i--) {
      if (powerups[i].pos === player.pos) {
        const pu = powerups.splice(i, 1)[0];
        if (pu.type === 'shield') {
          player.hasShield = true;
        } else {
          player.powerup = pu.type;
        }
      }
    }
  }

  if (input.type === 'fire') {
    if (!player.alive || !player.powerup) return;
    if (player.powerup === 'blast') {
      waves.push({ owner: playerId, center: player.pos, radius: 0, maxRadius: WAVE_MAX });
      player.powerup = null;
    } else if (player.powerup === 'bomb') {
      bombs.push({
        pos: player.pos,
        owner: playerId,
        placedAt: Date.now(),
        width: BOMB_WIDTH,
        exploding: false,
        explodeFrame: 0,
      });
      player.powerup = null;
    }
  }

  if (input.type === 'name') {
    player.name = String(input.name).slice(0, 12);
  }
}

// --- Game tick ---
function tick() {
  const now = Date.now();
  animTime += 0.03;

  // Spawn power-ups
  if (now - lastPowerupSpawn >= nextPowerupDelay && powerups.length < POWERUP_MAX) {
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    powerups.push({ pos: randomPowerupPos(), type, spawnTime: now });
    lastPowerupSpawn = now;
    nextPowerupDelay = randomBetween(POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
  }

  // Player updates
  for (const p of players.values()) {
    if (p.lastDelta !== 0 && now - p.lastMoveTime > 200) p.lastDelta = 0;
    if (!p.hasDash && p.alive && now - p.lastDashTime >= DASH_REGEN_MS) p.hasDash = true;
    if (!p.alive && now >= p.respawnAt) {
      p.alive = true;
      p.pos = spawnPos();
      p.lastDelta = 0;
      p.hasDash = true;
      p.powerup = null;
      p.hasShield = false;
    }
  }

  // Advance waves
  for (const w of waves) {
    w.radius += WAVE_SPEED;
    const r = Math.round(w.radius);
    for (const p of players.values()) {
      if (!p.alive || p.id === w.owner) continue;
      if (Math.abs(p.pos - w.center) >= r - 1 && Math.abs(p.pos - w.center) <= r + 1) {
        hitPlayer(p, w.owner, now);
      }
    }
  }
  waves = waves.filter(w => w.radius <= w.maxRadius);

  // Advance bombs
  for (const b of bombs) {
    if (b.exploding) {
      b.explodeFrame++;
      // Check explosion hits
      const r = Math.round(b.explodeFrame * (BOMB_EXPLODE_RADIUS / BOMB_EXPLODE_FRAMES));
      for (const p of players.values()) {
        if (!p.alive) continue;
        if (Math.abs(p.pos - b.pos) <= r) {
          hitPlayer(p, b.owner, now);
        }
      }
    } else {
      const elapsed = now - b.placedAt;
      const progress = Math.min(1, elapsed / BOMB_FUSE_MS);
      b.width = Math.max(1, Math.round(BOMB_WIDTH * (1 - progress)));
      if (elapsed >= BOMB_FUSE_MS) {
        b.exploding = true;
        b.explodeFrame = 0;
      }
    }
  }
  bombs = bombs.filter(b => !(b.exploding && b.explodeFrame > BOMB_EXPLODE_FRAMES));

  // --- Render ---
  const pixels = new Array(NUM_LEDS).fill(null);

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
    if (b.exploding) {
      // Explosion: expanding white-red flash
      const r = Math.round(b.explodeFrame * (BOMB_EXPLODE_RADIUS / BOMB_EXPLODE_FRAMES));
      const fade = 1 - b.explodeFrame / BOMB_EXPLODE_FRAMES;
      for (let d = -r; d <= r; d++) {
        const led = b.pos + d;
        if (led >= 0 && led < NUM_LEDS) {
          const dist = Math.abs(d) / (r + 1);
          const bri = fade * (1 - dist * 0.5);
          pixels[led] = [Math.round(255 * bri), Math.round(100 * bri * fade), 0];
        }
      }
    } else {
      // Ticking bomb: pulsing red, shrinking
      const half = Math.floor(b.width / 2);
      const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(animTime * 10));
      for (let d = -half; d <= half; d++) {
        const led = b.pos + d;
        if (led >= 0 && led < NUM_LEDS) {
          const edge = 1 - Math.abs(d) / (half + 1) * 0.5;
          pixels[led] = [Math.round(220 * pulse * edge), 0, 0];
        }
      }
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
    if (p.hasShield) {
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
    players: serializePlayers(),
    waves: serializeWaves(),
    powerups: powerups.map(p => ({ pos: p.pos, type: p.type })),
    bombs: bombs.map(b => ({ pos: b.pos, owner: b.owner, width: b.width, exploding: b.exploding, explodeFrame: b.explodeFrame })),
    animTime,
  });
}

function serializePlayers() {
  return [...players.values()].map(p => ({
    id: p.id, pos: p.pos, color: p.color, width: p.width,
    hasDash: p.hasDash, alive: p.alive, score: p.score, name: p.name,
    powerup: p.powerup, hasShield: p.hasShield,
  }));
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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const server = Bun.serve({
  port: 3000,
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
      const id = nextPlayerId++;
      const player = createPlayer(id);
      players.set(id, player);
      clients.set(ws, id);
      ws.send(JSON.stringify({ type: 'welcome', id, color: player.color }));
      console.log(`Player ${id} joined (${players.size} total)`);
    },
    message(ws, msg) {
      const id = clients.get(ws);
      if (!id) return;
      try { handleInput(id, JSON.parse(msg)); } catch {}
    },
    close(ws) {
      const id = clients.get(ws);
      if (id) {
        players.delete(id);
        clients.delete(ws);
        console.log(`Player ${id} left (${players.size} total)`);
      }
    },
  },
});

setInterval(tick, TICK_MS);
connectWled();
console.log(`LED Arch Game server running on http://localhost:${server.port}`);
