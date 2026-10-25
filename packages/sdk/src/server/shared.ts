import fs from "node:fs";
import os from "node:os";
import { ErrorCode } from "@yavio/shared/error-codes";
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  shutdownTimeoutFromEnv,
} from "../core/config.js";
import { LruMap } from "../core/lru.js";
import { raceDeadline, unref } from "../core/timers.js";
import type { SessionState, YavioConfig } from "../core/types.js";
import { type FlushOutcome, HttpTransport } from "../transport/http.js";
import type { Transport } from "../transport/types.js";

/**
 * Process-level state behind every wrapped server (#133).
 *
 * A stateless host builds a new McpServer — and so wraps a new one — for
 * every request. Everything that must survive across those wraps lives here,
 * keyed by the resolved `(endpoint, apiKey)`, so a conversation spread over
 * many per-request server instances looks like one long-lived server to
 * ingest:
 *
 * - one `HttpTransport` (one flush timer, one batch stream) per key;
 * - one `sessions` map per key: `yavio.identify()`, the traits and the step
 *   sequence of a conversation, found again by the next instance that serves
 *   the same `Mcp-Session-Id` or `openai/session`;
 * - exactly one SIGTERM/SIGINT handler pair for the whole process, which
 *   drains every transport in the registry and then hands the signal back:
 *   the listeners are removed and, if nothing else listens, the signal is
 *   re-raised so Node's default exit runs (#138).
 *
 * Not shared, on purpose: the widget token. Ingest binds a widget JWT to the
 * trace id of the call that minted it (`WIDGET_TRACE_ID_MISMATCH` for any
 * other), and every tool call has its own trace id, so a token is minted per
 * call and never cached.
 *
 * Still per wrapped instance (in createProxy): the connection's own session,
 * the current MCP transport, the set of tools the instance wrapped. Module
 * level elsewhere, keyed by API key: the connection-event dedup
 * (`emittedConnections`) and the discovery dedup (`emittedToolDiscoveries`)
 * in proxy.ts.
 *
 * Lifetime. The transport of a key is held by every `createYavio()` client
 * bound to it (a counter) and pinned by the first `withYavio()` call for it
 * (which has no shutdown of its own). `client.shutdown()` drains and
 * releases that client's hold; the last hold's release stops the transport
 * — another client's events for the same key keep flowing until then. On
 * a pinned key a fresh transport takes over at once, so a pinned key
 * always has a live transport and its `withYavio()` servers keep sending
 * (#179; before, that release only drained, and its deadline neither
 * aborted the fetch nor counted the loss). The signal handlers drain
 * everything regardless, and so does a natural exit with events queued
 * (#167, below). The key's state object outlives its transports: proxies
 * keep it, and a re-acquire after a stop puts a fresh transport behind the
 * same facade.
 *
 * Shutdown from a signal handler (#142). The SDK's listener is prepended,
 * so it runs first and drains the registry; the app's handler then calls
 * `client.shutdown()`, whose hold the signal already cleared. Every release
 * therefore awaits the process-level `signalDrain` first, and a stale hold
 * then drains the key's current transport — the immediate one a request
 * finishing after the signal sent through — instead of returning. So
 * `shutdown()` resolves only once everything queued before it reached
 * ingest, and `process.exit()` after the await exits with nothing in
 * flight. The one order this does not cover is the documented #140
 * exception: an app listener added with `prependOnceListener` after the
 * SDK installed its own runs before ours and is gone when we count, so the
 * SDK takes itself for the only listener and re-raises after the drain.
 *
 * Deadlines (#148). Outside a signal every `client.shutdown()` is bounded
 * by its own client's `shutdownTimeoutMs`, from its call. A signal fixes
 * ONE process deadline at signal + D, where D is the smallest
 * `shutdownTimeoutMs` set explicitly (option, env or rc file) by any live
 * `createYavio()` hold, `withYavio()` pin or `shutdown()` call still in
 * progress at the signal, across every key — the grace period is per
 * process, so the strictest explicit bound wins, and a participant on the
 * default adds no bound (review round 3 of #142: registering the default
 * capped a raised value). `YAVIO_SHUTDOWN_TIMEOUT_MS` counts even when no
 * participant is live; with nothing set, D is the 4 s default. The signal
 * drain, every drain or stop a release causes, and every `shutdown()`
 * running at or after the signal — one that started before it included —
 * resolve by that deadline; a `shutdown()` called with no time left
 * resolves at once. Values registered after the signal do not move it; a
 * `SIGTERM` after the cycle's `SIGINT` — Claude Code's stop sequence —
 * moves it in to SIGINT + 400 ms, never out (#175); a new cycle after a
 * hand-back gets a new deadline. After the hand-back a
 * `shutdown()` waits at most D from its own call, so a process that
 * survives a signal still delivers what requests finishing later send,
 * without blocking the exit. Before #148 there were three clocks (the
 * signal, each `shutdown()` call, the post-signal transport's own drain),
 * which added up to 15–18 s with a 10 s default.
 *
 * Natural exit (#167). A process that ends on its own gets neither a
 * signal nor a `shutdown()`: the loop empties and Node exits — a stdio
 * server whose client closed its stdin (the MCP stdio binding's graceful
 * shutdown), a script or CLI that never calls `shutdown()`, a host that
 * closes its server without a signal. Node emits `beforeExit` first, and
 * the SDK's listener — one per process, installed with the first transport
 * — stops every live transport in the registry under min(1.5 s, D), as the
 * last holder's release stops it: the stops hold the loop until the queue
 * is delivered, given up or the deadline comes, and the exit hook prints
 * what that deadline gave up in one `Exit deadline …` line. A higher
 * explicit `shutdownTimeoutMs` does not raise the 1.5 s — the MCP
 * TypeScript clients send `SIGTERM` 2 s after they close stdin — and a
 * signal during the drain takes its stops over without extending them.
 * With nothing queued the listener returns at once, as fast and quiet as
 * before. A process that goes on after it and sends again re-enters the
 * registry, and the next `beforeExit` drains that too (review round 1).
 * `process.exit()`, a signal's default exit and an uncaught
 * exception emit no `beforeExit`: those paths are unchanged. Before #167
 * the queue went with the process, without a line.
 *
 * Freeze after the response (#171). AWS Lambda, Vercel Functions, Cloud
 * Run with request-based billing, Netlify Functions and Cloudflare Workers
 * suspend the instance once the response is out: no timer runs, and the
 * instance may be recycled without a signal the app can act on, so the
 * 10 s interval held the last invocations' events until they were lost.
 * `client.flush()` (`flushShared`) sends the key's queue now and waits for
 * ingest, bounded by `flushTimeoutMs` — or by what a signal cycle leaves —
 * and touches no hold, stops nothing and arms no exit report, so the next
 * request finds the same transport. What it could not deliver stays
 * queued, with one `YAVIO-1208` line per stall.
 */

export interface SharedSessions {
  /**
   * Sessions by their derived id, for servers that serve many conversations
   * (stateless transports, OpenAI's per-call reconnects). Bounded; the least
   * recently used goes first, and its eviction hook drops the connection-event
   * mark so the conversation's next call, which starts a fresh state, emits
   * a fresh connection event.
   */
  sessions: LruMap<string, SessionState>;
}

export interface SharedState extends SharedSessions {
  /**
   * The transport to ingest, stable for the key's lifetime: a facade over
   * whichever `HttpTransport` is live for the key right now. A proxy keeps
   * the facade, so a wrap after the last holder's `shutdown()` — which
   * returns the existing proxy — sends through the fresh transport the
   * re-acquire started, not the stopped one.
   */
  transport: Transport;
}

export const MAX_SESSIONS = 1000;

/**
 * Fresh session state with no transport attached. The proxy's default when it
 * is built directly (tests); the registry builds the real one.
 */
export function createSharedSessions(onEvict?: (sessionId: string) => void): SharedSessions {
  return {
    sessions: new LruMap<string, SessionState>(MAX_SESSIONS, (sessionId) => onEvict?.(sessionId)),
  };
}

/**
 * The key's state, kept for the process lifetime (one per distinct config,
 * never deleted): the sessions and the transport facade every proxy of the
 * key holds. `live` is the HttpTransport behind the facade — replaced when
 * the key is re-acquired after its transport stopped.
 */
interface Slot extends SharedState {
  live: Transport | null;
  /** The version the key's transports report: the fresh transport a pinned key gets at its last client's release needs it (#179). */
  sdkVersion: string;
  /**
   * The transport a pinned key's last release is stopping, until that stop
   * settles (#179 review round 1). A send — a request finishing during the
   * client's `shutdown()` — joins it while it still takes sends (its drain
   * running, its deadline not come: `joinsShutdown`), as it would join any
   * drain in progress, and goes to the fresh transport in `live` after.
   */
  stopping: HttpTransport | null;
}

/** A live transport: holders, pin, and a generation that tells it from its successors. */
interface Entry {
  slot: Slot;
  /** Live `createYavio()` clients bound to this key. */
  holders: number;
  /**
   * Set by `withYavio()`, which never releases: the entry stays in the
   * registry until a signal, with a live transport — the last client's
   * release stops the current one and puts a fresh one behind the pin
   * (#179).
   */
  pinned: boolean;
  /** Distinct per transport: a hold on a cleared or stopped one must not release the next. */
  generation: number;
}

/** A hold on a key's live transport, released by `releaseShared(config, hold)`. */
export interface SharedHold {
  state: SharedState;
  generation: number;
  /** The holder's explicitly set `shutdownTimeoutMs` as registered (undefined on the default), removed from `holdDeadlines` on release. */
  deadlineMs: number | undefined;
}

const slots = new Map<string, Slot>();
const registry = new Map<string, Entry>();
let generations = 0;
/**
 * The `shutdownTimeoutMs` of every live `createYavio()` hold whose config
 * set it explicitly (option, env or rc file), one entry per such hold — a
 * client on the default adds nothing — and, per key, the smallest among
 * the explicitly set `withYavio()` pins: the inputs of the process
 * deadline a signal fixes (`processBudgetMs`), the smallest of them all
 * across every key. Kept here, not on the registry entry: a signal cycle
 * clears the registry, but the holds and pins live on — a hold is released
 * by its own `shutdown()`, a pin never — and a second cycle in a process
 * that survived the first (an app listener; a later wrap reinstalled the
 * handlers) must still see them. On the entry they went with the first
 * drain, and the second cycle fell back to the 4 s default over a client
 * that had set 25 s (#148 review round 6).
 */
