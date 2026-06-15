# Spectator Throwable Orbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spectators slingshot drifting white orbs into the arch edges to trigger the existing Hand-of-God bomb, with the physical WLED arch softly glowing as an orb approaches.

**Architecture:** All orb physics/rendering/input live in the spectator client (`bledsport-external/index.html`). On approach, the client sends a throttled `orb_glow` message; on an edge hit (left/top/right), it sends the existing `god_bomb`. The game server (`bLEDsport-game-server/server.js`) stores the latest `orb_glow` as transient state and composites a soft glow into the playing-phase WLED pixels. The external relay forwards spectator JSON unchanged — no relay changes.

**Tech Stack:** Bun, plain JS, Canvas 2D, Pointer Events, hand-rolled WebSocket JSON messages.

> **Testing note:** This is a real-time visual/hardware system. Per the spec, verification is **manual** (watch the spectator screen + physical arch), not automated. Each task ends with explicit manual-verification steps and a commit. Run the spectator server with `bun run server.ts` in `bledsport-external/` and open the page; the game server runs with `bun server.js`. For client-only tasks you can verify against the deployed/local game server or just confirm the JS parses and the visuals behave.

---

## File Structure

- **Modify** `bledsport-external/index.html`
  - `.info` line (line 44): update hint text (remove click-to-bomb wording).
  - Remove the click→`god_bomb` handler (lines ~417-438).
  - Add an orb system: state, spawn/drift, slingshot input (Pointer Events), physics, rendering, nearest-LED mapping, `orb_glow`/`god_bomb` sending. New self-contained `<script>` section near the other interaction code.
  - Hook orb update+draw into the existing `animLoop()` (line 638).
- **Modify** `bLEDsport-game-server/server.js`
  - Transient `orbGlow` state near other game state (~line 414).
  - Clear `orbGlow` in `resetGame()` (~416) and `startGame()` (~446).
  - New `orb_glow` handler in the external relay's `ws.onmessage` (next to the `god_bomb` handler at line 1727).
  - Composite the glow into `pixels[]` just before the playing-phase `sendToWled(pixels)` (line 1453).

---

## Task 1: Remove click-to-bomb and update the hint text

**Files:**
- Modify: `bledsport-external/index.html:44` (info text)
- Modify: `bledsport-external/index.html:416-438` (remove click handler)

- [ ] **Step 1: Update the hint text**

Replace line 44:

```html
<div class="info">Click the arch to drop a Hand of God bomb! &middot; Double-click for fullscreen</div>
```

with:

```html
<div class="info">Grab a glowing orb and fling it at the arch! &middot; Double-click for fullscreen</div>
```

- [ ] **Step 2: Remove the click-to-bomb handler**

Delete this entire block (the "HAND OF GOD — click to drop bomb" section, lines ~416-438):

```js
// ============================================================
// HAND OF GOD — click to drop bomb
// ============================================================
canvas.addEventListener('click', (e) => {
  if (e.detail > 1) return; // part of a double-click (fullscreen toggle), not a bomb
  if (gameState.gamePhase !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  let closest = 0;
  let closestDist = Infinity;
  for (let i = 0; i < renderer.ledPositions.length; i++) {
    const lp = renderer.ledPositions[i];
    const dx = lp.x - cx;
    const dy = lp.y - cy;
    const dist = dx * dx + dy * dy;
    if (dist < closestDist) {
      closestDist = dist;
      closest = i;
    }
  }
  conn.send({ type: 'god_bomb', pos: closest });
});
```

Leave the `document.addEventListener('dblclick', …)` fullscreen handler (immediately after) intact.

