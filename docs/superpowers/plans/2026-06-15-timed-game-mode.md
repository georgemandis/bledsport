# Timed Game Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional match timer that runs alongside best-of-X, ends the game when it expires (highest score wins, ties go to sudden death), and renders a smooth countdown on the spectator screen.

**Architecture:** The game server (`server.js`) gains a `matchDurationMs` config field, a `matchStartAt` timestamp, timer-expiry logic in `tick()`, and a new `suddenDeath` phase that reuses the playing-phase logic. The server appends two timer anchor fields (`matchDurationSec`, `matchElapsedSec`) to the tail of the existing binary state packet. The spectator screen (`bledsport-external/index.html`) decodes those anchors and runs its own per-frame countdown in the existing `animLoop()`.

**Tech Stack:** Bun, plain JS, hand-rolled binary WebSocket protocol, Canvas 2D.

> **Testing note:** This is a real-time visual/hardware system. The spec specifies **manual verification on the spectator screen** rather than automated unit tests. Each task therefore ends with explicit manual-verification steps and a commit, rather than a TDD red/green cycle. Run the game server with `bun server.js` and the external server with `bun server.ts` (in `bledsport-external/`), then open the spectator page in a browser.

---

## File Structure

- **Modify** `bLEDsport-game-server/server.js`
  - `CONFIG_SCHEMA` (line ~13): add `matchDurationMs`.
  - Game state block (line ~361-365): add `matchStartAt`, update the `gamePhase` comment.
  - `startGame()` (line ~420): set `matchStartAt`.
  - `tick()` playing-phase guard / idle check (line ~909-916): broaden to run for `suddenDeath`; add timer-expiry block.
  - `hitPlayer()` (line ~642-665): add sudden-death resolution; broaden the early-return phase guard.
  - `handleInput()` guard (line ~671): accept input during `suddenDeath`.
  - The playing-phase `broadcast({...})` (line ~1384): include `gamePhase` correctly (already dynamic) — add a leader-eval helper.
  - `packStateForExternal()` (line ~1483-1600): append timer bytes at tail; bump size; map `suddenDeath` to phase `3`.
- **Modify** `bledsport-external/index.html`
  - **Cleanup (Task 0):** remove the dead `cornerWalls` decode section that mis-aligns the wall offsets, and its unused render block + state field.
  - `PHASES` array (line 406): add `'suddenDeath'`.
  - `gameState` object (line ~100-110): add timer fields.
  - `unpackState()` (line ~520-532): read trailing timer bytes after victory block.
  - `renderer.draw()` (line ~342-356): countdown overlay + sudden-death banner.

---

## Task 0: Fix the corner-walls decode mismatch (cleanup)

**Background:** The spectator decoder reads a `cornerWallCount` section (index.html:491-495) that the game server **never sends** — `packStateForExternal()` writes `random walls → sweeper → portals → victory` with no corner-walls section, and the server has no concept of corner walls (zero references in `server.js`). The client renders `cornerWalls` (line 184) identically to `randomWalls` (line 193). Net effect: `cornerWalls` is dead code that also shifts every subsequent decode offset by one section, corrupting random-wall/sweeper/portal decoding whenever random walls are present. Removing it makes the decoder match the wire format exactly. This is independent of the timer feature, so it goes first on its own commit.

**Files:**
- Modify: `bledsport-external/index.html:101` (remove `cornerWalls` state field)
- Modify: `bledsport-external/index.html:183-190` (remove corner-walls render block)
- Modify: `bledsport-external/index.html:489-495` (remove corner-walls decode block)

- [ ] **Step 1: Remove the corner-walls decode block**

In `unpackState()`, the section guarded by `if (off < buf.length) {` currently starts (lines 490-495):

```js
  if (off < buf.length) {
    const cornerWallCount = buf[off++] || 0;
    gameState.cornerWalls = [];
    for (let i = 0; i < cornerWallCount; i++) {
      gameState.cornerWalls.push({ pos: buf[off++], size: buf[off++] });
    }

    // Random walls
    const randomWallCount = buf[off++] || 0;
```