const holdDeadlines: number[] = [];
const pinDeadlines = new Map<string, number>();
/**
 * Every transport this process created and not yet shut down, for the loss
 * accounting (#148). A transport leaves the set when its `shutdown()` has
 * settled, its deadline losses folded into `lostFromClosed`: a host that
 * creates and shuts down a client per request would otherwise keep one
 * transport per request for the process lifetime (#148 review round 1).
 */
const transports = new Set<HttpTransport>();
/** Events a deadline gave up on transports that have since left `transports`. */
let lostFromClosed = 0;

/**
 * What the registry needs of a config: the key, the drain deadline and
 * where the deadline came from. The first client or `withYavio()` call to
 * create a key's transport sets the transport's own deadline (what a
 * `drain()` or `shutdown()` without a value uses; the signal drain always
 * passes one); a `client.shutdown()` outside a signal passes its own config's
 * deadline into every release, drain and transport shutdown it causes; the
 * signal drain uses the smallest deadline registered for the key by its
 * holders and pins (#142 review), and only an explicitly set one is
 * registered (review round 3).
 */
type Key = Pick<
  YavioConfig,
  "endpoint" | "apiKey" | "shutdownTimeoutMs" | "shutdownTimeoutMsSource"
>;

const keyOf = (config: Key): string => `${config.endpoint}\n${config.apiKey}`;

/** The key each transport was created for: a `flush()` awaits only its own key's stops in progress (#171). */
const transportKeys = new WeakMap<Transport, string>();
/**
 * Keys whose current stall has had its `YAVIO-1208` line (#171): a later
 * flush that leaves events undelivered prints nothing while the key is
 * here, so an ingest outage on a host that flushes after every request is
 * one line, not one per request. A stall the once-a-minute limit silenced
 * is not added, so the first flush after the minute that still leaves
 * events undelivered reports it (review round 5). Cleared by the next flush
 * that delivers everything.
 */
const stalledFlushes = new Set<string>();
/** When each key's last `YAVIO-1208` line was printed: at most one per key per `STALL_LINE_INTERVAL_MS` (#171 review round 4). */
const stallLineAt = new Map<string, number>();
const STALL_LINE_INTERVAL_MS = 60_000;

/**
 * The deadline a config registers for the signal drain: its
 * `shutdownTimeoutMs` when the option, `YAVIO_SHUTDOWN_TIMEOUT_MS` or
 * `.yaviorc.json` set it, nothing when it is the default — so a participant
 * that set none does not lower the bound of one that did (review round 3).
 */
const explicitDeadline = (config: Key): number | undefined =>
  config.shutdownTimeoutMsSource === "default" ? undefined : config.shutdownTimeoutMs;

/**
 * Set by the signal handler, never cleared (outside tests): the process is
 * on its way out. A transport created from now on sends on every `send()`
 * — no timer will fire for it and no shutdown will drain it — so events
 * from requests still served during the graceful-shutdown window go out
 * best effort, bounded by the fetch timeout and the buffer cap.
 */
let draining = false;

/**
 * The signal handler's drain, running or done — accumulated when a signal is
 * handled again after a hand-back, and joined by a natural-exit drain
 * (#167). Awaited by every `releaseShared` and `settleShared`, so an app
 * handler's `client.shutdown()` waits for the drain the SDK's listener
 * started a tick earlier (#142) — and an app's own `beforeExit` listener
 * for the natural-exit drain. Cleared with the rest of the state only in
 * tests: a process that got a signal stays on its way out.
 */
let signalDrain: Promise<void> | null = null;

