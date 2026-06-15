# Spectator Throwable Orbs Design

**Date:** 2026-06-15
**Status:** Approved

## Overview

A spectator-screen toy layered on the existing arch view. White orbs occasionally
drift near the center of the screen. A spectator **slingshots** an orb (press,
pull back, release) toward the edges. Orbs fly in a straight line (no gravity); a
too-soft throw slows via friction and becomes grabbable again. When an orb reaches
a viewport edge it **explodes**, mapping to the nearest arch LED and firing the
existing Hand-of-God bomb (`god_bomb`). As an orb nears an edge, the **physical
WLED arch softly glows** at the predicted impact point. Throwing an orb toward the
open bottom of the arch **wastes** it (no real LEDs there → no arch response).

This **replaces** the current click-to-drop-bomb spectator interaction: the only
way a spectator triggers a bomb is by slingshotting an orb into a left/top/right edge.

## Goals

1. Ambient white orbs that drift near center, spawn occasionally, and expire if untouched.
2. Slingshot grab-and-throw (mouse + touch), straight-line flight, friction stall.
3. Edge collision → nearest arch LED → fire existing `god_bomb` (except the bottom edge, which wastes the orb).
4. Physical WLED arch softly glows near the predicted impact as an orb approaches.
5. On-screen arch dots also glow locally (no round-trip latency) + an explosion burst.
6. Gated by the existing `spectatorInteraction` config; no new config field.

## Non-Goals

- No new gameplay mechanic — the explosion reuses `god_bomb` exactly.
- No gravity or bouncing physics.
- No binary-protocol change (the glow is server→WLED only; the browser draws its own).

## Architecture

Three components across the two repos:

1. **Orb system** — spectator client (`bledsport-external/index.html`): spawn/drift/expire,
   slingshot input, straight-flight physics, edge collision, rendering.
2. **Messages** — spectator → game server: a new throttled `orb_glow` while approaching,
   and the existing `god_bomb` on explosion. The external relay forwards spectator JSON
   unchanged, so no relay code changes.
3. **Server glow rendering** — game server (`bLEDsport-game-server/server.js`): store the
   latest `orb_glow` as transient state and composite a soft glow into the playing-phase
   WLED `pixels[]` before `sendToWled`.

## Component 1 — Orb system (spectator client)

**State.** An `orbs[]` array. Each orb: `{ x, y, vx, vy, state, bornAt }`, where
`state ∈ { 'drifting', 'held', 'flying' }`. Plus a `heldOrb` reference and the current
pull anchor/vector while dragging.

