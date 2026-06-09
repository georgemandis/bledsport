# bLEDsport Game Config UI Design

**Date:** 2026-06-09
**Status:** Approved

## Overview

Replace the current browser-based spectator/player view with a local-only **game master console** — a config dashboard that lets you tune every game parameter in real-time, save/load presets, and view the live game state. The external spectator mode lives in a separate repo.

## Goals

1. Make all hardcoded game constants configurable via a web UI
2. Support live mid-game tweaking AND pre-match-only settings
3. Add preset save/load system with stock and custom presets
4. Add new game mechanics: walls, moving portals, configurable momentum
5. Keep the existing game loop architecture intact

## Architecture

### Approach: Config Object + WebSocket Messages

- A single `gameConfig` object in `server.js` replaces all hardcoded constants
- The game loop reads `gameConfig.*` values each tick — live changes take effect immediately
- The config page communicates via WebSocket using new message types
- Presets are stored as individual JSON files in a `presets/` directory

### Data Flow

```
Config Page (index.html)  --->  server.js (gameConfig {})  --->  WLED (DDP)
       ^                              |        |
       |                              |        v
       +---- config_state broadcast --+    Game Loop (16ms tick)
                                           reads gameConfig.* each tick

presets/*.json  <--->  server.js (save/load)

USB Gamepads  --->  server.js (player inputs, unchanged)
External Server  <---  server.js (binary relay, unchanged)
```

### WebSocket Message Types

**Client → Server:**
- `{ type: 'config_update', category: string, key: string, value: any }` — change one setting
- `{ type: 'load_preset', name: string }` — load a preset
- `{ type: 'save_preset', name: string }` — save current config as preset
- `{ type: 'delete_preset', name: string }` — delete a custom preset
- `{ type: 'randomize' }` — randomize all settings within valid ranges
- `{ type: 'reset_presets' }` — delete all custom presets, restore stock defaults

**Server → Client:**
- `{ type: 'config_state', config: {...}, presets: [...], activePreset: string|null }` — full config broadcast (sent on connect and after any config change, debounced to max ~10/sec for slider drags)
- `{ type: 'game_state', ... }` — existing game state broadcast (pixels, players, scores, phase)

**Category strings** for `config_update` messages: `"gameRules"`, `"movement"`, `"bombs"`, `"shield"`, `"pewPew"`, `"portals"`, `"walls"`, `"powerups"` (camelCase, matching the gameConfig object keys).

### What Changes

**Remove from index.html:**
- God bomb click handler
- Browser-as-player mode (keyboard controls, movement)
- Join game / start game buttons
- Player HUD (ability status, zone indicator)

**Add:**
- `gameConfig` object in server.js (replaces hardcoded constants)
- Config WebSocket message handlers
- Preset save/load/delete/randomize logic
- Config UI (sliders, toggles, preset bar)
- Wall system (corner, random, sweeper)
- Moving portal system
- Configurable momentum (skating mode)

**Keep unchanged:**
- Game loop structure (16ms tick, phases: waiting/playing/victory)
- DDP output to WLED
- USB gamepad input handling
- External server binary relay (wall/sweeper data will need protocol extension in the external repo separately)
- Canvas-based arch rendering (repurposed for live view in config page)
- Core game mechanics (bombs, pew-pew, shields, push chains)

## Config Schema

All parameters read by the game loop each tick. In-flight objects (bombs mid-fuse, active explosions, etc.) pick up new config values on their next tick — no special handling needed. This means changing `bombFuseMs` mid-game affects bombs already ticking.

### Game Rules (Pre-match only — locked during play)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `winsNeeded` | int | 3 | 1-10 | Kills to win a round |
| `playerWidth` | int | 1 | 1-5 | Player size in LEDs (see implementation note below) |
| `respawnMs` | int | 2000 | 500-5000 | Respawn delay in ms |
| `randomSpawns` | bool | false | — | Randomize spawn/respawn positions |
| `spectatorInteraction` | bool | true | — | Allow spectators to interact with the game (see details below) |
| `victoryDurationMs` | int | 5000 | 2000-10000 | Victory animation duration before reset |
| `idleResetMs` | int | 60000 | 10000-300000 | Auto-reset game after no input for this long |

**`spectatorInteraction` details:** When `false`, god bomb messages are rejected from both local WebSocket spectators and the external server relay. When `true`, existing behavior.

**`playerWidth` implementation note:** When `playerWidth > 1`, collision detection (`playersOverlap`), bomb proximity checks, and shield rendering must account for multi-LED players. This affects `pushChain()`, `hitPlayer()`, bomb kick collision, and powerup pickup. Details left to implementation but this is a non-trivial change — consider implementing width=1 first and extending later.