function noteDraining(): void {
  logOnce("draining", () =>
    console.error(
      "[yavio] Shutdown signal received — events from requests served from now on are sent at once, best effort.",
    ),
  );
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type HandledSignal = (typeof SIGNALS)[number];

/** The SDK's listener per signal, bound to its name — `process.emit("SIGINT")` without an argument is common in harnesses. */
let signalListeners: Map<HandledSignal, () => void> | null = null;

/**
 * One handled signal, from its arrival to the hand-back: the signal the
 * cycle hands back — the one that started it, or a later one that ended it
 * early — with whether the SDK was its only listener when it arrived, and
 * the process deadline the cycle fixed — `budgetMs` (D) from `startedAt`,
 * absolute in `deadlineAt`.
 */
interface SignalCycle {
  signal: HandledSignal;
  sole: boolean;
  startedAt: number;
  budgetMs: number;
  deadlineAt: number;
  /**
   * Per transport, the events the hand-back line counted while they were
   * still pending, and the counters it stood at: as the only listener
   * every transport's, which the re-raise is about to cut; next to an app
   * listener, at the drain's end, what the cycle's own stops still hold —
   * at the deadline that is what they give up (#148 review round 10). A
   * later count leaves out what of them a deadline then gave up
   * (`lostOfMarked`) or what is left of them (the exit hook,
   * `outstandingOfMarked`), so no event is in two lines — and nothing
   * else, so an event sent after the hand-back and lost at the deadline is
   * still printed (#148 review round 5).
   */
  marks: PendingMark[];
  /**
   * The transports the cycle's drain stops: the registry's, and the stops
   * already in progress at the signal, cut to its deadline
   * (`shutdownAllShared`).
   */
  stops: Set<Transport>;
  /**
   * Resolves once every one of `stops` has settled; `stopsRunning` until
   * then. The drain's wait for them ends at the deadline whether or not
   * they did, and their deadline timers run in the same tick as the
   * cycle's, often after it.
   */
  stopsSettled: Promise<void>;
  stopsRunning: boolean;
  /**
   * Set by the first line counted at the cycle's deadline — one of its
   * deadline timers fired (`onCycleDeadline`), or its drain ended with a
   * stop cut by its own — which also counted the post-signal fetches that
   * deadline cuts (`precountLate`, #154). Once per cycle.
   */
  deadlineCounted: boolean;
  /**
   * Set once the cycle printed its late line — at its deadline
   * (`late-deadline`) or once its stops settled (`drain-settled`): a cycle
   * prints one line when it ends and at most one more after that (#154 CI
   * fix: a line at the deadline and another when the stops settled were
   * two).
   */
  lateReported: boolean;
  /**
   * Set once the cycle printed a line: the exit hook's line after a
   * `shutdown()` this cycle's deadline cut says "more" only then (#154
   * review round 2).
   */
  printed: boolean;
  /** Set when one of the cycle's deadline timers ran (`onCycleDeadline`, the cycle's own timer). */
  deadlinePassed: boolean;
  /** `resets` when the cycle started: a cycle from before a test reset reports nothing after it. */
  epoch: number;
  /**
   * Set when a `SIGTERM` came after the `SIGINT` that started the cycle and
   * before `ESCALATION_MS` had passed (#175): a client's stop sequence, not
   * a request to give up at once. `afterMs`: when the `SIGTERM` came,
   * counted from `startedAt`; `cut`: it moved `deadlineAt` in to
   * `startedAt + ESCALATION_MS` — false when a lower D already ended the
   * cycle sooner.
   */
  escalation?: { afterMs: number; cut: boolean };
}

/**
 * A transport's counters when the hand-back line counted its pending
 * events. `lostOfMarked` reads them back when the cycle's stops settle,
 * `outstandingOfMarked` at exit: a transport settles its queue in order,
 * and a deadline ends delivery, so whatever was delivered or failed since
 * came from the pending events first, and what remains of them is what a
 * deadline gave up of them or what is still pending.
 */
interface PendingMark {
  transport: HttpTransport;
  pending: number;
  delivered: number;
  failed: number;
  deadlineLost: number;
}

/**
 * The signal being handled. A second signal while this is set means "stop
 * waiting" — unless it is the same signal within `SAME_DELIVERY_MS` of the
 * first, which is taken for one delivery arriving twice: `npm run` forwards
 * the terminal's Ctrl-C to a script that already received it, a few
 * milliseconds apart (#148, Decision E).
 *
 * A heuristic on the wall clock, not a fact about the delivery: Node gives
 * a listener no way to tell a forwarded signal from a new one. Its limits:
 * a deliberate second `SIGTERM` within 250 ms (a supervisor that escalates
 * at once) is swallowed and the drain goes on to the deadline; a forward
 * that arrives after 250 ms on a loaded host ends the drain early and some
 * events are given up, counted in the cycle's `YAVIO-1205` line. Neither
 * costs more than the deadline, and a DIFFERENT signal hands back at once
 * (#148 review round 3) — except a `SIGTERM` after the cycle's `SIGINT`,
 * which keeps the drain until `SIGINT + ESCALATION_MS` (#175). After that
 * `SIGTERM` the window counts from the `SIGTERM`'s arrival: a repeat of it
 * within 250 ms is the same delivery, and any other signal hands back at
 * once.
 */
let signalInFlight: SignalCycle | null = null;
const SAME_DELIVERY_MS = 250;
/**
 * How long after the `SIGINT` that started a cycle a `SIGTERM` lets the
 * drain run (#175): the cycle hands the `SIGTERM` back by min(SIGINT + D,
 * SIGINT + 400 ms), at once when that has passed. Measured in Claude Code
 * 2.1.310 on macOS and Linux: it stops a stdio server with `SIGINT`, a
 * `SIGTERM` 100 ms later if the process is still alive, and a `SIGKILL`
 * 400 ms after that — without closing stdin first. Before #175 that
 * `SIGTERM` handed back at once, about 100 ms in, and a batch on a fresh
 * connection to a remote ingest never left the machine; 400 ms leaves
 * about 100 ms before the `SIGKILL` for the hand-back, its line and the
 * re-raise. Counted from the `SIGINT`, never from the `SIGTERM`: the
 * `SIGINT`'s drain is often the process's first `fetch()`, whose lazy
 * setup blocks the loop for tens of milliseconds (more under load), so the
 * `SIGTERM` is handled late and "its arrival + 300 ms" came after the
 * `SIGKILL` in 5 of 12 measured runs. Only that order: `SIGTERM` then
 * `SIGINT` — Ctrl-C on a process a supervisor is already stopping — still
 * hands back at once.
 */
const ESCALATION_MS = 400;
/**
 * Transport stops started outside a signal and still running (the last
 * holder's release), with the transport each one stops: a signal arriving
 * meanwhile awaits them too, instead of finding an empty registry and
 * re-raising mid-send (#148), and cuts their deadline to the cycle's
 * (review round 6).
 */
const stopsInProgress = new Map<Promise<void>, Transport>();
/**
 * The latest cycle's deadline timer: cuts every `shutdown()` await still
 * pending at signal + D, even after an early hand-back. Unref'd, so it
 * never keeps the process alive; replaced by the next cycle's, cleared on
 * reset.
 */
let cycleTimer: ReturnType<typeof setTimeout> | undefined;
/** D of the last cycle that ended: after the hand-back a `shutdown()` waits at most this long from its call. */
let lastBudgetMs: number | undefined;
/**
 * The absolute deadline (signal + D) of the last cycle that ended: a
 * post-signal fetch started after an early hand-back still runs within it
 * (`lateFetchBudgetMs`), not for D from its own start (#148 review round 4).
 */
let lastDeadlineAt: number | undefined;
/**
 * The explicit `shutdownTimeoutMs` of every `shutdown()` call in progress
 * (a release or a settle), kept until the call resolves: a hold that is
 * releasing when the signal arrives still counts towards D.
 */
const inProgressDeadlines: number[] = [];
/** Resolvers of the `shutdown()` awaits to cut at the next cycle's deadline. */
const deadlineWaiters = new Set<() => void>();
/**
 * `shutdown()` waits in progress (`awaitBounded`). A cycle handed back
 * early reports at its deadline only when one of them is about to return
 * there — the app it releases may exit right away; with none, its late
 * report waits for its stops as before #154 and holds everything they and
 * the deadline cut (#154 CI fix).
 */
let appWaits = 0;
/** The latest signal cycle, running or ended; a new one replaces it. */
let lastCycle: SignalCycle | null = null;
/**
 * The latest time a fetch's budget aborted it, on any transport
 * (`onBudgetCut`): kept here, not read off the transports, so a transport
 * that closed and left `transports` still counts (#154 review round 3).
 */
let lastBudgetCut: number | undefined;
/**
 * The cycle in which the last `shutdown()` to return returned — null when
 * its own value cut it outside a cycle's bound. With no `shutdown()` in
 * progress at exit, the latest cycle's deadline come, and this the latest
 * cycle, the app did await `shutdown()`, and what the exit hook finds is
 * what that deadline left after the cycle's line: a request served after
 * the signal whose batch it cut in flight, or that sent more than that
 * batch, or a send in its last 100 ms. The exit line then says so in the
 * cycle's wording (#154 review rounds 1 and 2). Decided at exit, not when
 * the wait returns: a wait can end because its work settled at the
 * deadline's own cut, before the cycle's timer ran (round 2).
 */
let returnedIn: SignalCycle | null = null;

/**
 * The natural-exit drain that ran last (#167): its deadline, for the exit
 * line's wording; the latest signal cycle when it started, so a cycle
 * since — which took its stops over and printed the line — is told apart;
 * and whether its stops have settled: an exit before they did (an app's
 * `process.exit()` during the drain) was not its deadline's doing.
 */
interface ExitDrain {
  budgetMs: number;
  afterCycle: SignalCycle | null;
  settled: boolean;
  epoch: number;
}
let lastExitDrain: ExitDrain | null = null;
let beforeExitInstalled = false;
/** Transports a natural-exit drain stops: their loss is the exit line's, not a `shutdown()` line (#167). */
const exitStops = new WeakSet<Transport>();
/**
 * The entries a natural-exit drain took out of the registry, by key, until
 * one is put back — by a send, a re-acquire or a client's next `wrap()`
 * (`restoreDrained`) — or the last hold on it is released (#167 review
 * rounds 1–3). Nobody released them: the process
 * went on after `beforeExit` — an app's `beforeExit` listener that
 * schedules more work, an unref'd timer of the app's firing while the
 * drain holds the loop — and a proxy it already has still sends. Such a
 * send puts the entry back (`slotFor`'s facade) with a fresh transport and
 * the same generation, holders and pin, so the holds the drain took are
 * live again: a `createYavio()` client's `shutdown()` then releases and
 * stops it under its own deadline, as before the drain. The next
 * `beforeExit` drains it again. Round 1 re-entered with a new entry pinned
 * by the SDK, which left the client's hold stale: its `shutdown()` only
 * drained, never aborted a hanging fetch, and the process stayed up for
 * the 30 s fetch timeout.
 */
const exitDrained = new Map<string, Entry>();

/**
 * D for a signal arriving now: the smallest `shutdownTimeoutMs` set
 * explicitly by a live hold or pin (every key), by a `shutdown()` in
 * progress, or by `YAVIO_SHUTDOWN_TIMEOUT_MS`; the default when none is.
 */
export function processBudgetMs(): number {
  let budget = shutdownTimeoutFromEnv();
  for (const ms of holdDeadlines) budget = minDeadline(budget, ms);
  for (const ms of pinDeadlines.values()) budget = minDeadline(budget, ms);
  for (const ms of inProgressDeadlines) budget = minDeadline(budget, ms);
  return budget ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/** D of the cycle running or last run, or what a signal arriving now would fix. */
function currentBudgetMs(): number {
  return signalInFlight?.budgetMs ?? lastBudgetMs ?? processBudgetMs();
}

/** What is left of the running cycle's budget, undefined outside a cycle. */
function remainingMs(): number | undefined {
  return signalInFlight ? Math.max(0, signalInFlight.deadlineAt - Date.now()) : undefined;
}

/**
 * The least a post-signal transport's fetch may run: a send right at the
 * deadline is still attempted, not aborted before the request is out.
 */
const MIN_LATE_FETCH_MS = 100;

/**
 * How long a fetch of a post-signal transport started now may run: what is
 * left until signal + D — of the cycle running, or of the last one that
 * ended, while that is still ahead — and D from the call only once
 * signal + D has passed. Read per fetch, not fixed when the transport is
 * created: that transport starts on the first send after the signal and is
 * reused, and a timeout of min(30 s, D) from its creation let a request
 * finishing at signal + D − ε keep its socket — and a host without
 * `process.exit()` — alive until signal + 2D, past Fly.io's 5 s (#148
 * review round 3). The same held after an early, healthy hand-back: the
 * cycle was gone, so a request finishing at signal + 3 s sent with a 4 s
 * budget and held the socket until signal + 7 s (review round 4).
 */
function lateFetchBudgetMs(now = Date.now()): number {
  const deadlineAt = signalInFlight?.deadlineAt ?? lastDeadlineAt;
  if (deadlineAt !== undefined) {
    const left = deadlineAt - now;
    if (signalInFlight || left > 0) return Math.max(MIN_LATE_FETCH_MS, left);
  }
  return currentBudgetMs();
}

/**
 * The deadline a drain or stop started now runs under: the caller's own
 * value, cut to what the signal cycle leaves, or to D after a hand-back.
 */
export function boundedBy(ownMs: number): number {
  const remaining = remainingMs();
  if (remaining !== undefined) return Math.min(ownMs, remaining);
  if (lastBudgetMs !== undefined) return Math.min(ownMs, lastBudgetMs);
  return ownMs;
}

/**
 * Await `work` for at most `ownMs`, cut earlier by the deadline of a signal
 * cycle running now — or of one that starts meanwhile. With no time left
 * it returns at once; the work goes on in the background.
 */
export async function awaitBounded(work: Promise<void>, ownMs: number): Promise<void> {
  const cycle = signalInFlight;
  const remaining = remainingMs();
  const ms = boundedBy(ownMs);
  // Bounded by the running cycle's deadline rather than by the caller's own
  // value: when the wait ends there, the cycle's line comes before the
  // caller goes on — a timer made after the cycle's can run before it (#154).
  const byCycle = cycle && remaining !== undefined && remaining <= ownMs ? cycle : null;
  if (ms <= 0) {
    if (byCycle) onCycleDeadline(byCycle, true);
    returnedIn = lastCycle;
    return;
  }
  const epoch = resets;
  let ownTimer = false;
  appWaits++;
  try {
    await raceDeadline(work, ms, {
      waiters: deadlineWaiters,
      onTimeout: () => {
        ownTimer = true;
        if (byCycle) onCycleDeadline(byCycle, true);
      },
    });
  } finally {
    // A test reset zeroes the count and releases this wait: not again here
    // (#154 review round 1).
    if (epoch === resets) appWaits--;
  }
  if (epoch !== resets) return;
  // Its own value cut it, not a cycle's deadline (#154 review round 2).
  returnedIn = ownTimer && !byCycle ? null : lastCycle;
}

/**
 * Whether the cycle's deadline has come: one of its deadline timers ran
 * (`deadlinePassed`), one of its stops was cut by its own, or a fetch's
 * budget ended at or after it (`lastBudgetCut`) — a post-signal fetch cut
 * by its budget, the timer that may run first of all (#154 review rounds 2
 * and 3; round 2's "a deadline gave something up since the cycle began"
 * also fired on a retry wait refused before the deadline and on an earlier
 * cycle's stops settling late).
 */
const deadlineCame = (cycle: SignalCycle): boolean =>
  cycle.deadlinePassed ||
  stopsCut(cycle) ||
  (lastBudgetCut !== undefined && lastBudgetCut >= cycle.deadlineAt);

function releaseWaiters(): void {
  const waiters = [...deadlineWaiters];
  deadlineWaiters.clear();
  for (const resolve of waiters) resolve();
}

/**
 * Loss accounting (#148). Every transport counts the events a shutdown
 * deadline gave up (queued, in flight, refused after it, or a retry wait
 * cut by it) in `deadlineLostEvents()`; `reportedLost` is how many of them
 * a `YAVIO-1205` line already covered. A batch that failed for good on its
 * own (`YAVIO-1201`, an unexpected status) is not in it: that line is its
 * report, and a failure from hours earlier must not come back as a deadline
 * loss at the next signal or exit (#148 review round 2). One line per
 * signal cycle, printed when the cycle ends — before the POSIX re-raise,
 * which skips `exit` listeners — with the events still in flight when the
 * re-raise is about to end the process; one line per non-signal
 * `shutdown()` that timed out; and one at `exit` for what was counted after
 * that, which covers an app calling `process.exit()` before its
 * `shutdown()` resolved, and what a natural-exit drain gave up (#167). The
 * exit hook is armed only after a signal, a started `shutdown()` or a
 * natural-exit drain, which runs only with events queued: a plain exit
 * with nothing queued (tests, CLIs) stays quiet.
 *
 * A cycle handed back early (a second signal) ends before the stops it
 * started reach their deadline. What those stops give up afterwards is
 * still the cycle's: one more line with the cycle's wording and budget
 * when they have settled — not one `shutdown()` line per transport, which
 * is what a stop the registry started outside a signal gets (#148 review
 * round 1). `signalStops` marks the transports a cycle stopped. A cycle
 * handed back at its deadline with a stop already in progress at the
 * signal may end before its stops' deadline timers have run: the
 * hand-back line counts what they still hold (review round 10).
 */
let reportedLost = 0;
let exitHookArmed = false;
let exitReported = false;
/**
 * The marks of the last hand-back line that counted pending events, until
 * the cycle's stops have settled and the drain-settled report has taken
 * them in: the exit hook leaves out what is left of them. On win32, or
 * when `process.kill` throws, the re-raise ends the process through
 * `process.exit()`, whose `exit` listeners run inside it (#148 review
 * round 2); next to an app listener the app's `process.exit()` can follow
 * the line before the stops it pre-counted have settled (review round 10).
 * Either way the exit hook must not count those events a second time.
 */
let preCounted: PendingMark[] = [];
/** Bumped by the test reset, so a cycle from before it reports nothing after it. */
let resets = 0;
const signalStops = new WeakSet<Transport>();

const lostTotal = (): number =>
  [...transports].reduce((n, t) => n + t.deadlineLostEvents(), lostFromClosed);
const pendingTotal = (): number => [...transports].reduce((n, t) => n + t.pendingEvents(), 0);

/**
 * The pending events and the counters they stand at — of every transport,
 * or of those in `within` — for `lostOfMarked` and `outstandingOfMarked`.
 */
function markPending(within?: Set<Transport>): PendingMark[] {
  const marks: PendingMark[] = [];
  for (const transport of transports) {
    if (within && !within.has(transport)) continue;
    const pending = transport.pendingEvents();
    if (pending === 0) continue;
    marks.push({
      transport,
      pending,
      delivered: transport.deliveredEvents(),
      failed: transport.lostEvents() - transport.deadlineLostEvents(),
      deadlineLost: transport.deadlineLostEvents(),
    });
  }
  return marks;
}

/**
 * Of a mark's pending events, how many were neither delivered nor failed
 * since: the queue is settled in order and nothing is delivered after a
 * deadline, so the events delivered or failed since the mark are the
 * pending ones first.
 */
function leftOfMark(mark: PendingMark): number {
  const t = mark.transport;
  const settledOtherwise =
    t.deliveredEvents() - mark.delivered + (t.lostEvents() - t.deadlineLostEvents() - mark.failed);
  return Math.max(0, mark.pending - settledOtherwise);
}

/**
 * Of the events the hand-back line pre-counted, how many a deadline gave
 * up since: what is left of each mark, capped at the deadline losses since
 * (events sent after the mark and refused after the deadline are counted
 * there too, and are not the mark's).
 */
function lostOfMarked(marks: PendingMark[]): number {
  let n = 0;
  for (const mark of marks) n += lostOfMark(mark);
  return n;
}

function lostOfMark(mark: PendingMark): number {
  const lostSince = mark.transport.deadlineLostEvents() - mark.deadlineLost;
  return Math.min(lostSince, leftOfMark(mark));
}

/**
 * Of the events the hand-back line pre-counted, how many the exit hook
 * would count again: what is left of each mark, given up by a deadline
 * since or still pending.
 */
function outstandingOfMarked(marks: PendingMark[]): number {
  let n = 0;
  for (const mark of marks) {
    const t = mark.transport;
    const lostSince = t.deadlineLostEvents() - mark.deadlineLost;
    n += Math.min(lostSince + t.pendingEvents(), leftOfMark(mark));
  }
  return n;
}

const RAISE_HINT =
  "Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.";

/**
 * "Shutdown deadline of D ms" — or, for a cycle a `SIGTERM` after its
 * `SIGINT` cut (#175), the bound that ended it and when the `SIGTERM`
 * came: raising D does not move that bound.
 */
const deadlineWords = (cycle: SignalCycle): string =>
  cycle.escalation?.cut
    ? `Shutdown deadline of ${cycle.deadlineAt - cycle.startedAt} ms (SIGTERM ${cycle.escalation.afterMs} ms after SIGINT)`
    : `Shutdown deadline of ${cycle.budgetMs} ms`;

/** The cycle's hint: not to raise D when the client's stop sequence cut it (#175). */
const hintFor = (cycle: SignalCycle): string =>
  cycle.escalation?.cut
    ? "The client stops the server with SIGINT, SIGTERM and SIGKILL (Claude Code: 100 ms, then 400 ms); a higher shutdownTimeoutMs does not extend that."
    : RAISE_HINT;

function yavioReportAtExit(): void {
  if (exitReported) return;
  exitReported = true;
  const n = lostTotal() - reportedLost + pendingTotal() - outstandingOfMarked(preCounted);
  if (n <= 0) return;
  reportedLost = lostTotal();
  // Synchronous: `process.exit()` ends the process right after its `exit`
  // listeners, and an asynchronous stderr pipe would lose a console.warn
  // (#148 review round 3, as the hand-back line in round 2).
  const cycle = lastCycle;
  // After a natural-exit drain that settled, with no signal cycle since:
  // the rest is what its deadline gave up (#167). A cycle since took its
  // stops over, and its line counted them.
  const drain = lastExitDrain;
  const natural =
    drain && drain.epoch === resets && drain.settled && drain.afterCycle === cycle ? drain : null;
  // After a `shutdown()` that a cycle's deadline cut, the rest is that
  // deadline's, not an app's that forgot to await (#154 review round 1).
  const cut =
    !natural &&
    cycle &&
    cycle.epoch === resets &&
    appWaits === 0 &&
    returnedIn === cycle &&
    deadlineCame(cycle)
      ? cycle
      : null;
  writeStderrLine(
    natural
      ? `[YAVIO-1205] Exit deadline of ${natural.budgetMs} ms reached — ${n} events not delivered (the process ended on its own with events queued; queued, in flight or refused after the deadline). To wait longer, await analytics.shutdown() before the event loop empties (on stdin's end or at the end of the script; a beforeExit listener is too late).`
      : cut
        ? `[YAVIO-1205] ${deadlineWords(cut)} reached — ${n} ${cut.printed ? "more " : ""}events not delivered (in flight when the deadline cut it, sent in its last 100 ms or after it, or queued behind a request it cut). ${hintFor(cut)}`
        : `[YAVIO-1205] Process exit with ${n} events not delivered — await analytics.shutdown() before exiting, or raise shutdownTimeoutMs.`,
  );
}

/** Arm the exit-time report once: on the first signal, the first `shutdown()` call or a natural-exit drain. */
export function armExitHook(): void {
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.on("exit", yavioReportAtExit);
}

/**
 * The natural-exit deadline's cap (#167). The MCP TypeScript clients send
 * `SIGTERM` 2 s after they close a stdio server's stdin (v1 1.24–1.32,
 * v2 2.0–2.4); 1.5 s leaves 0.5 s for the 0–6 ms to `beforeExit`,
 * `ABORT_SETTLE_MS`, the teardown and a loaded host, and fits one retry
 * after a 1 s backoff when the first failure comes within 0.5 s.
 */
const NATURAL_EXIT_MS = 1_500;

/**
 * The natural-exit deadline: min(1.5 s, D), where D is what a signal
 * arriving now would fix. A lower explicit `shutdownTimeoutMs` (option,
 * env or rc file) lowers it; a higher one does not raise it — a
 * fleet-wide 25 s would push every stdio server past its client's
 * `SIGKILL`. An app that wants to wait longer awaits `shutdown()` itself,
 * before the loop empties: a `beforeExit` listener registered after the
 * SDK's runs after it, and its `shutdown()` only waits for this drain
 * (review round 1 — 0.5.4's workaround is capped at the bound on 0.5.5).
 */
function naturalExitBudgetMs(): number {
  return Math.min(NATURAL_EXIT_MS, processBudgetMs());
}

/** Events the registry's live transports hold: what a natural exit would lose. */
function registryPending(): number {
  let n = 0;
  for (const entry of registry.values()) {
    if (entry.slot.live instanceof HttpTransport) n += entry.slot.live.pendingEvents();
  }
  return n;
}

/**
 * The natural-exit drain (#167). Node emits `beforeExit` once the event
 * loop has emptied: nothing of the app's is left, no signal came, no
 * `shutdown()` is running. The process exits right after it, and before
 * #167 everything still queued — the flush interval is 10 s and unref'd,
 * a batch goes out early only at 100 events — went with it, without a
 * line. Now every live transport is taken out of the registry and stopped
 * under one deadline, as the last holder's release stops it (not
 * `drain()`, whose deadline only stops waiting: a hanging fetch would hold
 * its socket, and the process, for the 30 s fetch timeout): the stop's
 * deadline timer is ref'd while it runs (#164) and its fetch holds the
 * loop, so the process stays until the queue is delivered, given up, or
 * the deadline comes, and at the deadline the fetch is aborted (#148).
 * The stops are tracked like any stop in progress, so a signal arriving
 * meanwhile takes them over within its own deadline and never extends
 * theirs (`cutDeadline`); and an app's `shutdown()` called meanwhile — its
 * own `beforeExit` listener, 0.5.4's workaround — awaits them
 * (`signalDrain`). `draining` is not set: no signal came.
 *
 * The process may go on after it: an app's `beforeExit` listener that
 * schedules more work (AWS Lambda's Node 20/22 runtime client posts a
 * callback-style handler's result from its own `beforeExit` listener and
 * goes on to the next invocation, so this drain runs after every one of
 * them, #171), or an unref'd timer or socket of the app's that fires while
 * the drain holds the loop.
 * A send through a proxy it already has then puts the entry back into the
 * registry with a fresh transport and its holds and pin (`exitDrained`),
 * and the next `beforeExit`, which
 * Node emits once that work has settled, drains it under a deadline of
 * its own (review round 1: those events were dropped without a line).
 *
 * Returns at once while a signal cycle is in flight (its stops hold the
 * loop, so this is defensive) and when the registry holds nothing
 * pending: an idle exit stays as fast and quiet as before, and so do the
 * passes Node emits again once the drain's work settled or while a stop
 * waits on its unref'd `ABORT_SETTLE_MS` — the drain took every entry
 * out, so the registry is empty then. Not emitted on `process.exit()`, on
 * a signal's default exit or on an uncaught exception: those paths are
 * unchanged.
 */
function onBeforeExit(): void {
  if (signalInFlight || registryPending() === 0) return;
  const drain: ExitDrain = {
    budgetMs: naturalExitBudgetMs(),
    afterCycle: lastCycle,
    settled: false,
    epoch: resets,
  };
  lastExitDrain = drain;
  armExitHook(); // what the deadline gives up is reported at exit, in one line
  const stops: Promise<void>[] = [];
  for (const [key, entry] of registry) {
    registry.delete(key);
    exitDrained.set(key, entry); // a later send puts it back (review rounds 1 and 2)
    const live = entry.slot.live;
    entry.slot.live = null;
    if (!live) continue;
    exitStops.add(live);
    stops.push(trackStop(live, live.shutdown(drain.budgetMs)).catch(() => {}));
  }
  const drained = Promise.all(stops).then(() => {
    drain.settled = true;
  });
  signalDrain = signalDrain ? Promise.all([signalDrain, drained]).then(() => {}) : drained;
}

function installBeforeExit(): void {
  if (beforeExitInstalled) return;
  beforeExitInstalled = true;
  process.on("beforeExit", onBeforeExit);
}

/**
 * The cycle's one line: everything the deadline gave up, plus — at the
 * hand-back — what is still pending and will not be delivered: as the
 * only listener everything the re-raise is about to cut; next to an app
 * listener, when the drain ends (`drain-end`), what the cycle's own stops
 * still hold. Their deadline is the cycle's, and the cycle's timer, made
 * first in the same run for the same duration, usually ends the drain's
 * wait before theirs have counted what they give up: before #148 review
 * round 10 those events went to the exit hook's line, or to none if the
 * process was killed first. After a drain that settled they hold nothing.
 * Called again once the cycle's stops have settled after a hand-back that
 * came first (a second signal, or the deadline), for what was given up
 * since — less what the hand-back line pre-counted and a deadline then
 * gave up (`lostOfMarked`), not less the whole pre-count: with the batch
 * in flight at the hand-back delivered afterwards, subtracting all of it
 * swallowed the later losses of other sends for good, since `reportedLost`
 * moved past them and the exit hook never saw them (#148 review round 5).
 * A response that arrived at the deadline's instant and is read after it,
 * or one a fetch that ignores its abort delivers within `ABORT_SETTLE_MS`,
 * is a pre-counted event that was delivered: the line counted it, nothing
 * counts it twice. At the deadline itself (`deadline`: the cycle's timer,
 * or a wait it bounds, ran before the drain's end) the line counts what
 * it counts at the drain's end, plus the post-signal fetches that deadline
 * cuts (`precountLate`); a cycle handed back before its deadline with its
 * stops still running reports then (`late-deadline`) when a `shutdown()`
 * wait returns at that deadline — the app it released may exit right
 * after (#154) — and otherwise once they have settled. One late line per
 * cycle (`lateReported`).
 */
function reportCycleLoss(
  cycle: SignalCycle,
  at: "hand-back" | "drain-end" | "deadline" | "late-deadline" | "drain-settled",
): void {
  if (at === "drain-settled" && cycle.lateReported) {
    // The late line came at the deadline, and a cycle prints one (#154 CI
    // fix). What the stops gave up since was in it (`precountStops` marked
    // it); anything else lost since — a send in the deadline's last 100 ms,
    // whose floor outlives the deadline — stays unreported for the exit
    // hook, as on any cycle that ends at its deadline.
    reportedLost += lostOfMarked(cycle.marks);
    if (preCounted === cycle.marks) preCounted = [];
    return;
  }
  const total = lostTotal();
  let n = total - reportedLost;
  reportedLost = total;
  // At the cycle's deadline (#154) — its own timers, or a drain ended by a
  // stop its own deadline cut — the line also counts the post-signal
  // fetches that deadline cuts in the same tick: the README recipe's
  // request in flight, whose event the app's `process.exit(0)` right after
  // this line would otherwise leave to the exit hook. First, so a mark
  // made below no longer holds them.
  if (at === "deadline" || at === "late-deadline" || (at !== "hand-back" && stopsCut(cycle))) {
    if (!cycle.deadlineCounted) n += precountLate(cycle);
    cycle.deadlineCounted = true;
  }
  if (at === "drain-settled") {
    n -= lostOfMarked(cycle.marks);
    if (preCounted === cycle.marks) preCounted = [];
  } else if (at === "late-deadline") {
    n += precountStops(cycle);
  } else {
    if (cycle.sole) cycle.marks = markPending();
    // At "deadline", what the cycle's stops still hold. At "drain-end" they
    // have settled since #154 — every wait that ends at the deadline ends
    // the cycle first (`onCycleDeadline`), so a drain ending with stops
    // pending finds the cycle over — and this marks nothing there; it is
    // kept so that a drain whose wait anything else ends early (round 10's
    // case) still pre-counts them rather than leaving them to the exit hook
    // (#154 review round 1: a mutant dropping "drain-end" here survives).
    else if (at !== "hand-back") cycle.marks = markPending(cycle.stops);
    if (cycle.marks.length > 0) preCounted = cycle.marks;
    for (const mark of cycle.marks) n += mark.pending;
  }
  if (n <= 0) return;
  if (at === "late-deadline" || at === "drain-settled") cycle.lateReported = true;
  cycle.printed = true;
  const line = `[YAVIO-1205] ${deadlineWords(cycle)} reached — ${n} events not delivered (queued, in flight or refused after the deadline). ${hintFor(cycle)}`;
  if (at !== "drain-settled" && at !== "late-deadline" && cycle.sole) writeStderrLine(line);
  else console.warn(line);
}

/**
 * The post-signal fetches the cycle's deadline cuts — a request served
 * after the signal sent its events through an immediate transport whose
 * fetch runs to signal + D — counted as not delivered now, on the
 * transport itself (`precountDue`), so no later line counts them again.
 * Not the cycle's stops (marked), nor a transport an earlier line of the
 * cycle marked.
 */
function precountLate(cycle: SignalCycle): number {
  const marked = new Set<Transport>(cycle.marks.map((mark) => mark.transport));
  let n = 0;
  for (const transport of transports) {
    if (cycle.stops.has(transport) || marked.has(transport)) continue;
    n += transport.precountDue(cycle.deadlineAt);
  }
  return n;
}

/**
 * At a deadline that comes after the cycle was handed back (a second
 * signal), its stops still running: what they still hold is what the
 * deadline gives up, counted now — less what an earlier line of the cycle
 * pre-counted, and with the losses of those events since taken out — and
 * marked afresh for the drain-settled report and the exit hook (#154).
 */
function precountStops(cycle: SignalCycle): number {
  let n = -lostOfMarked(cycle.marks);
  const marks = markPending(cycle.stops);
  for (const mark of marks) {
    const earlier = cycle.marks.find((m) => m.transport === mark.transport);
    const stillPending = earlier ? leftOfMark(earlier) - lostOfMark(earlier) : 0;
    n += Math.max(0, mark.pending - stillPending);
  }
  cycle.marks = marks;
  preCounted = marks;
  return n;
}

/**
 * One line to stderr, synchronously: what follows ends the process — the
 * re-raise after the hand-back line, `process.exit()` after the exit hook's
 * — and where stderr is an asynchronous pipe (macOS and BSD under `npm run`
 * or a log collector) a `console.warn` just before it can be lost with the
 * process (#148 review rounds 2 and 3). `console.warn` elsewhere.
 */
function writeStderrLine(line: string): void {
  try {
    fs.writeSync(2, `${line}\n`);
  } catch {
    console.warn(line); // a full non-blocking pipe (EAGAIN): the stream's turn
  }
}

/**
 * A `shutdown()` whose deadline gave events up: its own line, its own
 * count — unless a signal cycle started it (the cycle's line covers it,
 * at the hand-back or when its drain settles), one is running (its line
 * counts every loss until it ends), or a natural-exit drain started it
 * (the exit hook's line counts it, #167: nobody called `shutdown()`).
 */
function reportCallLoss(transport: Transport, lost: number, deadlineMs: number): void {
  if (signalInFlight || signalStops.has(transport) || exitStops.has(transport)) return;
  reportedLost += lost;
  console.warn(
    `[YAVIO-1205] shutdown() deadline of ${deadlineMs} ms reached — ${lost} events not delivered. ${RAISE_HINT}`,
  );
}

/**
 * Re-raise a signal once the SDK's listener is gone, so Node's default action
 * runs: exit with 128 + the signal number, terminal mode reset (#138). Any
 * listener on a signal — ours included — replaces that default, which is why
 * an app with no handler of its own kept running after Ctrl-C or
 * `docker stop` once the SDK had drained. On Windows `process.kill` with a
 * signal is a plain TerminateProcess (exit code 1), so the exit code is set by
 * hand there. Replaceable for tests only.
 */
const defaultReraise = (signal: HandledSignal): void => {
  const code = 128 + (os.constants.signals[signal] ?? (signal === "SIGINT" ? 2 : 15));
  if (process.platform === "win32") process.exit(code);
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(code);
  }
};
let reraise: (signal: HandledSignal) => void = defaultReraise;

/**
 * The first signal fixes the process deadline, drains the registry, then
 * hands the signal back (`finishSignal`); a second one while that is still
 * running hands back at once, so a second Ctrl-C still ends the process
 * the way it does without the SDK — except the same signal within 250 ms,
 * taken for the first one delivered twice (a heuristic, see
 * `SAME_DELIVERY_MS`), and a `SIGTERM` after the cycle's `SIGINT`, a
 * client's stop sequence, which the cycle hands back by SIGINT +
 * `ESCALATION_MS` (#175, `escalate`). What is handed back is the signal
 * that ARRIVED, with its own listeners deciding: re-raised only if the SDK
 * is its only listener (re-raising the first signal with the first's
 * decision killed an app that handles only the second one — SIGINT, say —
 * with the default action of the first, SIGTERM's 143, in the middle of
 * its own shutdown; #148 review round 4). Whether to re-raise is decided
 * when the signal arrives: an app listener registered with `process.once`
 * is gone by the time the drain is done, and that app must not be killed
 * in the middle of its own shutdown. Each cycle is its own object, and
 * `finishSignal(cycle)` ends only the cycle still in flight: a drain that
 * ends after its cycle was handed back cannot end a later cycle.
 */
function onSignal(signal: HandledSignal): void {
  const running = signalInFlight;
  if (running) {
    const afterMs = Date.now() - running.startedAt;
    // The same delivery: a repeat within 250 ms of the arrival of the
    // signal the cycle hands back — the one it started with, or the
    // `SIGTERM` an escalation took (#175).
    const sinceArrival = afterMs - (running.escalation?.afterMs ?? 0);
    if (running.signal === signal && sinceArrival < SAME_DELIVERY_MS) return;
    const escalates = running.signal === "SIGINT" && signal === "SIGTERM" && !running.escalation;
    running.signal = signal;
    running.sole = process.listenerCount(signal) === 1;
    if (escalates && escalate(running, afterMs)) return;
    finishSignal(running, "hand-back");
    return;
  }
  const budgetMs = processBudgetMs();
  const startedAt = Date.now();
  const cycle: SignalCycle = {
    signal,
    sole: process.listenerCount(signal) === 1,
    startedAt,
    budgetMs,
    deadlineAt: startedAt + budgetMs,
    marks: [],
    stops: new Set(),
    stopsSettled: Promise.resolve(),
    stopsRunning: false,
    deadlineCounted: false,
    lateReported: false,
    printed: false,
    deadlinePassed: false,
    epoch: resets,
  };
  signalInFlight = cycle;
  // A new cycle starts afresh: a `shutdown()` that returned in an earlier
  // one says nothing about an exit in this one (#154 review round 2).
  lastCycle = cycle;
  armCycleTimer(cycle);
  armExitHook();
  beginProcessShutdown()
    .catch(() => {})
    .then(() => {
      // Still this cycle: end it — the drain is done, or the deadline cut
      // its wait with the cycle's stops still settling.
      const handedBack = signalInFlight !== cycle;
      if (!handedBack) finishSignal(cycle, "drain-end");
      // Handed back before its stops settled (a second signal, or the
      // deadline): once they have, what they gave up since the hand-back
      // is reported as the cycle's, in one line.
      if (handedBack || cycle.stopsRunning) {
        void cycle.stopsSettled.then(() => {
          if (cycle.epoch === resets) reportCycleLoss(cycle, "drain-settled");
        });
      }
    });
}

/**
 * The cycle's deadline timer, for its `deadlineAt` as it stands now: at
 * the signal, and again when an escalation moves the deadline in (#175).
 * Replaces the timer before it.
 */
function armCycleTimer(cycle: SignalCycle): void {
  clearTimeout(cycleTimer);
  cycleTimer = setTimeout(
    () => {
      onCycleDeadline(cycle); // the cycle's line first, then the waiters (#154)
      cycle.deadlinePassed = true;
      releaseWaiters();
    },
    Math.max(0, cycle.deadlineAt - Date.now()),
  );
  unref(cycleTimer);
}

/**
 * A `SIGTERM` after the `SIGINT` that started the cycle (#175): Claude Code
 * stops a stdio server with `SIGINT`, `SIGTERM` 100 ms later and `SIGKILL`
 * 400 ms after that, so this is a client's stop sequence, not a request to
 * give up at once. The cycle goes on and hands the `SIGTERM` back — its
 * own listeners deciding, as at any hand-back — by min(SIGINT + D, SIGINT
 * + `ESCALATION_MS`). Everything the cycle bounds follows the earlier
 * deadline: `deadlineAt` moves in (never out), the cycle's timer is
 * re-armed for it, the cycle's stops are cut to it (`cutDeadline` aborts
 * their fetch there), the drain's wait and every `shutdown()` and
 * `flush()` wait end on that timer (`deadlineWaiters`), and a post-signal
 * fetch started from now on gets what is left (`lateFetchBudgetMs`). D
 * itself (`budgetMs`) stays: after the hand-back a `shutdown()` still
 * waits at most D from its call. A post-signal fetch already in flight
 * keeps its budget; as the only listener the re-raise ends it anyway.
 * False when SIGINT + `ESCALATION_MS` has passed: the hand-back comes now,
 * as before #175.
 */
function escalate(cycle: SignalCycle, afterMs: number): boolean {
  const at = cycle.startedAt + ESCALATION_MS;
  if (at <= Date.now()) return false;
  const cut = at < cycle.deadlineAt;
  cycle.escalation = { afterMs, cut };
  if (!cut) return true; // a lower D ends the cycle sooner
  cycle.deadlineAt = at;
  armCycleTimer(cycle);
  for (const stop of cycle.stops) stop.cutDeadline?.(at);
  return true;
}

/**
 * The SDK's listeners are only there to drain; once that is done they are
 * removed. If the SDK was the only listener when the signal arrived, the app
 * relied on Node's default exit, which our listener had suppressed: re-raise
 * so it happens now. An app with its own listener keeps control of what
 * happens next (its listener already ran). Known limit: a library that also
 * only re-raises when it is the last listener (signal-exit, used by execa and
 * ora) does not get its turn either — that app must handle the signal itself.
 */
function finishSignal(cycle: SignalCycle, at: "hand-back" | "drain-end" | "deadline"): void {
  if (signalInFlight !== cycle) return; // handed back already, or a later cycle is running
  signalInFlight = null;
  lastBudgetMs = cycle.budgetMs;
  lastDeadlineAt = cycle.deadlineAt;
  reportCycleLoss(cycle, at); // before the re-raise: a POSIX re-raise skips `exit` listeners
  removeSignalHandlers();
  if (cycle.sole) reraise(cycle.signal);
}

/**
 * The cycle's deadline has come (#154): its timer fired, or a wait bounded
 * by it — an app's `shutdown()`, the drain's wait for a stop in progress —
 * got there first; their order within the tick is not fixed. The cycle's
 * line comes now, before whatever that wait releases: the README recipe's
 * `process.exit(0)` runs as soon as its `await analytics.shutdown()`
 * returns. Before #154 the waiters went first — the cycle's timer, made
 * before the stops' deadline timers for the same duration, usually runs
 * before them — and the exit hook's "Process exit … await
 * analytics.shutdown()" line counted every event, with a hint for an app
 * that did. Still in flight, the cycle ends here. Handed back early (a
 * second signal) with its stops still running, its late report comes now
 * rather than when they settle — but only when a `shutdown()` wait returns
 * at this deadline (`releases`: an app's own timer, or one waiting on the
 * cycle's): with none, nothing is released here, and the late report waits
 * for the stops and holds what the deadline and the 100 ms floor cut by
 * then, in one line (#154 CI fix). Once per cycle.
 */
function onCycleDeadline(cycle: SignalCycle, releases = appWaits > 0): void {
  cycle.deadlinePassed = true;
  if (cycle.epoch !== resets || cycle.deadlineCounted) return;
  if (signalInFlight === cycle) finishSignal(cycle, "deadline");
  else if (cycle.stopsRunning && releases) reportCycleLoss(cycle, "late-deadline");
}

/** Whether one of the cycle's stops was cut by its own deadline timer: the deadline has come. */
const stopsCut = (cycle: SignalCycle): boolean =>
  [...cycle.stops].some((stop) => stop.reachedDeadline?.() === true);

/**
 * Prepended, so the SDK's listener runs before the app's and counts them all
 * when the signal arrives — a `process.once` listener registered earlier
 * would otherwise already be gone by the time ours runs.
 */
function installSignalHandlers(): void {
  if (signalListeners) return;
  signalListeners = new Map(SIGNALS.map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, listener] of signalListeners) process.prependListener(signal, listener);
}

