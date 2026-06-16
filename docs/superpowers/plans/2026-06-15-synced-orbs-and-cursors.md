# Synced Orbs + Spectator Cursors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make throwable orbs relay-authoritative and synced across all spectator screens, add Yjs-Awareness spectator cursors, and brighten/thicken the aim line.

**Architecture:** The external relay (`bledsport-external/server.ts`) becomes the single source of truth for orbs: it runs a ~30 Hz physics sim in normalized 0..1 coordinates, accepts claim/drag/release input, broadcasts `orb_state` snapshots to all spectators, and emits `god_bomb`/`orb_glow` to the game server itself (browsers stop sending those). Browsers render the synced orb state, send input gestures, and show each other's cursors via Yjs Awareness over a `y-websocket` channel on `/yjs`.

**Tech Stack:** Bun, TypeScript (relay), plain JS + Canvas 2D (browser), WebSocket JSON, Yjs + y-websocket (ESM CDN in browser).

> **Testing note:** Real-time visual/multi-screen system; verification is **manual** (open 2+ browser windows, watch sync + cursors + arch). Each task ends with explicit manual/parse checks and a commit. Run the relay with `bun run server.ts` in `bledsport-external/`. The game server runs separately with `bun server.js`.

---

## File Structure

- **Modify** `bledsport-external/server.ts`
  - Add per-spectator id assignment.
  - Add `ORB` constants + `orbs[]` state + sim tick (spawn/drift/flight/friction/edge).
  - Handle `orb_claim`/`orb_drag`/`orb_release` from spectators.
  - Broadcast `orb_state` ~30/sec; emit `god_bomb`/`orb_glow` to the game server.
  - Analytic normalized→LED mapping.
  - Add `y-websocket` handler on `/yjs` for cursor Awareness.
  - Start sim on first spectator, stop + clear on last disconnect.
- **Modify** `bledsport-external/index.html`
  - Browser WS `onmessage`: handle string `orb_state` JSON (currently strings are ignored).
  - Remove the local orb sim (spawn/drift/flight/`explodeOrb`/local `god_bomb`/`orb_glow`).
  - Keep + adapt: rendering (scale normalized→pixels), input gestures (emit claim/drag/release in normalized coords), on-screen proximity glow + bursts.
  - Add Yjs cursor publish + render (ESM CDN import, try/catch).
  - Brighter/thicker aim line.

---

## Task 1: Relay — per-spectator id + ORB constants + state

**Files:**
- Modify: `bledsport-external/server.ts`

- [ ] **Step 1: Assign an id to each spectator and add orb state**

Near the top, after `let latestState: Buffer | null = null;`, add:

```ts
// --- Orb simulation state (relay-authoritative, normalized 0..1 coords) ---
const ORB = {
  TICK_MS: 33,           // ~30 Hz sim + broadcast
  SPAWN_MIN_MS: 5000,
  SPAWN_MAX_MS: 8000,
  MAX_COUNT: 3,
  LIFETIME_MS: 12000,
  DRIFT_SPEED: 0.0004,   // normalized units per tick
  CENTER_PULL: 0.0006,
  FLING_K: 0.10,         // launch vel = pull(normalized) * FLING_K
  MAX_SPEED: 0.035,      // normalized units per tick
  FRICTION: 0.992,
  STALL_SPEED: 0.002,
  MIN_PULL: 0.02,        // normalized pull below this = mis-grab
  GLOW_RADIUS_FRAC: 0.25,
  GLOW_THROTTLE_MS: 100,
};

type Orb = {
  id: number; x: number; y: number; vx: number; vy: number;
  state: 'drifting' | 'held' | 'flying';
  bornAt: number; heldBy: number | null; lastGlowAt: number;
  anchorX: number; anchorY: number; pullX: number; pullY: number;
};

const orbs: Orb[] = [];
let nextOrbId = 1;
let nextSpectatorId = 1;
let orbTimer: any = null;
let nextSpawnAt = 0;
```

- [ ] **Step 2: Tag spectators with an id on connect**

In `websocket.open`, the spectator branch currently is:

```ts
      } else {
        spectators.add(ws);
        ws.send(JSON.stringify({ type: "spectating" }));
        if (latestState) ws.send(latestState);
        console.log(`Spectator connected (${spectators.size} total)`);
        notifySpectatorCount();
      }
```