Change it to drop the corner-walls read so `randomWallCount` is the first thing read inside the guard:

```js
  if (off < buf.length) {
    // Random walls
    const randomWallCount = buf[off++] || 0;
```

- [ ] **Step 2: Remove the corner-walls render block**

Delete the render block at lines 183-190:

```js
    // Corner walls (orange)
    for (const w of (gameState.cornerWalls || [])) {
      const half = Math.floor(w.size / 2);
      for (let d = -half; d <= half; d++) {
        const led = w.pos + d;
        if (led >= 0 && led < NUM_LEDS) pixels[led] = [200, 120, 0];
      }
    }

```

(Random walls are still rendered by the block immediately below it, unchanged.)

- [ ] **Step 3: Remove the unused state field**

Delete line 101:

```js
  cornerWalls: [],
```

- [ ] **Step 4: Manual verification — random walls render correctly**

Run both servers. In the config, enable `randomWallsEnabled` (and a short spawn time if available). Join a player and start a game so random walls spawn.
Expected: orange wall segments appear at the correct LED positions, and the sweeper/portals also render in their correct positions (previously they could be shifted when walls were present). No console errors.

- [ ] **Step 5: Commit**

```bash
git add bledsport-external/index.html
git commit -m "fix: remove dead cornerWalls decode that mis-aligned wall offsets"
```

---

## Task 1: Add `matchDurationMs` config field

**Files:**
- Modify: `bLEDsport-game-server/server.js:13` (inside `CONFIG_SCHEMA`, `gameRules` category)

- [ ] **Step 1: Add the config field**

In `CONFIG_SCHEMA`, immediately after the `victoryDurationMs` line (line 13), add:

```js
  matchDurationMs:  { default: 120000, min: 0, max: 600000, step: 15000, category: 'gameRules', live: false },
```

- [ ] **Step 2: Verify the server boots and exposes the field**

Run: `cd bLEDsport-game-server && bun server.js`
Expected: server starts with no error (`Game reset — waiting for players` or similar). The config defaults loop at line ~71 will pick up `matchDurationMs: 120000` automatically. Stop the server with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: add matchDurationMs config field"
```

---

## Task 2: Add match-start timestamp and broaden the phase comment

**Files:**
- Modify: `bLEDsport-game-server/server.js:361` (game state)
- Modify: `bLEDsport-game-server/server.js:420` (`startGame()`)

- [ ] **Step 1: Add `matchStartAt` state and update the phase comment**

Replace line 361-362:

```js
let gamePhase = 'waiting'; // 'waiting' | 'playing' | 'victory'
let victoryStart = 0;
```

with:

```js
let gamePhase = 'waiting'; // 'waiting' | 'playing' | 'suddenDeath' | 'victory'
let victoryStart = 0;
let matchStartAt = 0;
```

- [ ] **Step 2: Set `matchStartAt` in `startGame()`**

In `startGame()`, immediately after `gamePhase = 'playing';` (line 422), add:

```js
  matchStartAt = Date.now();
```

- [ ] **Step 3: Verify the server boots**

Run: `cd bLEDsport-game-server && bun server.js`
Expected: starts cleanly. Stop with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: track match start time"
```

---

## Task 3: Add a leader-evaluation helper

This helper is used by both the timer-expiry block (Task 4) and sudden-death resolution (Task 5). Define it once.

**Files:**
- Modify: `bLEDsport-game-server/server.js` (add near `hitPlayer`, before line 642)

- [ ] **Step 1: Add the helper function**

Immediately before `function hitPlayer(...)` (line 642), add:

