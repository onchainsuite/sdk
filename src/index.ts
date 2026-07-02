import { createToastRenderer, type ToastRenderer } from "./renderer";
import type {
  ClientEvent,
  Eip1193Provider,
  EventType,
  Notification,
  OnchainSuiteOptions,
} from "./types";

export type {
  Notification,
  EventType,
  DisplayOptions,
  OnchainSuiteOptions,
  NotificationActions,
  SignMessageFn,
} from "./types";

/** Minimal socket shape we rely on (a subset of socket.io-client's Socket). */
interface MinimalSocket {
  on(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  connect(): void;
  disconnect(): void;
  connected: boolean;
}
type IoFactory = (uri: string, opts?: Record<string, unknown>) => MinimalSocket;

const WS_PATH = "/api/v1/inapp/register";

/**
 * OnchainSuite in-app notifications — one class, key in the constructor.
 *
 * ```ts
 * const os = new OnchainSuite("pk_live_...");
 * await os.start();               // wallet signs in, notifications start showing
 * ```
 *
 * Handles the whole path: wallet auth (challenge → sign → verify), a self-
 * reconnecting socket, rendering (built-in toast or your own), and analytics
 * reporting. Zero framework; the only runtime dep is socket.io-client.
 */
export class OnchainSuite {
  private readonly publishableKey: string;
  private readonly opts: OnchainSuiteOptions;
  private readonly base: string;
  private readonly renderer: ToastRenderer | null;
  private readonly listeners = new Map<
    ClientEvent,
    Set<(payload: unknown) => void>
  >();

  private socket: MinimalSocket | null = null;
  private walletAddress: string | null = null;

  constructor(publishableKey: string, options: OnchainSuiteOptions = {}) {
    if (!publishableKey || !publishableKey.startsWith("pk_")) {
      throw new Error("A publishable key (pk_live_… / pk_test_…) is required");
    }
    this.publishableKey = publishableKey;
    this.opts = options;
    this.base = (options.apiBaseUrl ?? "").replace(/\/$/, "");
    this.renderer =
      options.display === false
        ? null
        : createToastRenderer(options.display ?? undefined);
  }

  /**
   * Authenticate a wallet and start receiving notifications. If `walletAddress`
   * is omitted, the injected wallet (window.ethereum) is prompted to connect and
   * sign. Resolves once connected.
   */
  async start(walletAddress?: string): Promise<void> {
    const wallet = (walletAddress ?? (await this.discoverWallet()))?.trim();
    if (!wallet) throw new Error("No wallet address available");
    this.walletAddress = wallet;
    const { token, wsUrl } = await this.authenticate(wallet);
    await this.openSocket(wsUrl, token, wallet);
  }

