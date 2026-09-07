/**
 * The manual lab page — tier 3.
 *
 * Tiers 1 and 2 assert. This tier is for a person: it opens the same
 * `VoqalizeMediaManager` against the real `navigator.mediaDevices`, wires it to
 * the same `LoopbackCall` the contract cases use, and puts every number on
 * screen so someone can watch a frame get encoded, sent and decoded and decide
 * for themselves whether to believe it.
 *
 * Two rules it holds itself to:
 *
 *  - **No Web Audio anywhere near the capture path** (SPEC.md decision 7). The
 *    microphone meter is `audioLevel` from the *receiving* peer's `getStats()`.
 *    An `AnalyserNode` on the capture track would be easier and would measure a
 *    pipeline we do not ship.
 *  - **Nothing here is a second implementation.** The page drives the shipped
 *    manager and the shipped loopback; if it needs a behaviour they do not
 *    have, that is a gap in them, not a helper in here.
 */

import { LANE_ORDER, LoopbackCall, type Lane, type LaneStats } from "./loopback";
import { ENCODING_POLICY, VoqalizeMediaManager, type LocalTrackType } from "../src/mediaManager";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const el = {
  support: $("support"),
  start: $<HTMLButtonElement>("start"),
  stop: $<HTMLButtonElement>("stop"),
  mic: $<HTMLButtonElement>("mic"),
  cam: $<HTMLButtonElement>("cam"),
  screen: $<HTMLButtonElement>("screen"),
  micSel: $<HTMLSelectElement>("micSel"),
  camSel: $<HTMLSelectElement>("camSel"),
  spkSel: $<HTMLSelectElement>("spkSel"),
  hear: $<HTMLInputElement>("hear"),
  localCam: $<HTMLVideoElement>("localCam"),
  remoteCam: $<HTMLVideoElement>("remoteCam"),
  localScr: $<HTMLVideoElement>("localScr"),
  remoteScr: $<HTMLVideoElement>("remoteScr"),
  localCamInfo: $("localCamInfo"),
  remoteCamInfo: $("remoteCamInfo"),
  localScrInfo: $("localScrInfo"),
  remoteScrInfo: $("remoteScrInfo"),
  remoteAudio: $<HTMLAudioElement>("remoteAudio"),
  meterBar: $("meterBar"),
  meterNum: $("meterNum"),
  statsBody: $<HTMLTableSectionElement>("statsBody"),
  state: $<HTMLDListElement>("state"),
  log: $("log"),
};

// ---------------------------------------------------------------- event log

function log(text: string, kind: "" | "err" | "hot" = ""): void {
  const now = new Date();
  const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(
    now.getSeconds(),
  ).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  const line = document.createElement("div");
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = `${stamp}  `;
  const body = document.createElement("span");
  if (kind) body.className = kind;
  body.textContent = text;
  line.append(time, body);
  el.log.append(line);
  // Only follow the tail when the reader is already at the tail — scrolling
  // back to read something and having it yanked away is the fastest way to
  // make a log useless.
  const atBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 60;
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
  while (el.log.childElementCount > 600) el.log.firstElementChild?.remove();
}

// ------------------------------------------------------------------- state

let manager: VoqalizeMediaManager | null = null;
let loopback: LoopbackCall | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let loopbackFailure: string | null = null;

const remoteStreams: Partial<Record<Lane, MediaStream>> = {};

function label(deviceId: string, name: string): string {
  // Every engine hides labels until a capture permission has been granted, so
  // a bare id is the honest fallback rather than a blank row.
  return name || (deviceId ? `(unlabelled) ${deviceId.slice(0, 12)}` : "(default)");
}

function fillSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  selectedId: string | undefined,
): void {
  const previous = select.value;
  select.replaceChildren();
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = label(device.deviceId, device.label);
    select.append(option);
  }
  const wanted =
    selectedId && devices.some((d) => d.deviceId === selectedId) ? selectedId : previous;
  if (wanted && devices.some((d) => d.deviceId === wanted)) select.value = wanted;
  select.disabled = devices.length === 0;
}

async function refreshDevices(): Promise<void> {
  if (!manager) return;
  const [mics, cams, speakers] = await Promise.all([
    manager.getAllMics(),
    manager.getAllCams(),
    manager.getAllSpeakers(),
  ]);
  fillSelect(el.micSel, mics, (manager.selectedMic as MediaDeviceInfo).deviceId);
  fillSelect(el.camSel, cams, (manager.selectedCam as MediaDeviceInfo).deviceId);
  fillSelect(el.spkSel, speakers, (manager.selectedSpeaker as MediaDeviceInfo).deviceId);
}

