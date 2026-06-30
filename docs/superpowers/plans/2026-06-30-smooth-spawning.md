# Smooth Spawning + Spawn Invulnerability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let new players join a live match without resetting it, spawn everyone from a single hazard-aware top-center point, and give freshly-spawned players a configurable flashing invulnerability.

**Architecture:** All changes are in the single Bun game server (`server.js`) plus a small render tweak in the config/spectator page (`index.html`). A new `spawnPoint()` helper centralizes placement; the two join handlers branch on `gamePhase` to add players live instead of calling `startGame()`; a per-player `invulnUntil` timestamp gates damage in the existing `hitPlayer()` chokepoint and drives an on/off color blink on both the LED strip and the web canvas.

**Tech Stack:** Bun (JavaScript), WebSocket broadcast, DDP-over-UDP to WLED (irrelevant in `--debug`), vanilla JS + canvas client.

## Global Constraints

- Runtime: Bun. Run the server with `bun server.js --debug` (no WLED hardware; LED output disabled).
- No test framework exists in this project. "Tests" are **runtime verification**: start the server in `--debug`, drive it via the web client at `http://localhost:8080` (or a small WebSocket probe), and observe broadcast state / console logs. Use `PORT=8080` to avoid the privileged default port 80.
- Default spawn point: `SPAWN_POINT = 96` (center of the `top` zone, LEDs 58–134).
- New config key: `spawnInvulnMs`, category `gameRules`, `{ default: 3000, min: 0, max: 10000, step: 250, live: true }`. `0` disables protection.
- Field shapes (verified): players carry `pos`, `alive`, `score`, `invulnUntil` (new); `bombs[]` have `.pos`; `fires[]` are `{pos, placedAt}`; `randomWalls[]` are `{pos, size}`.
- `randomSpawns` game mode must still be honored (it bypasses the single spawn point).
- Do NOT modify scoring, win conditions, abilities, portals, sweeper, or the idle/waiting animation beyond what each task specifies.
- This repo's top-level dir is not a git repo; the server lives under `bLEDsport-server/` which **is** a git repo (`origin` → `github.com:georgemandis/bledsport.git`, branch `main`). All `git` commands below run from `bLEDsport-server/`. Paths in commits are relative to that dir.

---

### Task 1: Add `spawnInvulnMs` config + `invulnUntil` player field

Adds the config knob and the per-player timestamp field with safe defaults. No behavior change yet (nothing reads `invulnUntil` until Task 3), so this task is isolated and verifiable on its own: the slider appears in the UI and the field exists on new players.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (`CONFIG_SCHEMA` ~line 18; `createPlayer()` ~line 623)

**Interfaces:**
- Produces: `gameConfig.spawnInvulnMs` (number, ms); player objects gain `invulnUntil` (number, ms timestamp; `0` = not invulnerable).

- [ ] **Step 1: Add the config schema entry**

In `server.js`, in `CONFIG_SCHEMA`, add `spawnInvulnMs` to the Game Rules group (immediately after the `idleResetMs` line):

```js
  idleResetMs: { default: 60000, min: 10000, max: 300000, step: 5000, category: 'gameRules', live: false },
  spawnInvulnMs: { default: 3000, min: 0, max: 10000, step: 250, category: 'gameRules', live: true },
```

- [ ] **Step 2: Add the `invulnUntil` field to `createPlayer()`**

In `createPlayer()`, alongside the other initial fields (next to `respawnAt: 0,`), add:

```js
    respawnAt: 0,
    invulnUntil: 0,
```

- [ ] **Step 3: Run the server and verify the config is exposed**