### Movement (Live-adjustable)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `dashDistance` | int | 5 | 1-20 | LEDs per dash (currently an inline `5` in server.js, not a named constant) |
| `dashRegenMs` | int | 3000 | 500-10000 | Dash recharge time |
| `momentumTicks` | int | 0 | 0-12 | Forced movement ticks after input (0 = classic, 4+ = skating) |
| `momentumIntervalMs` | int | 60 | 16-200 | Ms between momentum moves (also used for portal momentum — unified timer) |

### Bombs (Live-adjustable)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `bombWidth` | int | 5 | 1-15 | Initial bomb visual width |
| `bombFuseMs` | int | 3000 | 500-10000 | Fuse duration |
| `bombExplodeRadius` | int | 8 | 2-30 | Explosion radius in LEDs |
| `bombExplodeFrames` | int | 10 | 3-20 | Frames of explosion animation (affects how long hitbox is active) |
| `bombCooldownMs` | int | 1000 | 0-5000 | Cooldown between placements |
| `bombKickSpeed` | float | 0.5 | 0.1-2.0 | LEDs per tick when bomb is kicked |
| `bombLeavesFlames` | bool | false | — | Regular bombs leave fire after exploding |
| `flameDurationMs` | int | 3000 | 500-10000 | How long fire burns (applies to both regular bomb flames and god bomb flames) |
| `flameSpread` | int | 1 | 0-10 | LEDs of fire on each side of explosion center |

**Note on flames:** God bombs always leave fire regardless of `bombLeavesFlames`. The `bombLeavesFlames` toggle adds fire to regular player-placed bombs. `flameDurationMs` and `flameSpread` control both god bomb and regular bomb flames.

**Note on bomb charges:** The current code uses a cooldown system for bombs (not a charge/ammo system). Players can place bombs unlimited times, gated only by `bombCooldownMs`. This spec preserves that behavior. The `bombCharges`/`bombMaxCharges` fields on the player object in the current code are vestigial and unused for bombs.

### Shield (Live-adjustable)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `shieldDurationMs` | int | 1000 | 250-5000 | Shield active duration |
| `shieldCooldownMs` | int | 5000 | 500-15000 | Cooldown between uses |

### Pew-Pew (Live-adjustable)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `pewPewCooldownMs` | int | 5000 | 500-15000 | Cooldown between pew-pews |
| `waveSpeed` | int | 2 | 1-5 | LEDs per tick wave expands |
| `waveMaxRadius` | int | 12 | 4-40 | Max wave expansion |

### Portals (Live-adjustable)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `portalsEnabled` | bool | true | — | Portals on/off |
| `portalsMoving` | bool | false | — | Portals rotate between landmarks |
| `portalMoveIntervalMs` | int | 15000 | 5000-60000 | Time between portal position changes |
| `portalMomentum` | int | 4 | 0-12 | Forced ticks after portal entry (uses `momentumIntervalMs` for timing) |

**Note on `portalMomentum` vs `momentumTicks`:** These interact. Portal exit applies `max(portalMomentum, momentumTicks)` forced ticks. If `momentumTicks` (skating mode) is higher than `portalMomentum`, portals use the skating value. In classic mode (`momentumTicks = 0`), `portalMomentum` is the only source of post-portal momentum. The UI should show a tooltip explaining this interaction.

### Walls (Live-adjustable)

**Corner Walls:**

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `cornerWallsEnabled` | bool | false | — | Walls grow at zone corners |
| `cornerWallMaxSize` | int | 6 | 2-15 | Max corner wall size in LEDs |
| `cornerWallGrowMs` | int | 5000 | 1000-30000 | Time between wall growth steps |

Corner wall positions are derived from ZONES boundaries (currently LED 58 and LED 134, where left/top and top/right zones meet). If ZONES ever change, wall positions should update to match.

**Random Walls:**

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `randomWallsEnabled` | bool | false | — | Random walls spawn on field |
| `randomWallSpawnMs` | int | 10000 | 3000-30000 | Time between random wall spawns |
| `randomWallSize` | int | 5 | 1-15 | Size of random walls |
| `randomWallMaxCount` | int | 3 | 1-8 | Max random walls on field |

**Sweeper Wall:**

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `sweeperEnabled` | bool | false | — | Moving sweeper wall |
| `sweeperSize` | int | 3 | 1-10 | Sweeper width in LEDs |
| `sweeperSpeed` | float | 0.25 | 0.1-2.0 | LEDs per tick sweeper moves |
| `sweeperLethal` | bool | true | — | Sweeper kills on contact (vs blocks) |

### Powerups (Live-adjustable)

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `powerupSpawnMinMs` | int | 4000 | 1000-20000 | Min spawn interval |
| `powerupSpawnMaxMs` | int | 8000 | 2000-30000 | Max spawn interval |
| `powerupMaxCount` | int | 1 | 0-5 | Max powerups on field |

