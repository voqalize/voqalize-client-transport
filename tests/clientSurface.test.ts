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
 * - An `AppProtocol` types actions, UI events and client messages by name.
 *
 * That a `PipecatClient` has every member and event we offer is checked in
 * `src/client.ts` itself, where the assignment happens.
 */
import { readFileSync } from "node:fs";

import { RTVIEvent } from "@pipecat-ai/client-js";
import { describe, expect, it } from "vitest";

import type { AppProtocol, VoqalizeClient } from "../src/clientTypes";

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
function theClientFitsItsConsumers(client: VoqalizeClient): void {
  const stage: StageClient = client;
  const holder: HolderClient = client;
  const relayed: RelayedClient = client;
  const avatar: AvatarClientLike = client;
  void [stage, holder, relayed, avatar];

  // The body sessions.connect returns, as JSON.parse gives it.
  const body = {
    webrtc_request_params: {
      endpoint: "https://signal.example/webrtc",
      headers: { Authorization: "Bearer t" },
    },
    session_id: "s",
    ice_config: { iceServers: [{ urls: ["turn:t.example"], username: "u", credential: "c" }] },
  };
  void client.connect(body).then((ready) => void ready.version);
  void client.connect(); // a rejoin
  void client.hasLiveCall;
  // @ts-expect-error the body names its endpoint
  void client.connect({ session_id: "s" });

  client.on("uiCommand", (action) => void action.command);
  client.on(RTVIEvent.UICommand, (action) => void action.payload);
  client.on("botOutput", (output) => void output.spoken_status);
  client.on("error", (message) => void message.data.fatal);
  client.on(
    "deviceError",
    (error) => error.devices.includes("mic") && error.type === "permissions",
  );
  client.sendUIEvent("anything", { any: "payload" });
  client.sendUIEvent("bare");
  client.sendClientMessage("anything");
  // @ts-expect-error not an event we offer
  client.on("metrics", () => {});
  // @ts-expect-error the payload is ours, not any
  client.on("uiCommand", (action: number) => void action);
  // @ts-expect-error gato never sent output_type
  client.on("botOutput", (output) => void output.output_type);
  // @ts-expect-error not a status pipecat has
  client.on("botOutput", (output) => output.spoken_status === "done");
  // @ts-expect-error not a member we offer
  void client.enableCam;
}
void theClientFitsItsConsumers;

interface Shop extends AppProtocol {
  actions: { show_product: { sku: string }; open_cart: null };
  uiEvents: { added_to_cart: { sku: string; qty: number }; cart_opened: undefined };
  serverMessage: { type: "stock"; sku: string; left: number };
}

/** Never called: an app's protocol narrows names and payloads. */
function aProtocolTypesTheApp(client: VoqalizeClient<Shop>): void {
  client.on("uiCommand", (action) => {
    if (action.command === "show_product") void action.payload.sku;
    // @ts-expect-error open_cart's payload is null
    if (action.command === "open_cart") void action.payload.sku;
    // @ts-expect-error not an action the brain sends
    if (action.command === "close_cart") return;
  });
  client.on("serverMessage", (message) => void message.left);
  client.sendUIEvent("added_to_cart", { sku: "a", qty: 1 });
  client.sendUIEvent("cart_opened");
  // @ts-expect-error a UI event the brain does not handle
  client.sendUIEvent("checkout", {});
  // @ts-expect-error added_to_cart needs its payload
  client.sendUIEvent("added_to_cart");
  // @ts-expect-error qty is a number
  client.sendUIEvent("added_to_cart", { sku: "a", qty: "1" });
  // No clientMessages in Shop: any type, any data.
  client.sendClientMessage("whatever", 1);

  // A protocol client is still every consumer's client.
  const stage: StageClient = client;
  const avatar: AvatarClientLike = client;
  void [stage, avatar];
}
void aProtocolTypesTheApp;

describe("the narrow client", () => {
  it("declares its types without importing anything", () => {
    const source = readFileSync(new URL("../src/clientTypes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m);
  });
});
