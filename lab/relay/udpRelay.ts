/**
 * A controllable UDP relay, run inside the Vite dev server.
 *
 * Two sockets per call, cross-forwarding. Peer A is told the relay's
 * `portFromA` is peer B; peer B is told `portFromB` is peer A. A datagram that
 * arrives on the `portFromA` socket therefore came from A, and is sent onward
 * **out of the `portFromB` socket** — so B sees it arriving from the address it
 * already holds as A's candidate, and ICE's source-address check passes. That
 * cross is the entire trick, and it is why the two ports are named for who
 * sends rather than who listens.
 *
 * The relay learns each peer's real address from the first datagram it sends,
 * so nothing has to tell it where the browser bound its sockets — which is
 * good, because on Chrome that address is an mDNS name the page is not allowed
 * to resolve.
 *
 * Why Node and not a page-side shim: there is no page-side shim. WebRTC's
 * transport is below JavaScript. The only way to get between two peers is to
 * be a real address on the network they are told to use, and only a real
 * socket can be that.
 *
 * Everything is loopback-only (`127.0.0.1`) and lives and dies with the dev
 * server. It listens for nothing but the two peers it was created for.
 */

import dgram from "node:dgram";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";

import type { RelayDirection, RelayHandleInfo, RelayPorts, RelayStats } from "../relayTypes";

/**
 * Bind on every interface, and advertise the host's own LAN address.
 *
 * The sockets have to answer on the address the candidates name, and the
 * candidates cannot name `127.0.0.1` — see `RelayPorts.address` in
 * `src/relayTypes.ts` for the measurement: Firefox gathers no loopback host
 * candidate and so never forms a pair against one. Traffic to the host's own
 * LAN address is still delivered over loopback by the kernel, so nothing about
 * this puts a test packet on the wire.
 */
const HOST = "0.0.0.0";

function advertisedAddress(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue; // link-local: nothing routes there
      return entry.address;
    }
  }
  return "127.0.0.1";
}

const ADDRESS = advertisedAddress();

interface PeerAddress {
  address: string;
  port: number;
}

class RelayPair {
  private socketFromA: dgram.Socket | null = null;
  private socketFromB: dgram.Socket | null = null;
  private addrA: PeerAddress | null = null;
  private addrB: PeerAddress | null = null;

  private ports: RelayPorts = { address: ADDRESS, portFromA: 0, portFromB: 0 };
  private blackhole: RelayDirection | null = null;
  private lossRate = 0;
  private forwardedAToB = 0;
  private forwardedBToA = 0;
  private dropped = 0;
  private rebinds = 0;

  constructor(readonly id: string) {}

  async open(): Promise<RelayPorts> {
    this.socketFromA = await this.bind("a");
    this.socketFromB = await this.bind("b");
    this.ports = {
      address: ADDRESS,
      portFromA: (this.socketFromA.address() as { port: number }).port,
      portFromB: (this.socketFromB.address() as { port: number }).port,
    };
    return this.ports;
  }

  /**
   * Move the path. The old sockets close — so the address each peer has been
   * sending to stops existing, exactly as it does when an interface goes away
   * — and two fresh ports open in their place. The learned peer addresses are
   * dropped with them: after a rebind the relay knows nothing until each side
   * sends again, which is the correct model of a new path.
   */
  async rebind(): Promise<RelayPorts> {
    this.closeSockets();
    this.addrA = null;
    this.addrB = null;
    this.rebinds += 1;
    return this.open();
  }

  setBlackhole(direction: RelayDirection | null): void {
    this.blackhole = direction;
  }

  setLoss(rate: number): void {
    this.lossRate = Math.min(1, Math.max(0, rate));
  }

  stats(): RelayStats {
    return {
      id: this.id,
      ...this.ports,
      forwardedAToB: this.forwardedAToB,
      forwardedBToA: this.forwardedBToA,
      dropped: this.dropped,
      blackhole: this.blackhole,
      lossRate: this.lossRate,
      seenA: !!this.addrA,
      seenB: !!this.addrB,
      rebinds: this.rebinds,
    };
  }

  info(): RelayHandleInfo {
    return { id: this.id, ...this.ports };
  }

  close(): void {
    this.closeSockets();
  }