**Validation:** `powerupSpawnMinMs` must be ≤ `powerupSpawnMaxMs`. The UI enforces this by clamping the min slider to not exceed max's value (and vice versa). Server-side, if min > max, use min for both.

## New Game Mechanics

### Sweeper Wall

**State:** `sweeper = { pos: 0.0, dir: 1, size: gameConfig.sweeperSize }`

**Each tick:**
- `sweeper.pos += sweeper.dir * gameConfig.sweeperSpeed`
- If `pos <= 0` or `pos >= NUM_LEDS - 1`: reverse direction (`sweeper.dir *= -1`)
- Occupied LEDs = `floor(pos)` to `floor(pos) + size - 1`
- If `sweeperLethal`: kill any player overlapping (shield absorbs one hit)
- If barrier mode: block movement into those LEDs

**Rendering:**
- Lethal mode: bright red pulsing bar
- Barrier mode: gray/stone colored bar (same visual language as walls)

**Interactions:**
- Bombs on sweeper LEDs are destroyed (swept away)
- Pew-pew waves pass through
- Explosions pass through

### Corner Walls

**State:** `cornerWalls = [{ pos: ZONES[1].start, currentSize: 0, lastGrowAt: 0 }, { pos: ZONES[2].start, currentSize: 0, lastGrowAt: 0 }]`

(Currently `ZONES[1].start = 58` and `ZONES[2].start = 135`, but derived from the ZONES array rather than hardcoded.)

**Each tick:**
- If timer elapsed and `currentSize < cornerWallMaxSize`: grow by 1
- Occupied LEDs = `pos - floor(currentSize/2)` to `pos + floor(currentSize/2)`
- Block all movement and bomb kicks into occupied LEDs

**Rendering:** Orange solid bar at corners, grows visibly.

**Reset:** Walls reset to size 0 at round start.

### Random Walls

**State:** `randomWalls = [{ pos, size }]`

**Spawn logic:**
- Timer-based (same pattern as powerup spawning)
- Random position with minimum distance from players, portals, and other walls
- Max count enforced by `randomWallMaxCount`
- Persist until round ends

**Rendering:** Orange solid bar (same as corner walls).

### Moving Portals

**Landmarks:** `[0, 58, 134, 191]` (arch ends + zone corners)

**State:** `portalA = { pos: 0 }, portalB = { pos: 191 }, lastPortalMoveAt = 0`

**Each tick (when `portalsMoving = true`):**
- If timer elapsed:
  - 2 seconds before move: portals start blinking (visual warning)
  - Pick new pair of landmarks (different from current, A != B)
  - Snap portals to new positions
  - Brief flash animation at new locations

**Portal wrapping (modified):**
- Current: position-based wrapping at edges (`wrapPos` checks `< 0` and `>= NUM_LEDS`)
- New: stepping on `portalA.pos` teleports to `portalB.pos` (and vice versa)
- Same momentum behavior after teleport
- If portal moves onto a player, player is NOT teleported

**Scope note:** This changes the portal system for all modes, not just moving portals. When `portalsMoving = false`, portals stay at their defaults (0 and 191) and behave like the current edge-wrapping — functionally identical but implemented as portal-position-based teleportation rather than position-range wrapping. This unifies the portal code path.

### Momentum / Skating Mode

Extends existing portal momentum pattern. The `momentumIntervalMs` config value replaces the current `PORTAL_MOMENTUM_MS` constant and is used for all momentum timing (both portal and skating).

**When `momentumTicks > 0`:**
- Every movement input triggers `momentumTicks` forced movement ticks at `momentumIntervalMs` intervals
- New input while sliding replaces current momentum (new direction + reset tick count)
- Portal momentum uses `max(portalMomentum, momentumTicks)`
- Walls stop momentum
- Dash applies dash distance as initial jump, then momentum slide continues

**When `momentumTicks = 0` (Classic):** Exactly current behavior.

### Wall Collision Matrix

| Entity | Corner/Random Wall | Sweeper (lethal) | Sweeper (barrier) |
|--------|-------------------|-------------------|-------------------|
| Player movement | Blocked | Killed | Blocked |
| Bomb kick | Stopped | Destroyed | Stopped |
| Pew-pew wave | Passes through | Passes through | Passes through |
| Explosion | Passes through | Passes through | Passes through |
| Player momentum | Stopped | Killed | Stopped |
| Shield vs contact | N/A | Absorbs hit | N/A |

### Rendering Colors

- **Orange:** Corner walls, random walls (obstacles/barriers)
- **Red (pulsing):** Sweeper wall in lethal mode
- **Gray/stone:** Sweeper wall in barrier mode

## Preset System

