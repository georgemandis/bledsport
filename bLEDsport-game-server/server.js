// LED Arch Game — multiplayer server
// Run: bun server.js [--debug] [--gamepad ./innext-controller.json]

const NUM_LEDS = 192;
const WAVE_SPEED = 2;
const WAVE_MAX = 12;
const PLAYER_WIDTH = 1;
const DASH_REGEN_MS = 3000;
const TICK_MS = 16; // ~60fps
const RESPAWN_MS = 2000;

// Ability cooldowns
const BOMB_COOLDOWN_MS = 1000;
const BLAST_COOLDOWN_MS = 5000;
const SHIELD_DURATION_MS = 1000;
const SHIELD_COOLDOWN_MS = 5000;

// Power-up spawning
const POWERUP_SPAWN_MIN = 4000;  // ms
const POWERUP_SPAWN_MAX = 8000;
const POWERUP_MAX = 1;           // max on field at once
const POWERUP_TYPES = ['blast'];

// Bomb config
const BOMB_WIDTH = 5;
const BOMB_FUSE_MS = 3000;       // shrinks over this time
const BOMB_EXPLODE_RADIUS = 8;
const BOMB_EXPLODE_FRAMES = 10;
const BOMB_KICK_SPEED = 0.5;     // LEDs per tick (half player speed)

// Hand of God config
const GOD_FIRE_DURATION_MS = 3000; // fire lasts 3 seconds
const GOD_FIRE_SPREAD = 1;         // 1 pixel each side = 3 total pixels

// Portal config
const PORTAL_GLOW_SIZE = 3;      // LEDs of glow at each end
const PORTAL_MOMENTUM = 4;       // forced moves after teleporting
const PORTAL_MOMENTUM_MS = 60;   // ms between forced moves

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

// --- Speech (espeak-ng, Pi only) ---
const { execFile } = require('child_process');
const HAS_ESPEAK = (() => {
  try { require('child_process').execFileSync('which', ['espeak-ng']); return true; }
  catch { return false; }
})();
if (HAS_ESPEAK) console.log('espeak-ng detected — audio enabled');



function speak(text) {
  if (!HAS_ESPEAK) return;
  const pitch = 20 + Math.floor(Math.random() * 70);  // 20-90
  const speed = 120 + Math.floor(Math.random() * 100); // 120-220 wpm
  const variant = Math.floor(Math.random() * 5) + 1;
  execFile('espeak-ng', [
    '-p', String(pitch),
    '-s', String(speed),
    '-v', `en+m${variant}`,
    text,
  ], (err) => { if (err) {} }); // fire and forget
}

// --- Music (mpg123) ---
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
let mpg123 = null;
let hasMpg123 = false;

function initMusic() {
  try {
    require('child_process').execFileSync('which', ['mpg123']);
    hasMpg123 = true;
    console.log('mpg123 found — music enabled');
  } catch {
    console.log('mpg123 not found — music disabled');
  }
}