function removeSignalHandlers(): void {
  if (!signalListeners) return;
  for (const [signal, listener] of signalListeners) process.off(signal, listener);
  signalListeners = null;
}

/** @internal Replace (or with `null` restore) the re-raise — exposed for testing only. */
export function _setSignalReraise(fn: ((signal: "SIGTERM" | "SIGINT") => void) | null): void {
  reraise = fn ?? defaultReraise;
}

function newTransport(config: Key, sdkVersion: string): HttpTransport {
  // After the signal, a transport sends at once with one attempt and a
  // fetch that gives up within what is left of the process budget: a
  // request finishing late still delivers its events, and never keeps the
  // process alive for the 30 s default or past the deadline (#148).
  const transport = new HttpTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    sdkVersion,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    immediate: draining,
    onShutdownLoss: (lost, deadlineMs) => reportCallLoss(transport, lost, deadlineMs),
    onBudgetCut: (atMs) => {
      lastBudgetCut = lastBudgetCut === undefined ? atMs : Math.max(lastBudgetCut, atMs);
    },
    onClosed: () => {
      // Settled: nothing is pending, and nothing reaches it any more (the
      // registry unhooks a transport from its slot before stopping it), so
      // its count is final. Folded, then forgotten.
      if (!transports.delete(transport)) return;
      lostFromClosed += transport.deadlineLostEvents();
    },
    ...(draining ? { maxRetries: 0, fetchBudgetMs: lateFetchBudgetMs } : {}),
  });
  transports.add(transport);
  transportKeys.set(transport, keyOf(config));
  if (draining) noteDraining();
  else transport.start();
  return transport;
}

