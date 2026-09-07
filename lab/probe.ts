import { Lab } from "./lab";
import type { LabMethod, LabResult } from "./labApi";
import { RealLabPlatform } from "./realPlatform";

/**
 * The probe surface. Tier-2 tests call these through `page.evaluate`, never
 * touch `navigator.mediaDevices` directly from Playwright's Node side — a
 * `MediaStreamTrack` doesn't survive structured clone, so everything here
 * returns plain data and keeps the live objects in-page, keyed by id.
 *
 * This file has no behaviour of its own to test — it is a thin, honest
 * window onto the real browser API. The interesting assertions live in
 * tests/harness.spec.ts.
 */

interface SerializedTrack {
  id: string;
  kind: string;
  label: string;
  readyState: MediaStreamTrackState;
  enabled: boolean;
  muted: boolean;
}

interface SerializedDevice {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
  groupId: string;
}

const tracks = new Map<string, MediaStreamTrack>();

function serializeTrack(track: MediaStreamTrack): SerializedTrack {
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    readyState: track.readyState,
    enabled: track.enabled,
    muted: track.muted,
  };
}

function serializeDevice(device: MediaDeviceInfo): SerializedDevice {
  return {
    deviceId: device.deviceId,
    kind: device.kind,
    label: device.label,
    groupId: device.groupId,
  };
}

const probe = {
  environment(): { secureContext: boolean; hasMediaDevices: boolean; userAgent: string } {
    return {
      secureContext: window.isSecureContext,
      hasMediaDevices: typeof navigator.mediaDevices !== "undefined",
      userAgent: navigator.userAgent,
    };
  },

  async enumerateDevices(): Promise<SerializedDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.map(serializeDevice);
  },

  // Acquires a stream and stores each track under its own id. Returns the
  // serialized tracks so the test can assert on them, then use the id with
  // getTrackState / setTrackEnabled / stopTrack to keep driving the same
  // live track across further calls.
  async getUserMedia(constraints: MediaStreamConstraints): Promise<SerializedTrack[]> {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const result: SerializedTrack[] = [];
    for (const track of stream.getTracks()) {
      tracks.set(track.id, track);
      result.push(serializeTrack(track));
    }
    return result;
  },

  hasGetDisplayMedia(): boolean {
    return typeof navigator.mediaDevices.getDisplayMedia === "function";
  },

  // Attempts getDisplayMedia with no prior user gesture — chromium/firefox
  // fake-media flags are expected to auto-accept regardless; if an engine
  // instead throws for lack of a gesture or lack of support, the test
  // records that as the finding, not a harness bug.
  async getDisplayMedia(): Promise<
    { ok: true; tracks: SerializedTrack[] } | { ok: false; error: string }
  > {
    if (typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      return { ok: false, error: "getDisplayMedia not implemented" };
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia();
      const result: SerializedTrack[] = [];
      for (const track of stream.getTracks()) {
        tracks.set(track.id, track);
        result.push(serializeTrack(track));
      }
      return { ok: true, tracks: result };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  },

  hasSetSinkId(): boolean {
    return typeof HTMLMediaElement.prototype.setSinkId === "function";
  },

  getTrackState(id: string): SerializedTrack | null {
    const track = tracks.get(id);
    return track ? serializeTrack(track) : null;
  },

  setTrackEnabled(id: string, enabled: boolean): void {
    const track = tracks.get(id);
    if (track) track.enabled = enabled;
  },

  stopTrack(id: string): void {
    const track = tracks.get(id);
    if (track) track.stop();
  },

  // Resolves once `ended` fires on the track, or after timeoutMs if it
  // never does — used to prove/disprove that stop() fires `ended` (it
  // shouldn't, per spec: stop() is a local no-event transition).
  waitForEvent(
    id: string,
    event: "ended" | "mute" | "unmute",
    timeoutMs: number,
  ): Promise<boolean> {
    const track = tracks.get(id);
    if (!track) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      track.addEventListener(
        event,
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });
  },

  stopAllTracks(): void {
    for (const track of tracks.values()) track.stop();
    tracks.clear();
  },
};

export type Probe = typeof probe;

/**
 * The tier-2 half of "one contract suite, two harnesses".
 *
 * `window.__probe` above is agent 1's harness surface and stays exactly as it
 * was — `harness.spec.ts` still drives it. `window.__lab` is the new one: a
 * single data-in/data-out `call(method, args)` over a real
 * `VoqalizeMediaManager` running against a thinly-wrapped real
 * `navigator.mediaDevices`. It is one method rather than many for the same
 * reason the probe keeps an id-keyed registry — everything that crosses
 * `page.evaluate` has to be structured-cloneable, and one envelope is easier
 * to keep honest than forty signatures.
 */
const lab = new Lab(() => new RealLabPlatform());

const labSurface = {
  call(method: LabMethod, args: unknown[]): Promise<LabResult> {
    return lab.call(method, args);
  },
};

export type LabSurface = typeof labSurface;

declare global {
  interface Window {
    __probe: Probe;
    __lab: LabSurface;
  }
}

window.__probe = probe;
window.__lab = labSurface;