// ------------------------------------------------------------- video wiring

function showLocal(
  video: HTMLVideoElement,
  track: MediaStreamTrack | null,
  info: HTMLElement,
): void {
  if (!track) {
    video.srcObject = null;
    info.textContent = "idle";
    return;
  }
  video.srcObject = new MediaStream([track]);
  const settings = track.getSettings();
  info.textContent = `${settings.width ?? "?"}×${settings.height ?? "?"} · hint "${track.contentHint}"`;
}

function syncLocalPreviews(): void {
  if (!manager) return;
  const capture = manager.captureTracks();
  showLocal(el.localCam, (capture.video as MediaStreamTrack | null) ?? null, el.localCamInfo);
  showLocal(el.localScr, (capture.screenVideo as MediaStreamTrack | null) ?? null, el.localScrInfo);
}

function attachRemote(lane: Lane, track: MediaStreamTrack): void {
  const stream = remoteStreams[lane] ?? new MediaStream();
  for (const existing of stream.getTracks()) stream.removeTrack(existing);
  stream.addTrack(track);
  remoteStreams[lane] = stream;
  if (lane === "video") el.remoteCam.srcObject = stream;
  if (lane === "screenVideo") el.remoteScr.srcObject = stream;
  if (lane === "audio") el.remoteAudio.srcObject = stream;
  log(
    `loopback decoded lane ${LANE_ORDER.indexOf(lane)} (${lane}) — remote track ${track.id}`,
    "hot",
  );
}

// ------------------------------------------------------------------ buttons

function paint(): void {
  const live = !!manager;
  el.start.disabled = live;
  el.stop.disabled = !live;
  el.mic.disabled = !live;
  el.cam.disabled = !live;
  el.screen.disabled = !live || !manager?.supportsScreenShare;
  el.micSel.disabled = !live;
  el.camSel.disabled = !live;

  const micOn = !!manager?.isMicEnabled;
  const camOn = !!manager?.isCamEnabled;
  const screenOn = !!manager?.isSharingScreen;
  el.mic.textContent = micOn ? "Mic on" : "Mic off";
  el.mic.className = micOn ? "on" : "";
  el.cam.textContent = camOn ? "Camera on" : "Camera off";
  el.cam.className = camOn ? "on" : "";
  el.screen.textContent = screenOn ? "Stop sharing" : "Share screen";
  el.screen.className = screenOn ? "danger" : "";
}

function banner(kind: "good" | "bad", html: string): void {
  el.support.innerHTML = "";
  const box = document.createElement("div");
  box.className = `banner ${kind}`;
  box.innerHTML = html;
  el.support.append(box);
}

// ---------------------------------------------------------------- the call

