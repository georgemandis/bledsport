# bLEDsport

A multiplayer arena game played on a 192-LED arch controlled by [WLED](https://kno.wled.ge/). Players move along the arch, collect power-ups, and try to blast each other off. Built at the [Recurse Center](https://www.recurse.com/).

The game server runs on a Raspberry Pi connected to USB gamepads and talks to a WLED controller via DDP over UDP. An external spectator server (deployed on [Disco](https://disco.cloud/)) mirrors the game in real-time so anyone on the internet can watch and interact.

## The Arch

The physical LED arch is divided into three zones:

- **Left side** (LEDs 0–57) — vertical, controlled with up/down
- **Top** (LEDs 58–134) — horizontal, controlled with left/right
- **Right side** (LEDs 135–191) — vertical, controlled with up/down

Portals at each end (LED 0 and LED 191) teleport players to the opposite side with momentum.

## Gameplay

Up to 4 players join by pressing Start on their gamepad (or clicking Join in the browser). The game starts immediately when the first player joins. Kill other players to score — first to 3 wins.

### Abilities

| Button | Ability | Details |
|--------|---------|---------|
| D-pad | Move | Navigates the arch, direction maps to zone |
| L/R + D-pad | Dash | 5-LED leap, recharges after 3s |
| A | Blast | Expanding wave that kills on contact (earned via power-up pickup) |
| B | Bomb | Ticking bomb that shrinks over 3s then explodes in radius 8 |
| X | Shield | Absorbs one hit, lasts 1s, 5s cooldown |
| Y | Kick | Kicks an adjacent bomb in the held direction |
| Select | Cycle color | Swap between cyan, pink, green, gold |

### Power-ups

Blast charges spawn randomly on the arch every 4–8 seconds. Walk over one to pick it up.

### Spectators

Spectators (browser clients that haven't joined) can use **Hand of God** — click anywhere on the arch to drop a bomb from above. These bombs leave fire on the ground for 3 seconds.

### Game Settings

| Setting | Value |
|---------|-------|
| Max players | 4 |
| Wins to win | 3 |
| Tick rate | ~60fps (16ms) |
| Respawn time | 2s |
| Idle timeout | 60s (resets game) |
| Victory celebration | 5s |
| Spawn Invuln (ms) | 3000 (configurable via `spawnInvulnMs`) |

### Spawning

Players spawn at the top-center of the arch (LED 96) and flash while invulnerable for the **Spawn Invuln** duration. This applies to:
- New players joining a match already in progress (the match is not reset)
- Existing players respawning after death

Set `spawnInvulnMs` to `0` to disable spawn invulnerability.

## Architecture

```
┌──────────────┐     DDP/UDP      ┌──────────┐
│  Game Server │ ───────────────> │   WLED   │
│  (Raspberry  │                  │  (LEDs)  │
│    Pi)       │     WebSocket    └──────────┘
│              │ ───────────────> Browser clients (LAN)
│              │
│              │     WebSocket    ┌──────────────┐     WebSocket
│              │ ───────────────> │   External   │ ───────────> Spectators
│              │   (binary)       │   Server     │              (internet)
│              │ <─────────────── │   (Disco)    │ <───────────
└──────────────┘  (god_bomb JSON) └──────────────┘  (god_bomb JSON)
```

### WLED Communication

The game server sends pixels to WLED using **DDP (Distributed Display Protocol)** over UDP on port 4048. Each packet is 586 bytes: a 10-byte header + 576 bytes of RGB data (192 LEDs × 3 bytes).

### External Server Binary Protocol

To minimize load on the Pi, the game server sends state to the external server using a compact binary format instead of JSON. Updates are only sent when state actually changes (not every tick).

**Packet structure:**

```
Header (2 bytes):
  [0] gamePhase: 0=waiting, 1=playing, 2=victory
  [1] hi nibble = playerCount (0-4), lo nibble = waveCount (0-15)

Per player (8 bytes each, max 4):
  [0] pos (0-191)
  [1] colorR     [2] colorG     [3] colorB
  [4] flags: bit0=alive, bit1=shieldActive, bit2=hasDash
  [5] score      [6] id
  [7] blastCharges (lo nibble) | blastMax (hi nibble)

Per wave (4 bytes each):
  [0] center     [1] radius     [2] owner     [3] maxRadius

Variable sections:
  [1 byte] bombCount
  Per bomb (4 bytes):
    [0] pos  [1] width  [2] explodeFrame
    [3] flags: bit0=exploding, bit1=godBomb, bits4-7=owner

  [1 byte] powerupCount
  Per powerup (1 byte): pos

  [1 byte] fireCount
  Per fire (2 bytes): [0] pos  [1] age (0-255, scaled from 0.0-1.0)

If victory (phase=2), appended:
  [3 bytes] victoryColor RGB
  [1 byte] nameLen
  [nameLen bytes] victoryPlayerName (UTF-8)
```

Typical packet size: ~10-50 bytes vs ~500+ bytes of JSON.

## Running

Requires [Bun](https://bun.sh/).

```bash
# Start the game server
bun server.js

# Debug mode (no WLED output)
bun server.js --debug

# With gamepad support (can specify multiple)
bun server.js --gamepad innext-controller.json --gamepad logitech-controller.json
```

Open `http://localhost` in a browser for the local visualization.

### Environment Variables

Configure via `.env` file (Bun loads it automatically):

```bash
# External spectator server URL
EXTERNAL_SERVER_URL=wss://bledsport.rcdis.co

# Auth key for external server connection
EXTERNAL_SERVER_KEY=bledsport

# Server port (default: 80)
PORT=80
```

See `.env.example` for a template.

## Gamepad Setup

The game uses raw HID to read USB gamepads — no browser gamepad API, no Linux joystick driver. Each controller type needs a JSON mapping file that describes which bytes correspond to which buttons.

### Adding a New Controller

1. Plug in the controller and find its vendor/product IDs:
   ```bash
   lsusb
   ```

2. Record the idle state and button byte positions (the `gamepad.ts` module reads raw HID reports)

3. Create a mapping JSON (see `innext-controller.json` or `logitech-controller.json` for examples)

4. Add a udev rule so the game server can access the device without root:
   ```bash
   # /etc/udev/rules.d/99-gamepad.rules
   SUBSYSTEM=="usb", ATTR{idVendor}=="XXXX", ATTR{idProduct}=="YYYY", MODE="0666"
   SUBSYSTEM=="hidraw", ATTRS{idVendor}=="XXXX", ATTRS{idProduct}=="YYYY", MODE="0666"
   ```
   Then reload:
   ```bash
   sudo udevadm control --reload-rules
   sudo udevadm trigger
   ```

### Currently Supported Controllers

- **iNNEXT USB Gamepad** (0079:0011) — `innext-controller.json`
- **Logitech Dual Action** (046d:c216) — `logitech-controller.json`

## Raspberry Pi Deployment

### systemd Service

A service file is included at `config/bledsport.service`:

```ini
[Unit]
Description=bLEDsport
After=network.target

[Service]
ExecStart=/home/recurse/.bun/bin/bun /home/recurse/bledsport/bLEDsport-game-server/server.js --gamepad innext-controller.json --gamepad logitech-controller.json
Restart=always
User=recurse
WorkingDirectory=/home/recurse/bledsport/bLEDsport-game-server
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

Install it:

```bash
sudo cp config/bledsport.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable bledsport
sudo systemctl start bledsport
```

Monitor logs:

```bash
journalctl -u bledsport -f
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | Game logic, WLED DDP output, WebSocket server, external relay |
| `index.html` | Browser client (canvas visualization, input handling) |
| `gamepad.ts` | Raw HID gamepad reader with mapping-driven button detection |
| `innext-controller.json` | Button mapping for iNNEXT USB gamepads |
| `logitech-controller.json` | Button mapping for Logitech Dual Action |
| `config/bledsport.service` | systemd unit file for Raspberry Pi |
| `.env.example` | Environment variable template |

## Notable Implementation Details

- **DDP over UDP** instead of WLED's WebSocket/JSON API — switched for lower latency and higher throughput at 60fps. A single 586-byte UDP packet per frame vs multiple JSON WebSocket messages.

- **Raw HID for gamepads** — reads `/dev/hidraw*` directly instead of using the Linux joystick subsystem or browser gamepad API. This lets the game run headless on a Pi with no X server. Each controller type is described by a JSON mapping file that maps byte positions to button names.

- **Binary protocol for spectator relay** — the Pi packs game state into ~50 bytes of binary data instead of ~500+ bytes of JSON. The external server passes raw bytes through without parsing. Browser clients decode with `Uint8Array`. State is only sent when something changes, not every tick.

- **Portal momentum** — entering a portal at one end teleports you to the other with 4 ticks of forced movement, preventing instant back-and-forth teleport spam.

- **Hand of God** — spectators can click the arch to drop bombs, adding a crowd-vs-players dynamic. God bombs leave lingering fire patches.

- **udev rules** — required for the Pi to access HID devices without root. Each controller vendor/product ID needs its own rule. `systemctl daemon-reload` does *not* affect udev rules (they're completely separate systems).
