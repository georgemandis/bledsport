# Bledsport

A multiplayer game played on a 192-LED arch controlled by [WLED](https://kno.wled.ge/). Players move along the arch, collect power-ups, and try to blast each other off. Built at the [Recurse Center](https://www.recurse.com/).

## How It Works

The arch is divided into three zones:

- **Left side** (LEDs 0–57) — controlled with up/down arrows
- **Top** (LEDs 58–134) — controlled with left/right arrows
- **Right side** (LEDs 135–191) — controlled with up/down arrows

The server runs the game at ~30fps, rendering to both the physical LED strip (via WLED websocket) and a browser-based visualization. Players connect by opening the web UI in a browser.

## Controls

| Key | Action |
|-----|--------|
| Arrow keys | Move along the arch |
| Space | Fire your power-up (blast or bomb) |
| Shift + arrow | Dash (5-LED leap, recharges after 3s) |

## Power-ups

Power-ups spawn randomly on the arch. Walk over one to pick it up (one at a time).

- **Blast** — fires an expanding wave that kills on contact
- **Bomb** — places a ticking bomb that shrinks then explodes in a radius
- **Shield** — absorbs one hit

## Running

Requires [Bun](https://bun.sh/).

```bash
# Start the game server (connects to WLED at ws://10.100.3.132/ws)
bun server.js

# Start in debug mode (no WLED connection)
bun server.js --debug
```

Open `http://localhost:3000` in a browser to play.

## Timer

There's also a standalone countdown timer that fills the arch from both ends:

```bash
# Default 5-minute timer
bun timer.js

# Custom duration (in minutes)
bun timer.js 10
```

Ends with a rainbow celebration animation.

## Files

- `server.js` — game server (game logic, WLED output, websocket server)
- `index.html` — browser client (input handling, canvas visualization)
- `timer.js` — standalone LED countdown timer
