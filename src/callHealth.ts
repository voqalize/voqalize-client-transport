/**
 * CallHealth: one snapshot of everything that can stop a call from working,
 * phrased for the person on it.
 *
 * `VoqalizeMediaManager.onCallHealthChanged(listener)` calls the listener at
 * once with the current snapshot, then again whenever any part of it changes.
 * Each part is a small state machine (`mic`, `cam`, `speaker`, `screen`,
 * `connection`); a failure always carries a `problem` and the `fixes` a UI can
 * offer, most likely first.
 *
 * It is a superset of pipecat's `mediaState`, not an extension of its union:
 * pipecat's own state stays driven by our device errors, unchanged.
 *
 * This file holds the vocabulary and the pure parts: the types, the store,
 * the classification of a capture error into a problem, the fixes for each
 * problem and the traits read from a device label. Everything stateful lives
 * where the state is — the manager for devices, the transport for the
 * connection.
 */

// -- the vocabulary ----------------------------------------------------------
//
// Where pipecat's `mediaState` names the same thing, these use its word:
// `blocked`, `already-in-use`, `not-found`, `not-supported` and `unknown`. The rest is
// what pipecat cannot say. Only `CallHealth`, its listener and its parts are
// exported from the package: an app names a leaf type through them, as
// `CallHealth["mic"]` or `Extract<CaptureHealth, { state: "failed" }>["fixes"]`.

export interface CallHealth {
  mic: CaptureHealth;
  cam: CaptureHealth;
  speaker: SpeakerHealth;
  screen: ScreenHealth;
  connection: ConnectionHealth;
}

export type CaptureHealth =
  | { state: "off" }
  | { state: "muted"; device: Device }
  | { state: "asking" }
  | { state: "starting"; device: Device }
  | { state: "live"; device: Device; signal: Signal; recovered?: Recovery }
  | { state: "degraded"; device: Device; signal: Signal; problem: Problem; fixes: Fix[] }
  | { state: "recovering"; device: Device; cause: Cause }
  | { state: "failed"; device: Device | null; problem: Problem; fixes: Fix[]; error?: RawError };

/**
 * Whether the device is producing sound. `local` is measured in this page,
 * once its audio context runs — which a browser may hold until the page's
 * first gesture; until then it is `unmeasured`. `server` is what the voice
 * runtime decoded: `none` means no packets reached it.
 */
export interface Signal {
  local: "sound" | "silent" | "unmeasured";
  server: "sound" | "silent" | "none" | "unmeasured";
}

export type Problem =
  | { code: "blocked"; by: "user" | "page" | "policy" | "os" | "in-app-browser" | "unknown" }
  | {
      code:
        | "prompt-dismissed"
        | "already-in-use"
        | "not-found"
        | "no-signal"
        | "interrupted"
        | "not-supported"
        | "unknown";
    };

export type Fix =
  | "ask-again"
  | "allow-in-browser"
  | "allow-in-os-settings"
  | "open-in-browser"
  | "contact-admin"
  | "fix-page-embedding"
  | "unmute-hardware"
  | "raise-input-volume"
  | "close-other-apps"
  | "open-camera-shutter"
  | "start-camera-app"
  | "connect-a-device"
  | "choose-another-device";

export type Cause = "device-lost" | "interrupted" | "permission-granted" | "no-signal";

export interface Device {
  deviceId: string;
  label: string;
  traits: Trait[];
}

export type Trait = "loopback" | "virtual" | "bluetooth-handsfree" | "display-audio";

export interface Recovery {
  from: Device | null;
  cause: Cause;
}

export interface RawError {
  name: string;
  message: string;
}

export type SpeakerHealth =
  | { state: "idle"; device: Device | null }
  | {
      state: "playing";
      device: Device | null;
      signal: "sound" | "unmeasured";
      recovered?: Recovery;
    }
  | { state: "blocked" }
  | { state: "recovering"; device: Device | null; cause: "stalled" };