```js
// Returns the single player with the strictly-highest score, or null on a tie/empty.
function soleLeader() {
  let best = null;
  let bestScore = -Infinity;
  let tied = false;
  for (const p of players.values()) {
    if (p.score > bestScore) {
      bestScore = p.score;
      best = p;
      tied = false;
    } else if (p.score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

// Transition into the victory phase for a given winning player.
function declareWinner(player, now) {
  gamePhase = 'victory';
  victoryStart = now;
  victoryColor = player.color;
  victoryPlayerName = player.name;
  speak(`${player.name} wins`);
  console.log(`${player.name} wins!`);
}
```

- [ ] **Step 2: Verify the server boots**

Run: `cd bLEDsport-game-server && bun server.js`
Expected: starts cleanly. Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: add soleLeader and declareWinner helpers"
```

---

## Task 4: Refactor best-of win to use `declareWinner`, add timer expiry

**Files:**
- Modify: `bLEDsport-game-server/server.js:656-664` (`hitPlayer` best-of check)
- Modify: `bLEDsport-game-server/server.js:909-916` (`tick` playing phase)

- [ ] **Step 1: Use `declareWinner` for the best-of win**

In `hitPlayer()`, replace the "Check for winner" block (lines 656-664):

```js
  // Check for winner
  if (attacker && attacker !== player && attacker.score >= gameConfig.winsNeeded) {
    gamePhase = 'victory';
    victoryStart = now;
    victoryColor = attacker.color;
    victoryPlayerName = attacker.name;
    speak(`${attacker.name} wins`);
    console.log(`${attacker.name} wins!`);
  }
```

with:

```js
  // Check for winner (best-of-X — active in both playing and sudden death)
  if (attacker && attacker !== player && attacker.score >= gameConfig.winsNeeded) {
    declareWinner(attacker, now);
  }
```

- [ ] **Step 2: Add the timer-expiry block in `tick()`**

In `tick()`, immediately after the idle-timeout block (after line 916, the closing `}` of the `idleResetMs` check) and before the `// Spawn power-ups` comment, add:

```js
  // --- Match timer expiry (only during normal play; sudden death has no timer) ---
  if (gamePhase === 'playing' && gameConfig.matchDurationMs > 0 &&
      now - matchStartAt >= gameConfig.matchDurationMs) {
    const leader = soleLeader();
    if (leader) {
      declareWinner(leader, now);
    } else {
      gamePhase = 'suddenDeath';
      speak('sudden death');
      console.log('Time! Sudden death.');
    }
    return;
  }
```

- [ ] **Step 3: Manual verification — timer expiry with a clear leader**

