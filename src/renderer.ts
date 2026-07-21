import type { DisplayOptions, Notification } from "./types.js";

/**
 * Zero-dependency toast renderer for notifications. Injects a fixed-position
 * stack of dismissible cards using vanilla DOM + inline styles (no framework, no
 * CSS file). XSS-safe — all content is set via textContent, never innerHTML.
 * No-ops in non-browser environments.
 */
export interface ToastRenderer {
  show(
    n: Notification,
    handlers: { onClick: () => void; onDismiss: () => void; onView: () => void }
  ): void;
  destroy(): void;
}

type ResolvedDisplay = {
  position: NonNullable<DisplayOptions["position"]>;
  accent: string;
  background: string;
  foreground: string;
  duration: number | ((n: Notification) => number);
  maxVisible: number;
  zIndex: number;
  cardStyle?: Partial<CSSStyleDeclaration>;
};

const DEFAULTS: ResolvedDisplay = {
  position: "bottom-right",
  accent: "#6d5efc",
  background: "#111318",
  foreground: "#f5f6f8",
  duration: 8000,
  maxVisible: 3,
  zIndex: 2147483000,
};

export function createToastRenderer(display?: DisplayOptions): ToastRenderer {
  const t: ResolvedDisplay = { ...DEFAULTS, ...(display ?? {}) };
  const hasDom =
    typeof document !== "undefined" && typeof window !== "undefined";
  let container: HTMLDivElement | null = null;

  const durationFor = (n: Notification): number =>
    typeof t.duration === "function" ? t.duration(n) : t.duration;

  const ensureContainer = (): HTMLDivElement | null => {
    if (!hasDom) return null;
    if (container && document.body.contains(container)) return container;
    container = document.createElement("div");
    const vertical = t.position.startsWith("top") ? "top" : "bottom";
    const horizontal = t.position.endsWith("right") ? "right" : "left";
    Object.assign(container.style, {
      position: "fixed",
      [vertical]: "16px",
      [horizontal]: "16px",
      display: "flex",
      flexDirection: vertical === "top" ? "column" : "column-reverse",
      gap: "10px",
      zIndex: String(t.zIndex),
      maxWidth: "360px",
      width: "calc(100vw - 32px)",
      pointerEvents: "none",
    } as unknown as CSSStyleDeclaration);
    document.body.appendChild(container);
    return container;
  };

  const show: ToastRenderer["show"] = (n, handlers) => {
    const root = ensureContainer();
    if (!root) return;

    while (root.children.length >= t.maxVisible && root.firstChild) {
      root.removeChild(root.firstChild);
    }

    const card = document.createElement("div");
    Object.assign(card.style, {
      pointerEvents: "auto",
      background: t.background,
      color: t.foreground,
      borderRadius: "12px",
      padding: "14px 16px",
      boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
      border: "1px solid rgba(255,255,255,0.08)",
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontSize: "14px",
      lineHeight: "1.4",
      opacity: "0",
      transform: "translateY(6px)",
      transition: "opacity .2s ease, transform .2s ease",
      ...(t.cardStyle ?? {}),
    } as CSSStyleDeclaration);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "8px",
    } as CSSStyleDeclaration);

    const title = document.createElement("div");
    title.textContent = n.title;
    Object.assign(title.style, {
      fontWeight: "600",
      fontSize: "14px",
    } as CSSStyleDeclaration);

    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    Object.assign(close.style, {
      background: "transparent",
      border: "none",
      color: t.foreground,
      opacity: "0.6",
      cursor: "pointer",
      fontSize: "18px",
      lineHeight: "1",
      padding: "0 2px",
    } as CSSStyleDeclaration);

    const body = document.createElement("div");
    body.textContent = n.body;
    Object.assign(body.style, {
      marginTop: "6px",
      opacity: "0.9",
    } as CSSStyleDeclaration);

    header.appendChild(title);
    header.appendChild(close);
    card.appendChild(header);
    card.appendChild(body);

    let dismissed = false;
    let autoTimer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      if (dismissed) return;
      dismissed = true;
      if (autoTimer) clearTimeout(autoTimer);
      card.style.opacity = "0";
      card.style.transform = "translateY(6px)";
      setTimeout(() => card.remove(), 200);
    };

    if (n.cta && n.cta.label) {
      const cta = document.createElement("a");
      cta.textContent = n.cta.label;
      cta.href = n.cta.url || "#";
      if (n.cta.url) {
        cta.target = "_blank";
        cta.rel = "noopener noreferrer";
      }
      Object.assign(cta.style, {
        display: "inline-block",
        marginTop: "10px",
        padding: "7px 12px",
        background: t.accent,
        color: "#fff",
        borderRadius: "8px",
        textDecoration: "none",
        fontWeight: "600",
        fontSize: "13px",
        cursor: "pointer",
      } as CSSStyleDeclaration);
      cta.addEventListener("click", () => {
        handlers.onClick();
        remove();
      });
      card.appendChild(cta);
    }

    close.addEventListener("click", () => {
      handlers.onDismiss();
      remove();
    });

    root.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
      handlers.onView();
    });

    const ms = durationFor(n);
    if (ms > 0) {
      autoTimer = setTimeout(() => {
        handlers.onDismiss();
        remove();
      }, ms);
    }
  };

  const destroy = () => {
    if (container && container.parentNode)
      container.parentNode.removeChild(container);
    container = null;
  };

  return { show, destroy };
}