Replace with:

```ts
      } else {
        (ws.data as any).id = nextSpectatorId++;
        spectators.add(ws);
        ws.send(JSON.stringify({ type: "spectating" }));
        if (latestState) ws.send(latestState);
        console.log(`Spectator connected (${spectators.size} total)`);
        notifySpectatorCount();
        startOrbSim();
      }
```

(`startOrbSim` is defined in Task 2; this references it ahead of definition, which is fine for a hoisted `function` declaration.)

- [ ] **Step 3: Verify it parses/boots**

Run: `cd bledsport-external && bun build server.ts --target=bun > /dev/null && echo BUILD_OK` (type-checks/parses). If `bun build` is unavailable, `bun run --smol -e "import('./server.ts')"` won't work cleanly — instead just `node --check` won't handle TS; rely on the boot in the next step.

- [ ] **Step 4: Commit**

```bash
cd /Users/georgemandis/Projects/recurse/2026/bLEDsport/bledsport-external
git add server.ts
git commit -m "feat: relay orb state scaffolding + spectator ids"
```

---

## Task 2: Relay — sim tick (spawn, drift, flight, edge), start/stop

**Files:**
- Modify: `bledsport-external/server.ts`

- [ ] **Step 1: Add the analytic normalized→LED mapper**

Add near the orb state (module scope). The arch is a ⊓ over 192 LEDs: left 0–57 (bottom→top), top 58–134 (left→right), right 135–191 (top→bottom). Returns an LED index, or `-1` for the open bottom (wasted).

```ts
const NUM_LEDS = 192;
// Map a normalized edge-exit point to an arch LED index. -1 = bottom (wasted).
function edgeToLed(x: number, y: number): number {
  // Pick the edge by which boundary was crossed most.
  const overLeft = -x, overRight = x - 1, overTop = -y, overBottom = y - 1;
  const m = Math.max(overLeft, overRight, overTop, overBottom);
  if (m === overBottom) return -1; // open bottom
  if (m === overLeft) {
    const t = Math.min(1, Math.max(0, y));      // 0 top .. 1 bottom
    return Math.round((1 - t) * 57);            // bottom(0)→top(57) ⇒ invert
  }
  if (m === overTop) {
    const t = Math.min(1, Math.max(0, x));      // 0 left .. 1 right
    return 58 + Math.round(t * (134 - 58));
  }
  // right edge
  const t = Math.min(1, Math.max(0, y));        // 0 top .. 1 bottom
  return 135 + Math.round(t * (191 - 135));
}
```

- [ ] **Step 2: Add spawn + sim tick + start/stop**

Add these functions (module scope):

