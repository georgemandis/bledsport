# Synced Orbs + Spectator Cursors Design

**Date:** 2026-06-15
**Status:** Approved

## Overview

Two changes to the spectator experience:

1. **Synced orbs.** Move the throwable-orb simulation from each browser (independent,
   unsynced) to the **external relay** (`bledsport-external/server.ts`), which becomes
   authoritative. The relay runs spawn/drift/flight physics and broadcasts orb state to
   all spectators ~30×/sec, so every screen — including the projection — shows the same
   orbs moving in sync. Grab-and-throw is server-authoritative (claim → drag → release),
   and the held pull-back is visible live on all screens. Orbs live in normalized
   `0..1` coordinates so screens of different size/aspect stay consistent.

2. **Spectator cursors.** Add live cursors via **Yjs Awareness** over a `y-websocket`
   channel, so each spectator sees everyone else's pointer as a colored dot with a soft
   trail. This is a separate subsystem from orbs (presence state, not simulation).

Plus a small polish: the slingshot aim line becomes brighter and thicker.

## Goals

1. Orbs spawn/drift/fly identically and in sync across all connected spectator screens.
2. Grabbing/pulling an orb on one screen is visible (pull-back + flight) on all others.
3. Exactly ONE `god_bomb`/`orb_glow` reaches the game server per orb event (no per-screen duplicates).
4. Resolution-independent: normalized coordinates render correctly on any screen size/aspect.
5. Live spectator cursors (colored dot + trail) via Yjs Awareness.
6. Brighter, thicker aim line.

## Non-Goals

- No persistence: orbs reset on relay restart; sim pauses when no spectators are connected.
- No CRDT semantics for orbs (Yjs is used ONLY for cursor presence, not orb state).
- No change to the bomb mechanics on the game server (the existing `god_bomb` path is reused).

## Architecture

Two independent subsystems:

1. **Orb sync** — JSON over the EXISTING relay WebSocket. The relay owns orb physics and
   emits `god_bomb`/`orb_glow` to the game server itself (browsers no longer send these).
2. **Cursors** — Yjs Awareness over a NEW `y-websocket` handler in the relay at path `/yjs`.

### Major change to flag

Today the browser detects orb edge-hits and sends `god_bomb`/`orb_glow` to the game
server (via relay passthrough). After this change, the **relay** runs the physics and
sends those messages to the game server directly through its existing `gameServerWs`
connection. Browsers stop sending orb-related game messages entirely. This is what
guarantees exactly one bomb per hit regardless of how many screens are watching.

## Coordinate space

All orb positions and velocities are normalized to `0..1` (fraction of viewport width
for x, height for y). The relay simulates in this space. Each browser converts to its
own pixels on render (`px = x * canvas.width`) and normalizes pointer input before
sending (`x = (clientX - rect.left) / canvas.width`).

## Component 1 — Orb sync (relay-authoritative, `bledsport-external/server.ts`)

### Relay state

An `orbs` array; each orb: `{ id, x, y, vx, vy, state, bornAt, heldBy }` where
`state ∈ {drifting, held, flying}` and `heldBy` is the owning spectator's id (or null).
A monotonic `nextOrbId` counter. Velocities are in normalized units **per tick**.

### Simulation tick

A `setInterval` at ~30 Hz (≈33 ms). Each tick:
- Spawn: every 5–8 s (jittered), up to 3 orbs, near center (0.5, 0.5 with jitter), while ≥1 spectator is connected.
- `drifting`: gentle velocity + soft centering toward (0.5, 0.5); expire after 12 s.
- `held`: position is driven by `orb_drag` from the owner; no integration.
- `flying`: integrate position, apply friction; on edge crossing → explode (below); if speed stalls below threshold → revert to drifting.
- The sim only runs while ≥1 spectator is connected (start the interval on first connect, clear it on last disconnect; orbs array cleared then too).

Tuning constants live in one `ORB` object at the top of `server.ts` (mirrors the
client constants previously used, converted to normalized units): spawn timing, max
count, lifetime, drift speed, center pull, fling multiplier, max speed, friction,
stall speed, min pull, glow radius fraction, glow throttle.

### Messages: browser → relay (JSON)

- `{type:'orb_claim', id}` — if that orb exists and is free (`heldBy == null`), set `heldBy = senderId`, `state='held'`. Otherwise ignored (already held / gone).
- `{type:'orb_drag', id, x, y}` — only honored if `heldBy === senderId`; updates the held orb's pulled position and stores the pull anchor/vector for aim rendering.
- `{type:'orb_release', id, vx, vy}` — only from the owner; sets `state='flying'` with clamped velocity, clears `heldBy`. A negligible pull (below min) reverts to drifting instead.

