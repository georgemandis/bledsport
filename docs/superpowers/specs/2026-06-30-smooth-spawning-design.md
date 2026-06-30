# Smooth Spawning + Spawn Invulnerability — Design

**Date:** 2026-06-30
**Component:** `bLEDsport-game-server` (`server.js`, `index.html`)

## Goal

Make joining and respawning feel smooth instead of disruptive:

1. A new player can join a match **already in progress without resetting it** —
   existing players keep their positions and scores, the board and timer are
   untouched.
2. All players spawn from a **single point at the top-center of the arch**,
   fanning out to nearby free LEDs so they never stack on one pixel and never
   land on a static hazard (bomb, fire, wall).
3. A freshly-spawned player **flashes (on/off blink of their own color) and is
   invulnerable** for a configurable duration (~3s default). This applies to
   both initial joins and death-respawns.

## Background

Current behavior in `server.js`:

- **Join resets the game.** Both join paths — the browser handler
  (`input.type === 'join'`, ~line 1960) and the gamepad Start handler
  (~line 2092) — call `startGame()`. `startGame()` zeroes every player's score,
  repositions everyone via `spawnPos()`, and clears waves/bombs/powerups/walls.
  So one new joiner wipes the in-progress match.
- **Scattered spawns.** `spawnPos()` (~line 587) places players at fixed
  candidates `[0, 48, 96, 144, 191]` (arch ends and spread points) — the "odd
  places."
- **No invulnerability concept.** `hitPlayer()` (~line 791) is the single
  chokepoint for all damage (bombs, waves, sweeper, fire, walls, hand-of-god);
  it already early-returns on `player.shieldActive`.

The arch has three `ZONES`: `left` (0–57), `top` (58–134), `right` (135–191).
Top-center ≈ LED **96**.

## Design

### 1. Single spawn point with hazard-aware fan-out

Add a constant and a helper:

```js
const SPAWN_POINT = 96; // top-center of the arch (center of the `top` zone)

// Nearest free LED to the spawn point, searching outward: 96,95,97,94,98,…
// "Blocked" = a living player, a bomb, a fire tile, or a wall LED.
// Powerups are NOT avoided (spawning on one just grants it).
// The sweeper is NOT avoided (it moves; spawn-invuln covers it).
function spawnPoint() {
  if (gameConfig.randomSpawns) return spawnPos(); // honor random-spawn game mode

  const blocked = new Set();
  for (const p of players.values()) if (p.alive) blocked.add(p.pos);
  for (const b of bombs) blocked.add(b.pos);
  for (const f of fires) blocked.add(f.pos);
  for (const w of randomWalls) {
    for (let i = 0; i < w.size; i++) blocked.add(w.pos + i);
  }

  for (let d = 0; d < NUM_LEDS; d++) {
    for (const cand of (d === 0 ? [SPAWN_POINT] : [SPAWN_POINT - d, SPAWN_POINT + d])) {
      if (cand >= 0 && cand < NUM_LEDS && !blocked.has(cand)) return cand;
    }
  }
  return SPAWN_POINT; // total gridlock fallback; invuln covers it
}
```

Notes:
- Exact fire/wall field names (`fires[].pos`, `randomWalls[].pos/.size`) are
  confirmed against current code; the implementation will match whatever those
  structures actually expose.
- `spawnPos()` is kept and still used by `randomSpawns` mode; all
  non-random join/respawn/start placement routes through `spawnPoint()`.

### 2. Live join — no reset

Factor the shared join logic so both paths behave identically. New behavior:

- **`gamePhase === 'waiting'`** → `startGame()` (unchanged round start).
- **`gamePhase === 'playing'` or `'suddenDeath'`** → add the player **live**:
  create them, set `pos = spawnPoint()`, grant spawn-invulnerability (see §3),
  set `alive = true`, `score = 0` for the *new* player only. Do **not** call
  `startGame()`, do **not** touch existing players, scores, board, or timer.
- **`gamePhase === 'victory'`** → unchanged (joins already ignored).

This is the core fix. `startGame()` is unchanged for genuine round starts,
except its per-player placement also routes through `spawnPoint()` (still fanning
out so 2–4 starters don't stack).

### 3. Flashing spawn invulnerability (configurable)

- **Player field:** `invulnUntil` (timestamp ms). Added in `createPlayer()`
  (default `0`). Set to `now + gameConfig.spawnInvulnMs` whenever a player
  spawns — on live join, on round-start in `startGame()`, and on death-respawn
  (~line 1113).
- **Config:** new `spawnInvulnMs` in the **gameRules** category,
  `{ default: 3000, min: 0, max: 10000, step: 250, live: true }`. `0` disables
  spawn protection. It renders automatically in the config UI as a slider
  labeled "Spawn Invuln (ms)".
- **Damage immunity:** one guard at the top of `hitPlayer()`:
  `if (now < player.invulnUntil) return;` — covers every damage source. The
  invulnerable player can still move and attack normally (offense unaffected).
- **Visual flash:** while `now < player.invulnUntil`, the player blinks on/off in
  their own color. A simple time-based toggle (e.g. `Math.floor(now / 120) % 2`)
  decides whether the player's LED(s) are drawn this frame. Applied in the
  player render path for the physical strip, and mirrored on the web canvas:
  the per-player state in the `broadcast(...)` payload gains an `invuln` boolean
  so `index.html` applies the same on/off blink.

### 4. Out of scope / unchanged

- Scoring, win conditions, abilities, portals, sweeper, the idle/waiting
  animation — untouched.
- `randomSpawns` mode is still honored (bypasses the single spawn point).
- Max-4-players cap and victory-phase join block — unchanged.

## Testing

Run `bun server.js --debug` (no hardware needed) and use the web client /
gamepad. Verify:

1. **Live join, no reset:** with a match in progress and players holding
   nonzero scores at various positions, a new player joins → existing players'
   positions and scores are unchanged; the new player appears at top-center.
2. **Single spawn point + fan-out:** multiple players starting a round, or
   joining together, appear clustered around LED 96 on distinct LEDs (never the
   same pixel).
3. **Hazard avoidance:** place a bomb/wall/fire on LED 96 → the next spawner
   lands on the nearest clear LED beside it, not on the hazard.
4. **Invulnerability + flash:** a just-spawned player blinks in their color and
   survives bombs/waves/fire/hand-of-god for `spawnInvulnMs`, then becomes
   vulnerable. Confirm on both the strip-render path and the web canvas.
5. **Config:** the **Spawn Invuln (ms)** slider appears under GAME RULES,
   defaults to 3000, is live-adjustable; setting it to 0 removes protection.
6. **Death-respawn parity:** a killed player respawns at the spawn point with the
   same flash + invulnerability.