function slotFor(config: Key, sdkVersion: string, onEvict?: (sessionId: string) => void): Slot {
  const key = keyOf(config);
  const existing = slots.get(key);
  if (existing) return existing;
  const slot: Slot = {
    ...createSharedSessions(onEvict),
    live: null,
    sdkVersion,
    stopping: null,
    transport: {
      send: (events) => {
        // A request finishing during the stop a pinned key's last release
        // started joins that stop while it still takes sends: delivered with
        // it, or counted once in its line (#179 review round 1). Before, it
        // went to the fresh transport, outside the `shutdown()` the app
        // awaited, and the README recipe's `process.exit(0)` lost it.
        if (slot.stopping?.joinsShutdown()) {
          slot.stopping.send(events);
          return;
        }
        // Nothing live: every holder released (the event has nowhere to go,
        // as with a stopped transport) — or a signal drained it, and a
        // request still being served sends best effort through an immediate
        // transport, like a wrap after the signal would get — or a natural
        // exit drained it and the process went on: the entry the drain took
        // goes back with a fresh transport, its holds and pin live again,
        // and the next `beforeExit` drains it (#167 review rounds 1 and 2).
        if (!slot.live) {
          if (draining) slot.live = newTransport(config, sdkVersion);
          else restoreDrained(config, sdkVersion);
        }
        slot.live?.send(events);
      },
      flush: () => slot.live?.flush() ?? Promise.resolve(),
      drain: (deadlineMs) => drainTransport(slot.live, deadlineMs),
      shutdown: (deadlineMs) => slot.live?.shutdown(deadlineMs) ?? Promise.resolve(),
    },
  };
  slots.set(key, slot);
  return slot;
}