export type ScreenHealth =
  | { state: "not-supported" }
  | { state: "off"; ended?: "app" | "user" }
  | { state: "asking" }
  | { state: "live"; surface: "monitor" | "window" | "browser" | "unknown" }
  | { state: "failed"; problem: Problem; fixes: Fix[]; error?: RawError };

export interface ConnectionHealth {
  state: "connecting" | "connected" | "reconnecting" | "disconnected";
  /**
   * Why a call is over: `ended` by either side, `unreachable` when no media
   * path formed, `refused` when the server turned the call down (an expired
   * or ended session, a quota, a key it does not accept).
   */
  reason?: "ended" | "unreachable" | "refused";
  uplink: Grade;
  downlink: Grade;
}

export type Grade = "good" | "fair" | "poor" | "bad" | "unknown";

/** Passed through to `getDisplayMedia`, per call. */
export interface ScreenPickerHints {
  displaySurface?: "monitor" | "window" | "browser";
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
}

export type CallHealthListener = (health: CallHealth) => void;

export const INITIAL_CONNECTION: ConnectionHealth = {
  state: "disconnected",
  uplink: "unknown",
  downlink: "unknown",
};

// -- the store ---------------------------------------------------------------

/**
 * Holds the snapshot and its listeners. A listener is called synchronously on
 * subscribe and after every change that alters the snapshot; an update that
 * leaves it equal calls nobody. A throwing listener is isolated: the others
 * still hear, and the throw is reported asynchronously so it is not lost.
 */
export class CallHealthStore {
  private current: CallHealth;
  private readonly listeners = new Set<CallHealthListener>();

  constructor(initial: CallHealth) {
    this.current = freeze(initial);
  }

  get snapshot(): CallHealth {
    return this.current;
  }

