#!/usr/bin/env bun
// LED Arch 5-Minute Timer
// Fills LEDs from both sides toward the center over 5 minutes,
// then plays a rainbow celebration animation.
// Run: bun timer.js

const NUM_LEDS = 192;
const WLED_WS_URL = 'ws://10.100.3.132/ws';
const LED_START = 1;
const TIMER_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const TICK_MS = 33; // ~30fps
const RAINBOW_DURATION_MS = 10_000; // 10 second celebration

let wledWs = null;
let wledReady = false;

// --- WLED connection ---
function connectWled() {
  return new Promise((resolve, reject) => {
    try {
      wledWs = new WebSocket(WLED_WS_URL);
      wledWs.onopen = () => {
        wledReady = true;
        console.log('WLED connected');
        resolve();
      };
      wledWs.onclose = () => { wledReady = false; };
      wledWs.onerror = (e) => { wledReady = false; reject(e); };
    } catch (e) {
      reject(e);
    }
  });
}

function sendToWled(pixels) {
  if (!wledWs || !wledReady) return;
  const colors = [0, NUM_LEDS, '000000'];
  for (let i = 0; i < NUM_LEDS; i++) {
    const c = pixels[i];
    if (!c) continue;
    const hex = c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
    colors.push(i, hex);
  }
  wledWs.send(JSON.stringify({
    on: true, bri: 255, transition: 0, ps: -1, pl: -1, lor: 1,
    seg: [
      { id: 0, start: LED_START, stop: LED_START + NUM_LEDS, frz: true, fx: 0, i: colors },
      { id: 1, stop: 0 }
    ]
  }));
}

// --- HSL helper ---
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// --- Timer fill rendering ---
function renderTimerFill(progress) {
  const pixels = new Array(NUM_LEDS).fill(null);
  const litCount = Math.floor(progress * NUM_LEDS);

  // Fill from both ends toward the middle
  const halfLit = Math.ceil(litCount / 2);
  const mid = Math.floor(NUM_LEDS / 2); // 96

  for (let i = 0; i < halfLit && i < mid; i++) {
    // Color: warm gradient from green -> yellow -> orange -> red as timer progresses
    const ledProgress = i / mid; // position along the arm
    const hue = 0.33 - (ledProgress * 0.33 * progress); // green to red
    const brightness = 0.35 + 0.15 * Math.sin(Date.now() / 1000 + i * 0.1);
    const c = hslToRgb(Math.max(0, hue), 1, brightness);

    // Left side (from LED 0 upward)
    pixels[i] = c;
    // Right side (from LED 191 downward)
    const rightIdx = NUM_LEDS - 1 - i;
    if (rightIdx >= mid) pixels[rightIdx] = c;
  }

  // Leading edge glow (brighter pixel at the fill front)
  if (halfLit > 0 && halfLit < mid) {
    const pulseB = 0.4 + 0.1 * Math.sin(Date.now() / 200);
    const edgeColor = hslToRgb(0.15, 1, pulseB);
    pixels[halfLit - 1] = edgeColor;
    const rightEdge = NUM_LEDS - halfLit;
    if (rightEdge >= mid) pixels[rightEdge] = edgeColor;
  }

  return pixels;
}

// --- Rainbow celebration ---
function renderRainbow(elapsed) {
  const pixels = new Array(NUM_LEDS).fill(null);
  const t = elapsed / 1000;
  const speed = 2;
  const waves = 3; // number of full rainbow cycles across the strip

  for (let i = 0; i < NUM_LEDS; i++) {
    const hue = ((i / NUM_LEDS) * waves + t * speed) % 1;
    const pulse = 0.4 + 0.1 * Math.sin(t * 8 + i * 0.3);
    pixels[i] = hslToRgb(hue, 1, pulse);
  }

  return pixels;
}

// --- Format time for display ---
function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// --- Main ---
async function main() {
  const durationArg = process.argv[2];
  let durationMs = TIMER_DURATION_MS;
  if (durationArg) {
    const parsed = parseFloat(durationArg);
    if (!isNaN(parsed) && parsed > 0) {
      durationMs = parsed * 60 * 1000;
    }
  }

  console.log(`LED Arch Timer: ${durationMs / 60000} minutes`);
  console.log('Connecting to WLED...');

  try {
    await connectWled();
  } catch {
    console.error('Failed to connect to WLED. Is it reachable?');
    process.exit(1);
  }

  const startTime = Date.now();
  let phase = 'counting'; // 'counting' | 'rainbow' | 'done'
  let rainbowStart = 0;

  console.log('Timer started! Press Ctrl+C to cancel.\n');

  const interval = setInterval(() => {
    const now = Date.now();

    if (phase === 'counting') {
      const elapsed = now - startTime;
      const remaining = Math.max(0, durationMs - elapsed);
      const progress = Math.min(1, elapsed / durationMs);

      // Update terminal display
      const bar = '='.repeat(Math.floor(progress * 30)) + ' '.repeat(30 - Math.floor(progress * 30));
      process.stdout.write(`\r  [${bar}] ${formatTime(remaining)} remaining `);

      sendToWled(renderTimerFill(progress));

      if (remaining <= 0) {
        phase = 'rainbow';
        rainbowStart = now;
        console.log('\n\n  TIME\'S UP! Rainbow celebration!');
      }
    } else if (phase === 'rainbow') {
      const rainbowElapsed = now - rainbowStart;
      sendToWled(renderRainbow(rainbowElapsed));

      if (rainbowElapsed >= RAINBOW_DURATION_MS) {
        phase = 'done';
        // Turn off LEDs
        sendToWled(new Array(NUM_LEDS).fill(null));
        console.log('  Done! LEDs off.');
        clearInterval(interval);
        setTimeout(() => process.exit(0), 200);
      }
    }
  }, TICK_MS);

  // Clean shutdown on Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n  Timer cancelled. Turning off LEDs...');
    sendToWled(new Array(NUM_LEDS).fill(null));
    clearInterval(interval);
    setTimeout(() => process.exit(0), 200);
  });
}

main();