Set a short duration to test fast. Temporarily edit the `matchDurationMs` default to `10000` (10s), OR set it via the config UI if available. Start the game server and external server, open the spectator page, join with at least one player, and get one player ahead on score. Wait for 10s to elapse.
Expected: server logs `<name> wins!`, game enters victory animation. (Countdown display comes in Task 8 — for now you're verifying the server-side transition only via logs.)
Restore the default to `120000` after testing.

- [ ] **Step 4: Manual verification — timer expiry on a tie**

With `matchDurationMs` at `10000` and either zero kills or a tied score, wait for expiry.
Expected: server logs `Time! Sudden death.` and does NOT enter victory. Restore default to `120000`.

- [ ] **Step 5: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: end match on timer expiry, enter sudden death on tie"
```

---

## Task 5: Make sudden death play like the playing phase and resolve on first decisive kill

**Files:**
- Modify: `bLEDsport-game-server/server.js:643` (`hitPlayer` early-return guard)
- Modify: `bLEDsport-game-server/server.js:671` (`handleInput` guard)
- Modify: `bLEDsport-game-server/server.js:909` (`tick` playing-phase guard region)

- [ ] **Step 1: Allow `hitPlayer` during sudden death and resolve ties**

In `hitPlayer()`, change the guard at line 643:

```js
  if (gamePhase !== 'playing') return; // game already ended
```

to:

```js
  if (gamePhase !== 'playing' && gamePhase !== 'suddenDeath') return; // game already ended
```

Then, at the END of `hitPlayer()` (after the best-of winner check block, inside the function), add a sudden-death resolution:

```js
  // Sudden death: first kill that creates a sole leader ends the match
  if (gamePhase === 'suddenDeath') {
    const leader = soleLeader();
    if (leader) declareWinner(leader, now);
  }
```

- [ ] **Step 2: Accept input during sudden death**

In `handleInput()`, change the guard at line 671:

```js
  if (gamePhase !== 'playing') return; // only accept input during gameplay
```

to:

```js
  if (gamePhase !== 'playing' && gamePhase !== 'suddenDeath') return; // only accept input during gameplay
```

- [ ] **Step 3: Run the playing-phase tick during sudden death**

The playing-phase code in `tick()` begins after the `waiting`-phase block returns (line 907) and currently runs as the fall-through for any non-victory, non-waiting phase. Confirm it runs for `suddenDeath`: the only explicit phase checks before the playing code are `if (gamePhase === 'victory')` (line 835) and `if (gamePhase === 'waiting')` (line 864), each of which `return`s. Since `suddenDeath` matches neither, execution falls through to the playing code automatically — **no change needed here** beyond the timer-expiry guard already scoped to `'playing'` in Task 4 (so the timer does not re-fire during sudden death).

Verify by reading: the idle-timeout check at line 911 will also apply during sudden death (a stalled sudden death resets after `idleResetMs`), which is the desired behavior.

- [ ] **Step 4: Manual verification — sudden death resolves on a kill**

With `matchDurationMs` at `10000`, force a tie (e.g. two players, equal scores), let the timer expire into sudden death (server logs `Time! Sudden death.`). Then have one player kill another.
Expected: server logs `<name> wins!` and enters victory. Restore default to `120000`.

- [ ] **Step 5: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: resolve sudden death on first decisive kill"
```

---

## Task 6: Map sudden death to phase 3 and append timer bytes in the packet

**Files:**
- Modify: `bLEDsport-game-server/server.js:1496` (phase mapping)
- Modify: `bLEDsport-game-server/server.js:1505-1514` (size calc)
- Modify: `bLEDsport-game-server/server.js:1584-1599` (write portals + victory, then append timer)

- [ ] **Step 1: Map the phase number**

Replace line 1496:

```js
  const phase = msg.gamePhase === 'waiting' ? 0 : msg.gamePhase === 'playing' ? 1 : 2;
```

with:

```js
  const phase = msg.gamePhase === 'waiting' ? 0
    : msg.gamePhase === 'playing' ? 1
    : msg.gamePhase === 'suddenDeath' ? 3
    : 2;
```

Note: the victory branch already keys off `phase === 2`, and `suddenDeath` (3) correctly skips it.

- [ ] **Step 2: Compute the timer values**

Immediately after the `const phase = ...` assignment (and after `nameBytes` is computed around line 1498), add:

```js
  const matchDurationSec = Math.min(65535, Math.round((msg.matchDurationMs || 0) / 1000));
  const matchElapsedSec = Math.min(65535, Math.max(0, Math.round((msg.matchElapsedMs || 0) / 1000)));
```

- [ ] **Step 3: Add 4 bytes to the size calculation**

In the `const size = ...` expression (lines 1505-1514), add `+ 4` for the two `Uint16` timer fields. Change the final term so the expression ends:

```js
    + 2                               // portal positions
    + (phase === 2 ? 3 + 1 + nameBytes.length : 0)
    + 4;                              // matchDurationSec + matchElapsedSec (Uint16 each)
```

- [ ] **Step 4: Write the timer bytes at the absolute tail**

At the very end of the packing logic, after the victory block (after line 1597, just before `return buf;` at line 1599), add:

```js
  // Timer anchors (always present, at the very tail)
  buf.writeUInt16BE(matchDurationSec, off); off += 2;
  buf.writeUInt16BE(matchElapsedSec, off); off += 2;
```

- [ ] **Step 5: Verify the server boots and packs without error**

Run: `cd bLEDsport-game-server && bun server.js`
Expected: starts cleanly. With the external server running and a spectator connected, the server should send packets without a `RangeError` (which would indicate a size miscalculation). Watch for a few seconds, then stop.

- [ ] **Step 6: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: send timer anchors and suddenDeath phase in binary packet"
```

---

## Task 7: Populate `matchDurationMs`/`matchElapsedMs` on every broadcast

The packer reads `msg.matchDurationMs` and `msg.matchElapsedMs`. These must be present on the broadcast `msg` for all phases. The simplest place is the `broadcast()` wrapper so every phase gets them.

**Files:**
- Modify: `bLEDsport-game-server/server.js:1602` (`broadcast()`)

- [ ] **Step 1: Inject timer fields in `broadcast()`**

Change `function broadcast(msg) {` (line 1602) body so the timer fields are attached before packing. Replace:

```js
function broadcast(msg) {
  const data = JSON.stringify(msg);
```

with:

```js
function broadcast(msg) {
  msg.matchDurationMs = gameConfig.matchDurationMs;
  msg.matchElapsedMs = (gamePhase === 'playing' && matchStartAt)
    ? Date.now() - matchStartAt
    : 0;
  const data = JSON.stringify(msg);
```

Note: `matchElapsedMs` is `0` outside the `playing` phase (including `suddenDeath`), so the client shows no countdown during sudden death — the banner takes over instead.

- [ ] **Step 2: Manual verification — packet carries timer values**

Run both servers, connect a spectator, join a player, and start a game with the default `matchDurationMs` (120000). In the browser devtools console on the spectator page, the decoded `gameState` (Task 8 will surface it) should eventually show a duration of 120 and a rising elapsed value. For now, verify no errors and packets flow.

- [ ] **Step 3: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: attach timer fields to every broadcast"
```

---

## Task 8: Decode timer bytes and `suddenDeath` phase on the spectator screen

**Files:**
- Modify: `bledsport-external/index.html:406` (`PHASES`)
- Modify: `bledsport-external/index.html:100-110` (`gameState`)
- Modify: `bledsport-external/index.html:520-532` (`unpackState` tail)

- [ ] **Step 1: Add the phase and gameState fields**

Change line 406:

```js
const PHASES = ['waiting', 'playing', 'victory'];
```

to:

```js
const PHASES = ['waiting', 'playing', 'victory', 'suddenDeath'];
```

In the `gameState` object (after `victoryPlayerName: '',` at line 109), add:

```js
  matchDurationSec: 0,
  timerDeadline: 0, // performance.now() timestamp when the countdown hits zero
```

- [ ] **Step 2: Read the trailing timer bytes in `unpackState`**

The timer bytes are the last 4 bytes of the packet, after the victory block. At the end of `unpackState()` (after the victory `if/else` block ending at line 532, before the closing `}`), add:

```js
  // Timer anchors (last 4 bytes, present on all phases from newer servers)
  if (off + 4 <= buf.length) {
    const matchDurationSec = (buf[off] << 8) | buf[off + 1]; off += 2;
    const matchElapsedSec = (buf[off] << 8) | buf[off + 1]; off += 2;
    gameState.matchDurationSec = matchDurationSec;
    if (matchDurationSec > 0 && gameState.gamePhase === 'playing') {
      const remainingMs = Math.max(0, (matchDurationSec - matchElapsedSec) * 1000);
      gameState.timerDeadline = performance.now() + remainingMs;
    } else {
      gameState.timerDeadline = 0;
    }
  } else {
    // Old server without timer support
    gameState.matchDurationSec = 0;
    gameState.timerDeadline = 0;
  }
```

Note on offsets: because the victory block is variable-length and these bytes follow it, reading them only after the victory `if/else` keeps `off` correct for both victory and non-victory packets. With Task 0 applied, the decoder now matches the wire format exactly, so the trailing read is reliable.

- [ ] **Step 3: Manual verification — values decode**

Run both servers, connect a spectator, start a game (default 120s). In devtools console run `gameState.matchDurationSec` → expect `120`, and `gameState.timerDeadline` → a large positive number that, minus `performance.now()`, is ~the remaining ms.

- [ ] **Step 4: Commit**

```bash
git add bledsport-external/index.html
git commit -m "feat: decode timer anchors and suddenDeath phase on spectator screen"
```

---

## Task 9: Render the countdown and sudden-death banner

**Files:**
- Modify: `bledsport-external/index.html:342-356` (phase-specific HUD in `draw()`)

- [ ] **Step 1: Add a MM:SS formatter helper**

Near the top of the `<script>` (e.g. right after the `NUM_LEDS`/`ZONES` consts around line 45), add:

```js
function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Draw the countdown and banner**

In `renderer.draw()`, the phase-specific HUD block is at lines 342-356. Add the countdown and sudden-death rendering. Insert, right after the `victory`/`waiting` HUD block (after line 356, before the "Tick marks" comment):

```js
    // Countdown timer (center of arch, during normal play)
    if (gameState.gamePhase === 'playing' && gameState.matchDurationSec > 0 && gameState.timerDeadline) {
      const remainingMs = gameState.timerDeadline - performance.now();
      const text = formatClock(remainingMs);
      const urgent = remainingMs <= 10000;
      ctx.fillStyle = urgent ? '#ff4040' : '#ffcc44';
      ctx.font = 'bold 30px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }

    // Sudden death banner
    if (gameState.gamePhase === 'suddenDeath') {
      const pulse = 0.6 + 0.4 * Math.sin(gameState.animTime * 6);
      ctx.fillStyle = `rgba(255,60,60,${pulse})`;
      ctx.font = 'bold 30px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SUDDEN DEATH', canvas.width / 2, canvas.height / 2);
    }
```

- [ ] **Step 3: Manual verification — full countdown flow**

Run both servers. Temporarily set `matchDurationMs` default to `30000` (30s). Connect a spectator, join a player, start a game.
Expected:
- A `0:30` countdown appears in the center of the arch and ticks down smoothly (driven locally by `animLoop`, not jumping once per packet).
- In the final 10s, the countdown turns red.
- At zero with a clear leader → victory animation + `NAME WINS!`.
- At zero with a tie → red pulsing `SUDDEN DEATH` banner, no countdown; next decisive kill → victory.
Restore the default to `120000` after testing.

- [ ] **Step 4: Manual verification — timer off**

Set `matchDurationMs` to `0` (via config UI or temporary default edit). Start a game.
Expected: no countdown shown anywhere; game plays as pure best-of-X exactly like before. Restore default.

- [ ] **Step 5: Commit**

```bash
git add bledsport-external/index.html
git commit -m "feat: render countdown timer and sudden-death banner"
```

---

## Self-Review Notes

- **Spec coverage:** config field (T1), match start (T2), timer expiry + highest-score win (T3/T4), sudden death on tie + resolution (T5), phase 3 + timer anchors in protocol (T6/T7), decode + backward-compat guard (T8), countdown + banner + urgent color + timer-off (T9). Timeout win reuses the victory animation via `declareWinner` (T3/T4). All spec sections map to a task.
- **Type/name consistency:** `soleLeader()`, `declareWinner(player, now)`, `matchStartAt`, `matchDurationMs`, `matchElapsedMs` (server-side, ms) → `matchDurationSec`, `matchElapsedSec`, `timerDeadline`, `formatClock(ms)` (client-side, sec/ms). `gamePhase === 'suddenDeath'` ↔ phase number `3` ↔ `PHASES[3]`. Consistent across tasks.
- **Decoder alignment:** Task 0 removes the dead `cornerWalls` decode section that previously mis-aligned the wall/sweeper/portal offsets, so reader and writer now match the wire format exactly. Timer bytes (T6/T8) are appended strictly at the tail, after the variable-length victory block, so they don't disturb any existing section.
