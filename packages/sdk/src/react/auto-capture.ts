import type { BaseEvent } from "@yavio/shared/events";
import type { WidgetConfig } from "./types.js";

type Enqueue = (events: BaseEvent[]) => void;

function eventId(): string {
  return crypto.randomUUID();
}

function baseFields(
  config: WidgetConfig,
  eventType: string,
  extra?: Record<string, unknown>,
): BaseEvent {
  return {
    event_id: eventId(),
    event_type: eventType as BaseEvent["event_type"],
    trace_id: config.traceId,
    session_id: config.sessionId,
    timestamp: new Date().toISOString(),
    source: "widget",
    ...extra,
  };
}

/**
 * Initialize all auto-capture listeners. Returns a cleanup function.
 */
export function initAutoCapture(config: WidgetConfig, enqueue: Enqueue): () => void {
  const cleanups: Array<() => void> = [];

  // ── widget_render ──────────────────────────────────────────────────
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const conn =
    nav && "connection" in nav
      ? (nav as unknown as { connection?: { effectiveType?: string } }).connection
      : undefined;

  enqueue([
    baseFields(config, "widget_render", {
      metadata: {
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        device_pixel_ratio: window.devicePixelRatio ?? 1,
        touch_support: "ontouchstart" in window ? 1 : 0,
        connection_type: conn?.effectiveType ?? "unknown",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }),
  ]);

  // ── widget_error ───────────────────────────────────────────────────
  const onError = (ev: ErrorEvent) => {
    enqueue([
      baseFields(config, "widget_error", {
        metadata: {
          error_message: ev.message,
          error_stack: (ev.error?.stack ?? "").slice(0, 1024),
          error_source: ev.filename ?? "unknown",
        },
      }),
    ]);
  };
  window.addEventListener("error", onError);
  cleanups.push(() => window.removeEventListener("error", onError));

  const onUnhandled = (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? "").slice(0, 1024) : "";
    enqueue([
      baseFields(config, "widget_error", {
        metadata: {
          error_message: message,
          error_stack: stack,
          error_source: "unhandledrejection",
        },
      }),
    ]);
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  cleanups.push(() => window.removeEventListener("unhandledrejection", onUnhandled));

  // ── widget_click ───────────────────────────────────────────────────
  const onClick = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    enqueue([
      baseFields(config, "widget_click", {
        metadata: {
          target_tag: target?.tagName?.toLowerCase() ?? "unknown",
          target_id: target?.id || undefined,
          target_class: target?.className || undefined,
          click_x: ev.clientX,
          click_y: ev.clientY,
          click_count: ev.detail,
        },
      }),
    ]);
  };
  document.addEventListener("click", onClick, { capture: true });
  cleanups.push(() => document.removeEventListener("click", onClick, { capture: true }));

  // ── widget_rage_click ──────────────────────────────────────────────
  const rageState = {
    target: null as EventTarget | null,
    count: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
  };

  const onRageClick = (ev: MouseEvent) => {
    if (ev.target === rageState.target) {
      rageState.count++;
    } else {
      rageState.target = ev.target;
      rageState.count = 1;
      if (rageState.timer) clearTimeout(rageState.timer);
    }

    if (rageState.timer) clearTimeout(rageState.timer);
    rageState.timer = setTimeout(() => {
      rageState.count = 0;
      rageState.target = null;
    }, 500);

    if (rageState.count >= 3) {
      const target = ev.target as HTMLElement | null;
      enqueue([
        baseFields(config, "widget_rage_click", {
          metadata: {
            target_tag: target?.tagName?.toLowerCase() ?? "unknown",
            target_id: target?.id || undefined,
            click_count: rageState.count,
          },
        }),
      ]);
      rageState.count = 0;
    }
  };
  document.addEventListener("click", onRageClick, { capture: true });
  cleanups.push(() => document.removeEventListener("click", onRageClick, { capture: true }));

  // ── widget_scroll ──────────────────────────────────────────────────
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastScrollY = window.scrollY || 0;
  const onScroll = () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const docHeight =
        document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const depthPct = docHeight > 0 ? Math.round((scrollTop / docHeight) * 100) : 0;
      const direction = scrollTop >= lastScrollY ? "down" : "up";
      lastScrollY = scrollTop;
      enqueue([
        baseFields(config, "widget_scroll", {
          metadata: {
            scroll_depth_pct: depthPct,
            scroll_direction: direction,
            viewport_height: window.innerHeight,
          },
        }),
      ]);
    }, 250);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  cleanups.push(() => {
    window.removeEventListener("scroll", onScroll);
    if (scrollTimer) clearTimeout(scrollTimer);
  });

  // ── widget_form_field ──────────────────────────────────────────────
  const fieldTimers = new WeakMap<EventTarget, number>();

  const onFocusIn = (ev: FocusEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target || !isFormField(target)) return;
    fieldTimers.set(target, Date.now());
  };
  const onFocusOut = (ev: FocusEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target || !isFormField(target)) return;
    const start = fieldTimers.get(target);
    const timeInField = start ? Date.now() - start : 0;
    const input = target as HTMLInputElement;
    enqueue([
      baseFields(config, "widget_form_field", {
        metadata: {
          field_name: input.name || input.id || undefined,
          field_type: input.type || target.tagName.toLowerCase(),
          time_in_field_ms: timeInField,
          filled: !!input.value,
        },
      }),
    ]);
  };
  document.addEventListener("focusin", onFocusIn, { capture: true });
  document.addEventListener("focusout", onFocusOut, { capture: true });
  cleanups.push(() => {
    document.removeEventListener("focusin", onFocusIn, { capture: true });
    document.removeEventListener("focusout", onFocusOut, { capture: true });
  });

  // ── widget_form_submit ─────────────────────────────────────────────
  const formStartTimes = new WeakMap<HTMLFormElement, number>();
  const trackFormStart = (ev: FocusEvent) => {
    const target = ev.target as HTMLElement | null;
    const form = target?.closest?.("form");
    if (form && !formStartTimes.has(form)) {
      formStartTimes.set(form, Date.now());
    }
  };
  document.addEventListener("focusin", trackFormStart, { capture: true });
  cleanups.push(() => document.removeEventListener("focusin", trackFormStart, { capture: true }));

  const onSubmit = (ev: SubmitEvent) => {
    const form = ev.target as HTMLFormElement | null;
    const startTime = form ? formStartTimes.get(form) : undefined;

    // Count invalid fields via constraint validation API + aria-invalid
    let validationErrors = 0;
    if (form) {
      const fields = form.querySelectorAll("input, textarea, select");
      for (const field of fields) {
        const el = field as HTMLInputElement;
        if (el.validity && !el.validity.valid) {
          validationErrors++;
        } else if (el.getAttribute("aria-invalid") === "true") {
          validationErrors++;
        }
      }
    }

    enqueue([
      baseFields(config, "widget_form_submit", {
        metadata: {
          form_id: form?.id || undefined,
          time_to_submit_ms: startTime ? Date.now() - startTime : undefined,
          validation_errors: validationErrors,
        },
      }),
    ]);
  };
  document.addEventListener("submit", onSubmit, { capture: true });
  cleanups.push(() => document.removeEventListener("submit", onSubmit, { capture: true }));

  // ── widget_link_click ──────────────────────────────────────────────
  const onLinkClick = (ev: MouseEvent) => {
    const anchor = (ev.target as HTMLElement)?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    const isExternal = href.startsWith("http") && !href.startsWith(window.location.origin);
    enqueue([
      baseFields(config, "widget_link_click", {
        metadata: {
          href,
          link_text: (anchor.textContent ?? "").slice(0, 200),
          is_external: isExternal,
        },
      }),
    ]);
  };
  document.addEventListener("click", onLinkClick, { capture: true });
  cleanups.push(() => document.removeEventListener("click", onLinkClick, { capture: true }));

  // ── widget_navigation ─────────────────────────────────────────────
  let currentView = window.location.pathname + window.location.hash;
  let viewStartTime = Date.now();

  const emitNavigation = () => {
    const newView = window.location.pathname + window.location.hash;
    if (newView === currentView) return;
    const timeOnPrev = Date.now() - viewStartTime;
    enqueue([
      baseFields(config, "widget_navigation", {
        metadata: {
          from_view: currentView,
          to_view: newView,
          time_on_prev_ms: timeOnPrev,
        },
      }),
    ]);
    currentView = newView;
    viewStartTime = Date.now();
  };

  window.addEventListener("popstate", emitNavigation);
  cleanups.push(() => window.removeEventListener("popstate", emitNavigation));

  // Intercept pushState / replaceState
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  const pushWrapper = (...args: Parameters<typeof history.pushState>) => {
    origPush(...args);
    emitNavigation();
  };
  const replaceWrapper = (...args: Parameters<typeof history.replaceState>) => {
    origReplace(...args);
    emitNavigation();
  };

  history.pushState = pushWrapper;
  history.replaceState = replaceWrapper;
  cleanups.push(() => {
    // Only restore originals if our wrappers are still current — avoids
    // overwriting patches applied by other libraries after us.
    if (history.pushState === pushWrapper) {
      history.pushState = origPush;
    }
    if (history.replaceState === replaceWrapper) {
      history.replaceState = origReplace;
    }
  });

  // ── widget_focus ───────────────────────────────────────────────────
  let focusStart: number | null = null;
  let focusCount = 0;

  const onFocus = () => {
    focusStart = Date.now();
    focusCount++;
  };
  const onBlur = () => {
    const duration = focusStart ? Date.now() - focusStart : 0;
    enqueue([
      baseFields(config, "widget_focus", {
        metadata: {
          focus_duration_ms: duration,
          focus_count: focusCount,
        },
      }),
    ]);
    focusStart = null;
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  cleanups.push(() => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  });

  // ── widget_visibility (IntersectionObserver) ───────────────────────
  if (typeof IntersectionObserver !== "undefined") {
    let visibleStart: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleStart = Date.now();
          } else if (visibleStart) {
            enqueue([
              baseFields(config, "widget_visibility", {
                metadata: {
                  visible_duration_ms: Date.now() - visibleStart,
                  percent_visible: Math.round(entry.intersectionRatio * 100),
                },
              }),
            ]);
            visibleStart = null;
          }
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1.0] },
    );

    observer.observe(document.documentElement);
    cleanups.push(() => observer.disconnect());
  }

  // ── widget_performance (PerformanceObserver) ───────────────────────
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "navigation") {
            const nav = entry as PerformanceNavigationTiming;
            enqueue([
              baseFields(config, "widget_performance", {
                metadata: {
                  load_time_ms: Math.round(nav.loadEventEnd - nav.startTime),
                  ttfp_ms: Math.round(nav.responseStart - nav.startTime),
                  dcl_ms: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
                  resource_transfer_bytes: nav.transferSize,
                },
              }),
            ]);
          }
        }
      });
      perfObserver.observe({ type: "navigation", buffered: true });
      cleanups.push(() => perfObserver.disconnect());
    } catch {
      // PerformanceObserver not supported for navigation type
    }
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

function isFormField(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}
