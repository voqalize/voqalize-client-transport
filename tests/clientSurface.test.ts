/**
 * The narrow client's claims, most of them checked by `pnpm typecheck`.
 *
 * - `src/clientTypes.ts` imports nothing, so no pipecat type is reachable
 *   from the surface an app holds. Checked at runtime below, on the source.
 * - What `createVoqalizeClient()` returns fits every place we hand a client
 *   to: Stage, the site holders, the relay, the avatar. Each consumer type is
 *   copied here as it is declared in its own repo; if one widens past what we
 *   offer, the copy here is where it shows.
 * - Events we do not offer are compile errors, and pipecat's `RTVIEvent`
 *   constants still work for the ones we do.
 *
 * That a `PipecatClient` is a `VoqalizeClient` is checked in `src/client.ts`
 * itself, where the assignment happens.
 */
import { readFileSync } from "node:fs";

import { RTVIEvent } from "@pipecat-ai/client-js";
import { describe, expect, it } from "vitest";

import type { VoqalizeSession } from "../src/clientTypes";

type ClientHandler = (...args: any[]) => void;

/** voqalize `sdk/js/stage/src/attach.ts` */
interface StageClient {
  on(event: string, handler: ClientHandler): unknown;
  off(event: string, handler: ClientHandler): unknown;
  sendUIEvent(event: string, payload?: unknown): void;
  readonly state?: string;
}
/** The site holders and extensions: Stage's client, plus the call controls. */
interface HolderClient extends StageClient {
  connect(params?: unknown): Promise<unknown>;
  disconnect(): Promise<void>;
  disconnectBot(): void;
  enableMic(enable: boolean): void;
  sendClientMessage(type: string, data?: unknown): void;
  readonly transport: unknown;
}
/** voqalize `sdk/js/stage/src/relay.ts` */
interface RelayedClient {
  on(event: string, handler: ClientHandler): unknown;
  off(event: string, handler: ClientHandler): unknown;
  readonly transport: unknown;
}
/** `@voqalize/avatar` 0.7.1 `AvatarClientLike` */
interface AvatarClientLike {
  on(event: string, handler: (...args: any[]) => void): unknown;
  off(event: string, handler: (...args: any[]) => void): unknown;
  tracks(): { readonly bot?: { readonly audio?: MediaStreamTrack } | null };
  sendClientMessage(msgType: string, data?: unknown): unknown;
  readonly transport?: unknown;
}

/** Never called: its body is the assertion. */
function theSessionFitsItsConsumers(session: VoqalizeSession): void {
  const stage: StageClient = session;
  const holder: HolderClient = session;
  const relayed: RelayedClient = session;
  const avatar: AvatarClientLike = session;
  void [stage, holder, relayed, avatar];

  // The body sessions.connect returns, as JSON.parse gives it.
  const body = {
    webrtc_request_params: {
      endpoint: "https://signal.example/webrtc",
      headers: { Authorization: "Bearer t" },
    },
  };
  void session.connect(body);
  void session.connect(); // a rejoin

  session.on("uiCommand", (action) => void action.command);
  session.on(RTVIEvent.UICommand, (action) => void action.payload);
  session.on("botOutput", (output) => void output.output_type);
  session.on("deviceError", (error) => void error.devices);
  // @ts-expect-error not an event we offer
  session.on("metrics", () => {});
  // @ts-expect-error the payload is ours, not any
  session.on("uiCommand", (action: number) => void action);
  // @ts-expect-error not a member we offer
  void session.enableCam;
}
void theSessionFitsItsConsumers;

describe("the narrow client", () => {
  it("declares its types without importing anything", () => {
    const source = readFileSync(new URL("../src/clientTypes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m);
  });
});
