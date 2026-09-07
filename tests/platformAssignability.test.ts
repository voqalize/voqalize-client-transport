/**
 * The compile-time half of the "one manager, two platforms" claim.
 *
 * `voqalizeMediaManager.ts` is written against the structural interfaces in
 * `mediaPlatform.ts` so the *same file* runs in node against a fake and in a
 * browser against the real thing. That only holds if the real DOM types
 * actually satisfy those interfaces — and nothing in tier 1 would ever notice
 * if they stopped, because tier 1 never sees a DOM type.
 *
 * These assignments are the proof. They are erased at runtime; if one of them
 * breaks, `pnpm typecheck` fails and the manager is provably not the thing
 * running in the browser. The single `it` below exists so the file is a valid
 * vitest module — the real assertion is that this file compiles at all.
 */
import { describe, expect, it } from "vitest";

import type {
  MediaDevicesLike,
  OutputElementLike,
  StreamLike,
  TrackLike,
  VisibilitySource,
} from "../src/mediaPlatform";

/**
 * Never called. Its body is typechecked, which is the entire assertion — every
 * line below is a claim about the browser that tsc either accepts or rejects.
 */
function realDomTypesSatisfyThePlatformInterfaces(
  track: MediaStreamTrack,
  stream: MediaStream,
  mediaDevices: MediaDevices,
  doc: Document,
  audio: HTMLAudioElement,
  labTrack: TrackLike,
): void {
  const asTrack: TrackLike = track;
  const asStream: StreamLike = stream;
  const asDevices: MediaDevicesLike = mediaDevices;
  const asVisibility: VisibilitySource = doc;
  const asOutput: OutputElementLike = audio;
  // And the other direction where it matters: the manager hands pipecat
  // `MediaStreamTrack`s, so `TrackLike` must be castable to one. That cast
  // lives in the manager (`asTrack`) and is deliberately the only one there.
  const backToDom = labTrack as unknown as MediaStreamTrack;
  void [asTrack, asStream, asDevices, asVisibility, asOutput, backToDom];
}

void realDomTypesSatisfyThePlatformInterfaces;

describe("platform assignability", () => {
  it("is proven by this file compiling", () => {
    expect(true).toBe(true);
  });
});