  subscribe(listener: CallHealthListener): () => void {
    this.listeners.add(listener);
    this.call(listener, this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(patch: Partial<CallHealth>): void {
    let changed = false;
    const next: CallHealth = { ...this.current };
    for (const key of Object.keys(patch) as (keyof CallHealth)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (sameValue(this.current[key], value)) continue;
      (next as unknown as Record<string, unknown>)[key] = value;
      changed = true;
    }
    if (!changed) return;
    this.current = freeze(next);
    for (const listener of [...this.listeners]) this.call(listener, this.current);
  }

  clear(): void {
    this.listeners.clear();
  }

  private call(listener: CallHealthListener, health: CallHealth): void {
    try {
      listener(health);
    } catch (error) {
      setTimeout(() => {
        throw error;
      }, 0);
    }
  }
}

/** Deep equality over plain data, whatever order its keys were written in. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((k) => left[k] !== undefined);
  if (keys.length !== Object.keys(right).filter((k) => right[k] !== undefined).length) return false;
  return keys.every((k) => sameValue(left[k], right[k]));
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) freeze(inner);
  }
  return value;
}

// -- traits ------------------------------------------------------------------

/**
 * Read from the label, because a label is all the platform gives us. Each list
 * is the names seen in the field and in vendor documentation; a device that
 * matches none has no traits, which is the safe reading.
 */
const TRAIT_PATTERNS: Array<[Trait, RegExp]> = [
  [
    "loopback",
    /stereo mix|what u hear|wave out mix|vb-audio|cable output|voicemeeter|blackhole|background music|soundflower|loopback audio|mezcla est[eé]reo|mixage st[eé]r[eé]o|stereomix/i,
  ],
  [
    "virtual",
    /nvidia broadcast|\bcamo\b|droidcam|iriun|\bobs\b|obs virtual|snap camera|manycam|xsplit|epoccam|krisp|steam streaming|nomachine|virtual/i,
  ],
  ["bluetooth-handsfree", /hands-?free|\bhfp\b|headset \(.*hands|bluetooth.*headset|\bAG audio\b/i],
  [
    "display-audio",
    /hdmi|displayport|display audio|\bdp\b audio|nvidia high definition|amd high definition|intel\(r\) display/i,
  ],
];

/**
 * A Bluetooth microphone is a headset in call mode: classic Bluetooth carries
 * a mic only in the hands-free profile, so opening one switches the headset
 * into it. Windows names these "Headset (AirPods)" or "… (Bluetooth)", macOS
 * just "AirPods Pro". Only for inputs: the same name on an output can be the
 * stereo profile.
 */
const BLUETOOTH_INPUT = /bluetooth|airpods/i;

export function traitsOf(label: string, input = false): Trait[] {
  if (!label) return [];
  const traits: Trait[] = [];
  for (const [trait, pattern] of TRAIT_PATTERNS) if (pattern.test(label)) traits.push(trait);
  if (input && BLUETOOTH_INPUT.test(label) && !traits.includes("bluetooth-handsfree"))
    traits.push("bluetooth-handsfree");
  // A loopback device is also "virtual" by some vendors' names; loopback is
  // the more useful of the two, so it is not doubled.
  return traits.includes("loopback") ? traits.filter((t) => t !== "virtual") : traits;
}

export function describeDevice(deviceId: string, label: string, input = false): Device {
  return { deviceId, label, traits: traitsOf(label, input) };
}

// -- classification ----------------------------------------------------------

export type PermissionReading = "granted" | "denied" | "prompt" | "unknown";

/** What the page knows about where it runs, beyond the error itself. */
export interface CaptureEnvironment {
  /** The permission as read just before the request, or `unknown`. */
  permission: PermissionReading;
  /** True when this frame's Permissions Policy does not allow the feature (Chromium can tell). */
  framePolicyBlocked: boolean;
  /** True for in-app browsers (Instagram, Facebook, LinkedIn, …) that cannot grant capture. */
  inAppBrowser: boolean;
}

export interface Classified {
  problem: Problem;
  fixes: Fix[];
  error: RawError;
}

export function rawError(error: unknown): RawError {
  const source =
    (error as { details?: { sourceError?: unknown } } | null)?.details?.sourceError ?? error;
  if (source && typeof source === "object") {
    const { name, message } = source as { name?: unknown; message?: unknown };
    return { name: String(name ?? "Error"), message: String(message ?? "") };
  }
  return { name: "Error", message: String(source) };
}

export const SYSTEM_DENIAL = /denied by system|system denied|by the system|operating system/i;
const DISMISSED = /dismiss/i;
const POLICY = /policy|administrator|enterprise/i;

/** Turn a `getUserMedia` failure into the problem a person can act on. */
export function classifyCaptureError(
  error: unknown,
  kind: "mic" | "cam",
  env: CaptureEnvironment,
): Classified {
  const raw = rawError(error);
  return { ...classifyRaw(raw, kind, env), error: raw };
}

function classifyRaw(
  raw: RawError,
  kind: "mic" | "cam",
  env: CaptureEnvironment,
): { problem: Problem; fixes: Fix[] } {
  switch (raw.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return classifyDenial(raw, env, kind);
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return withFixes({ code: "already-in-use" }, kind);
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return withFixes({ code: "not-found" }, kind);
    case "TypeError":
    case "NotSupportedError":
      return withFixes({ code: "not-supported" }, kind);
    default:
      // pipecat's word for an error nobody recognises: calling it a busy
      // device would send the user to close apps that are not the cause.
      return withFixes({ code: "unknown" }, kind);
  }
}

function classifyDenial(
  raw: RawError,
  env: CaptureEnvironment,
  kind: "mic" | "cam",
): { problem: Problem; fixes: Fix[] } {
  const blocked = (by: Extract<Problem, { code: "blocked" }>["by"]) =>
    withFixes({ code: "blocked", by }, kind);
  if (env.framePolicyBlocked) return blocked("page");
  if (SYSTEM_DENIAL.test(raw.message)) return blocked("os");
  // The browser says yes and the request still fails: something under it said no.
  if (env.permission === "granted") return blocked("os");
  if (env.inAppBrowser) return blocked("in-app-browser");
  if (POLICY.test(raw.message)) return blocked("policy");
  if (DISMISSED.test(raw.message)) return withFixes({ code: "prompt-dismissed" }, kind);
  if (env.permission === "denied") return blocked("user");
  // Firefox (no reliable permission reading) and anything we cannot tell apart.
  return blocked("unknown");
}

function withFixes(problem: Problem, kind: "mic" | "cam"): { problem: Problem; fixes: Fix[] } {
  return { problem, fixes: fixesFor(problem, kind) };
}

/**
 * The fixes for a problem, most likely first. `traits` are the device's, where
 * they change the advice.
 */
export function fixesFor(
  problem: Problem,
  kind: "mic" | "cam" | "screen",
  traits: readonly Trait[] = [],
): Fix[] {
  if (kind === "screen") {
    // A screen is not a device the user plugs in or switches: only a block, or
    // another app holding the capture, has a fix the person can make.
    switch (problem.code) {
      case "blocked":
        break;
      case "already-in-use":
        return ["close-other-apps"];
      default:
        return [];
    }
  }
  switch (problem.code) {
    case "blocked":
      switch (problem.by) {
        case "user":
          return ["allow-in-browser"];
        case "os":
          return ["allow-in-os-settings"];
        case "page":
          return ["fix-page-embedding"];
        case "in-app-browser":
          return ["open-in-browser"];
        case "policy":
          return ["contact-admin"];
        default:
          return ["allow-in-browser", "allow-in-os-settings", "open-in-browser"];
      }
    case "prompt-dismissed":
      return ["ask-again"];
    case "already-in-use":
      return ["close-other-apps", "choose-another-device"];
    case "unknown":
      return ["ask-again", "choose-another-device"];
    case "not-found":
      return ["connect-a-device", "choose-another-device"];
    case "no-signal":
      if (kind === "cam") {
        // A virtual camera (NVIDIA Broadcast, OBS, a phone through Phone Link)
        // sends black until its app or phone is running: it has no shutter.
        return traits.includes("virtual")
          ? ["start-camera-app", "choose-another-device"]
          : ["open-camera-shutter", "choose-another-device"];
      }
      return [
        "unmute-hardware",
        "raise-input-volume",
        "allow-in-os-settings",
        "choose-another-device",
      ];
    case "interrupted":
      // Reached only with the page in front: the reopens wait for it. A device
      // that still comes back muted is held by something else (a phone call,
      // another app, a hardware mute), so returning to the page would not help.
      return kind === "cam"
        ? ["close-other-apps", "choose-another-device"]
        : ["close-other-apps", "unmute-hardware", "choose-another-device"];
    case "not-supported":
      return ["open-in-browser"];
  }
}

// -- the environment ---------------------------------------------------------

const IN_APP_BROWSER =
  /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Line\/|MicroMessenger|Snapchat|TikTok|musical_ly|Twitter|Pinterest|GSA\//i;

export function isInAppBrowser(userAgent: string | undefined): boolean {
  return !!userAgent && IN_APP_BROWSER.test(userAgent);
}

interface PolicyLike {
  allowsFeature?(feature: string): boolean;
}

/**
 * Whether this frame may use the feature at all. Chromium exposes the frame's
 * policy; elsewhere the answer is "can't tell", which reads as allowed so a
 * denial falls through to the other readings.
 */
export type FramePolicy = (feature: "microphone" | "camera" | "display-capture") => boolean;

export function browserFramePolicy(): FramePolicy | null {
  const doc = (
    globalThis as { document?: { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike } }
  ).document;
  const policy = doc?.permissionsPolicy ?? doc?.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== "function") return null;
  return (feature) => {
    try {
      return policy.allowsFeature?.(feature) !== false;
    } catch {
      return true;
    }
  };
}
