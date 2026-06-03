// Gamepad — reads a controller mapping JSON and exposes a clean interface
// Usage:
//   import { createGamepad, discoverGamepads } from "./gamepad";
//   const pads = discoverGamepads("./innext-controller.json");
//   pads[0].on("press", (button) => console.log("pressed", button));
//   pads[0].on("release", (button) => console.log("released", button));

import HID from "node-hid";
import { EventEmitter } from "node:events";

export type ControllerMapping = {
  device: {
    vendorId: number;
    productId: number;
    product: string;
  };
  idleState: string;
  byteCount: number;
  buttons: Record<string, { byte: number; idle: number; pressed: number }>;
  axes: Record<string, { byte: number; idle: number; pressed: number }>;
};

export type GamepadState = {
  buttons: Record<string, boolean>;
  axes: Record<string, number>;
};

export type GamepadEvents = {
  press: [button: string];
  release: [button: string];
  axis: [axis: string, value: number];
  change: [state: GamepadState];
  error: [err: Error];
  disconnect: [];
};

export class Gamepad extends EventEmitter<GamepadEvents> {
  readonly index: number;
  readonly mapping: ControllerMapping;
  readonly state: GamepadState;
  private device: HID.HID;
  private prevData: Buffer | null = null;

  constructor(device: HID.HID, mapping: ControllerMapping, index: number) {
    super();
    this.device = device;
    this.mapping = mapping;
    this.index = index;

    this.state = {
      buttons: {},
      axes: {},
    };

    // Initialize state
    for (const name of Object.keys(mapping.buttons)) {
      this.state.buttons[name] = false;
    }
    for (const name of Object.keys(mapping.axes)) {
      this.state.axes[name] = 0;
    }

    device.on("data", (data: Buffer) => this.handleData(data));
    device.on("error", (err: Error) => {
      this.emit("error", err);
      this.close();
    });
  }

  private handleData(data: Buffer) {
    if (this.prevData && data.equals(this.prevData)) return;
    this.prevData = Buffer.from(data);

    let changed = false;

    // Check buttons
    for (const [name, map] of Object.entries(this.mapping.buttons)) {
      const raw = data[map.byte];
      const pressed = raw === map.pressed;
      const wasPreviously = this.state.buttons[name];

      if (pressed !== wasPreviously) {
        this.state.buttons[name] = pressed;
        changed = true;
        this.emit(pressed ? "press" : "release", name);
      }
    }

    // Check axes — normalize to -1..1
    for (const [name, map] of Object.entries(this.mapping.axes)) {
      const raw = data[map.byte];
      // Map 0..255 to -1..1 with idle as center
      const value = Math.round(((raw - map.idle) / 127) * 100) / 100;
      const clamped = Math.max(-1, Math.min(1, value));

      if (clamped !== this.state.axes[name]) {
        this.state.axes[name] = clamped;
        changed = true;
        this.emit("axis", name, clamped);
      }
    }

    if (changed) {
      this.emit("change", { ...this.state });
    }
  }

  close() {
    try {
      this.device.close();
    } catch {}
    this.emit("disconnect");
  }
}

export function loadMapping(path: string): ControllerMapping {
  const raw = require(path.startsWith("/") ? path : `${process.cwd()}/${path}`);
  return raw as ControllerMapping;
}

export function discoverGamepads(mappingPath: string): Gamepad[] {
  const mapping = loadMapping(mappingPath);
  const devices = HID.devices().filter(
    (d) =>
      d.vendorId === mapping.device.vendorId &&
      d.productId === mapping.device.productId
  );

  return devices.map((info, i) => {
    const device = new HID.HID(info.path!);
    return new Gamepad(device, mapping, i);
  });
}