```ts
function spawnOrb() {
  const j = () => (Math.random() - 0.5);
  orbs.push({
    id: nextOrbId++,
    x: 0.5 + j() * 0.2, y: 0.5 + j() * 0.2,
    vx: j() * ORB.DRIFT_SPEED, vy: j() * ORB.DRIFT_SPEED,
    state: 'drifting', bornAt: Date.now(), heldBy: null, lastGlowAt: 0,
    anchorX: 0, anchorY: 0, pullX: 0, pullY: 0,
  });
}

function sendToGame(msg: any) {
  if (gameServerWs) gameServerWs.send(JSON.stringify(msg));
}

function orbTick() {
  const now = Date.now();
  if (now >= nextSpawnAt && orbs.length < ORB.MAX_COUNT) {
    spawnOrb();
    nextSpawnAt = now + ORB.SPAWN_MIN_MS + Math.random() * (ORB.SPAWN_MAX_MS - ORB.SPAWN_MIN_MS);
  }
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (o.state === 'drifting') {
      o.vx += (0.5 - o.x) * ORB.CENTER_PULL;
      o.vy += (0.5 - o.y) * ORB.CENTER_PULL;
      o.x += o.vx; o.y += o.vy;
      if (now - o.bornAt > ORB.LIFETIME_MS) orbs.splice(i, 1);
    } else if (o.state === 'flying') {
      o.x += o.vx; o.y += o.vy;
      o.vx *= ORB.FRICTION; o.vy *= ORB.FRICTION;
      if (o.x < 0 || o.x > 1 || o.y < 0 || o.y > 1) {
        const led = edgeToLed(o.x, o.y);
        if (led >= 0) sendToGame({ type: 'god_bomb', pos: led });
        orbs.splice(i, 1);
        continue;
      }
      if (Math.hypot(o.vx, o.vy) < ORB.STALL_SPEED) {
        o.state = 'drifting'; o.bornAt = now; continue;
      }
      // proximity glow (predict the nearest edge LED by clamping the current point)
      const led = edgeToLed(
        o.x <= o.y && o.x <= 1 - o.x ? 0 : (1 - o.x < o.x ? 1 : o.x),
        o.y
      );
      // distance to the nearest edge (normalized)
      const edgeDist = Math.min(o.x, 1 - o.x, o.y); // ignore bottom
      if (led >= 0 && edgeDist <= ORB.GLOW_RADIUS_FRAC && now - o.lastGlowAt >= ORB.GLOW_THROTTLE_MS) {
        const intensity = 1 - edgeDist / ORB.GLOW_RADIUS_FRAC;
        sendToGame({ type: 'orb_glow', pos: led, intensity });
        o.lastGlowAt = now;
      }
    }
    // 'held' integrates nothing; position set by orb_drag
  }
  broadcastOrbs();
}

function broadcastOrbs() {
  const payload = JSON.stringify({
    type: 'orb_state',
    orbs: orbs.map(o => ({
      id: o.id, x: o.x, y: o.y, state: o.state, heldBy: o.heldBy,
      anchorX: o.anchorX, anchorY: o.anchorY, pullX: o.pullX, pullY: o.pullY,
    })),
  });
  for (const s of spectators) s.send(payload);
}

function startOrbSim() {
  if (orbTimer) return;
  nextSpawnAt = Date.now() + 1000;
  orbTimer = setInterval(orbTick, ORB.TICK_MS);
}

function stopOrbSim() {
  if (orbTimer) { clearInterval(orbTimer); orbTimer = null; }
  orbs.length = 0;
}
```

NOTE on the glow `led` line: it picks left/right/top by which boundary the orb is closest to (bottom excluded from `edgeDist`), so the predicted impact LED tracks the nearest non-bottom edge. This is approximate but only drives a soft glow; exactness isn't required.

- [ ] **Step 3: Stop the sim when the last spectator leaves**

In `websocket.close`, the spectator branch currently:

```ts
      } else {
        spectators.delete(ws);
        console.log(`Spectator disconnected (${spectators.size} total)`);
        notifySpectatorCount();
      }
```

Replace with:

```ts
      } else {
        spectators.delete(ws);
        // release any orb this spectator was holding
        const id = (ws.data as any).id;
        for (const o of orbs) if (o.heldBy === id) { o.heldBy = null; o.state = 'drifting'; o.bornAt = Date.now(); }
        console.log(`Spectator disconnected (${spectators.size} total)`);
        notifySpectatorCount();
        if (spectators.size === 0) stopOrbSim();
      }
```

- [ ] **Step 4: Verify boots**

Run: `cd bledsport-external && PORT=3990 timeout 4 bun run server.ts 2>&1 | head -5 ; true`
Expected: `External server running...` with no TS/runtime error.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: relay orb physics sim, edge->LED mapping, broadcast"
```

---

## Task 3: Relay — claim/drag/release input handling

**Files:**
- Modify: `bledsport-external/server.ts`

- [ ] **Step 1: Handle orb input in the spectator message branch**

In `websocket.message`, the spectator branch currently:

```ts
      } else {
        // Spectator sending JSON input — forward to game server
        if (gameServerWs) {
          gameServerWs.send(message);
        }
      }
