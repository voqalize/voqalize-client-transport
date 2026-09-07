/**
 * The page's handle on one relay. A thin `fetch` wrapper — the interesting
 * half is in `relay/udpRelay.ts` and in what `transport.ts` does with the
 * ports.
 *
 * Ports are re-read rather than cached. `rebind()` changes them, and the whole
 * point of scenario 6 is that the transport rebuilds against wherever the path
 * has moved to instead of the address it started with.
 */

import type { RelayDirection, RelayHandleInfo, RelayPorts, RelayStats } from "./relayTypes";

const BASE = "/__relay";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`relay ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`relay ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

export class RelayHandle {
  constructor(readonly id: string) {}

  static async open(): Promise<RelayHandle> {
    const info = await post<RelayHandleInfo>("/open");
    return new RelayHandle(info.id);
  }

  /** Where the path is **right now**, which is not where it was before a rebind. */
  ports(): Promise<RelayPorts> {
    return get<RelayPorts>(`/${this.id}/ports`);
  }

  stats(): Promise<RelayStats> {
    return get<RelayStats>(`/${this.id}/stats`);
  }

  /** Scenario 7: the path stays, the packets stop. */
  blackhole(direction: RelayDirection = "both"): Promise<RelayStats> {
    return post<RelayStats>(`/${this.id}/blackhole`, { direction });
  }

  resume(): Promise<RelayStats> {
    return post<RelayStats>(`/${this.id}/resume`);
  }

  /** Scenario 6: the path moves. New ports, no memory of the peers. */
  rebind(): Promise<RelayPorts> {
    return post<RelayPorts>(`/${this.id}/rebind`);
  }

  loss(rate: number): Promise<RelayStats> {
    return post<RelayStats>(`/${this.id}/loss`, { rate });
  }

  close(): Promise<unknown> {
    return post(`/${this.id}/close`);
  }
}