  /** Stop receiving notifications and clear any built-in toasts. */
  stop(): void {
    try {
      this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.renderer?.destroy();
  }

  /** Subscribe: "notification" | "connected" | "disconnected" | "error". Returns an unsubscribe fn. */
  on(event: ClientEvent, cb: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }

  /** Report an interaction (also called automatically by the built-in UI). */
  report(n: Notification, type: EventType): void {
    if (!this.socket) return;
    try {
      this.socket.emit("EVENT", {
        campaignRunId: n.campaignRunId,
        deliveryId: n.deliveryId,
        type,
        walletAddress: this.walletAddress ?? undefined,
      });
    } catch (err) {
      this.log("report failed", err);
    }
  }

  // --- internals -----------------------------------------------------------

  private async authenticate(
    wallet: string
  ): Promise<{ token: string; wsUrl: string }> {
    const challenge = await this.post<{ message: string }>(
      "/api/v1/inapp/challenge",
      { walletAddress: wallet }
    );
    const signature = await this.sign(challenge.message, wallet);
    return this.post<{ token: string; wsUrl: string }>("/api/v1/inapp/verify", {
      walletAddress: wallet,
      signature,
    });
  }

  private async openSocket(
    wsUrl: string,
    token: string,
    wallet: string
  ): Promise<void> {
    const io = await this.resolveIo();
    let origin =
      this.base || (typeof location !== "undefined" ? location.origin : "");
    let path = WS_PATH;
    try {
      const u = new URL(wsUrl, origin || undefined);
      origin = u.origin;
      path = u.pathname;
    } catch {
      /* fall back to base + WS_PATH */
    }

    const socket = io(origin, {
      path,
      auth: { token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      withCredentials: true,
    });
    this.socket = socket;

    socket.on("connect", () => {
      socket.emit("REGISTER", { walletAddress: wallet });
      this.emit("connected", { walletAddress: wallet });
      this.log("connected");
    });
    socket.on("disconnect", (reason: unknown) => {
      this.emit("disconnected", { reason });
      this.log("disconnected", reason);
    });
    socket.on("connect_error", (err: unknown) => {
      this.emit("error", err);
      this.log("connect_error", err);
    });
    socket.on("PUSH", (item: unknown) =>
      this.handleNotification(item as Notification)
    );

    if (!socket.connected) {
      await new Promise<void>((resolve) => {
        socket.on("connect", () => resolve());
        setTimeout(resolve, 8000);
      });
    }
  }

  private handleNotification(n: Notification): void {
    if (!n || !n.deliveryId) return;
    this.report(n, "delivered");
    this.emit("notification", n);

    const actions = {
      report: (type: EventType) => this.report(n, type),
      click: () => {
        this.report(n, "clicked");
        if (n.cta?.url && typeof window !== "undefined") {
          window.open(n.cta.url, "_blank", "noopener,noreferrer");
        }
      },
      dismiss: () => this.report(n, "dismissed"),
    };

    const suppress = this.opts.onNotification?.(n, actions) === false;
    if (suppress || !this.renderer) return;

    this.renderer.show(n, {
      onView: () => this.report(n, "viewed"),
      onClick: () => this.report(n, "clicked"),
      onDismiss: () => this.report(n, "dismissed"),
    });
  }

  private async sign(message: string, wallet: string): Promise<string> {
    if (this.opts.signMessage) return this.opts.signMessage(message, wallet);
    const provider = this.getProvider();
    if (!provider)
      throw new Error(
        "No signer available — pass `signMessage` or an EIP-1193 `provider`."
      );
    const sig = await provider.request({
      method: "personal_sign",
      params: [message, wallet],
    });
    return String(sig);
  }

  private async discoverWallet(): Promise<string | undefined> {
    const provider = this.getProvider();
    if (!provider) return undefined;
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[] | undefined;
    return Array.isArray(accounts) ? accounts[0] : undefined;
  }

  private getProvider(): Eip1193Provider | undefined {
    if (this.opts.provider) return this.opts.provider;
    const w = globalThis as unknown as { ethereum?: Eip1193Provider };
    return w.ethereum;
  }

  private async resolveIo(): Promise<IoFactory> {
    if (this.opts.ioClient) return this.opts.ioClient as IoFactory;
    const g = globalThis as unknown as { io?: IoFactory };
    if (typeof g.io === "function") return g.io;
    try {
      // Computed specifier so socket.io-client stays an optional peer dependency.
      const spec = "socket.io-client";
      const mod = (await import(/* @vite-ignore */ spec)) as {
        io?: IoFactory;
      };
      if (mod.io) return mod.io;
    } catch {
      /* not installed */
    }
    throw new Error(
      "socket.io-client not found. Install it, load it via <script>, or pass `ioClient`."
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-key": this.publishableKey,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: { message?: string };
      message?: string;
    };
    if (!res.ok) {
      throw new Error(
        data?.error?.message ?? data?.message ?? `Request failed (${res.status})`
      );
    }
    return data && typeof data === "object" && "data" in data
      ? (data.data as T)
      : (data as unknown as T);
  }

  private emit(event: ClientEvent, payload: unknown): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(payload);
      } catch {
        /* listener errors shouldn't break the client */
      }
    });
  }

  private log(...args: unknown[]): void {
    if (this.opts.debug) console.log("[onchainsuite]", ...args);
  }
}

/** Factory alias for `new OnchainSuite(key, options)`. */
export function createClient(
  publishableKey: string,
  options?: OnchainSuiteOptions
): OnchainSuite {
  return new OnchainSuite(publishableKey, options);
}