### Storage

- Directory: `presets/` (next to `server.js`)
- One JSON file per preset: `presets/classic.json`, `presets/the-kumite.json`, etc.
- Each file is a full `gameConfig` snapshot
- Stock presets are version-controlled in the repo
- Custom presets are saved alongside them

### Stock Presets

- **Classic** — all default values (current hardcoded behavior). Always available, cannot be deleted.
- **The Kumite** — (to be defined, aggressive/competitive settings)
- Others TBD as we discover fun combinations

### Operations

- **Load:** Read JSON file, apply all values to `gameConfig`, broadcast to clients
- **Save:** Write current `gameConfig` to `presets/<name>.json`
- **Delete:** Remove the JSON file (cannot delete `classic.json`)
- **Randomize:** For each parameter, pick a random value within its valid range. Apply and broadcast. Does not save to disk. During active gameplay, pre-match-only settings are skipped (not randomized).
- **Reset:** Delete all custom presets, restore stock presets from repo defaults

### Randomize Bounds

Each parameter uses the min/max from the Range column in the config schema tables. Boolean values have a 50/50 chance. This ensures the game is always playable (no zero-width explosions, no infinite cooldowns, etc.).

## Config UI Layout

### Page Structure

Two-panel layout:

**Left panel (scrollable):** Config controls
1. **Header:** "bLEDsport — GAME CONFIGURATION"
2. **Preset bar:** Buttons for each preset + Randomize + Save Preset
3. **Categories:** Collapsible sections, each with sliders and toggles
   - Game Rules (badge: PRE-MATCH)
   - Movement (badge: LIVE)
   - Bombs (badge: LIVE)
   - Shield (badge: LIVE)
   - Pew-Pew (badge: LIVE)
   - Portals (badge: LIVE)
   - Walls — subdivided: Corner Walls, Random Walls, Sweeper (badge: LIVE)
   - Powerups (badge: LIVE)

**Right panel (fixed):** Live game view
1. **Canvas:** Real-time arch rendering (same as current spectator view)
2. **Game status:** Current phase (waiting/playing/victory)
3. **Scoreboard:** Connected players and scores

### Controls

- **Sliders** for numeric values (showing current value)
- **Toggles** for booleans
- **PRE-MATCH settings** are visually disabled (grayed out) during active gameplay
- Slider changes are debounced client-side (~100ms) before sending `config_update` to avoid flooding the server during drags
- No explicit "apply" button — changes are sent on input

### Preset Interaction

- Clicking a preset button loads it immediately
- Active preset is highlighted
- Changing any value after loading a preset deselects the preset indicator (shows "Custom")
- "+ Save Preset" opens a name input prompt
- "Randomize" applies random values immediately (fun, chaotic button)

## Spawn System Changes

### Current Behavior

`spawnPos()` tries 5 fixed candidates `[0, 48, 96, 144, 191]` first, falls back to random only if all are occupied.

### New Behavior (when `randomSpawns = true`)

Skip the fixed candidates. Pick a random position with minimum distance from other players, walls, bombs, and portals. Same safety logic as `randomPowerupPos()`.

### When `randomSpawns = false` (Classic)

Existing behavior unchanged.

## External Server Impact

The external spectator server lives at a separate repo (`bledsport-external`). It's a lightweight relay: receives binary game state from the game server, broadcasts to spectators, forwards god bomb clicks back. Changes needed there are tracked separately but noted here for completeness.

### Binary Protocol Extension

The current binary protocol has no fields for walls, sweeper, or moving portal positions. New fields need to be appended:

```
After existing fire data:

  1 byte    cornerWallCount (0-2)
  Per corner wall (2 bytes):
    1 byte  pos
    1 byte  currentSize

  1 byte    randomWallCount
  Per random wall (2 bytes):
    1 byte  pos
    1 byte  size

  1 byte    sweeperFlags (bit0=enabled, bit1=lethal)
  If enabled (2 bytes):
    1 byte  pos (floor of float)
    1 byte  size

  2 bytes   portalA pos, portalB pos
```

This keeps the protocol backwards-compatible — old clients that don't read past the fire data will still work (they just won't see walls/portals).

### External Server Rendering Updates

The external `index.html` needs to render:
- **Corner walls / random walls** — orange solid bars
- **Sweeper wall** — red (lethal) or gray (barrier) pulsing bar
- **Moving portal positions** — portal glow at dynamic positions instead of hardcoded 0/191

### No Server Logic Changes

The relay server (`server.ts`) remains pass-through. No changes needed — it forwards binary buffers and spectator messages without parsing them.

### `spectatorInteraction` Enforcement

When `spectatorInteraction = false`, the game server rejects incoming god bomb messages. The external server still forwards them, but they're silently dropped. No external server change needed.