Run: `cd bLEDsport-game-server && PORT=8080 bun server.js --debug`
In another shell:
`curl -s localhost:8080/ -o /dev/null -w "%{http_code}\n"` → expect `200`.
Open `http://localhost:8080`, expand **GAME RULES**, and confirm a **Spawn Invuln (ms)** slider appears, default `3000`, adjustable. (`formatLabel('spawnInvulnMs')` → "Spawn Invuln (ms)" automatically.)
Stop the server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat(spawn): add spawnInvulnMs config and player invulnUntil field"
```

---

### Task 2: Add hazard-aware `spawnPoint()` helper

Centralizes spawn placement at the top-center point with outward fan-out that avoids living players, bombs, fire tiles, and walls. Pure function of current game state; not wired into join/respawn yet (Task 4), so verify it directly via a temporary probe.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (add helper next to `spawnPos()` ~line 587; add `SPAWN_POINT` constant near `ZONES` ~line 247)

**Interfaces:**
- Consumes: `gameConfig.randomSpawns`, `spawnPos()`, `players`, `bombs`, `fires`, `randomWalls`, `NUM_LEDS`.
- Produces: `SPAWN_POINT` (const number = 96); `spawnPoint(): number` — returns a valid LED index `0..NUM_LEDS-1`, preferring `SPAWN_POINT` and fanning outward to the nearest LED not occupied by a living player, bomb, fire, or wall. If `randomSpawns` is on, delegates to `spawnPos()`.

- [ ] **Step 1: Add the `SPAWN_POINT` constant**

In `server.js`, just after the `ZONES` array (~line 247), add:

```js
const SPAWN_POINT = 96; // top-center of the arch (center of the `top` zone)
```

- [ ] **Step 2: Add the `spawnPoint()` helper**

Immediately after the existing `spawnPos()` function (after its closing `}` ~line 608), add:

```js
// Nearest free LED to the single spawn point, searching outward: 96,95,97,94,98,…
// "Blocked" = a living player, a bomb, a fire tile, or any wall LED.
// Powerups are intentionally NOT avoided (spawning on one just grants it).
// The sweeper is intentionally NOT avoided (it moves; spawn-invuln covers it).
function spawnPoint() {
  if (gameConfig.randomSpawns) return spawnPos(); // honor the random-spawn game mode

  const blocked = new Set();
  for (const p of players.values()) if (p.alive) blocked.add(p.pos);
  for (const b of bombs) blocked.add(b.pos);
  for (const f of fires) blocked.add(f.pos);
  for (const w of randomWalls) {
    for (let i = 0; i < w.size; i++) blocked.add(w.pos + i);
  }

  for (let d = 0; d < NUM_LEDS; d++) {
    const cands = d === 0 ? [SPAWN_POINT] : [SPAWN_POINT - d, SPAWN_POINT + d];
    for (const cand of cands) {
      if (cand >= 0 && cand < NUM_LEDS && !blocked.has(cand)) return cand;
    }
  }
  return SPAWN_POINT; // total gridlock fallback; invuln covers it
}
```

- [ ] **Step 3: Verify with a temporary probe**

Temporarily append to the bottom of `server.js`:

```js
// TEMP PROBE — remove before commit
console.log('PROBE empty board spawnPoint =', spawnPoint()); // expect 96
players.set(999, { pos: 96, alive: true });
console.log('PROBE with player on 96 =', spawnPoint());      // expect 95
bombs.push({ pos: 95 });
console.log('PROBE with player@96 bomb@95 =', spawnPoint()); // expect 97
players.delete(999); bombs.length = 0;
```

Run: `cd bLEDsport-game-server && bun server.js --debug` and read the three PROBE lines in the console (they print at startup). Expected: `96`, `95`, `97`. Stop the server.

- [ ] **Step 4: Remove the probe**

Delete the TEMP PROBE block added in Step 3. Re-run `bun server.js --debug` briefly to confirm clean startup (no PROBE lines), then stop.

- [ ] **Step 5: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat(spawn): add hazard-aware top-center spawnPoint() helper"
```

---

### Task 3: Gate damage on invulnerability in `hitPlayer()`

