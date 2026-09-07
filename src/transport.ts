/**
 * `createVoqalizeTransport()` — stock `SmallWebRTCTransport`, with our media
 * manager in place of Daily's.
 *
 * ## Why a factory and not a subclass
 *
 * `SmallWebRTCTransportConstructorOptions.mediaManager` is a public, supported
 * option, so the manager goes in through the front door. What the option does
 * *not* do is finish the wiring, and that gap is the whole reason this file
 * exists rather than a one-line `new SmallWebRTCTransport({ mediaManager })`
 * in your app.
 *
 * Two facts about `@pipecat-ai/small-webrtc-transport@1.10.6`, both read off
 * the shipped build:
 *
 * 1. **The abstract `MediaManager` base is not exported.** Only
 *    `WavMediaManager` and `DailyMediaManager` are. There is no class to
 *    extend and no type to name, so `VoqalizeMediaManager` implements the
 *    shape (`MediaManagerSurface`) and this factory performs exactly one cast.
 *    That cast is safe for a structural reason, not a hopeful one: every
 *    member the transport calls on `this.mediaManager` is a public member of
 *    the abstract base, and `MediaManagerSurface` lists all of them.
 *
 * 2. **The track-changed callback is a `DailyMediaManager` constructor
 *    argument, not a base-class method.** The transport passes its
 *    `replaceTrack` closure into `new DailyMediaManager(..., onTrackStarted,
 *    onTrackStopped)` *in the `||` branch it never reaches when you supply
 *    your own manager*. There is no `setLocalTrackChangedHandler` on the base
 *    for an injected manager to receive it through. Inject a manager and say
 *    nothing else, and the peer connection is wired **once**, at
 *    `addUserMedia()` time: every later device switch — a headset unplugged
 *    mid-call, a camera changed from a settings menu, a screen share started
 *    — produces a new track that nothing ever hands to a sender. The call
 *    stays up and the far end keeps receiving the *old* track, or silence.
 *
 * So the factory does the second half itself: it subscribes to the manager's
 * own `setLocalTrackChangedHandler` and performs the `replaceTrack` the stock
 * transport would have performed for Daily. Same behaviour, same lane mapping,
 * no fork of pipecat.
 */

import { logger } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import type { SmallWebRTCTransportConstructorOptions } from "@pipecat-ai/small-webrtc-transport";

import { VoqalizeMediaManager } from "./mediaManager";
import type { LocalTrackChangedEvent, VoqalizeMediaManagerOptions } from "./mediaManager";
import type { MediaManagerSurface } from "./pipecatTypes";

/**
 * The undeclared-but-present members of `SmallWebRTCTransport` this file uses.
 *
 * They are absent from the shipped `.d.ts` and present on the shipped class —
 * the build has no `#private` fields at all, so nothing here reaches past a
 * language boundary. Each is optional, and every use is guarded: if a future
 * pipecat release renames or truly privatises one, the manager falls back to
 * matching the sender by the track it is currently carrying, which needs
 * nothing but the standard `RTCPeerConnection` API.
 */
interface TransportInternals {
  pc?: RTCPeerConnection | null;
  getAudioTransceiver?: () => RTCRtpTransceiver;
  getVideoTransceiver?: () => RTCRtpTransceiver;
  getScreenVideoTransceiver?: () => RTCRtpTransceiver;
}

export interface VoqalizeTransportOptions extends Omit<
  SmallWebRTCTransportConstructorOptions,
  "mediaManager"
> {
  /**
   * Options for the media manager this transport will own.
   *
   * Ignored when `mediaManager` is supplied — pass one or the other.
   */
  media?: VoqalizeMediaManagerOptions;
  /**
   * Bring your own manager, already constructed. Use this when the app needs a
   * reference to it (to call `bindOutputElement()` or `resumePlayback()`, say)
   * before the transport exists. The factory still does the `replaceTrack`
   * wiring described above.
   */
  mediaManager?: VoqalizeMediaManager;
}

export interface VoqalizeTransport extends SmallWebRTCTransport {
  /**
   * The manager driving this transport's local media.
   *
   * Exposed because two of its capabilities have no pipecat equivalent and an
   * app has to reach them: `bindOutputElement()` (speaker routing, and the
   * `setSinkId` re-application that a device change needs) and
   * `resumePlayback()` (the user gesture that answers a blocked autoplay).
   */
  readonly voqalizeMedia: VoqalizeMediaManager;
}