/**
 * Put back the entry a natural-exit drain took for this config's key, with
 * a fresh transport and the same generation, holders and pin, so every
 * hold the drain took is live again (#167 review rounds 2 and 3). Nothing
 * after a signal: a send then goes out through an immediate transport.
 */
function restoreDrained(config: Key, sdkVersion: string): Entry | undefined {
  if (draining) return undefined;
  const key = keyOf(config);
  const drained = exitDrained.get(key);
  if (!drained) return undefined;
  exitDrained.delete(key);
  drained.slot.live = newTransport(config, sdkVersion);
  registry.set(key, drained);
  return drained;
}

function entryFor(config: Key, sdkVersion: string, onEvict?: (sessionId: string) => void): Entry {
  const key = keyOf(config);
  const existing = registry.get(key);
  if (existing) return existing;
  // A re-acquire after a natural drain — a `wrap()`, a `withYavio()`, a new
  // `createYavio()` — puts back the entry the drain took instead of making
  // a new one: a new entry left the drained entry's holds stale, and once
  // its last holder released, a stale client's later sends were dropped
  // without a line (review round 3).
  const restored = restoreDrained(config, sdkVersion);
  if (restored) return restored;

  const slot = slotFor(config, sdkVersion, onEvict);
  // After a signal the facade may already have started an immediate
  // transport for a request finishing in the grace window: keep it, so the
  // send it has in flight is what a later shutdown() awaits — a fresh one
  // would orphan it mid-send (#142).
  const transport = slot.live ?? newTransport(config, sdkVersion);
  slot.live = transport;
  const entry: Entry = { slot, holders: 0, pinned: false, generation: ++generations };
  registry.set(key, entry);
  // A new entry after a signal: a drained entry's holds stay stale, and
  // their sends go out through immediate transports. A release that stops
  // this transport is a release, and a send after it is dropped (review
  // round 1).
  exitDrained.delete(key);
  installSignalHandlers();
  installBeforeExit();
  return entry;
}