async function start(): Promise<void> {
  el.start.disabled = true;
  loopbackFailure = null;
  const media = new VoqalizeMediaManager();
  manager = media;

  media.setClientOptions({
    enableMic: true,
    enableCam: false,
    callbacks: {
      onTrackStarted: (track) => {
        log(`onTrackStarted(${track.kind}) ${track.id}`);
        syncLocalPreviews();
      },
      onTrackStopped: (track) => {
        log(`onTrackStopped(${track.kind}) ${track.id}`);
        syncLocalPreviews();
      },
      onScreenTrackStarted: (track) => {
        log(`onScreenTrackStarted ${track.label || track.id}`, "hot");
        syncLocalPreviews();
      },
      onScreenTrackStopped: (track) => {
        // This is also how the browser's own "Stop sharing" chrome arrives —
        // the track ends and we never called stop().
        log(
          `onScreenTrackStopped ${track.id} (this is what browser "Stop sharing" looks like)`,
          "hot",
        );
        syncLocalPreviews();
        paint();
      },
      onScreenShareError: (message) => log(`onScreenShareError: ${message}`, "err"),
      onDeviceError: (error) =>
        log(
          `onDeviceError type=${error.type} devices=[${error.devices.join()}] — ${error.message}`,
          "err",
        ),
      onMicUpdated: (mic) => {
        log(`onMicUpdated ${label(mic.deviceId, mic.label)}`);
        void refreshDevices();
      },
      onCamUpdated: (cam) => {
        log(`onCamUpdated ${label(cam.deviceId, cam.label)}`);
        void refreshDevices();
      },
      onSpeakerUpdated: (speaker) =>
        log(`onSpeakerUpdated ${label(speaker.deviceId, speaker.label)}`),
      onAvailableMicsUpdated: (mics) => {
        log(`onAvailableMicsUpdated — ${mics.length} microphone(s)`);
        void refreshDevices();
      },
      onAvailableCamsUpdated: (cams) => {
        log(`onAvailableCamsUpdated — ${cams.length} camera(s)`);
        void refreshDevices();
      },
      onAvailableSpeakersUpdated: (speakers) => {
        log(`onAvailableSpeakersUpdated — ${speakers.length} output(s)`);
        void refreshDevices();
      },
    },
  });

  // The replaceTrack hook, which is the whole reason a device switch reaches
  // the wire without a renegotiation. Note it is awaited: the manager holds
  // the old clone live until this resolves, so there is no gap on the lane.
  media.setLocalTrackChangedHandler(async (event) => {
    const type: LocalTrackType = event.type;
    log(`onLocalTrackChanged(${type}) → ${event.track ? event.track.id : "null"}`);
    syncLocalPreviews();
    if (!loopback || type === "screenAudio") return;
    await loopback.publish(type, event.track);
    log(`  replaceTrack on lane ${LANE_ORDER.indexOf(type)} (${type}) — no renegotiation`, "hot");
  });

  try {
    log("initialize() — acquiring the microphone");
    await media.initialize();
    log("connect() — publishing clones");
    await media.connect();
    media.bindOutputElement(el.remoteAudio);
    await refreshDevices();
    syncLocalPreviews();
    paint();

    log("opening the loopback: two RTCPeerConnections, three sendonly transceivers");
    const call = new LoopbackCall({
      onRemoteTrack: ({ lane, track }) => attachRemote(lane, track),
    });
    loopback = call;
    for (const lane of LANE_ORDER) {
      const track = media.tracks().local[lane];
      if (track) await call.publish(lane, track);
    }
    await call.negotiate();
    log(`offer sent with ${call.mLineCount()} m-lines; waiting for ICE`);
    await call.waitUntilConnected(15_000);
    log("loopback connected — both peers report connected", "hot");
    for (const lane of LANE_ORDER) {
      const applied = await call.applyEncoding(lane, ENCODING_POLICY[lane]);
      log(
        `setParameters(${lane}): maxBitrate=${applied.maxBitrate} maxFramerate=${applied.maxFramerate} ` +
          `degradationPreference=${applied.degradationPreference}${applied.error ? ` ERROR ${applied.error}` : ""}`,
        applied.error ? "err" : "",
      );
    }
    banner(
      "good",
      "<b>Loopback is up.</b> The right-hand videos below are your own capture after a real " +
        "encode / RTP / decode round trip inside this tab.",
    );
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    loopbackFailure = message;
    log(`start failed: ${message}`, "err");
    banner(
      "bad",
      `<b>The loopback did not come up:</b> <code>${message}</code>. The manager half of the page ` +
        "still works — devices, buttons, local previews and the log are all live — but nothing is " +
        "being encoded, so every counter below will stay at zero. Firefox is the known case: it " +
        "gathers no ICE candidates at all under some configurations.",
    );
  }
  paint();
  startTicker();
}

async function stop(): Promise<void> {
  stopTicker();
  loopback?.close();
  loopback = null;
  const media = manager;
  manager = null;
  el.remoteCam.srcObject = null;
  el.remoteScr.srcObject = null;
  el.remoteAudio.srcObject = null;
  el.localCam.srcObject = null;
  el.localScr.srcObject = null;
  for (const lane of LANE_ORDER) delete remoteStreams[lane];
  if (media) {
    await media.destroy().catch((error: unknown) => log(`destroy failed: ${String(error)}`, "err"));
    log("call torn down — every capture device released");
  }
  el.statsBody.replaceChildren();
  laneRows.clear();
  el.state.replaceChildren();
  stateRows.clear();
  el.meterBar.style.width = "0%";
  el.meterNum.textContent = "";
  paint();
}

// --------------------------------------------------------------- the 1 Hz loop

