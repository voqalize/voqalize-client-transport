/**
 * The wire between the page and the Node-side UDP relay.
 *
 * Scenarios 6 and 7 — "the Wi-Fi/VPN path changed" and "ICE is wedged" — are
 * the two failures a same-page loopback can never produce. Both peers in
 * `loopback.ts` sit on the same host, discover each other over `127.0.0.1`,
 * and no test can take that path away: `pc.close()` proves teardown, not loss.
 *
 * So the media path gets an addressable middle. `relay/udpRelay.ts` runs two
 * UDP sockets inside the Vite dev server and cross-forwards between them; the
 * page hands each peer the relay's address instead of the other peer's, so
 * every packet of the call — STUN checks, DTLS, SRTP — passes through
 * something a test can switch off, degrade, or move.
 *
 * These are the three verbs that matter, and they are different failures:
 *
 * - `blackhole` — the path stays, the packets stop. This is the wedge: ICE
 *   consent checks go unanswered, `iceConnectionState` walks
 *   `connected → disconnected → failed`, and nothing on either peer has
 *   changed. **Scenario 7.**
 * - `rebind` — the path itself moves. The old ports are closed and two new
 *   ones open, which is what a laptop leaving Wi-Fi for a VPN looks like from
 *   the far end: the address it had been sending to answers nothing, and a
 *   different one now works. **Scenario 6.**
 * - `loss` — the path degrades without breaking. Not a scenario of its own,
 *   but the state in between, and the one that tells a real wedge from a
 *   rough minute.
 *
 * Everything here is plain JSON: it crosses `fetch` from the page and is
 * shared by the Node relay and the browser client so the two cannot drift.
 */

/** Which way to stop forwarding. A one-way blackhole is a real network, too. */
export type RelayDirection = "both" | "a-to-b" | "b-to-a";

/**
 * The two ports a call is wired through.
 *
 * `portFromA` is the socket **peer A sends to** — so it is the address peer A
 * is told is peer B. Packets that arrive there leave from `portFromB`, which
 * is the address peer B has for peer A. The names say who sends, never who
 * receives, because that is the direction the SDP munging has to get right.
 */
export interface RelayPorts {
  /**
   * The IPv4 address to put in both peers' candidates — a real interface
   * address, not `127.0.0.1`, whenever the host has one.
   *
   * Measured on 2026-09-07, and the reason this field exists at all: with a
   * `127.0.0.1` candidate the call connects on chromium and webkit and
   * **fails instantly on Firefox**, with `iceConnectionState` going straight
   * to `failed` and zero candidate pairs ever formed. Firefox does not gather
   * loopback host candidates (`media.peerconnection.ice.loopback` was measured
   * and changes nothing), so its only local candidate is the LAN interface,
   * and a LAN-to-loopback pair is not a pair it will form. Point the same call
   * at the host's own LAN address and all three engines connect — the packets
   * never leave the machine either way, because the kernel routes a datagram
   * addressed to one of its own interfaces over loopback.
   *
   * On a host with no non-internal IPv4 (offline, no interface up) this falls
   * back to `127.0.0.1`, which still works on chromium and webkit; the network
   * cases declare a named skip on Firefox rather than pass quietly.
   */
  address: string;
  portFromA: number;
  portFromB: number;
}

export interface RelayHandleInfo extends RelayPorts {
  id: string;
}

export interface RelayStats extends RelayHandleInfo {
  /** Datagrams forwarded, per direction. Non-zero on both is the proof media crossed the middle. */
  forwardedAToB: number;
  forwardedBToA: number;
  /** Datagrams dropped by `blackhole` or `loss`, which is what a wedge looks like from here. */
  dropped: number;
  blackhole: RelayDirection | null;
  lossRate: number;
  /** Set once a peer's real address has been learned from its first datagram. */
  seenA: boolean;
  seenB: boolean;
  /** How many times `rebind` has moved the path. Scenario 6 counts this. */
  rebinds: number;
}