/**
 * Everything queued, every batch, giving up at `deadlineMs` (the transport's
 * own when omitted); a transport without `drain` is flushed once.
 */
async function drainTransport(transport: Transport | null, deadlineMs?: number): Promise<void> {
  if (!transport) return;
  if (transport.drain) await transport.drain(deadlineMs);
  else await transport.flush();
}

/**
 * The shared state for a resolved config, pinned: created on first use, then
 * reused by every later wrap with the same endpoint and key, and always with
 * a live transport until a signal (`withYavio()` has no shutdown). The last
 * `createYavio()` client's `shutdown()` on the key stops the current
 * transport and a fresh one takes over at once (#179). Installs the process
 * signal handlers the first time any state is created.
 */
export function pinShared(
  config: Key,
  sdkVersion: string,
  onEvict?: (sessionId: string) => void,
): SharedState {
  const entry = entryFor(config, sdkVersion, onEvict);
  entry.pinned = true;
  const ms = explicitDeadline(config);
  if (ms !== undefined) {
    const key = keyOf(config);
    pinDeadlines.set(key, minDeadline(pinDeadlines.get(key), ms) as number);
  }
  return entry.slot;
}

const minDeadline = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * The shared state for a resolved config, held by one more client. Each hold
 * is balanced by one `releaseShared` of that same hold.
 */
export function acquireShared(
  config: Key,
  sdkVersion: string,
  onEvict?: (sessionId: string) => void,
): SharedHold {
  const entry = entryFor(config, sdkVersion, onEvict);
  entry.holders++;
  const deadlineMs = explicitDeadline(config);
  if (deadlineMs !== undefined) holdDeadlines.push(deadlineMs);
  return { state: entry.slot, generation: entry.generation, deadlineMs };
}

/**
 * Take a hold's explicit value out of `holdDeadlines`: on its release, and
 * when `createYavio()` replaces a hold a signal made stale with a new one —
 * the new hold registers the value again, and the stale one's would
 * otherwise count towards D for the rest of the process (#148 review round 7).
 */
export function dropHoldDeadline(hold: SharedHold): void {
  if (hold.deadlineMs === undefined) return;
  const at = holdDeadlines.indexOf(hold.deadlineMs);
  if (at >= 0) holdDeadlines.splice(at, 1);
}

/** Is this hold on the transport that is live for its config right now? */
export function isLiveHold(config: Key, hold: SharedHold): boolean {
  return registry.get(keyOf(config))?.generation === hold.generation;
}

/**
 * A hold on the entry a natural-exit drain took, which nothing has put back
 * yet: put it back and say so, so the client keeps this hold instead of
 * taking a second one on the same entry — a holder that no `shutdown()`
 * would ever release (#167 review round 3).
 */
export function reviveHold(config: Key, hold: SharedHold, sdkVersion: string): boolean {
  const key = keyOf(config);
  if (registry.has(key) || exitDrained.get(key)?.generation !== hold.generation) return false;
  return restoreDrained(config, sdkVersion) !== undefined;
}

/**
 * Deliver everything queued before this call, then release one client's
 * hold on a config's state. First the signal drain, if one is running or
 * ran. A hold on a transport that is no longer live (a signal drained it,
 * or it stopped and a successor started) releases nothing — but still
 * drains the key's current transport, through which a request served after
 * the signal sent its events (#142). The transport stops once no other
 * client holds it — so a later wrap starts afresh, or, on a key a
 * `withYavio()` call pinned, a fresh transport takes over at once (#179);
 * otherwise the other holders keep delivering through it, with
 * everything this client queued delivered first. Every drain or stop this
 * causes runs under the releasing config's own `shutdownTimeoutMs`, not the
 * transport creator's, cut to the process deadline once a signal fixed one
 * (`boundedBy`). The config's explicit value counts towards D while the
 * call is in progress.
 */
export async function releaseShared(config: Key, hold: SharedHold): Promise<void> {
  const key = keyOf(config);
  const ownMs = config.shutdownTimeoutMs;
  // The hold's value leaves the live set now — whether or not its transport
  // is still the key's — and counts on through `noteInProgress` until the
  // call resolves.
  dropHoldDeadline(hold);
  const done = noteInProgress(config);
  try {
    if (signalDrain) await signalDrain;
    const entry = registry.get(key);
    const drained = exitDrained.get(key);
    if (!entry && drained?.generation === hold.generation) {
      // A hold a natural-exit drain took, and nothing sent since: its
      // release counts on that entry, so after the last one a send is
      // dropped, as after any last release (#167 review round 2).
      drained.holders = Math.max(0, drained.holders - 1);
      if (drained.holders === 0 && !drained.pinned) exitDrained.delete(key);
    }
    if (!entry || entry.generation !== hold.generation) {
      await drainTransport(slots.get(key)?.live ?? null, boundedBy(ownMs));
      return;
    }
    entry.holders = Math.max(0, entry.holders - 1);
    if (entry.holders > 0) {
      await drainTransport(entry.slot.live, boundedBy(ownMs));
      return;
    }
    // The last client's release stops the key's transport, pinned or not
    // (#179): a stop aborts the fetch in flight at its deadline and counts
    // what it gave up in its own `shutdown()` line. The drain a pinned key
    // got before did neither, so the README's shutdown-only client next to
    // `withYavio()` ended in the exit hook's "await analytics.shutdown()"
    // line, and without `process.exit()` a hanging fetch held the process
    // for the 30 s fetch timeout. A pinned key keeps its entry, its
    // generation and its pin, and gets a fresh transport at once, which the
    // `withYavio()` proxies send through once the stop no longer takes
    // sends; until then a send joins the stop (`slot.stopping`, review
    // round 1).
    const slot = entry.slot;
    const live = slot.live;
    if (entry.pinned) {
      slot.live = newTransport(config, slot.sdkVersion);
      if (live instanceof HttpTransport) slot.stopping = live;
    } else {
      registry.delete(key);
      slot.live = null;
    }
    if (!live) return;
    try {
      await trackStop(live, live.shutdown(boundedBy(ownMs)));
    } finally {
      if (slot.stopping === live) slot.stopping = null;
    }
  } finally {
    done();
  }
}

/** Keep a transport stop in `stopsInProgress` until it settles. */
function trackStop(transport: Transport, stop: Promise<void>): Promise<void> {
  const tracked = stop.catch(() => {}).finally(() => stopsInProgress.delete(tracked));
  stopsInProgress.set(tracked, transport);
  return stop;
}

/**
 * A `shutdown()` without a hold to release (a second call; a signal drained
 * the hold and nothing re-wrapped since): the signal drain, then whatever
 * the key's live transport still carries (#142). Never stops anything.
 */
export async function settleShared(config: Key): Promise<void> {
  const done = noteInProgress(config);
  try {
    if (signalDrain) await signalDrain;
    await drainTransport(
      slots.get(keyOf(config))?.live ?? null,
      boundedBy(config.shutdownTimeoutMs),
    );
  } finally {
    done();
  }
}