function fmtBitrate(bitsPerSecond: number | null): string {
  if (bitsPerSecond === null) return "—";
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/** Bytes are cumulative; a rate needs the previous sample. */
const previous = new Map<Lane, { bytesSent: number; at: number }>();

const STAT_COLUMNS = 9;

/**
 * Rows are built once and their cells updated in place, never replaced.
 *
 * Not a micro-optimisation: a table that rebuilds itself every second cannot
 * be selected, cannot be copied, and flickers — and a page whose whole purpose
 * is for a person to stare at numbers has to let them stare.
 */
const laneRows = new Map<Lane, HTMLTableRowElement>();

function rowFor(lane: Lane, index: number): HTMLTableRowElement {
  const existing = laneRows.get(lane);
  if (existing) return existing;
  const row = document.createElement("tr");
  for (let i = 0; i < STAT_COLUMNS; i++) row.append(document.createElement("td"));
  row.cells[0]!.textContent = `${lane} (m-line ${index})`;
  row.cells[0]!.className = "lane";
  laneRows.set(lane, row);
  el.statsBody.append(row);
  return row;
}

function paintLane(stats: LaneStats, index: number): void {
  const row = rowFor(stats.lane, index);
  const idle = stats.senderTrackId === null;

  const now = performance.now();
  const last = previous.get(stats.lane);
  let bitrate: number | null = null;
  if (last && now > last.at) {
    bitrate = ((stats.bytesSent - last.bytesSent) * 8) / ((now - last.at) / 1000);
  }
  previous.set(stats.lane, { bytesSent: stats.bytesSent, at: now });

  // Audio has no frames at all; "n/a" there is correct and a zero would be a
  // lie. A *video* lane that is live and still at zero is the failure this
  // whole page exists to make visible, so it gets the red class.
  const frames = stats.lane === "audio" ? "n/a" : idle ? "—" : String(stats.framesEncoded ?? 0);
  const framesClass =
    stats.lane === "audio" || idle
      ? "big idle"
      : (stats.framesEncoded ?? 0) > 0
        ? "big ok"
        : "big zero";

  const values = [
    null, // the lane name never changes
    frames,
    idle || stats.framesPerSecond === null ? "—" : String(stats.framesPerSecond),
    idle || stats.frameWidth === null ? "—" : `${stats.frameWidth}×${stats.frameHeight}`,
    idle ? "—" : fmtBitrate(bitrate),
    idle ? "—" : String(stats.packetsSent),
    idle
      ? "—"
      : stats.lane === "audio"
        ? `${stats.packetsReceived} pkts`
        : `${stats.framesDecoded ?? 0} / ${stats.packetsReceived}`,
    stats.codec ?? "—",
    stats.qualityLimitationReason ?? "—",
  ];
  values.forEach((value, column) => {
    if (value === null) return;
    const cell = row.cells[column]!;
    if (cell.textContent !== value) cell.textContent = value;
  });
  const framesCell = row.cells[1]!;
  if (framesCell.className !== framesClass) framesCell.className = framesClass;
}

const stateRows = new Map<string, HTMLElement>();

/** Same reason as the table: written once, updated in place. */
function stateRow(term: string, value: string): void {
  let dd = stateRows.get(term);
  if (!dd) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    dd = document.createElement("dd");
    stateRows.set(term, dd);
    el.state.append(dt, dd);
  }
  if (dd.textContent !== value) dd.textContent = value;
}

async function tick(): Promise<void> {
  const media = manager;
  if (!media) return;

  // -- the manager's own state, straight off the object ---------------------
  stateRow("isMicEnabled", String(media.isMicEnabled));
  stateRow("isCamEnabled", String(media.isCamEnabled));
  stateRow("isSharingScreen", String(media.isSharingScreen));
  stateRow("supportsScreenShare", `${media.supportsScreenShare} (constant — decision 4)`);
  const mic = media.selectedMic as MediaDeviceInfo;
  const cam = media.selectedCam as MediaDeviceInfo;
  const speaker = media.selectedSpeaker as MediaDeviceInfo;
  stateRow("selected mic", label(mic.deviceId ?? "", mic.label ?? ""));
  stateRow("selected camera", cam.deviceId ? label(cam.deviceId, cam.label ?? "") : "(none)");
  stateRow(
    "selected speaker",
    speaker.deviceId ? label(speaker.deviceId, speaker.label ?? "") : "(none)",
  );
  stateRow("requested mic id", media.requestedMicId || "(default)");
  stateRow("requested cam id", media.requestedCamId || "(default)");

  if (!loopback) {
    stateRow("loopback", loopbackFailure ? `not connected — ${loopbackFailure}` : "not open");
    return;
  }

  const connection = loopback.connectionStates();
  stateRow("m-lines in the offer", `${loopback.mLineCount()} (must never change)`);
  stateRow("transceivers", String(loopback.transceiverShape().length));
  stateRow(
    "renegotiations needed",
    `${loopback.renegotiationCount()} (decision 4 keeps this at 0)`,
  );
  stateRow("peer connection", `local ${connection.local} / remote ${connection.remote}`);
  stateRow("ICE", `local ${connection.iceLocal} / remote ${connection.iceRemote}`);

  // -- the numbers ----------------------------------------------------------
  const stats = await loopback.stats();
  LANE_ORDER.forEach((lane, index) => paintLane(stats[lane], index));

  const level = stats.audio.audioLevel;
  if (level === null) {
    el.meterBar.style.width = "0%";
    el.meterNum.textContent =
      "this engine reports no audioLevel on either the inbound stats or the synchronization source";
    el.meterNum.className = "idle";
  } else {
    el.meterBar.style.width = `${Math.min(100, level * 100).toFixed(1)}%`;
    el.meterNum.textContent = `audioLevel ${level.toFixed(4)} (${stats.audio.audioLevelSource})`;
    el.meterNum.className = "ok";
  }

  const camStats = stats.video;
  el.remoteCamInfo.textContent =
    camStats.framesDecoded === null
      ? "idle"
      : `${camStats.inboundFrameWidth ?? "?"}×${camStats.inboundFrameHeight ?? "?"} · ${camStats.framesDecoded} frames decoded`;
  const scrStats = stats.screenVideo;
  el.remoteScrInfo.textContent =
    scrStats.framesDecoded === null
      ? "idle"
      : `${scrStats.inboundFrameWidth ?? "?"}×${scrStats.inboundFrameHeight ?? "?"} · ${scrStats.framesDecoded} frames decoded`;
}