/**
 * Build a `SmallWebRTCTransport` whose local media is owned by
 * `VoqalizeMediaManager` — no `@daily-co/daily-js`, and no script fetched from
 * a third-party origin at runtime.
 *
 * ```ts
 * import { PipecatClient } from "@pipecat-ai/client-js";
 * import { createVoqalizeTransport } from "@voqalize/client-transport";
 *
 * const transport = createVoqalizeTransport({
 *   webrtcRequestParams: { endpoint: "https://example.com/webrtc" },
 * });
 *
 * const client = new PipecatClient({ transport, enableMic: true });
 * await client.connect();
 * ```
 */
export function createVoqalizeTransport(options: VoqalizeTransportOptions = {}): VoqalizeTransport {
  const { media, mediaManager, ...transportOptions } = options;
  const manager = mediaManager ?? new VoqalizeMediaManager(media);

  const transport = new SmallWebRTCTransport({
    ...transportOptions,
    // The one cast the missing `MediaManager` export forces. The `satisfies`
    // in front of it is what keeps the cast honest: if our manager ever stops
    // implementing something the transport calls, that is a compile error here
    // rather than a `TypeError` on someone's first connect.
    mediaManager: manager satisfies MediaManagerSurface as unknown as NonNullable<
      SmallWebRTCTransportConstructorOptions["mediaManager"]
    >,
  });

  attachTrackChangedHandler(transport, manager);

  Object.defineProperty(transport, "voqalizeMedia", {
    value: manager,
    enumerable: false,
    writable: false,
  });

  return transport as VoqalizeTransport;
}

/**
 * Wire the manager's track changes to the transport's senders — the half of
 * the injection the stock transport only performs for `DailyMediaManager`.
 *
 * Exported because an app that has already built a `SmallWebRTCTransport` some
 * other way (a framework wrapper, an existing factory of its own) still needs
 * this, and should not have to reimplement it from the header comment.
 */
export function attachTrackChangedHandler(
  transport: SmallWebRTCTransport,
  manager: VoqalizeMediaManager,
): void {
  const internals = transport as unknown as TransportInternals;

  manager.setLocalTrackChangedHandler(async (event: LocalTrackChangedEvent) => {
    // `screenAudio` has no transceiver in this transport — pipecat's own
    // handler logs and ignores it, and so do we. Saying nothing here would be
    // indistinguishable from a bug.
    if (event.type === "screenAudio") return;

    const pc = internals.pc;
    if (!pc) return; // Not connected yet; `addUserMedia()` will pick the track up.

    // A closed peer connection is the ordinary case, not an error: the manager
    // releases every track on `destroy()`, and an app that tore the transport
    // down first gets one track-changed event per lane afterwards. Checking
    // the state answers the common path; the `catch` below answers the race,
    // because the connection can close between this line and the await.
    if (pc.connectionState === "closed") return;

    const sender = findSender(internals, pc, event);
    if (!sender) return;

    try {
      // `replaceTrack(null)` is legal and is what a disabled lane wants: the
      // m-line stays, so no renegotiation, and nothing is encoded.
      await sender.replaceTrack((event.track as MediaStreamTrack | null) ?? null);
    } catch (error) {
      // Never rethrow. This handler is awaited *inside* the manager's own
      // mutation queue, so a rejection here would fail the device switch that
      // caused it — turning a teardown race into a user-visible error on an
      // operation that otherwise succeeded.
      logger.debug("[voqalize] replaceTrack failed; the sender is gone or closing", error);
    }
  });
}

function findSender(
  internals: TransportInternals,
  pc: RTCPeerConnection,
  event: LocalTrackChangedEvent,
): RTCRtpSender | null {
  const getter =
    event.type === "audio"
      ? internals.getAudioTransceiver
      : event.type === "video"
        ? internals.getVideoTransceiver
        : internals.getScreenVideoTransceiver;

  if (typeof getter === "function") {
    try {
      const transceiver = getter.call(internals);
      if (transceiver?.sender) return transceiver.sender;
    } catch {
      // The transceivers do not exist until the peer connection is built.
      // Fall through to the identity match below.
    }
  }

  // Fallback: the sender still carries the track we are replacing. This needs
  // nothing beyond the standard API, and it is exact — track ids are unique
  // within a document.
  const previous = event.previousTrack;
  if (!previous) return null;
  for (const sender of pc.getSenders()) {
    if (sender.track && sender.track.id === previous.id) return sender;
  }
  return null;
}