  private closeSockets(): void {
    for (const socket of [this.socketFromA, this.socketFromB]) {
      try {
        socket?.close();
      } catch {
        // Already closed. A relay is torn down from both the test and the
        // server shutdown hook, and neither should have to check first.
      }
    }
    this.socketFromA = null;
    this.socketFromB = null;
  }

  private bind(side: "a" | "b"): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
      socket.on("error", reject);
      socket.on("message", (data, from) => {
        if (side === "a") {
          this.addrA = { address: from.address, port: from.port };
          this.forward(data, "a-to-b");
        } else {
          this.addrB = { address: from.address, port: from.port };
          this.forward(data, "b-to-a");
        }
      });
      socket.bind(0, HOST, () => {
        socket.off("error", reject);
        socket.on("error", () => undefined);
        resolve(socket);
      });
    });
  }

  private forward(data: Buffer, direction: "a-to-b" | "b-to-a"): void {
    if (this.blackhole === "both" || this.blackhole === direction) {
      this.dropped += 1;
      return;
    }
    if (this.lossRate > 0 && Math.random() < this.lossRate) {
      this.dropped += 1;
      return;
    }
    // A datagram from A leaves the *B* socket, so B sees it coming from the
    // address it holds as A. Sending it back out of the socket it arrived on
    // would put the relay's other port in the source field and every ICE check
    // would be discarded as coming from an unknown address.
    const target = direction === "a-to-b" ? this.addrB : this.addrA;
    const out = direction === "a-to-b" ? this.socketFromB : this.socketFromA;
    if (!target || !out) {
      // The far side has not spoken yet, so there is nowhere to send. ICE
      // retransmits its checks; the first few rounds legitimately go nowhere.
      this.dropped += 1;
      return;
    }
    out.send(data, target.port, target.address, () => undefined);
    if (direction === "a-to-b") this.forwardedAToB += 1;
    else this.forwardedBToA += 1;
  }
}

const relays = new Map<string, RelayPair>();
let nextId = 1;

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Vite strips the mount prefix, so `url` is `/open` or `/<id>/blackhole`.
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const segments = path.split("/").filter(Boolean);

  // What the relay would advertise, without opening one. A test reads this to
  // decide whether an engine can reach the relay at all.
  if (segments[0] === "address") return send(response, 200, { address: ADDRESS });

  if (segments[0] === "open") {
    const relay = new RelayPair(`relay-${nextId++}`);
    relays.set(relay.id, relay);
    await relay.open();
    return send(response, 200, relay.info());
  }

  const [id, action] = segments;
  const relay = id ? relays.get(id) : undefined;
  if (!relay) return send(response, 404, { error: `no relay ${String(id)}` });

  switch (action) {
    case "ports":
      return send(response, 200, relay.info());
    case "stats":
      return send(response, 200, relay.stats());
    case "blackhole": {
      const body = await readBody(request);
      const direction = (body["direction"] as RelayDirection | undefined) ?? "both";
      relay.setBlackhole(direction);
      return send(response, 200, relay.stats());
    }
    case "resume":
      relay.setBlackhole(null);
      relay.setLoss(0);
      return send(response, 200, relay.stats());
    case "loss": {
      const body = await readBody(request);
      relay.setLoss(Number(body["rate"] ?? 0));
      return send(response, 200, relay.stats());
    }
    case "rebind": {
      const ports = await relay.rebind();
      return send(response, 200, { id: relay.id, ...ports });
    }
    case "close":
      relay.close();
      relays.delete(relay.id);
      return send(response, 200, { closed: true });
    default:
      return send(response, 404, { error: `unknown action ${String(action)}` });
  }
}

/**
 * Mount the relay's control API on the dev server at `/__relay`.
 *
 * `pnpm dev` and the Playwright `webServer` run the same command, so the
 * manual lab page and the suite drive the same relay — the point SPEC.md makes
 * about the demo being the thing under test rather than a second
 * implementation of it.
 */
export function udpRelayPlugin(): Plugin {
  return {
    name: "voqalize-udp-relay",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/__relay", (request, response) => {
        void handle(request, response).catch((error: unknown) => {
          send(response, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      server.httpServer?.on("close", () => {
        for (const relay of relays.values()) relay.close();
        relays.clear();
      });
    },
  };
}