/**
 * `client.flush()` (#171): everything queued for the config's key at the
 * call, sent now and answered — what is queued later is the next flush's
 * (decision A, review round 4) — without releasing, stopping or arming
 * anything. First what
 * a signal or natural-exit drain is still sending (`signalDrain`) and the
 * key's own stops in progress (a last holder's release): events queued
 * before the call may be on their way out there. Then the key's live
 * transport, through `flushQueued()` — one early retry per flush, a stale
 * fetch re-sent, nothing dropped at the deadline (decision C). Bounded by
 * `flushTimeoutMs` from the call, cut to what a signal cycle leaves (or to
 * D after a hand-back) and released by the cycle's deadline timer
 * (`deadlineWaiters`). The deadline timer is ref'd while the flush runs
 * (#164's rule): an `await analytics.flush()` with nothing else alive —
 * the end of a script, a Lambda handler — must not be cut short by Node
 * exiting on an empty loop. Never rejects. Not counted towards D.
 *
 * `holdMs` (`flushWhenSent()`, review round 2): past `flushTimeoutMs`, the
 * flush keeps waiting, up to `holdMs` from the call, for the fetch it
 * started or re-sent itself — it runs in `waitUntil` and delays no
 * response, and on Workers that fetch dies with the request once the flush
 * ends. Cut by a signal cycle like `flushTimeoutMs`.
 */
export async function flushShared(
  config: Key & Pick<YavioConfig, "flushTimeoutMs">,
  holdMs?: number,
): Promise<void> {
  const key = keyOf(config);
  const ms = boundedBy(config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
  if (ms <= 0) return; // a signal cycle with no time left
  const total = Math.max(ms, boundedBy(holdMs ?? ms));
  const deadlineAt = Date.now() + ms;
  const left = () => Math.max(1, deadlineAt - Date.now());
  let outcome: FlushOutcome | undefined;
  const work = (async (): Promise<FlushOutcome> => {
    if (signalDrain) await signalDrain;
    const stops: Promise<void>[] = [];
    for (const [stop, transport] of stopsInProgress) {
      if (transportKeys.get(transport) === key) stops.push(stop);
    }
    if (stops.length > 0) await Promise.all(stops);
    const live = slots.get(key)?.live ?? null;
    if (live instanceof HttpTransport) {
      const deadline = left();
      return live.flushQueued(deadline, ms, deadline + (total - ms));
    }
    await drainTransport(live, left());
    return "done";
  })().then(
    (result) => {
      outcome = result;
    },
    () => {
      outcome = "done"; // nothing above rejects; should it ever, the flush still resolves
    },
  );
  // The transport's flush bounds itself by the same deadline, and must end
  // first: its watches are removed in its own finally, from its own request
  // context. Came the two due in the same millisecond, this race (set
  // first) won, and on Workers the request ended with a watch left behind,
  // which a later request's flush then resolved (#171 review round 3).
  await raceDeadline(work, total + FLUSH_RACE_MARGIN_MS, {
    keepAlive: true,
    waiters: deadlineWaiters,
  });
  reportFlush(key, ms, outcome ?? "deadline");
}

/** How much later than the transport's own deadline `flushShared()`'s safety race comes due (#171 review round 3). */
const FLUSH_RACE_MARGIN_MS = 25;

/**
 * One `YAVIO-1208` line per stall per key (#171): printed by the first
 * flush that leaves events undelivered after one that delivered everything
 * (or after none), then nothing until a flush delivers everything again.
 * Nothing while the process drains after a signal: the cycle's `YAVIO-1205`
 * line counts what is not delivered then. A flush that deferred to another
 * running flush's send neither prints nor clears: that flush carries its
 * events and reports for them. And at most one line per key per minute, so
 * a stall that clears and comes back is not a line a second (review round
 * 4); such a stall is reported by the first flush after the minute that
 * still leaves events undelivered, and one that ends within the minute
 * prints nothing (round 5).
 */
function reportFlush(key: string, ms: number, outcome: FlushOutcome): void {
  if (draining || outcome === "deferred") return;
  const live = slots.get(key)?.live;
  const pending = live instanceof HttpTransport ? live.pendingEvents() : 0;
  if (outcome === "done" || pending === 0) {
    stalledFlushes.delete(key);
    return;
  }
  if (stalledFlushes.has(key)) return;
  // Marked only when its line is printed: a stall the minute's limit
  // silenced is reported by the first flush after the minute that still
  // leaves events undelivered, not never (#171 review round 5: a flapping
  // ingest's second stall stayed unreported for its ten minutes).
  const now = Date.now();
  const last = stallLineAt.get(key);
  if (last !== undefined && now - last < STALL_LINE_INTERVAL_MS) return;
  stalledFlushes.add(key);
  stallLineAt.set(key, now);
  const why =
    outcome === "retrying"
      ? "ingest failed a batch, which waits for its retry"
      : `ingest did not answer within ${ms} ms`;
  console.warn(
    `[${ErrorCode.SDK.FLUSH_INCOMPLETE}] flush() left ${pending} events undelivered — ${why}. They stay queued and go out with a later flush(), the flush interval or shutdown() — on a host that freezes after the response, with the next invocation's flush(). Shown once until a flush() delivers everything again.`,
  );
}

/** Count a `shutdown()` call's explicit deadline towards D until the returned function runs. */
function noteInProgress(config: Key): () => void {
  const ms = explicitDeadline(config);
  if (ms === undefined) return () => {};
  inProgressDeadlines.push(ms);
  return () => {
    const at = inProgressDeadlines.indexOf(ms);
    if (at >= 0) inProgressDeadlines.splice(at, 1);
  };
}

/**
 * What the SIGTERM/SIGINT handler does: mark the process as draining, so
 * everything created or sent from now on goes out at once, then drain every
 * transport in the registry under the process deadline (what the running
 * cycle leaves; D from now when called without a signal, as tests do). The
 * drain is kept in `signalDrain` for every release that follows; the
 * returned promise is this signal's drain alone.
 */
export function beginProcessShutdown(): Promise<void> {
  draining = true;
  const run = shutdownAllShared();
  const previous = signalDrain;
  signalDrain = previous ? Promise.all([previous, run]).then(() => {}) : run;
  return run;
}

/**
 * Drain every transport in the registry (`beginProcessShutdown`, tests),
 * every one under the same process deadline: what the running signal cycle
 * leaves, or D computed now when no signal is being handled. Not the
 * transport's own value, which is its creator's and stays after that
 * creator released (#142 review round 4), and not a per-key value: the
 * grace period is per process (#148). Stops already in progress — the last
 * holder's release when the signal arrived — are awaited too, within the
 * same deadline, and their own deadline is cut to it: `shutdown(D)` on
 * such a transport returns the stop already running under the releasing
 * hold's value, and with D below that value nothing else would abort its
 * fetch at signal + D — its socket outlived the process deadline and its
 * loss was nobody's but the exit hook's (review round 6).
 */
export async function shutdownAllShared(): Promise<void> {
  const cycle = signalInFlight;
  const deadlineMs = remainingMs() ?? processBudgetMs();
  const deadlineAt = cycle?.deadlineAt ?? Date.now() + deadlineMs;
  for (const transport of stopsInProgress.values()) {
    signalStops.add(transport); // what it gives up at the cut deadline is the cycle's loss, not a shutdown() line
    cycle?.stops.add(transport);
    transport.cutDeadline?.(deadlineAt);
  }
  const entries = [...registry.values()];
  registry.clear();
  const stops = entries.map((entry) => {
    const live = entry.slot.live;
    entry.slot.live = null;
    if (!live) return undefined;
    signalStops.add(live); // its deadline loss is the cycle's, even after a hand-back
    cycle?.stops.add(live);
    return live.shutdown(deadlineMs).catch(() => {});
  });
  const inProgress = [...stopsInProgress.keys()];
  const settled = Promise.all([...stops, ...inProgress]).then(() => {
    if (cycle) cycle.stopsRunning = false;
  });
  if (cycle) {
    cycle.stopsRunning = true;
    cycle.stopsSettled = settled;
  }
  if (inProgress.length === 0) {
    await settled;
    return;
  }
  // Released early by the cycle's deadline timer and by the test reset,
  // like every bounded shutdown() wait (#148 review round 2): this may
  // return before the stops have settled, and the hand-back line then
  // pre-counts what they still hold (review round 10). Its own timer, when
  // it runs first, counts the cycle's line first too (#154).
  await raceDeadline(settled, deadlineMs, {
    waiters: deadlineWaiters,
    onTimeout: cycle ? () => onCycleDeadline(cycle) : undefined,
  });
}

/** @internal Number of live shared states — exposed for testing only. */
export function _sharedStateCount(): number {
  return registry.size;
}

/** @internal `shutdown()` waits in progress — exposed for testing only. */
export function _appWaitCount(): number {
  return appWaits;
}

/** @internal Number of transports not yet shut down — exposed for testing only. */
export function _trackedTransportCount(): number {
  return transports.size;
}

/**
 * Messages that are worth exactly one line per process: the mode a wrap
 * runs in does not change between requests, and a stateless host wraps on
 * every request. Every SDK line goes to stderr (`console.warn`,
 * `console.error`, `writeStderrLine`), the informational ones included:
 * on a stdio server stdout is the JSON-RPC wire (#174).
 */
const loggedOnce = new Set<string>();

export function logOnce(key: string, log: () => void): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  log();
}

/**
 * @internal Reset the registry, the warn-once state, the signal handlers,
 * the process deadline, the loss accounting and the exit hook — exposed
 * for testing only. Transports are stopped without draining.
 */
export function _resetSharedState(): void {
  for (const entry of registry.values()) {
    entry.slot.live?.shutdown().catch(() => {});
    entry.slot.live = null;
  }
  registry.clear();
  slots.clear();
  draining = false;
  signalDrain = null;
  clearTimeout(cycleTimer);
  cycleTimer = undefined;
  signalInFlight = null;
  lastBudgetMs = undefined;
  lastDeadlineAt = undefined;
  inProgressDeadlines.length = 0;
  appWaits = 0;
  lastCycle = null;
  returnedIn = null;
  lastBudgetCut = undefined;
  holdDeadlines.length = 0;
  pinDeadlines.clear();
  releaseWaiters();
  transports.clear();
  lostFromClosed = 0;
  stopsInProgress.clear();
  reportedLost = 0;
  preCounted = [];
  resets++;
  if (exitHookArmed) process.off("exit", yavioReportAtExit);
  if (beforeExitInstalled) process.off("beforeExit", onBeforeExit);
  beforeExitInstalled = false;
  lastExitDrain = null;
  exitDrained.clear();
  exitHookArmed = false;
  exitReported = false;
  _setSignalReraise(null);
  loggedOnce.clear();
  stalledFlushes.clear();
  stallLineAt.clear();
  removeSignalHandlers();
}