Adds the single damage-immunity guard. Because `hitPlayer()` is the one chokepoint for all damage, this protects against every source at once. Verifiable by setting `invulnUntil` via the probe path and confirming a hit is ignored.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (`hitPlayer()` ~line 791)

**Interfaces:**
- Consumes: `player.invulnUntil` (from Task 1), `now`.
- Produces: `hitPlayer(player, attackerId, now)` becomes a no-op when `now < player.invulnUntil`.

- [ ] **Step 1: Add the guard at the top of `hitPlayer()`**

In `hitPlayer()`, add the invulnerability check as the first guard, right after the existing phase guard and before the shield check:

```js
function hitPlayer(player, attackerId, now) {
  if (gamePhase !== 'playing' && gamePhase !== 'suddenDeath') return; // game already ended
  if (now < player.invulnUntil) return; // spawn invulnerability — no damage
  if (player.shieldActive) return; // shield absorbs the hit
```

- [ ] **Step 2: Verify the guard with a temporary probe**

Temporarily append to the bottom of `server.js`:

```js
// TEMP PROBE — remove before commit
{
  gamePhase = 'playing';
  const t = 100000;
  const victim = { alive: true, invulnUntil: t + 5000, shieldActive: false, dashAnim: null, respawnAt: 0 };
  hitPlayer(victim, null, t);            // invulnerable: should stay alive
  console.log('PROBE invuln victim.alive =', victim.alive); // expect true
  const victim2 = { alive: true, invulnUntil: 0, shieldActive: false, dashAnim: null, respawnAt: 0 };
  hitPlayer(victim2, null, t);           // not invulnerable: should die
  console.log('PROBE vulnerable victim.alive =', victim2.alive); // expect false
  gamePhase = 'waiting';
}
```

Run: `cd bLEDsport-game-server && bun server.js --debug` and read the PROBE lines. Expected: `true` then `false`. Stop the server.

- [ ] **Step 3: Remove the probe**

Delete the TEMP PROBE block. Re-run `bun server.js --debug` briefly to confirm clean startup, then stop.

- [ ] **Step 4: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat(spawn): make hitPlayer respect spawn invulnerability"
```

---

### Task 4: Route round-start and death-respawn through `spawnPoint()` + grant invuln

Switches the two *existing* spawn sites (round start in `startGame()`, death-respawn in the per-player update loop) to the single spawn point and grants invulnerability. This is independently testable: start a round and kill/respawn a player, observing positions clustering at ~96 and the invuln window.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (`startGame()` ~line 545; death-respawn block ~line 1113)

**Interfaces:**
- Consumes: `spawnPoint()` (Task 2), `gameConfig.spawnInvulnMs`, `player.invulnUntil` (Task 1).
- Produces: at round start and on death-respawn, `p.pos = spawnPoint()` and `p.invulnUntil = <now> + gameConfig.spawnInvulnMs`.

- [ ] **Step 1: Update `startGame()` placement + invuln**

In `startGame()`, the per-player loop currently sets `p.pos = spawnPos();`. Change that line and add the invuln line. `startGame()` does not have a `now` in scope at that point, so capture one. At the top of the `for (const p of players.values())` loop body, replace:

```js
    p.score = 0;
    p.alive = true;
    p.pos = spawnPos();
```

with:

```js
    p.score = 0;
    p.alive = true;
    p.pos = spawnPoint();
    p.invulnUntil = matchStartAt + gameConfig.spawnInvulnMs;
