import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnchainSuite, type Notification } from "./index";

// jsdom may lack rAF depending on version — polyfill so the renderer runs.
(globalThis as unknown as { requestAnimationFrame?: unknown })
  .requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(0), 0);

/** A fake socket.io `io` factory we can drive from tests. */
function makeFakeIo() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const socket = {
    connected: false,
    on(e: string, cb: (...a: unknown[]) => void) {
      (handlers[e] ??= []).push(cb);
    },
    emit(e: string, ...args: unknown[]) {
      emitted.push({ event: e, args });
    },
    connect() {},
    disconnect() {
      socket.connected = false;
    },
    trigger(e: string, ...args: unknown[]) {
      (handlers[e] ?? []).forEach((f) => f(...args));
    },
    hasHandler: (e: string) => (handlers[e]?.length ?? 0) > 0,
  };
  const io = () => socket;
  return { io, socket, emitted };
}

const jsonRes = (data: unknown) => ({
  ok: true,
  json: async () => ({ success: true, data }),
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const samplePush: Notification = {
  deliveryId: "d1",
  campaignRunId: "c1",
  walletAddress: "0xWALLET",
  title: "Hello",
  body: "You have a new reward",
  cta: { label: "Claim", url: "https://x.io" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe("OnchainSuite SDK", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("requires a publishable key", () => {
    expect(() => new OnchainSuite("")).toThrow();
    expect(() => new OnchainSuite("nope")).toThrow();
    expect(() => new OnchainSuite("pk_test_ok")).not.toThrow();
  });

  it("runs challenge → sign → verify → connect and reports delivered", async () => {
    const fake = makeFakeIo();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ message: "sign me" }))
      .mockResolvedValueOnce(
        jsonRes({ token: "tok", wsUrl: "https://api.x/api/v1/inapp/register" })
      );
    vi.stubGlobal("fetch", fetchMock);

    const onNotification = vi.fn();
    const signMessage = vi.fn(async () => "0xsig");
    const os = new OnchainSuite("pk_test_abc", {
      apiBaseUrl: "https://api.x",
      display: false,
      ioClient: fake.io,
      signMessage,
      onNotification,
    });

    const started = os.start("0xWALLET");
    await tick(); // let challenge/sign/verify/openSocket run
    fake.socket.connected = true;
    fake.socket.trigger("connect");
    await started;

    // Auth used the publishable-key header + right endpoints.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0];
    expect(challengeUrl).toBe("https://api.x/api/v1/inapp/challenge");
    expect(
      (challengeInit as { headers: Record<string, string> }).headers[
        "x-publishable-key"
      ]
    ).toBe("pk_test_abc");
    expect(signMessage).toHaveBeenCalledWith("sign me", "0xWALLET");

    // REGISTER sent on connect.
    expect(fake.emitted.find((e) => e.event === "REGISTER")).toBeTruthy();

    // Incoming notification → auto "delivered" report + onNotification called.
    fake.socket.trigger("PUSH", samplePush);
    const delivered = fake.emitted.find(
      (e) =>
        e.event === "EVENT" &&
        (e.args[0] as { type: string }).type === "delivered"
    );
    expect(delivered).toBeTruthy();
    expect(onNotification).toHaveBeenCalledOnce();
  });

  it("renders a toast when display is enabled", async () => {
    const fake = makeFakeIo();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ message: "m" }))
        .mockResolvedValueOnce(jsonRes({ token: "t", wsUrl: "https://a/x" }))
    );
    const os = new OnchainSuite("pk_test_abc", {
      apiBaseUrl: "https://a",
      ioClient: fake.io,
      signMessage: async () => "0xsig",
      display: { position: "top-left", duration: 0 },
    });
    const started = os.start("0xWALLET");
    await tick();
    fake.socket.connected = true;
    fake.socket.trigger("connect");
    await started;

    fake.socket.trigger("PUSH", samplePush);
    // A fixed-position container with the card should be in the DOM.
    const fixed = Array.from(document.body.querySelectorAll("div")).find(
      (d) => (d as HTMLElement).style.position === "fixed"
    );
    expect(fixed).toBeTruthy();
    expect(document.body.textContent).toContain("Hello");
  });

  it("honors onNotification returning false (headless override) — no toast", async () => {
    const fake = makeFakeIo();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ message: "m" }))
        .mockResolvedValueOnce(jsonRes({ token: "t", wsUrl: "https://a/x" }))
    );
    const os = new OnchainSuite("pk_test_abc", {
      apiBaseUrl: "https://a",
      ioClient: fake.io,
      signMessage: async () => "0xsig",
      display: {}, // enabled…
      onNotification: () => false, // …but suppressed per-notification
    });
    const started = os.start("0xWALLET");
    await tick();
    fake.socket.connected = true;
    fake.socket.trigger("connect");
    await started;

    fake.socket.trigger("PUSH", samplePush);
    expect(document.body.textContent).not.toContain("Hello");
  });
});
