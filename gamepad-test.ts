// Gamepad HID mapping tool — records raw HID bytes for each button/axis
// Run: bun gamepad-test.ts
// Outputs a JSON mapping file for use by the game server

import HID from "node-hid";
import * as readline from "node:readline";

const GAMEPAD_VENDOR_ID = 0x79;
const GAMEPAD_PRODUCT_ID = 0x11;

// Find all matching gamepads
const devices = HID.devices();
const gamepads = devices.filter(
  (d) => d.vendorId === GAMEPAD_VENDOR_ID && d.productId === GAMEPAD_PRODUCT_ID
);

if (gamepads.length === 0) {
  console.log("No gamepads found. Connected HID devices:");
  for (const d of devices) {
    if (d.product) console.log(`  ${d.product} (vendor=${d.vendorId}, product=${d.productId})`);
  }
  process.exit(1);
}

console.log(`Found ${gamepads.length} gamepad(s):`);
gamepads.forEach((g, i) => console.log(`  [${i}] ${g.product?.trim()} at ${g.path}`));

// Use first gamepad for mapping
const pad = new HID.HID(gamepads[0].path!);
let latestData: Buffer | null = null;
let idleData: Buffer | null = null;

pad.on("data", (data: Buffer) => {
  latestData = Buffer.from(data);
});

pad.on("error", (err: Error) => {
  console.error("HID error:", err.message);
  process.exit(1);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function waitForChange(): Promise<Buffer> {
  return new Promise((resolve) => {
    const baseline = latestData ? Buffer.from(latestData) : null;
    const check = setInterval(() => {
      if (latestData && (!baseline || !latestData.equals(baseline))) {
        clearInterval(check);
        resolve(Buffer.from(latestData));
      }
    }, 16);
  });
}

function diffBytes(idle: Buffer, pressed: Buffer): Array<{ byte: number; idle: number; pressed: number }> {
  const diffs: Array<{ byte: number; idle: number; pressed: number }> = [];
  for (let i = 0; i < Math.min(idle.length, pressed.length); i++) {
    if (idle[i] !== pressed[i]) {
      diffs.push({ byte: i, idle: idle[i], pressed: pressed[i] });
    }
  }
  return diffs;
}

function formatBytes(buf: Buffer): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

const inputs = [
  { name: "dpad_up", label: "D-Pad UP" },
  { name: "dpad_down", label: "D-Pad DOWN" },
  { name: "dpad_left", label: "D-Pad LEFT" },
  { name: "dpad_right", label: "D-Pad RIGHT" },
  { name: "a", label: "A button" },
  { name: "b", label: "B button" },
  { name: "x", label: "X button" },
  { name: "y", label: "Y button" },
  { name: "l", label: "L (left shoulder)" },
  { name: "r", label: "R (right shoulder)" },
  { name: "select", label: "Select" },
  { name: "start", label: "Start" },
  { name: "axis_left_x", label: "Left stick X axis (push RIGHT)" },
  { name: "axis_left_y", label: "Left stick Y axis (push DOWN)" },
  { name: "axis_right_x", label: "Right stick X axis (push RIGHT)" },
  { name: "axis_right_y", label: "Right stick Y axis (push DOWN)" },
];

type InputMapping = {
  byte: number;
  idle: number;
  pressed: number;
};

type MappingResult = {
  device: {
    vendorId: number;
    productId: number;
    product: string;
  };
  idleState: string;
  byteCount: number;
  buttons: Record<string, InputMapping>;
  axes: Record<string, InputMapping>;
};

async function run() {
  console.log("\n=== Gamepad Mapping Tool ===\n");

  // Wait for initial data
  console.log("Waiting for gamepad data...");
  while (!latestData) await new Promise((r) => setTimeout(r, 50));

  console.log(`Receiving ${latestData.length} bytes per report.\n`);

  // Record idle state
  await prompt("Leave all buttons/sticks RELEASED, then press Enter... ");
  // Wait a moment for data to settle
  await new Promise((r) => setTimeout(r, 200));
  idleData = Buffer.from(latestData!);
  console.log(`Idle state: [${formatBytes(idleData)}]\n`);

  const mapping: MappingResult = {
    device: {
      vendorId: GAMEPAD_VENDOR_ID,
      productId: GAMEPAD_PRODUCT_ID,
      product: gamepads[0].product?.trim() || "Unknown",
    },
    idleState: formatBytes(idleData),
    byteCount: idleData.length,
    buttons: {},
    axes: {},
  };

  for (const input of inputs) {
    const isAxis = input.name.startsWith("axis_");
    console.log(`\nPress and HOLD: ${input.label}`);
    console.log("(Press Escape to skip if not available)");

    let escapeListener: ((key: Buffer) => void) | null = null;
    const result = await Promise.race([
      waitForChange(),
      new Promise<null>((resolve) => {
        escapeListener = (key: Buffer) => {
          if (key[0] === 0x1b) resolve(null);
        };
        process.stdin.setRawMode?.(true);
        process.stdin.on("data", escapeListener);
      }),
    ]);

    // Always clean up the escape listener
    if (escapeListener) process.stdin.removeListener("data", escapeListener);
    process.stdin.setRawMode?.(false);

    if (result === null) {
      console.log(`  Skipped ${input.label}`);
      continue;
    }

    const diffs = diffBytes(idleData, result as Buffer);
    console.log(`  Captured: [${formatBytes(result as Buffer)}]`);
    console.log(`  Changed bytes: ${diffs.map((d) => `[${d.byte}] ${d.idle} -> ${d.pressed}`).join(", ")}`);

    if (diffs.length > 0) {
      const diff = diffs[0]; // Use the first changed byte
      const entry: InputMapping = {
        byte: diff.byte,
        idle: diff.idle,
        pressed: diff.pressed,
      };

      if (isAxis) {
        mapping.axes[input.name] = entry;
      } else {
        mapping.buttons[input.name] = entry;
      }
    }

    // Wait for release
    console.log("  Release now...");
    while (latestData && !latestData.equals(idleData)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Write mapping file
  const filename = process.argv[2] || `gamepad-mapping-${GAMEPAD_VENDOR_ID.toString(16)}-${GAMEPAD_PRODUCT_ID.toString(16)}.json`;
  await Bun.write(filename, JSON.stringify(mapping, null, 2) + "\n");
  console.log(`\nMapping saved to ${filename}`);
  console.log(JSON.stringify(mapping, null, 2));

  pad.close();
  rl.close();
  process.exit(0);
}

run();