```

(`matchStartAt = Date.now()` is set a few lines above in `startGame()`, so it is in scope and equals "now".)

- [ ] **Step 2: Update the death-respawn block**

In the per-player update loop, the respawn branch currently begins:

```js
    if (!p.alive && now >= p.respawnAt) {
      p.alive = true;
      p.pos = spawnPos();
```

Change the position line and add invuln:

```js
    if (!p.alive && now >= p.respawnAt) {
      p.alive = true;
      p.pos = spawnPoint();
      p.invulnUntil = now + gameConfig.spawnInvulnMs;
```

(`now` is already in scope in this loop.)

- [ ] **Step 3: Runtime verification — round start clusters at center, respawn is protected**

Run: `cd bLEDsport-game-server && PORT=8080 bun server.js --debug`. Open `http://localhost:8080` in two browser tabs (each can press Start to join as a player via the on-screen control, or use the keyboard controls the client provides).

Verify:
1. When the round starts, joined players appear clustered around LED 96 (distinct LEDs, not stacked) — watch the canvas / scoreboard positions.
2. With `spawnInvulnMs = 3000`, a player who is killed reappears at ~96 and cannot be re-killed for ~3s (test by dropping a Hand-of-God bomb on them immediately after respawn — they survive until the window ends).

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat(spawn): round-start and respawn use spawnPoint() with invulnerability"
```

---

### Task 5: Live join without reset (browser + gamepad)

The core UX fix. Both join paths branch on `gamePhase`: start the round when waiting, otherwise drop the new player in live (no `startGame()`, existing players/scores/board untouched). A shared helper keeps the two paths identical.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (browser `join` handler ~line 1960; gamepad Start handler ~line 2092; add helper near `startGame()` ~line 581)

**Interfaces:**
- Consumes: `startGame()`, `spawnPoint()`, `gameConfig.spawnInvulnMs`, `gamePhase`, `players`.
- Produces: `joinPlayer(player): void` — if `gamePhase === 'waiting'`, calls `startGame()`; if `playing`/`suddenDeath`, places the player live at `spawnPoint()` with invulnerability and leaves everyone else untouched. (Callers create the player, assign id/name, and register it in `players`/client maps before calling.)

- [ ] **Step 1: Add the `joinPlayer()` helper**

In `server.js`, immediately after `startGame()` (after its closing `}` ~line 581), add:

```js
// Decide what happens when a player joins. Waiting → start the round.
// Mid-match → drop them in live at the spawn point with invulnerability,
// without disturbing existing players, scores, the board, or the timer.
function joinPlayer(player) {
  if (gamePhase === 'waiting') {
    startGame(); // startGame() positions everyone (including this player)
    return;
  }
  // gamePhase is 'playing' or 'suddenDeath' — live drop-in.
  const now = Date.now();
  player.alive = true;
  player.pos = spawnPoint();
  player.invulnUntil = now + gameConfig.spawnInvulnMs;
}
```

(Note: `score` was already initialized to `0` in `createPlayer()`, so a live joiner starts at 0 while existing players keep their scores. Victory-phase joins are blocked by the callers, so `joinPlayer` is only reached for waiting/playing/suddenDeath.)

- [ ] **Step 2: Update the browser `join` handler**

In the browser handler, replace the line `startGame(); // restart round with all current players` with `joinPlayer(player);`. The surrounding handler becomes:

```js
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
          joinPlayer(player); // start round if waiting, else live drop-in
          return;
        }
```

- [ ] **Step 3: Update the gamepad Start handler**

In the gamepad Start handler, replace `startGame(); // restart round with all current players` with `joinPlayer(player);`. The join branch becomes:

```js
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
          joinPlayer(player); // start round if waiting, else live drop-in
        }
        return;
      }
```

- [ ] **Step 4: Runtime verification — joining mid-match does not reset**

Run: `cd bLEDsport-game-server && PORT=8080 bun server.js --debug`. Open two browser tabs.

1. Tab A joins → round starts (player at ~96).
2. Move/score with Tab A so its position is away from center and (if easy) its score is nonzero. Note Tab A's position and score on the scoreboard.
3. Tab B joins **while the match is playing**.
4. Verify: Tab A's position and score are **unchanged**; Tab B appears at ~96, flashing/invulnerable (flash lands in Task 6 — for now confirm via state that Tab B has a future `invulnUntil` and existing players were untouched). The board/powerups/bombs are not cleared.

Optional precise check — a WebSocket probe that joins as a second player and prints the broadcast before/after is acceptable, but the two-tab observation is sufficient.

Stop the server.

- [ ] **Step 5: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat(spawn): join live mid-match without resetting the game"
```

---

### Task 6: Flashing render — strip + web canvas

Makes invulnerable players visibly blink in their own color on the LED strip render path and mirror the same blink on the web canvas. Adds an `invuln` flag to each serialized player so the client can blink in sync.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (player serialization in `serializePlayers()` / broadcast; the strip player-render path)
- Modify: `bLEDsport-game-server/index.html` (canvas player-draw path)

**Interfaces:**
- Consumes: `player.invulnUntil`, `now`/`animTime`.
- Produces: each serialized player gains `invuln: boolean`; both the strip render and the canvas render skip drawing the player's pixel(s) on "off" frames of a fixed-rate blink while invulnerable.

- [ ] **Step 1: Locate the serialization and render sites**

Run these to find exact line numbers (they anchor the edits below):

```bash
cd bLEDsport-game-server
grep -n "function serializePlayers" server.js
grep -n "serializePlayers" server.js
grep -n "p.alive" server.js        # strip render of players
grep -n "gameState.players" index.html   # canvas render of players
```

Expected: a `serializePlayers()` builder, a strip-side loop that renders living players to `pixels[]`, and an `index.html` loop that draws `gameState.players` to the canvas. Use the actual line numbers from this output for the edits below.

- [ ] **Step 2: Add `invuln` to serialized players**

In `serializePlayers()` (the object literal it builds per player), add an `invuln` field computed from the current time. Use `Date.now()` for the comparison so it is independent of frame cadence:

```js
    invuln: Date.now() < p.invulnUntil,
```

Add it alongside the existing serialized fields (e.g. next to `pos`, `color`, `alive`). This makes `invuln` available to the web client.

- [ ] **Step 3: Blink on the strip render path**

Define a shared blink helper near the top of the render section (once), so strip and any other server-side use agree on the rate. Just above the strip player-render loop, add:

```js
// On/off blink for spawn invulnerability — ~4 blinks/sec.
const invulnBlinkOn = (Math.floor(animTime * 8) % 2) === 0;
```

Then, in the strip loop that writes a living player's pixel(s) into `pixels[]`, wrap the write so an invulnerable player is skipped on "off" frames:

```js
    if (p.invulnUntil > now && !invulnBlinkOn) {
      // invulnerable + blink "off" frame — draw nothing this frame
    } else {
      // ...existing pixel write(s) for this player...
    }
```

Keep the existing pixel-write code unchanged inside the `else`. (If the render loop uses a different time variable than `animTime`, compute `invulnBlinkOn` from that same variable so the strip blink is smooth.)

- [ ] **Step 4: Blink on the web canvas**

In `index.html`, in the loop that draws `gameState.players` onto the canvas, skip drawing a player on "off" frames when `p.invuln` is true. Just before the per-player draw, add a blink gate using the client's existing animation clock (`gameState.animTime`, which is broadcast):

```js
  const invulnBlinkOn = (Math.floor(gameState.animTime * 8) % 2) === 0;
  // ...inside the per-player loop:
  if (p.invuln && !invulnBlinkOn) continue; // skip draw on "off" frame
```

Place the `invulnBlinkOn` computation once before the loop and the `continue` as the first line inside the per-player loop body.

- [ ] **Step 5: Runtime verification — visible blink, in sync**

Run: `cd bLEDsport-game-server && PORT=8080 bun server.js --debug`. Open `http://localhost:8080`.

1. Join as a player. Confirm that for ~3s after spawning, the player's dot on the canvas **blinks on/off in its own color**, then becomes solid.
2. Kill the player (Hand-of-God bomb) and confirm the respawn blinks again.
3. Set **Spawn Invuln (ms)** to `0` in the config UI → newly spawned players do **not** blink and are immediately vulnerable. Set it back to `3000`.

Stop the server.

- [ ] **Step 6: Commit**

```bash
git add bLEDsport-game-server/server.js bLEDsport-game-server/index.html
git commit -m "feat(spawn): flash invulnerable players on strip and web canvas"
```

---

### Task 7: Final integration pass + docs

End-to-end verification against the spec's test list, and a short README note so the new config knob is discoverable.

**Files:**
- Modify: `bLEDsport-game-server/README.md` (config / gameplay notes section)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: documented behavior; no new code interfaces.

- [ ] **Step 1: End-to-end runtime checks**

Run: `cd bLEDsport-game-server && PORT=8080 bun server.js --debug`, open `http://localhost:8080`, and walk the spec's test list:
1. Live join, no reset — existing positions/scores preserved.
2. Single spawn point + fan-out — multiple starters/joiners cluster at ~96 on distinct LEDs.
3. Hazard avoidance — drop a bomb/wall/fire on 96, next spawner lands beside it.
4. Invulnerability + flash — survives bombs/waves/fire/hand-of-god for the window, then vulnerable; blink visible on canvas.
5. Config — Spawn Invuln (ms) under GAME RULES, default 3000, live; 0 disables.
6. Death-respawn parity — respawn at spawn point with flash + invuln.

Note any failures and fix in the relevant task's file before continuing. Stop the server.

- [ ] **Step 2: Document the new config in README**

In `bLEDsport-game-server/README.md`, add a bullet near where game rules / config options are described (search the README for "config" or "winsNeeded" to find the right spot; if there is no such list, add a short "Spawning" note under the gameplay section):

```markdown
- **Spawn Invuln (ms)** (`spawnInvulnMs`, default 3000): players spawn at the
  top-center of the arch and flash while invulnerable for this many
  milliseconds after joining or respawning. Set to 0 to disable. New players
  join a match in progress without resetting it.
```

- [ ] **Step 3: Commit**

```bash
git add bLEDsport-game-server/README.md
git commit -m "docs(spawn): document spawn point and spawnInvulnMs behavior"
```

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**
- Live join without reset → Task 5 (+ `joinPlayer` helper). ✓
- Single top-center spawn point → Task 2 (`spawnPoint`, `SPAWN_POINT=96`), wired in Tasks 4–5. ✓
- Hazard-aware fan-out (bombs/fire/walls; ignore powerups + sweeper) → Task 2 blocked-set. ✓
- Flashing invulnerability, configurable (~3s default, 0 disables) → config in Task 1, guard in Task 3, grant in Tasks 4–5, flash in Task 6. ✓
- Applies to joins AND death-respawns → Task 4 (respawn + round start) and Task 5 (join). ✓
- Invulnerable players can still attack → Task 3 only gates `hitPlayer` (defense), offense untouched. ✓
- New joiner's score starts at 0, existing scores preserved → Task 5 Step 1 note (relies on `createPlayer` default + no `startGame` mid-match). ✓
- `randomSpawns` still honored → Task 2 delegates to `spawnPos()`. ✓
- Both browser and gamepad join paths → Task 5 Steps 2 and 3. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/vague steps. Task 6 deliberately uses a `grep` step to anchor render-site edits because those exact line numbers depend on current code; the edits themselves are shown in full. No empty test stubs (project has no test framework; runtime checks are concrete).

**Type consistency:** `spawnPoint()` (not `spawnPos()`) used consistently in Tasks 4–5; `invulnUntil` (number ms) defined in Task 1 and read in Tasks 3–6; `joinPlayer(player)` defined and called with the same signature in Task 5; serialized `invuln` (boolean) produced in Task 6 Step 2 and consumed in Step 4. `SPAWN_POINT` constant defined once (Task 2 Step 1).