- [ ] **Step 3: Verify it parses**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)`
Expected: exits 0 (no output).

Also confirm the click handler is gone: `grep -c "type: 'god_bomb'" index.html` → expect `0` (it will be re-added in Task 5).

- [ ] **Step 4: Commit**

```bash
cd /Users/georgemandis/Projects/recurse/2026/bLEDsport/bledsport-external
git add index.html
git commit -m "feat: remove click-to-bomb in favor of orbs"
```

---

## Task 2: Orb state, spawn, and drift

**Files:**
- Modify: `bledsport-external/index.html` (add orb module after the dblclick handler; hook into `animLoop`)

- [ ] **Step 1: Add the orb module**

After the `document.addEventListener('dblclick', …)` handler block, insert this new section. It defines all tuning constants up top, the `orbs` array, spawn timer, and an `updateOrbs(dt)` function. (Physics for held/flying orbs is added in later tasks; this task implements drifting + spawn + expire.)

```js
// ============================================================
// THROWABLE ORBS
// ============================================================
const ORB = {
  SPAWN_MIN_MS: 5000,    // min gap between spawns
  SPAWN_MAX_MS: 8000,    // max gap between spawns
  MAX_COUNT: 3,          // max concurrent orbs
  LIFETIME_MS: 12000,    // a drifting orb expires after this
  RADIUS: 16,            // visual + grab radius (px)
  DRIFT_SPEED: 0.25,     // gentle drift velocity (px/frame baseline)
  CENTER_PULL: 0.0006,   // soft steer back toward center
  FLING_K: 0.18,         // launch speed = pull distance * FLING_K
  MAX_SPEED: 22,         // cap launch speed (px/frame)
  FRICTION: 0.992,       // per-frame velocity decay in flight
  STALL_SPEED: 1.2,      // below this, a flying orb reverts to drifting
  MIN_PULL: 12,          // pull shorter than this = mis-grab, no launch
  GLOW_RADIUS_FRAC: 0.25,// glow kicks in within this fraction of min(vw,vh)
  GLOW_THROTTLE_MS: 100, // min gap between orb_glow sends
};

const orbs = [];
let heldOrb = null;
let nextSpawnAt = 0;

function spawnOrb() {
  const w = canvas.width, h = canvas.height;
  // near center, with a little jitter
  const jitter = () => (Math.random() - 0.5);
  orbs.push({
    x: w / 2 + jitter() * w * 0.2,
    y: h / 2 + jitter() * h * 0.2,
    vx: jitter() * ORB.DRIFT_SPEED,
    vy: jitter() * ORB.DRIFT_SPEED,
    state: 'drifting',
    bornAt: performance.now(),
    lastGlowAt: 0,
  });
}