The relay needs a per-connection id. Assign one on spectator connect (e.g. an
incrementing integer stored on the ws `data`). On disconnect, any orb `heldBy` that id
reverts to `drifting` (so a disconnect mid-grab doesn't strand an orb).

### Messages: relay → browsers (JSON)

- `{type:'orb_state', orbs:[{id, x, y, vx, vy, state, heldBy, anchorX, anchorY, pullX, pullY}]}` broadcast every sim tick (~30/sec) to all spectators. For held orbs, include the anchor + pull so all screens can draw the pull-back and aim line.

Browsers render the latest snapshot; optional light interpolation between snapshots for
smoothness (lerp toward the latest target each animation frame).

### Edge collision → game server (relay)

When a flying orb crosses an edge, the relay maps the normalized impact to an arch LED
**analytically** (the arch is a fixed ⊓ over 192 LEDs):
- Left edge (x ≤ 0): LED = round( (1 - yNorm') * 57 ), where yNorm' maps the arch's vertical span. (Left edge runs LEDs 0–57 bottom→top.)
- Top edge (y ≤ 0): LED = 58 + round( xNorm * (134 - 58) ). (Top runs 58–134 left→right.)
- Right edge (x ≥ 1): LED = 135 + round( yNorm' * (191 - 135) ). (Right runs 135–191 top→bottom.)
- Bottom edge (y ≥ 1): **wasted** — no message.

(Use the same vertical convention the browser layout uses; the exact normalized→LED
formula is finalized during implementation against `NUM_LEDS = 192` and the ⊓ ranges
left 0–57, top 58–134, right 135–191.)

On a left/top/right hit: send `{type:'god_bomb', pos}` to `gameServerWs`, remove the orb.
While a flying orb is within the glow radius of its predicted-impact LED: send throttled
`{type:'orb_glow', pos, intensity}` (~10/sec). These go to the game server, which already
handles them (no game-server changes needed).

### Browser side (`index.html`)

- Remove the local orb simulation (spawn/drift/flight/physics) and the local
  `god_bomb`/`orb_glow` sends — the relay owns all of that now.
- Keep: rendering orbs from `orb_state` (scaled to pixels), the slingshot input gestures
  (now emitting `orb_claim`/`orb_drag`/`orb_release` in normalized coords), the on-screen
  arch proximity glow (computed locally from synced flying orbs, purely visual), and bursts
  (triggered when a previously-`flying` orb id disappears from the synced set: burst at that
  orb's last-known position from the prior snapshot).
- Orb positions from the relay are normalized; multiply by canvas dimensions to draw.

## Component 2 — Spectator cursors (Yjs Awareness)

### Transport

Add a `y-websocket` server handler in `server.ts` on path `/yjs`. Browsers use the
standard `WebsocketProvider` against a shared Yjs doc and its `awareness`.

### Dependencies

Import `yjs` and `y-websocket` in the browser via ESM CDN (`https://esm.sh/yjs`,
`https://esm.sh/y-websocket`) to preserve the no-build-step setup. The relay side uses
the `y-websocket` server utilities (its bin/server handler) wired into the Bun server.
NOTE: requires internet at page-load for cursors to initialize; orbs and the game are
unaffected if the CDN is unreachable (cursors simply won't appear — wrap the Yjs setup
in a try/catch so a CDN failure never breaks orbs).

### Behavior

- Each browser assigns itself a random color (random hue) per session.
- On pointer move, set the local awareness state: `{ cursor: {x, y}, color }` in normalized coords.
- Each animation frame, read `awareness.getStates()` and draw every OTHER client's cursor
  as a colored dot with a short fading trail (keep the last N positions per client id).
- Awareness auto-expires disconnected clients (no manual cleanup).

## Component 3 — Aim line polish

In the orb render, the slingshot aim line changes from `rgba(255,255,255,0.35)` /
`lineWidth 2` to a brighter, thicker line: `rgba(255,255,255,0.85)` and `lineWidth 4`.

## Edge Cases

- **Two spectators grab the same orb:** relay honors the first `orb_claim`; the second is ignored (orb already `heldBy` someone). The loser's grab does nothing.
- **Owner disconnects mid-grab:** on disconnect, any orb `heldBy` that id reverts to `drifting`.
- **Duplicate bombs:** impossible — only the relay emits `god_bomb` (one authority), regardless of screen count.
- **Relay restart / zero spectators:** sim stops, orbs cleared; restarts fresh when a spectator connects.
- **Yjs CDN unreachable:** cursor setup is wrapped in try/catch; orbs and game continue working, cursors just don't appear.
- **Screen size differences:** normalized coords render correctly everywhere; the projection (no pointer) is view-only.

## Testing

Manual, multi-screen (open 2+ browser windows + the projection):

1. Orbs appear and drift identically and in sync across all windows.
2. Grabbing/pulling an orb in one window shows the pull-back + aim line live in the others.
3. Releasing flies the orb in sync everywhere; it explodes at the same edge on all screens.
4. An edge hit fires exactly ONE bomb/glow on the arch (watch the game server / arch — not one per window).
5. Bottom-edge throws are wasted (no bomb) on all screens.
6. Each window shows the OTHER windows' cursors as colored dots with trails; cursors vanish when a window closes.
7. The aim line is visibly brighter and thicker.
8. Disconnecting a window mid-grab releases its held orb (reverts to drifting) for the others.