function startTicker(): void {
  stopTicker();
  void tick();
  ticker = setInterval(() => void tick(), 1000);
}

function stopTicker(): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  previous.clear();
}

// ------------------------------------------------------------------- wiring

el.start.addEventListener("click", () => void start());
el.stop.addEventListener("click", () => void stop());

el.mic.addEventListener("click", () => {
  const media = manager;
  if (!media) return;
  const next = !media.isMicEnabled;
  log(`enableMic(${next})`);
  void media
    .enableMic(next)
    .catch((error: unknown) => log(`enableMic failed: ${String(error)}`, "err"))
    .finally(paint);
});

el.cam.addEventListener("click", () => {
  const media = manager;
  if (!media) return;
  const next = !media.isCamEnabled;
  log(`enableCam(${next})`);
  void media
    .enableCam(next)
    .catch((error: unknown) => log(`enableCam failed: ${String(error)}`, "err"))
    .finally(() => {
      syncLocalPreviews();
      paint();
    });
});

el.screen.addEventListener("click", () => {
  const media = manager;
  if (!media) return;
  const next = !media.isSharingScreen;
  log(`enableScreenShare(${next})`);
  void media
    .enableScreenShare(next)
    .catch((error: unknown) => log(`enableScreenShare failed: ${String(error)}`, "err"))
    .finally(() => {
      syncLocalPreviews();
      paint();
    });
});

el.micSel.addEventListener("change", () => {
  log(`updateMic(${el.micSel.value}) — expect a replaceTrack, not a renegotiation`);
  void manager
    ?.updateMic(el.micSel.value)
    .catch((error: unknown) => log(`updateMic failed: ${String(error)}`, "err"));
});
el.camSel.addEventListener("change", () => {
  log(`updateCam(${el.camSel.value}) — expect a replaceTrack, not a renegotiation`);
  void manager
    ?.updateCam(el.camSel.value)
    .catch((error: unknown) => log(`updateCam failed: ${String(error)}`, "err"));
});
el.spkSel.addEventListener("change", () => {
  log(`updateSpeaker(${el.spkSel.value})`);
  void manager
    ?.updateSpeaker(el.spkSel.value)
    .catch((error: unknown) => log(`updateSpeaker failed: ${String(error)}`, "err"));
});

el.hear.addEventListener("change", () => {
  el.remoteAudio.muted = !el.hear.checked;
  log(`remote audio ${el.hear.checked ? "unmuted — mind the feedback" : "muted"}`);
});
el.remoteAudio.muted = true;

// Capability notes the reader should see before they judge anything.
if (typeof HTMLMediaElement.prototype.setSinkId !== "function") {
  log(
    "this engine does not implement setSinkId — the speaker dropdown will not route output",
    "err",
  );
}
if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
  el.screen.title = "getDisplayMedia is not implemented on this engine";
}
banner(
  "good",
  "Press <b>Start call</b>. Nothing is acquired until you do — no permission prompt, no device " +
    "indicator, no <code>getUserMedia</code>.",
);
log("page loaded; no device has been touched yet");
paint();

window.addEventListener("beforeunload", () => {
  loopback?.close();
  void manager?.destroy();
});