```

Replace with:

```ts
      } else {
        // Spectator JSON: orb input is handled here; everything else forwards to the game server.
        let input: any = null;
        try { input = JSON.parse(typeof message === "string" ? message : message.toString()); } catch {}
        const sid = (ws.data as any).id;
        if (input && input.type === 'orb_claim') {
          const o = orbs.find(o => o.id === input.id);
          if (o && o.heldBy == null && o.state !== 'flying') {
            o.heldBy = sid; o.state = 'held';
            o.anchorX = o.x; o.anchorY = o.y; o.pullX = o.x; o.pullY = o.y;
            o.vx = 0; o.vy = 0;
          }
        } else if (input && input.type === 'orb_drag') {
          const o = orbs.find(o => o.id === input.id);
          if (o && o.heldBy === sid) {
            o.pullX = input.x; o.pullY = input.y; o.x = input.x; o.y = input.y;
          }
        } else if (input && input.type === 'orb_release') {
          const o = orbs.find(o => o.id === input.id);
          if (o && o.heldBy === sid) {
            o.heldBy = null;
            const dx = o.pullX - o.anchorX, dy = o.pullY - o.anchorY;
            const pullLen = Math.hypot(dx, dy);
            o.x = o.anchorX; o.y = o.anchorY;
            if (pullLen < ORB.MIN_PULL) { o.state = 'drifting'; o.bornAt = Date.now(); }
            else {
              let vx = -dx * ORB.FLING_K, vy = -dy * ORB.FLING_K;
              const sp = Math.hypot(vx, vy);
              if (sp > ORB.MAX_SPEED) { vx = vx / sp * ORB.MAX_SPEED; vy = vy / sp * ORB.MAX_SPEED; }
              o.vx = vx; o.vy = vy; o.state = 'flying';
            }
          }
        } else if (gameServerWs) {
          gameServerWs.send(message); // forward any other input (unchanged behavior)
        }
      }
```

- [ ] **Step 2: Verify boots**

Run: `cd bledsport-external && PORT=3990 timeout 4 bun run server.ts 2>&1 | head -5 ; true` → boots cleanly.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: relay handles orb claim/drag/release"
```

---

## Task 4: Browser — receive orb_state, remove local sim

**Files:**
- Modify: `bledsport-external/index.html`

- [ ] **Step 1: Handle string orb_state in the WS onmessage**

The browser currently IGNORES all string messages:

```js
    this.ws.onmessage = (e) => {
      // Text messages (e.g. {"type":"spectating"}) — ignore
      if (typeof e.data === 'string') return;

      // Binary state update
      const buf = new Uint8Array(e.data);
      unpackState(buf);
    };
```

Replace with:

```js
    this.ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg && msg.type === 'orb_state') onOrbState(msg.orbs);
        return;
      }
      const buf = new Uint8Array(e.data);
      unpackState(buf);
    };
```

- [ ] **Step 2: Replace the orb state model + remove local sim**

Replace the block from `function spawnOrb() {` through the end of `explodeOrb` (the function ending with the `conn.send({ type: 'god_bomb', pos: led });` line and its closing `}`) — i.e. delete `spawnOrb`, `updateOrbs`, `explodeOrb`, and the local spawn timer usage — and replace `orbAtPoint`/pointer handlers with normalized versions. Concretely:

Delete `spawnOrb`, `updateOrbs`, and `explodeOrb` entirely. Keep `nearestLed` (still used by the local proximity-glow visual). Replace the orb array declaration and add a synced-state receiver. Find the existing declarations near the top of the orb section:

```js
const orbs = [];
let heldOrb = null;
let nextSpawnAt = 0;
```

Replace with:

```js
// Synced orbs come from the relay as normalized 0..1 coords.
let orbs = [];          // latest snapshot: {id,x,y,state,heldBy,anchorX,anchorY,pullX,pullY}
const prevOrbById = {}; // for burst-on-disappear detection
let myHeldId = null;    // orb id this screen is currently dragging
const MY_CLIENT = { id: Math.floor(Math.random() * 1e9) };

function onOrbState(list) {
  // detect flying orbs that vanished → burst at their last spot
  const seen = new Set(list.map(o => o.id));
  for (const id in prevOrbById) {
    if (!seen.has(Number(id))) {
      const p = prevOrbById[id];
      if (p.state === 'flying') {
        orbBursts.push({ x: p.x * canvas.width, y: p.y * canvas.height, max: 60, bornAt: performance.now() });
      }
      delete prevOrbById[id];
    }
  }
  for (const o of list) prevOrbById[o.id] = o;
  orbs = list;
}
```

