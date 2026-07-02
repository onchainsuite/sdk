# @onchainsuite/sdk

Dead-simple in-app push notifications for any dApp. Wallet-authenticated,
real-time, and tiny. Built-in toast UI you can fully restyle — or render your own.

```ts
import { OnchainSuite } from "@onchainsuite/sdk";

const os = new OnchainSuite("pk_live_yourorg_xxx");
await os.start(); // wallet signs in → notifications start showing
```

That's the whole integration. No framework required; the only runtime dependency
is `socket.io-client`.

## Install

```bash
npm i @onchainsuite/sdk socket.io-client
```

No build step? Load it from a CDN (load `socket.io-client` first so the SDK finds
`window.io`):

```html
<script src="https://cdn.socket.io/4.8.3/socket.io.min.js"></script>
<script type="module">
  import { OnchainSuite } from "https://esm.sh/@onchainsuite/sdk";
  const os = new OnchainSuite("pk_live_yourorg_xxx", {
    apiBaseUrl: "https://api.onchainsuite.com",
  });
  await os.start();
</script>
```

## Usage

### 1. Simplest (uses the connected wallet)

```ts
const os = new OnchainSuite("pk_live_...", {
  apiBaseUrl: "https://api.onchainsuite.com",
});
await os.start(); // prompts window.ethereum to connect + sign
```

### 2. Bring your own signer (wagmi / viem / ethers)

```ts
const os = new OnchainSuite("pk_live_...", {
  apiBaseUrl: "https://api.onchainsuite.com",
  signMessage: async (message) => signMessageAsync({ message }), // your wallet lib
});
await os.start(walletAddress);
```

### 3. React

```tsx
useEffect(() => {
  const os = new OnchainSuite("pk_live_...", {
    apiBaseUrl: "https://api.onchainsuite.com",
  });
  os.start();
  return () => os.stop();
}, []);
```

## Send a notification (from your backend)

Sending is a server-to-server call authenticated with your **secret** key
(`sk_*`) — never expose it in the browser. One `POST`:

```ts
// Node / any backend
await fetch("https://api.onchainsuite.com/api/v1/inapp/push", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_live_xxx",
  },
  body: JSON.stringify({
    walletAddress: "0xabc...",
    title: "GM 👋",
    body: "Your rewards are ready to claim.",
    ctaLabel: "Claim",
    ctaUrl: "https://app.myprotocol.xyz/rewards",
  }),
});
```

The recipient's dApp (running the SDK from **Usage** above) receives it in real
time — or on next connect if they're offline.

## Make it yours — display is fully flexible

Everything about the built-in UI is overridable. Change timing, position, colors,
or opt out entirely.

```ts
new OnchainSuite("pk_live_...", {
  display: {
    position: "top-right",      // bottom-right | bottom-left | top-right | top-left
    accent: "#00e0b8",          // CTA / accent color
    background: "#0b0d12",
    foreground: "#ffffff",
    duration: 12000,            // ms on screen; 0 = sticky until dismissed
    maxVisible: 4,
    cardStyle: { borderRadius: "20px" }, // any CSS on the card
  },
});
```

Per-notification display time — pass a function:

```ts
new OnchainSuite("pk_live_...", {
  display: {
    duration: (n) => (n.cta ? 0 : 6000), // CTAs stay sticky, others auto-hide
  },
});
```

Render it 100% yourself (your own toast/modal/banner) — return `false` to skip the
built-in UI. Analytics still work via the provided actions:

```ts
new OnchainSuite("pk_live_...", {
  display: false, // turn the built-in UI off
  onNotification: (n, actions) => {
    myUI.toast({
      title: n.title,
      body: n.body,
      cta: n.cta,
      onShow: () => actions.report("viewed"),
      onClick: () => actions.click(), // reports "clicked" + opens the CTA url
      onClose: () => actions.dismiss(),
    });
  },
});
```

## API

### `new OnchainSuite(publishableKey, options?)`

`publishableKey` — `pk_live_*` / `pk_test_*` from **Dashboard → Integrations →
In-App**.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiBaseUrl` | `string` | same-origin | API host, no `/api/v1`. |
| `signMessage` | `(msg, wallet) => Promise<string>` | `window.ethereum` | Custom signer. |
| `provider` | EIP-1193 | `window.ethereum` | Wallet provider for the default signer. |
| `display` | `DisplayOptions \| false` | enabled | `false` = headless. See table below. |
| `onNotification` | `(n, actions) => boolean \| void` | — | Custom handler; return `false` to skip built-in UI. |
| `ioClient` | `io` factory | auto | Provide socket.io-client's `io` explicitly. |
| `debug` | `boolean` | `false` | Verbose logging. |

`DisplayOptions`: `position`, `accent`, `background`, `foreground`,
`duration` (`number | (n) => number`, `0` = sticky), `maxVisible`, `zIndex`,
`cardStyle`.

### Methods

- `start(walletAddress?) → Promise<void>` — auth + start receiving.
- `stop()` — disconnect + clear toasts.
- `on(event, cb) → unsubscribe` — `"notification" | "connected" | "disconnected" | "error"`.
- `report(notification, type)` — `"delivered" | "viewed" | "dismissed" | "clicked"`.

### Notification shape

```ts
interface Notification {
  deliveryId: string;
  campaignRunId: string;
  walletAddress: string;
  title: string;
  body: string;
  cta?: { label: string; url: string };
  createdAt: string;
  expiresAt: string;
}
```

## How it works & security

1. `POST /api/v1/inapp/challenge` (publishable-key auth) → a message to sign.
2. Wallet signs (EIP-191); `POST /api/v1/inapp/verify` → short-lived session JWT +
   WebSocket URL.
3. Socket.IO connects to `/api/v1/inapp/register` with the token, auto-reconnects,
   and replays notifications missed while offline.
4. Each notification is reported `delivered`, then rendered (or handed to
   `onNotification`), then `viewed/clicked/dismissed` from the UI.

Security notes:

- **No secrets in the browser.** Only the *publishable* key ships to the client;
  it's scoped by **allow-listed origins** (Dashboard → Integrations → In-App →
  Origins). Wrong origin → `401`.
- **Wallet ownership is proven** by an EIP-191 signature over a single-use,
  5-minute nonce; the challenge/verify endpoints are rate-limited server-side.
- **XSS-safe rendering** — content is set via `textContent`, never `innerHTML`.

## Docs

s- Runnable demo: [`example/index.html`](./example/index.html).
