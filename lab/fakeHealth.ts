/**
 * The scriptable world CallHealth reads in tier 1: what each fake device
 * "hears", and what the browser says about permissions. The manager gets it
 * through the same seams a browser fills — an `AudioContext` factory and a
 * `navigator.permissions` — so the rules run unchanged and only the readings
 * are scripted. What the voice runtime sees of the camera is played to the manager
 * directly (`setServerSignal`).
 */
import type {
  AnalyserLike,
  AudioContextFactory,
  AudioContextLike,
  AudioNodeLike,
} from "../src/localAudioLevel";
import type { PermissionStatusLike, PermissionsLike } from "../src/mediaManager";
import type { StreamLike, TrackLike } from "../src/mediaPlatform";

export type PermissionName = "microphone" | "camera";
export type PermissionValue = "granted" | "denied" | "prompt";

/** Ordinary speech-level noise: what a working mic reads. */
export const DEFAULT_LEVEL = 0.2;

class FakePermissionStatus extends EventTarget implements PermissionStatusLike {
  constructor(public state: PermissionValue) {
    super();
  }
  set(state: PermissionValue): void {
    if (state === this.state) return;
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}

export class FakeHealthWorld {
  private readonly levels = new Map<string, number>();
  private readonly statuses: Record<PermissionName, FakePermissionStatus> = {
    microphone: new FakePermissionStatus("granted"),
    camera: new FakePermissionStatus("granted"),
  };

  /** `"*"` sets the level every device without its own reads. */
  setInputLevel(deviceId: string, level: number): void {
    this.levels.set(deviceId, level);
  }

  setPermission(name: PermissionName, state: PermissionValue): void {
    this.statuses[name].set(state);
  }

  levelOf(track: TrackLike): number {
    const id = deviceIdOf(track);
    return this.levels.get(id) ?? this.levels.get("*") ?? DEFAULT_LEVEL;
  }

  readonly permissions: PermissionsLike = {
    query: async ({ name }) => {
      const status = this.statuses[name as PermissionName];
      if (!status) throw new TypeError(`unknown permission ${name}`);
      return status;
    },
  };

  readonly createAudioContext: AudioContextFactory = () => new FakeAudioContext(this);
}

function deviceIdOf(track: TrackLike): string {
  try {
    return track.getSettings().deviceId ?? "";
  } catch {
    return "";
  }
}

class FakeNode implements AudioNodeLike {
  connected: AudioNodeLike | null = null;
  constructor(readonly track: TrackLike | null) {}
  connect(destination: AudioNodeLike): unknown {
    this.connected = destination;
    if (destination instanceof FakeAnalyserNode && this.track) destination.source = this.track;
    return destination;
  }
  disconnect(): void {
    this.connected = null;
  }
}

class FakeAnalyserNode extends FakeNode implements AnalyserLike {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  source: TrackLike | null = null;
  constructor(private readonly world: FakeHealthWorld) {
    super(null);
  }
  getFloatTimeDomainData(array: Float32Array): void {
    const level =
      this.source && this.source.readyState === "live" ? this.world.levelOf(this.source) : 0;
    // A square-ish wave at the level: the peak is the level exactly.
    for (let i = 0; i < array.length; i++) array[i] = i % 2 === 0 ? level : -level;
  }
  getByteTimeDomainData(array: Uint8Array): void {
    const level = this.source ? this.world.levelOf(this.source) : 0;
    for (let i = 0; i < array.length; i++)
      array[i] = 128 + Math.round((i % 2 === 0 ? 1 : -1) * level * 127);
  }
}

/** Runs from the start: tier 1 has no autoplay policy to hold it. */
class FakeAudioContext implements AudioContextLike {
  state = "running";
  readonly sampleRate = 48_000;
  constructor(private readonly world: FakeHealthWorld) {}
  createMediaStreamSource(stream: StreamLike): AudioNodeLike {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new DOMException("no audio track", "InvalidStateError");
    return new FakeNode(track);
  }
  createAnalyser(): AnalyserLike {
    return new FakeAnalyserNode(this.world);
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.state = "closed";
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}