- [ ] **Step 3: Verify parses**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.
Confirm local sim gone: `grep -c "function updateOrbs\|function spawnOrb\|function explodeOrb" index.html` → expect 0.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: browser receives synced orb_state, removes local sim"
```

---

## Task 5: Browser — input gestures emit claim/drag/release (normalized)

**Files:**
- Modify: `bledsport-external/index.html`

- [ ] **Step 1: Replace the pointer handlers**

Replace the existing `orbAtPoint` + the three `canvas.addEventListener('pointer…')` handlers with normalized, relay-driven versions:

```js
function orbAtPoint(nx, ny) {
  // nearest synced orb within grab radius (normalized); returns its id or null
  const grab = 0.04; // normalized grab radius
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (o.state === 'flying') continue;
    const dx = o.x - nx, dy = o.y - ny;
    if (dx * dx + dy * dy <= grab * grab) return o.id;
  }
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / canvas.width;
  const ny = (e.clientY - rect.top) / canvas.height;
  const id = orbAtPoint(nx, ny);
  if (id == null) return;
  myHeldId = id;
  conn.send({ type: 'orb_claim', id });
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (myHeldId == null) return;
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / canvas.width;
  const ny = (e.clientY - rect.top) / canvas.height;
  conn.send({ type: 'orb_drag', id: myHeldId, x: nx, y: ny });
});

canvas.addEventListener('pointerup', (e) => {
  if (myHeldId == null) return;
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / canvas.width;
  const ny = (e.clientY - rect.top) / canvas.height;
  // velocity is derived server-side from anchor vs pull; we just send the final pull as a drag, then release
  conn.send({ type: 'orb_drag', id: myHeldId, x: nx, y: ny });
  conn.send({ type: 'orb_release', id: myHeldId });
  myHeldId = null;
});
```

NOTE: the relay computes launch velocity from `(pull - anchor)`. The client sends a final `orb_drag` then `orb_release` (no vx/vy from the client — the relay already has anchor+pull). The relay's `orb_release` handler ignores `vx/vy` and derives velocity itself, matching Task 3.

- [ ] **Step 2: Verify parses**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.
Confirm: `grep -c "type: 'orb_claim'\|type: 'orb_drag'\|type: 'orb_release'" index.html` → expect 3.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: browser orb input emits normalized claim/drag/release"
```

---

## Task 6: Browser — render synced orbs (normalized→pixels), brighter aim line

**Files:**
- Modify: `bledsport-external/index.html`

- [ ] **Step 1: Rewrite `drawOrbs` + `drawArchProximityGlow` for normalized orbs**

Replace the current `drawOrbs` and `drawArchProximityGlow` functions with versions that scale normalized coords to pixels and read `myHeldId`/`heldBy`:

```js
function drawArchProximityGlow() {
  const w = canvas.width, h = canvas.height;
  const glowRadiusPx = Math.min(w, h) * ORB_GLOW_RADIUS_FRAC;
  for (const o of orbs) {
    if (o.state !== 'flying') continue;
    const px = o.x * w, py = o.y * h;
    const led = nearestLed(px, py);
    const lp = renderer.ledPositions[led];
    const dist = Math.hypot(lp.x - px, lp.y - py);
    if (dist > glowRadiusPx) continue;
    const intensity = 1 - dist / glowRadiusPx;
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

function drawOrbs() {
  drawArchProximityGlow();
  const w = canvas.width, h = canvas.height;
  const now = performance.now();

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

  const R = 16; // orb pixel radius
  for (const o of orbs) {
    const ox = o.x * w, oy = o.y * h;
    if (o.state === 'held') {
      const ax = o.anchorX * w, ay = o.anchorY * h;
      const px = o.pullX * w, py = o.pullY * h;
      const dx = ax - px, dy = ay - py; // launch dir = opposite pull
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ax + dx, ay + dy);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, R * 2.2);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(ox, oy, R * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ox, oy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
  }
}
```

- [ ] **Step 2: Replace the old `ORB` constant references with a single client glow constant**

The browser no longer needs the full `ORB` physics constants (the relay owns physics). The only client constant still used is the glow radius fraction. Find the old `const ORB = { … }` block in the browser and replace it with:

```js
const ORB_GLOW_RADIUS_FRAC = 0.25; // on-screen proximity glow radius (fraction of min viewport dim)
```

