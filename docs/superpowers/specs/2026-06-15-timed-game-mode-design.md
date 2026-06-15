# bLEDsport Timed Game Mode Design

**Date:** 2026-06-15
**Status:** Approved

## Overview

Add an optional **match timer** that runs alongside the existing best-of-X
win condition. Both conditions are active at the same time: a game ends the
moment *either* a player reaches `winsNeeded` *or* the match timer expires. A
timer duration of `0` disables the timer entirely, so the game behaves exactly
as it does today (pure best-of-X).

The countdown is rendered on the spectator screen (`bledsport-external`),
overlaid in the center of the arch. When the timer expires on a tie for the
lead, the game enters a **sudden death** state until the next decisive kill.

## Goals

1. Add a configurable match duration (default 2:00) to the game config.
2. End the match when the timer expires, picking the highest-scoring player.
3. Break ties at expiry with a sudden-death phase (no timer, first decisive
   kill wins).
4. Display a smooth countdown on the spectator screen, driven locally by the
   client so the server does not send a packet every second.
5. Keep best-of-X working unchanged; `matchDurationMs = 0` means no timer.

## Config

One new field in `CONFIG_SCHEMA` (game server `server.js`), `gameRules`
category:

```js
matchDurationMs: { default: 120000, min: 0, max: 600000, step: 15000,
                   category: 'gameRules', live: false },
```

- Default `120000` (2:00). `0` disables the timer.
- `live: false` — pre-match only, consistent with `winsNeeded`.
- `winsNeeded` is unchanged and remains active simultaneously.

## Server Logic (`bLEDsport-game-server/server.js`)

### New state

- `matchStartAt` — module-level var (alongside `victoryStart`), set in
  `startGame()` to `Date.now()`.
- `gamePhase` gains a new value: `'suddenDeath'`.

### Match start

`startGame()` records `matchStartAt = Date.now()`.

### Timer expiry (in `tick()`, playing phase)

After the existing idle-timeout check, if `matchDurationMs > 0` and
`now - matchStartAt >= matchDurationMs`, evaluate the leader:

- **Clear leader** (exactly one player with the strictly-highest score):
  enter the `victory` phase exactly as a best-of win does — set
  `victoryStart`, `victoryColor`, `victoryPlayerName`, `speak('NAME wins')`.
  Reuses the existing victory animation. (Timeout wins look identical to
  best-of wins.)
- **Tie for the lead** (two or more players share the highest score): enter
  `gamePhase = 'suddenDeath'`. The timer no longer matters.

### Sudden death

`'suddenDeath'` plays identically to `'playing'`: same tick rendering, input
handling, and kill logic. The only differences:

- No timer is evaluated or displayed.
- In `hitPlayer()`, when in sudden death, the first kill that leaves exactly
  one player with the strictly-highest score ends the game → `victory`.
- The existing `winsNeeded` check in `hitPlayer()` still applies (unlikely to
  matter in practice but harmless).

The playing-phase tick code should run for both `'playing'` and
`'suddenDeath'` (i.e. the phase guard broadens to "playing or sudden death").

### Best-of win

Unchanged. `hitPlayer()` still ends the game early when a player reaches
`winsNeeded`, in either `playing` or `suddenDeath`.

## Data Flow to Spectator Screen

State reaches the spectator via the fixed-offset binary protocol in
`packStateForExternal()` (game server) and the matching decoder in
`bledsport-external/index.html`. The relay (`bledsport-external/server.ts`)
forwards a packet only when it differs from the previous one
(`buf.equals(lastExternalBuf)`).

### Client-driven countdown (no per-second packets)

The server sends timer **anchors**, not ticks. The client runs its own
countdown via the existing `requestAnimationFrame` render loop.

Two `Uint16` fields (seconds) are appended at the **tail** of the packet on
every phase:

- `matchDurationSec` — configured duration in seconds (`0` if no timer).
- `matchElapsedSec` — `floor((now - matchStartAt) / 1000)` during `playing`;
  `0` otherwise.

Both change slowly enough that they do not defeat the `buf.equals()` dedup —
so no packet is forced every second. The client syncs on the next packet sent
for any reason (constant during active play), then counts down locally.

### Phase encoding

Today: `0=waiting, 1=playing, 2=victory`. Add `3=suddenDeath`.

### Packet layout note

The two timer `Uint16`s are appended at the very end of the packet, after the
existing fields and after the optional victory block, to keep all current
offsets stable. The size calculation in `packStateForExternal()` and the
offset math in the decoder are bumped accordingly.

## Spectator Screen Rendering (`bledsport-external/index.html`)

### Decoder

- Add `'suddenDeath'` at index 3 of the `PHASES` array.
- Read the two trailing `Uint16` fields after the victory block.
- Length-guard: if the packet is too short to contain the timer fields
  (older/out-of-sync server), default `matchDurationSec`/`matchElapsedSec` to
  `0` (no timer). Preserves backward compatibility.

### Countdown overlay

- On each packet, set `timerDeadline = performance.now() +
  (matchDurationSec - matchElapsedSec) * 1000`.
- Each animation frame, when phase is `playing` and `matchDurationSec > 0`,
  draw `M:SS` from `max(0, timerDeadline - performance.now())` in the center
  of the arch (where the victory text sits).
- Turn the countdown amber/red in the final ~10 seconds for tension.

### Sudden death

- Phase `3` → draw a pulsing **"SUDDEN DEATH"** banner in the center of the
  arch; no timer. The live arch (players, bombs, etc.) renders identically to
  playing, since those fields are still in the packet.

### Victory

Unchanged — the existing `NAME WINS!` animation serves both best-of and
timeout wins.

## Edge Cases

- **Timer `0`:** no timer anywhere; pure best-of-X (today's behavior).
- **Short/old packets:** decoder length-guard defaults to no-timer.
- **Player disconnect mid-match:** leader eval at expiry simply reads current
  scores; no special handling.
- **Spectator connects mid-match:** anchors arrive on the next packet (near
  immediate during active play), countdown syncs within a frame or two.

## Testing

Manual verification on the spectator screen (real-time visual/hardware system,
not unit-testable):

1. Timer `0` → behaves exactly like today; no countdown shown.
2. Timer `2:00`, run down → countdown ticks smoothly and locally; clear leader
   at 0 → normal victory animation.
3. Force a tie at expiry → "SUDDEN DEATH" banner, no timer, next decisive kill
   wins.
4. Best-of win before timer expires → ends early as today.
5. Connect a spectator mid-match → countdown syncs within a frame or two.