function musicPlay(file) {
  if (!hasMpg123) return;
  musicStop();
  const filePath = path.resolve(__dirname, 'assets', file);
  console.log('Music path:', filePath);
  mpg123 = nodeSpawn('mpg123', ['-o', 'alsa', '--loop', '-1', '--quiet', filePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  mpg123.stderr.on('data', (d) => console.log('mpg123 stderr:', d.toString().trim()));
  mpg123.on('error', (err) => { console.log('mpg123 error:', err.message); mpg123 = null; });
  mpg123.on('exit', (code, signal) => { console.log('mpg123 exit:', code, signal); mpg123 = null; });
  console.log('Music playing:', file, '(pid ' + mpg123.pid + ')');
}

function musicStop() {
  if (!mpg123) return;
  mpg123.kill();
  mpg123 = null;
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

  // Fill RGB pixel data
  for (let i = 0; i < pixelCount; i++) {
    const off = 10 + i * 3;
    const c = pixels[i];
    if (c) {
      buf[off]     = Math.max(0, Math.min(255, Math.round(c[0])));
      buf[off + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
      buf[off + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
    }
    // else stays 0,0,0 (black) from Buffer.alloc
  }

  ddpSocket.send(buf, WLED_DDP_PORT, WLED_HOST);
}

// --- Game state ---
const WINS_NEEDED = 3;
const VICTORY_DURATION_MS = 5000;
const IDLE_RESET_MS = 60000;

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
let nextPowerupDelay = randomBetween(POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);

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
  // speak('fight');
  musicPlay('fight.mp3');
  console.log(`Game started with ${players.size} players`);
}

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
    colorIndex,
    width: PLAYER_WIDTH,
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
    const targetPos = wrapPos(pusher.pos + dir);
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

// --- Hit a player (from wave or explosion) ---
const DEATH_PHRASES = ['wasted', 'destroyed', 'eliminated', 'obliterated', 'annihilated', 'rekt', 'game over'];
const EXPLOSION_PHRASES = ['kaboom', 'boom', 'ka-blam', 'explosive', 'bang', 'kablammo', 'boooom'];
const BLAST_PHRASES = ['pew pew', 'bang bang', 'zap zap', 'pew pew pew', 'blam blam', 'zzzap'];
const GOD_PHRASES = ['the hand of god', 'hand of god', 'divine intervention', 'wrath of god', 'judgment from above'];

function hitPlayer(player, attackerId, now) {
  if (gamePhase !== 'playing') return; // game already ended
  if (player.shieldActive) return; // shield absorbs the hit
  player.alive = false;
  player.respawnAt = now + RESPAWN_MS;
  player.shieldActive = false;
  const attacker = players.get(attackerId);
  if (attacker) attacker.score++;
  const phrase = DEATH_PHRASES[Math.floor(Math.random() * DEATH_PHRASES.length)];
  // speak(`${player.name}, ${phrase}`);

  // Announce score
  if (attacker) {
    const scores = [...players.values()]
      .map(p => `${p.name}, ${p.score}`)
      .join('. ');
    setTimeout(() => {
      // speak(`${scores}. out of ${WINS_NEEDED}`);
      // Check for match point
      const matchPointPlayers = [...players.values()].filter(p => p.score === WINS_NEEDED - 1);
      if (matchPointPlayers.length > 0 && gamePhase === 'playing') {
        setTimeout(() => {
          // speak('match point');
        }, 2000);
      }
    }, 1500);
  }

  // Check for winner
  if (attacker && attacker.score >= WINS_NEEDED) {
    gamePhase = 'victory';
    victoryStart = now;
    victoryColor = attacker.color;
    victoryPlayerName = attacker.name;
    // speak(`${attacker.name} wins`);
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
    const step = wantsDash ? 5 : 1;
    const delta = getDelta(input.dir, player.pos) * step;
    if (delta === 0) return;

    player.lastDelta = delta > 0 ? 1 : -1;
    player.lastMoveTime = now;
    let newPos = player.pos + delta;
    let throughPortal = false;
    if (newPos < 0 || newPos >= NUM_LEDS) {
      newPos = wrapPos(newPos);
      throughPortal = true;
    }

    if (wantsDash) {
      player.pos = newPos;
      player.hasDash = false;
      player.lastDashTime = now;
    } else {
      const oldPos = player.pos;
      player.pos = newPos;
      if (!throughPortal) {
        const bumpDir = delta > 0 ? 1 : -1;
        const blocked = pushChain(player, bumpDir, playerId);
        if (blocked) player.pos = oldPos;
      }
    }

    // Apply portal momentum
    if (throughPortal) {
      player.momentum = PORTAL_MOMENTUM;
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
    if (player.bombLastUsed.length > 0 && now - player.bombLastUsed[player.bombLastUsed.length - 1] < BOMB_COOLDOWN_MS) return;
    player.bombLastUsed = [now]; // reset to just this placement
    bombs.push({
      pos: player.pos,
      owner: playerId,
      placedAt: now,
      width: BOMB_WIDTH,
      exploding: false,
      explodeFrame: 0,
    });
  }

  if (input.type === 'blast') {
    if (!player.alive) return;
    player.blastLastUsed = player.blastLastUsed.filter(t => now - t < BLAST_COOLDOWN_MS);
    const available = player.blastMaxCharges - player.blastLastUsed.length;
    if (available <= 0) return;
    waves.push({ owner: playerId, center: player.pos, radius: 0, maxRadius: WAVE_MAX });
    player.blastLastUsed.push(now);
    // speak(BLAST_PHRASES[Math.floor(Math.random() * BLAST_PHRASES.length)]);
  }

  if (input.type === 'shield') {
    if (!player.alive) return;
    if (player.shieldActive) return;
    if (now - player.shieldLastUsed < SHIELD_COOLDOWN_MS) return;
    player.shieldActive = true;
    player.shieldActiveUntil = now + SHIELD_DURATION_MS;
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
    if (elapsed >= VICTORY_DURATION_MS) {
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
    // Portal glow
    const portalPulse = 0.3 + 0.3 * Math.sin(animTime * 4);
    const portalSwirl = 0.15 * Math.sin(animTime * 7);
    for (let d = 0; d < PORTAL_GLOW_SIZE; d++) {
      const fade = (1 - d / PORTAL_GLOW_SIZE) * portalPulse;
      const swirl2 = portalSwirl * (1 - d / PORTAL_GLOW_SIZE);
      pixels[d] = [Math.round(255*(fade+swirl2)), Math.round(140*(fade+swirl2)), Math.round(20*fade)];
      pixels[NUM_LEDS-1-d] = [Math.round(20*fade), Math.round(100*(fade+swirl2)), Math.round(255*(fade+swirl2))];
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
  if (now - lastInputTime >= IDLE_RESET_MS) {
    console.log('No input for 60s — resetting');
    // speak('game over, no activity');
    resetGame();
    return;
  }

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
    // Portal momentum
    if (p.momentum > 0 && p.alive && now - p.lastMomentumTime >= PORTAL_MOMENTUM_MS) {
      p.pos = wrapPos(p.pos + p.momentumDir);
      p.momentum--;
      p.lastMomentumTime = now;
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
        // speak(EXPLOSION_PHRASES[Math.floor(Math.random() * EXPLOSION_PHRASES.length)]);
      }
      // Kick sliding
      if (b.kickDir) {
        b.kickProgress = (b.kickProgress || 0) + BOMB_KICK_SPEED;
        while (b.kickProgress >= 1) {
          b.kickProgress -= 1;
          const newPos = wrapPos(b.pos + b.kickDir);
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
    if (b.exploding && b.explodeFrame > BOMB_EXPLODE_FRAMES && b.godBomb) {
      for (let d = -GOD_FIRE_SPREAD; d <= GOD_FIRE_SPREAD; d++) {
        const fPos = b.pos + d;
        if (fPos >= 0 && fPos < NUM_LEDS) {
          fires.push({ pos: fPos, placedAt: now });
        }
      }
    }
  }
  bombs = bombs.filter(b => !(b.exploding && b.explodeFrame > BOMB_EXPLODE_FRAMES));

  // Expire fires and check fire collisions
  fires = fires.filter(f => now - f.placedAt < GOD_FIRE_DURATION_MS);
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

  // Portal glow (LED 0 = orange, LED 191 = blue)
  const portalPulse = 0.3 + 0.3 * Math.sin(animTime * 4);
  const portalSwirl = 0.15 * Math.sin(animTime * 7);
  for (let d = 0; d < PORTAL_GLOW_SIZE; d++) {
    const fade = (1 - d / PORTAL_GLOW_SIZE) * portalPulse;
    const swirl2 = portalSwirl * (1 - d / PORTAL_GLOW_SIZE);
    // Orange portal at LED 0
    pixels[d] = [
      Math.round(255 * (fade + swirl2)),
      Math.round(140 * (fade + swirl2)),
      Math.round(20 * fade),
    ];
    // Blue portal at LED 191
    pixels[NUM_LEDS - 1 - d] = [
      Math.round(20 * fade),
      Math.round(100 * (fade + swirl2)),
      Math.round(255 * (fade + swirl2)),
    ];
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

  // Fires (Hand of God)
  for (const f of fires) {
    const age = (now - f.placedAt) / GOD_FIRE_DURATION_MS;
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
    fires: fires.map(f => ({ pos: f.pos, age: (Date.now() - f.placedAt) / GOD_FIRE_DURATION_MS })),
    animTime,
  });
}

function serializePlayers() {
  const now = Date.now();
  return [...players.values()].map(p => {
    const bombReady = p.bombLastUsed.length === 0 || now - p.bombLastUsed[p.bombLastUsed.length - 1] >= BOMB_COOLDOWN_MS;
    const blastReady = p.blastMaxCharges - p.blastLastUsed.filter(t => now - t < BLAST_COOLDOWN_MS).length;
    const shieldReady = !p.shieldActive && (now - p.shieldLastUsed >= SHIELD_COOLDOWN_MS);
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

  const size = 2
    + playerCount * 8
    + waveCount * 4
    + 1 + bombCount * 4
    + 1 + powerupCount
    + 1 + fireCount * 2
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
          if (gamePhase !== 'playing') return;
          const pos = Math.round(input.pos);
          if (pos < 0 || pos >= NUM_LEDS) return;
          bombs.push({
            pos,
            owner: null,
            placedAt: Date.now(),
            width: BOMB_WIDTH,
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
      console.log('Spectator connected');
    },
    message(ws, msg) {
      try {
        const input = JSON.parse(msg);
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
          // speak(`${player.name} has joined`);
          startGame(); // restart round with all current players
          return;
        }
        if (input.type === 'start_game') {
          if (gamePhase === 'waiting' && players.size >= 1) startGame();
          return;
        }
        // Hand of God — spectators only
        if (input.type === 'god_bomb') {
          const id = clients.get(ws);
          if (id) return; // players can't use this
          if (gamePhase !== 'playing') return;
          const pos = Math.round(input.pos);
          if (pos < 0 || pos >= NUM_LEDS) return;
          bombs.push({
            pos,
            owner: null,
            placedAt: Date.now(),
            width: BOMB_WIDTH,
            exploding: false,
            explodeFrame: 0,
            godBomb: true,
          });
          // speak(GOD_PHRASES[Math.floor(Math.random() * GOD_PHRASES.length)]);
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

  const DPAD_REPEAT_MS = 25;

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
    }, DPAD_REPEAT_MS);
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
          // speak(`${player.name} has joined`);
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

setInterval(tick, TICK_MS);
connectWled();
connectExternal();
initMusic();
console.log(`LED Arch Game server running on http://localhost:${server.port}`);