**Spawn / drift.**
- A timer spawns an orb near screen center every ~5–8s (jittered), up to a cap of **3** concurrent orbs.
- Drifting orbs move with a gentle random velocity, loosely bounded to the central region (soft steer back toward center so they don't wander to the edges on their own).
- An untouched orb fades out and is removed after ~12s (`bornAt` age check); fade is visual only.

**Slingshot input (Pointer Events, mouse + touch).**
- `pointerdown`: if the point is on/near a `drifting` orb (within a grab radius), set it `held`, record the anchor = orb's current position.
- `pointermove` (while held): track the pull vector = `pointer - anchor`. The orb visually pulls back toward the pointer; draw an aim line in the launch direction (opposite the pull).
- `pointerup`: launch. `vx = -pull.x * K; vy = -pull.y * K` (slingshot = opposite the pull), with the launch speed **capped** at a max. State → `flying`. If the pull was negligible (tiny drag), revert to `drifting` (treat as a mis-grab, no launch).

**Physics (per frame, in the existing `animLoop`).**
- `drifting`: integrate gentle velocity + soft centering.
- `flying`: `x += vx; y += vy`; apply light friction each frame (`vx *= FRICTION; vy *= FRICTION`). If the speed drops below `STALL_SPEED` before reaching an edge, revert to `drifting` (the "too-soft throw" case).
- Edge collision: when the orb's position crosses any viewport edge (x<0, x>w, y<0, y>h), handle the explosion (Component 2) and remove the orb.

**Rendering.**
- Each orb: a white core with a soft radial glow.
- While `held`: draw the pull-back and an aim line indicating launch direction.
- Orbs render on the canvas; the HUD text (countdown, WINS!, etc.) stays drawn on top.
- On-screen proximity glow: as a flying orb nears its predicted-impact LED, brighten the nearby arch dots locally (immediate, no server round-trip).
- On explosion: a brief on-screen burst at the impact point.

**Removed behavior.** Delete the existing `canvas.addEventListener('click', … god_bomb …)`
handler entirely. Double-click → fullscreen remains. Update the `.info` hint text
(remove "Click the arch to drop a Hand of God bomb!", describe orbs instead).

## Component 2 — Messages

**Nearest-LED mapping.** Reuse the existing nearest-LED loop (the one the old click
handler used): given a screen point, scan `renderer.ledPositions[]` for the minimum
squared distance and return that LED index. Used for both the predicted-impact LED
(glow) and the actual-impact LED (explosion).

**Proximity glow (while flying).** Each frame a flying orb is within a glow radius
(~25% of the smaller viewport dimension) of its nearest LED, send a **throttled**
(~10 messages/sec, i.e. min ~100ms between sends) message:

```js
{ type: 'orb_glow', pos: <nearestLedIndex>, intensity: <0..1> }
```

`intensity` ramps 0 → 1 as the orb's distance to the nearest LED shrinks across the
glow radius. Throttling avoids flooding the relay.

**Explosion (edge hit).**
- If the orb exits via the **left, top, or right** edge: send `{ type: 'god_bomb', pos: <nearestLedIndex> }` and remove the orb.
- If the orb exits via the **bottom** edge: send nothing (the orb is "wasted") and remove it.

## Component 3 — Server glow rendering (`bLEDsport-game-server/server.js`)

**New message handler** alongside the `god_bomb` handler (~line 1727):

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

**Transient state.** A single module-level `let orbGlow = null;` (latest-wins; with
multiple orbs the closest/most-recent dominates, which is acceptable). It **decays
fast**: when rendering, ignore/clear `orbGlow` if `Date.now() - orbGlow.at > 150ms`,
so a thrown orb that just exploded doesn't leave a lingering glow.

**Compositing.** In `tick()`'s playing-phase render, immediately before
`sendToWled(pixels)`: if `orbGlow` is fresh, add a soft falloff around `orbGlow.pos`
(a few LEDs each side, brightness scaled by `intensity`), blended **additively** with
the existing pixel values (clamped to 255) so it never erases players/bombs/portals.
Use a soft cool-white tint so it reads as "incoming" and is distinct from the
orange/blue portal glows.

**Gating & cleanup.** Respect `spectatorInteraction`; only render during `playing`;
clear `orbGlow` in `resetGame()` and `startGame()`. No binary-protocol change — the
glow affects only the physical WLED output. The spectator browser draws its own glow
locally, so both the on-screen arch and the physical arch glow without extra packets.

## Edge Cases

- **Multiple orbs approaching:** server keeps only the latest `orb_glow`; the closest orb naturally sends the highest intensity and most frequent updates, so it dominates.
- **Orb in flight when match ends:** server gates `orb_glow`/`god_bomb` on `gamePhase === 'playing'`, so they're ignored outside play. Client may keep animating orbs; that's harmless (no server effect).
- **`spectatorInteraction` off:** server ignores both messages; orbs still appear/throw client-side but produce no arch response (consistent with how click-bomb was gated).
- **Stale glow:** the 150ms decay prevents a lingering glow if the client stops sending (orb exploded, stalled, or disconnected).
- **Tiny/accidental drag:** treated as a mis-grab; the orb reverts to drifting without launching.

## Testing

Manual verification (real-time visual/hardware system):

1. Orbs appear near center every several seconds, drift gently, expire if untouched, cap at 3.
2. Press an orb, pull back, release → it slingshots the opposite way at a speed scaled by pull distance.
3. A soft throw stalls via friction and becomes grabbable again.
4. Throw into the left/top/right edge → explosion at the nearest arch LED (a real god_bomb; can affect players).
5. Throw into the bottom edge → orb disappears, no arch response (wasted).
6. As an orb approaches an edge, the on-screen arch dots near the impact brighten, and the physical WLED arch softly glows at the same point; the glow fades promptly after the orb passes/explodes.
7. Clicking empty space no longer drops a bomb (click-to-bomb removed); double-click still toggles fullscreen.
8. With `spectatorInteraction` off, orbs still appear but cause no arch glow or explosion.