Then ensure no remaining references to `ORB.` exist in the browser (the rewritten draw/input code above uses `ORB_GLOW_RADIUS_FRAC` and literals).

- [ ] **Step 3: Verify parses + no stale refs**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.
Run: `grep -c "ORB\." index.html` → expect 0 (no leftover `ORB.FOO` physics refs).

- [ ] **Step 4: Manual verification (two windows)**

Run the relay (`bun run server.ts`), open the page in TWO browser windows. Expected: orbs appear and drift identically in both; grabbing/pulling in one shows the pull-back + brighter/thicker dashed aim line in BOTH; releasing flies the orb in sync; an edge hit bursts in both. (Bomb on the arch requires the game server + a live match.)

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: render synced orbs in pixels; brighter, thicker aim line"
```

---

## Task 7: Relay — y-websocket handler for cursor Awareness

**Files:**
- Modify: `bledsport-external/server.ts`
- Modify: `bledsport-external/package.json`

- [ ] **Step 1: Add y-websocket as a dependency**

Run: `cd bledsport-external && bun add yjs y-websocket`
Expected: adds `yjs` and `y-websocket` to `package.json` and installs.

- [ ] **Step 2: Wire the /yjs upgrade to y-websocket's Bun-compatible handler**

y-websocket ships a `setupWSConnection` utility (CommonJS: `y-websocket/bin/utils`). In `server.ts`, add at top:

```ts
import { setupWSConnection } from "y-websocket/bin/utils";
```

In `fetch`, add a branch BEFORE the spectator `/ws` branch:

```ts
    // Yjs cursor presence channel
    if (url.pathname === "/yjs") {
      if (server.upgrade(req, { data: { role: "yjs" } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
```

In `websocket.open`, handle the yjs role FIRST:

```ts
    open(ws) {
      const role = (ws.data as any).role;
      if (role === "yjs") {
        // hand the socket to y-websocket; it manages its own messages/close
        setupWSConnection(ws as any, { } as any);
        return;
      }
      // ... existing game/spectator logic ...
```

NOTE: `setupWSConnection` expects a `ws`-style socket. Bun's ServerWebSocket is not 100% identical to the `ws` library. If `setupWSConnection` is incompatible at runtime, FALL BACK to a minimal manual Yjs-awareness relay: treat `/yjs` like a broadcast room — on `message` for role `yjs`, forward the raw bytes to all other `yjs` sockets. Implement that fallback if the import or call throws at boot.

- [ ] **Step 3: Verify boots**

Run: `cd bledsport-external && PORT=3990 timeout 4 bun run server.ts 2>&1 | head -8 ; true`
Expected: boots, `External server running…`, no import/runtime crash. If it crashes on the `setupWSConnection` import/call, implement the manual broadcast-room fallback described above and re-run until it boots.

- [ ] **Step 4: Commit**

```bash
git add server.ts package.json bun.lock*
git commit -m "feat: relay y-websocket channel for cursor presence"
```

---

## Task 8: Browser — publish + render spectator cursors

**Files:**
- Modify: `bledsport-external/index.html`

- [ ] **Step 1: Add Yjs cursor setup (ESM CDN, try/catch)**

Add a new section near the orb code. It imports Yjs from a CDN, sets up Awareness, publishes this screen's cursor on pointer move (normalized), and exposes a `getRemoteCursors()` for the renderer. Wrapped so a CDN failure can't break orbs.

```js
// ============================================================
// SPECTATOR CURSORS (Yjs Awareness over /yjs)
// ============================================================
let awareness = null;
const myCursorColor = `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`;
const cursorTrails = {}; // clientID -> [{x,y}, ...] normalized

(async () => {
  try {
    const Y = await import('https://esm.sh/yjs@13');
    const { WebsocketProvider } = await import('https://esm.sh/y-websocket@2');
    const doc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const provider = new WebsocketProvider(`${proto}//${location.host}/yjs`, 'bledsport-cursors', doc);
    awareness = provider.awareness;
    awareness.setLocalStateField('color', myCursorColor);
    window.addEventListener('pointermove', (e) => {
      if (!awareness) return;
      awareness.setLocalStateField('cursor', { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight });
    });
  } catch (err) {
    console.warn('Cursor presence unavailable:', err);
  }
})();

function getRemoteCursors() {
  if (!awareness) return [];
  const out = [];
  const me = awareness.clientID;
  awareness.getStates().forEach((state, id) => {
    if (id === me || !state.cursor) return;
    out.push({ id, x: state.cursor.x, y: state.cursor.y, color: state.color || '#fff' });
  });
  return out;
}
```

- [ ] **Step 2: Render cursors with a soft trail**

Add a `drawCursors()` function and call it from `drawOrbs` (or `animLoop`). Add this function near `drawOrbs`:

```js
function drawCursors() {
  const w = canvas.width, h = canvas.height;
  const cursors = getRemoteCursors();
  const liveIds = new Set(cursors.map(c => c.id));
  for (const id in cursorTrails) if (!liveIds.has(Number(id))) delete cursorTrails[id];

  for (const c of cursors) {
    const trail = cursorTrails[c.id] || (cursorTrails[c.id] = []);
    trail.push({ x: c.x, y: c.y });
    if (trail.length > 12) trail.shift();
    // trail
    for (let i = 0; i < trail.length; i++) {
      const t = i / trail.length;
      ctx.beginPath();
      ctx.arc(trail[i].x * w, trail[i].y * h, 3 + 3 * t, 0, Math.PI * 2);
      ctx.fillStyle = c.color.replace(')', `, ${0.15 + 0.25 * t})`).replace('hsl', 'hsla').replace('rgb', 'rgba');
      ctx.fill();
    }
    // dot
    ctx.beginPath();
    ctx.arc(c.x * w, c.y * h, 7, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
  }
}
```

Then add `drawCursors();` as the LAST line inside `drawOrbs()` (so cursors render on top).

- [ ] **Step 3: Verify parses**

Run: `cd bledsport-external && node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)` → exits 0.
Confirm: `grep -c "getRemoteCursors\|drawCursors\|esm.sh/yjs" index.html` → expect 3+.

- [ ] **Step 4: Manual verification (two windows)**

Run relay, open the page in two windows. Move the mouse in one; the OTHER window shows a colored dot + soft trail following it. Close one window; its cursor disappears in the other. If the CDN is blocked, cursors simply don't appear and a console warning shows — orbs still work.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: spectator cursors via Yjs Awareness with soft trails"
```

---

## Self-Review Notes

- **Spec coverage:** relay-authoritative sim + 30Hz broadcast (T2), normalized coords (T1/T2/T4/T5/T6), claim/drag/release (T3/T5), single source for god_bomb/orb_glow on the relay (T2), analytic edge→LED (T2), browser receives orb_state + drops local sim (T4), normalized input (T5), pixel render + brighter/thicker aim line (T6), Yjs cursor transport (T7) + publish/render with trails (T8), sim pause-when-empty + reset (T2), held-orb release on disconnect (T2), CDN try/catch (T8). All spec sections map to a task.
- **Name consistency:** relay `Orb` fields `{id,x,y,vx,vy,state,bornAt,heldBy,lastGlowAt,anchorX,anchorY,pullX,pullY}`; `orb_state` payload exposes `{id,x,y,state,heldBy,anchorX,anchorY,pullX,pullY}` (no vx/vy needed by clients). Browser reads exactly those. Messages: `orb_claim{id}`, `orb_drag{id,x,y}`, `orb_release{id}` — relay handlers match. `edgeToLed`, `startOrbSim`/`stopOrbSim`, `onOrbState`, `getRemoteCursors`, `drawCursors`, `ORB_GLOW_RADIUS_FRAC` consistent.
- **Velocity note:** client `orb_release` sends no vx/vy; relay derives velocity from (pull-anchor). T5 and T3 agree on this.
- **Ordering:** `orbBursts` already exists in index.html (from the prior orbs feature); T4's `onOrbState` and T6's draw both use it — present. `nearestLed` kept in T4. `ORB.` physics refs removed in T6 after the sim is gone (T4 removed the functions; T6 removes the constant) — confirm grep in T6.
- **Risk flagged:** y-websocket's `setupWSConnection` may not be Bun-ServerWebSocket-compatible; T7 includes an explicit manual-broadcast-room fallback so the task can't get stuck.