function updateOrbs(now) {
  // Spawn timing
  if (now >= nextSpawnAt && orbs.length < ORB.MAX_COUNT) {
    spawnOrb();
    nextSpawnAt = now + ORB.SPAWN_MIN_MS + Math.random() * (ORB.SPAWN_MAX_MS - ORB.SPAWN_MIN_MS);
  }

  const w = canvas.width, h = canvas.height;
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (o.state === 'drifting') {
      // gentle drift + soft centering
      o.vx += (w / 2 - o.x) * ORB.CENTER_PULL;
      o.vy += (h / 2 - o.y) * ORB.CENTER_PULL;
      o.x += o.vx;
      o.y += o.vy;
      // expire if untouched too long
      if (now - o.bornAt > ORB.LIFETIME_MS) {
        orbs.splice(i, 1);
      }
    }
    // 'held' and 'flying' handled in later tasks
  }
}
```

- [ ] **Step 2: Hook into the animation loop**

Find the `animLoop()` function (around line 638):

```js
function animLoop() {
  gameState.animTime += 0.03;
  renderer.draw();
  requestAnimationFrame(animLoop);
}
```

Change it to update + draw orbs each frame:

```js
function animLoop() {
  gameState.animTime += 0.03;
  renderer.draw();
  updateOrbs(performance.now());
  drawOrbs();
  requestAnimationFrame(animLoop);
}
```

- [ ] **Step 3: Add a temporary `drawOrbs` stub**

So the loop runs before Task 4 adds real rendering, add a minimal `drawOrbs` right after `updateOrbs`:

```js
function drawOrbs() {
  for (const o of orbs) {
    ctx.beginPath();
    ctx.arc(o.x, o.y, ORB.RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
  }
}
```

(Task 4 replaces this with the full visual.)

- [ ] **Step 4: Verify**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.

Then run the server and watch: `bun run server.ts` (in `bledsport-external/`), open the page. Expected: white circles fade in near center every ~5-8s (up to 3), drift gently, and disappear after ~12s. They won't be grabbable yet.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: spawn and drift throwable orbs"
```

---

## Task 3: Slingshot input (grab, pull, release)

**Files:**
- Modify: `bledsport-external/index.html` (add pointer handlers in the orb module)

- [ ] **Step 1: Add a nearest-LED helper**

This is reused for glow + explosion. Add it inside the orb module (e.g. right after `spawnOrb`):

```js
// Nearest arch LED index to a screen point (squared distance).
function nearestLed(px, py) {
  let best = 0, bestDist = Infinity;
  const pts = renderer.ledPositions;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - px, dy = pts[i].y - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}
```

- [ ] **Step 2: Add pointer handlers**

Add these handlers in the orb module. They implement slingshot: press on an orb to hold it (anchor = its position), drag to set a pull vector, release to launch opposite the pull.

```js
function orbAtPoint(px, py) {
  // topmost orb under the point, within grab radius
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    const dx = o.x - px, dy = o.y - py;
    if (dx * dx + dy * dy <= ORB.RADIUS * ORB.RADIUS * 4) return o; // 2x radius grab
  }
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const o = orbAtPoint(px, py);
  if (!o) return;
  heldOrb = o;
  o.state = 'held';
  o.anchorX = o.x;       // launch origin
  o.anchorY = o.y;
  o.pullX = px;          // current pointer (= pulled position)
  o.pullY = py;
  o.vx = 0; o.vy = 0;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!heldOrb) return;
  const rect = canvas.getBoundingClientRect();
  heldOrb.pullX = e.clientX - rect.left;
  heldOrb.pullY = e.clientY - rect.top;
  // the orb visually sits at the pulled-back position
  heldOrb.x = heldOrb.pullX;
  heldOrb.y = heldOrb.pullY;
});

canvas.addEventListener('pointerup', (e) => {
  if (!heldOrb) return;
  const o = heldOrb;
  heldOrb = null;
  const pullX = o.pullX - o.anchorX;
  const pullY = o.pullY - o.anchorY;
  const pullLen = Math.hypot(pullX, pullY);
  if (pullLen < ORB.MIN_PULL) {
    // mis-grab — drop it back to drifting at the anchor
    o.x = o.anchorX; o.y = o.anchorY;
    o.state = 'drifting';
    return;
  }
  // launch opposite the pull, speed scaled by pull length, capped
  let vx = -pullX * ORB.FLING_K;
  let vy = -pullY * ORB.FLING_K;
  const sp = Math.hypot(vx, vy);
  if (sp > ORB.MAX_SPEED) { vx = vx / sp * ORB.MAX_SPEED; vy = vy / sp * ORB.MAX_SPEED; }
  o.vx = vx; o.vy = vy;
  o.x = o.anchorX; o.y = o.anchorY; // launch from the anchor
  o.state = 'flying';
});
```

- [ ] **Step 3: Verify parses**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.

(Flying motion + edge handling come in Task 5; for now a launched orb sets velocity but `updateOrbs` doesn't yet integrate the `flying` state, so it will sit still after release. That's expected and fixed in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: slingshot grab-and-pull input for orbs"
```

---

## Task 4: Orb rendering (orb visual, slingshot aim, on-screen glow, burst)

**Files:**
- Modify: `bledsport-external/index.html` (replace the `drawOrbs` stub)

- [ ] **Step 1: Replace the `drawOrbs` stub with the full visual**

Replace the temporary `drawOrbs` from Task 2 with:

```js
const orbBursts = []; // {x, y, r, max, bornAt}

function drawOrbs() {
  const now = performance.now();

  // Explosion bursts (expanding ring), drawn first
  for (let i = orbBursts.length - 1; i >= 0; i--) {
    const b = orbBursts[i];
    const t = (now - b.bornAt) / 350;
    if (t >= 1) { orbBursts.splice(i, 1); continue; }
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.max * t, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${1 - t})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  for (const o of orbs) {
    // Slingshot aim line while held
    if (o.state === 'held') {
      const dx = o.anchorX - o.pullX, dy = o.anchorY - o.pullY; // launch dir = opposite pull
      ctx.beginPath();
      ctx.moveTo(o.pullX, o.pullY);
      ctx.lineTo(o.anchorX + dx, o.anchorY + dy);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Soft glow halo
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, ORB.RADIUS * 2.2);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(o.x, o.y, ORB.RADIUS * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(o.x, o.y, ORB.RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
  }
}
```

- [ ] **Step 2: Add on-screen proximity glow on the arch dots**

When a flying orb is near its predicted impact LED, brighten nearby arch dots locally. Add this helper in the orb module and call it from `drawOrbs` (top, before the orb loop):

```js
function drawArchProximityGlow() {
  const w = canvas.width, h = canvas.height;
  const glowRadiusPx = Math.min(w, h) * ORB.GLOW_RADIUS_FRAC;
  for (const o of orbs) {
    if (o.state !== 'flying') continue;
    const led = nearestLed(o.x, o.y);
    const lp = renderer.ledPositions[led];
    const dist = Math.hypot(lp.x - o.x, lp.y - o.y);
    if (dist > glowRadiusPx) continue;
    const intensity = 1 - dist / glowRadiusPx; // 0..1
    // brighten a few dots around the impact LED
    for (let d = -3; d <= 3; d++) {
      const idx = led + d;
      if (idx < 0 || idx >= renderer.ledPositions.length) continue;
      const p = renderer.ledPositions[idx];
      const fall = (1 - Math.abs(d) / 4) * intensity;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,220,255,${0.6 * fall})`;
      ctx.fill();
    }
  }
}
```

Then add `drawArchProximityGlow();` as the first line inside `drawOrbs()` (before the bursts loop).

- [ ] **Step 3: Verify**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.

Run the server and open the page. Expected: orbs now have a soft white halo + core. Press-drag an orb and you should see a dashed aim line. (Flight + bursts + arch glow become visible once Task 5 makes orbs actually fly.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: render orbs, slingshot aim line, bursts, and on-screen arch glow"
```

---

## Task 5: Flight physics, edge collision, and message sending

**Files:**
- Modify: `bledsport-external/index.html` (extend `updateOrbs` for held/flying; send messages)

- [ ] **Step 1: Handle held + flying in `updateOrbs`**

In `updateOrbs(now)`, replace the loop body so it handles all three states. Find the existing loop:

```js
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (o.state === 'drifting') {
      // gentle drift + soft centering
      o.vx += (w / 2 - o.x) * ORB.CENTER_PULL;
      o.vy += (h / 2 - o.y) * ORB.CENTER_PULL;
      o.x += o.vx;
      o.y += o.vy;
      // expire if untouched too long
      if (now - o.bornAt > ORB.LIFETIME_MS) {
        orbs.splice(i, 1);
      }
    }
    // 'held' and 'flying' handled in later tasks
  }
```

Replace it with:

```js
  const glowRadiusPx = Math.min(w, h) * ORB.GLOW_RADIUS_FRAC;
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (o.state === 'drifting') {
      o.vx += (w / 2 - o.x) * ORB.CENTER_PULL;
      o.vy += (h / 2 - o.y) * ORB.CENTER_PULL;
      o.x += o.vx;
      o.y += o.vy;
      if (now - o.bornAt > ORB.LIFETIME_MS) orbs.splice(i, 1);
    } else if (o.state === 'held') {
      // position is driven by pointermove; nothing to integrate
    } else if (o.state === 'flying') {
      o.x += o.vx;
      o.y += o.vy;
      o.vx *= ORB.FRICTION;
      o.vy *= ORB.FRICTION;

      // edge collision
      if (o.x < 0 || o.x > w || o.y < 0 || o.y > h) {
        explodeOrb(o, o.y > h /* exited bottom? */);
        orbs.splice(i, 1);
        continue;
      }

      // too-soft throw: revert to drifting
      if (Math.hypot(o.vx, o.vy) < ORB.STALL_SPEED) {
        o.state = 'drifting';
        o.bornAt = now; // reset lifetime
        continue;
      }

      // proximity glow → throttled orb_glow message
      const led = nearestLed(o.x, o.y);
      const lp = renderer.ledPositions[led];
      const dist = Math.hypot(lp.x - o.x, lp.y - o.y);
      if (dist <= glowRadiusPx && now - o.lastGlowAt >= ORB.GLOW_THROTTLE_MS) {
        const intensity = 1 - dist / glowRadiusPx;
        conn.send({ type: 'orb_glow', pos: led, intensity });
        o.lastGlowAt = now;
      }
    }
  }
```

- [ ] **Step 2: Add `explodeOrb`**

Add this function in the orb module. Bottom-edge exits are "wasted" (no `god_bomb`); left/top/right fire the real bomb. A burst is shown either way.

```js
function explodeOrb(o, exitedBottom) {
  // visual burst at the orb's last position (clamped into view)
  const bx = Math.max(0, Math.min(canvas.width, o.x));
  const by = Math.max(0, Math.min(canvas.height, o.y));
  orbBursts.push({ x: bx, y: by, max: 60, bornAt: performance.now() });

  if (exitedBottom) return; // wasted — no arch response

  const led = nearestLed(bx, by);
  conn.send({ type: 'god_bomb', pos: led });
}
```

- [ ] **Step 3: Verify parses**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.

Confirm the message types are present: `grep -c "type: 'god_bomb'" index.html` → `1`; `grep -c "type: 'orb_glow'" index.html` → `1`.

- [ ] **Step 4: Manual verification (client behavior)**

Run the spectator server, open the page. Expected:
- Slingshot an orb → it flies straight in the launch direction, slowing slightly.
- A soft throw stalls and becomes a drifting (grabbable) orb again.
- Reaching the left/top/right edge → burst at the edge. Reaching the bottom edge → burst but (per design) no bomb.
- With the game server connected and a match in `playing`, a left/top/right hit should drop a Hand-of-God bomb on the arch.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: orb flight, edge explosion, and orb_glow/god_bomb messages"
```

---

## Task 6: Server-side glow state + handler

**Files:**
- Modify: `bLEDsport-game-server/server.js` (state ~414, resetGame ~416, startGame ~446, handler ~1727)

- [ ] **Step 1: Add transient `orbGlow` state**

Find the game-state area near `let portalBlinking = false;` (around line 414). Immediately after that line, add:

```js
let orbGlow = null; // transient spectator-orb proximity glow: { pos, intensity, at }
```

- [ ] **Step 2: Clear it on reset and start**

In `resetGame()`, find its `portalBlinking = false;` line (around line 441) and add right after it:

```js
  orbGlow = null;
```

In `startGame()`, find its `portalBlinking = false;` line (around line 481) and add right after it:

```js
  orbGlow = null;
```

- [ ] **Step 3: Add the `orb_glow` handler**

In the external relay's `ws.onmessage`, find the `god_bomb` handler (line 1727):

```js
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
```

Immediately AFTER that `}` (still inside the `try`), add:

```js
        if (input.type === 'orb_glow') {
          if (!gameConfig.spectatorInteraction) return;
          if (gamePhase !== 'playing') return;
          const pos = Math.round(input.pos);
          if (pos < 0 || pos >= NUM_LEDS) return;
          const intensity = Math.max(0, Math.min(1, input.intensity || 0));
          orbGlow = { pos, intensity, at: Date.now() };
        }
```

- [ ] **Step 4: Verify boots**

Run: `cd bLEDsport-game-server && node --check server.js` → no output (parses).
Then: `timeout 4 bun server.js 2>&1 | head -10 ; true` → boots with no SyntaxError/ReferenceError (WLED/network warnings are expected).

Confirm: `grep -n "orbGlow" server.js` shows the declaration, two clears, and the handler assignment.

- [ ] **Step 5: Commit**

```bash
cd /Users/georgemandis/Projects/recurse/2026/bLEDsport/bLEDsport-server
git add bLEDsport-game-server/server.js
git commit -m "feat: accept orb_glow messages and track transient glow state"
```

---

## Task 7: Composite the glow into the WLED output

**Files:**
- Modify: `bLEDsport-game-server/server.js:1453` (playing-phase `sendToWled`)

- [ ] **Step 1: Composite the glow before `sendToWled`**

Find the playing-phase render's `sendToWled(pixels)` (line 1453):

```js
  sendToWled(pixels);
  broadcast({
    type: 'state',
```

Insert the glow compositing immediately BEFORE `sendToWled(pixels);`:

```js
  // Spectator-orb proximity glow (additive, soft cool-white, fades fast if stale)
  if (orbGlow && Date.now() - orbGlow.at <= 150) {
    const GLOW_SPREAD = 4; // LEDs each side
    for (let d = -GLOW_SPREAD; d <= GLOW_SPREAD; d++) {
      const idx = orbGlow.pos + d;
      if (idx < 0 || idx >= NUM_LEDS) continue;
      const fall = (1 - Math.abs(d) / (GLOW_SPREAD + 1)) * orbGlow.intensity;
      const add = Math.round(120 * fall); // cool-white add
      const cur = pixels[idx] || [0, 0, 0];
      pixels[idx] = [
        Math.min(255, cur[0] + Math.round(add * 0.7)),
        Math.min(255, cur[1] + Math.round(add * 0.85)),
        Math.min(255, cur[2] + add),
      ];
    }
  }

  sendToWled(pixels);
```

Note: `pixels[idx]` may be `null` for unlit LEDs in this render path, hence the `|| [0,0,0]` guard.

- [ ] **Step 2: Verify boots**

Run: `cd bLEDsport-game-server && node --check server.js` → parses.
Then: `timeout 4 bun server.js 2>&1 | head -10 ; true` → boots cleanly.

- [ ] **Step 3: Manual verification (end-to-end, needs hardware/spectator)**

With the game server (this code) and the spectator screen both running and a match in `playing`:
- Slingshot an orb toward the left/top/right edge.
- Expected: as the orb approaches, the physical WLED arch softly glows (cool white) near the predicted impact LED, brightening as it nears; the glow fades within ~150ms after the orb passes/explodes; then the Hand-of-God bomb fires on impact.
- The glow must NOT erase players/bombs/portals (it's additive).
- With `spectatorInteraction` off: no glow and no bomb.

- [ ] **Step 4: Commit**

```bash
git add bLEDsport-game-server/server.js
git commit -m "feat: composite spectator-orb glow into WLED output"
```

---

## Self-Review Notes

- **Spec coverage:** ambient spawn/drift/expire/cap (T2); slingshot grab-pull-release + mis-grab revert (T3); straight flight + friction stall (T5); edge collision → nearest LED → god_bomb, bottom-edge wasted (T5); throttled orb_glow on approach (T5); on-screen arch glow + bursts (T4); server glow state + handler + gating + clear-on-reset/start (T6); additive WLED compositing with fast decay (T7); click-to-bomb removed + hint updated (T1); spectatorInteraction gating (T6/T7). All spec sections map to a task.
- **Name consistency:** `orbs`, `heldOrb`, `nextSpawnAt`, `updateOrbs(now)`, `drawOrbs()`, `drawArchProximityGlow()`, `spawnOrb()`, `nearestLed(px,py)`, `orbAtPoint`, `explodeOrb(o, exitedBottom)`, `orbBursts`, `ORB.*` constants (client); `orbGlow = { pos, intensity, at }` (server). The client sends `{type:'orb_glow', pos, intensity}` and the server reads exactly those fields. Consistent across tasks.
- **Ordering:** Task 2 adds a `drawOrbs` stub so `animLoop` runs; Task 4 replaces it; `orbBursts` is declared in Task 4 and used in Task 5's `explodeOrb` — Task 4 precedes Task 5, so it exists in time. `nearestLed` is added in Task 3 and used in T4/T5. No forward references at execution time.
- **No protocol change:** the relay forwards spectator JSON verbatim; `orb_glow` rides the same channel as `god_bomb`. Binary state packet untouched.
