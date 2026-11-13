// Live touch: a stroke sent one event at a time, as the pointer moves on the
// Mac, instead of a gesture recorded and played back when it ends.
//
// A stroke is many small events, so it does not fit the action pipeline:
//
// - No receipts and no replay. An event has no request ID and nothing is
//   recorded. An event whose outcome is unknown is never sent again; the stroke
//   is ended instead, because a touch stream with a hole in it is not the
//   gesture the user made.
// - It always ends with the finger up. A stroke ends on `up`, on `cancel`, when
//   any event fails, when no event arrives for a while, when it has lasted too
//   long, when another stroke begins, or when the device route changes. Every
//   ending but `up` cancels the touch on the device. The helper keeps the same
//   rule on its side, so a server that dies mid-stroke leaves nothing down.
// - It owns the command queue from `down` until it ends. Its later events
//   bypass the queue, because they belong to work that already holds it.
//   Nothing else, neither an inspection nor another input, runs between two
//   events of one stroke. What is queued behind a stroke waits for it, with
//   its own deadline still running.
import { apiError, errorInfo } from "../errors.mjs";
import { commandContext } from "../scheduler.ts";
import type { PointerRequest } from "./protocol.ts";

type Enqueue = <T>(fn: () => T | Promise<T>) => Promise<T>;
type PointerArguments = {
  stroke: string;
  phase: PointerRequest["phase"];
  points?: PointerRequest["points"];
  expectedBundleId?: string;
  expectedOrientation?: PointerRequest["expectedOrientation"];
};
type Stroke = {
  id: string;
  /** Settles when the previous event has; events of one stroke run in order. */
  tail: Promise<unknown>;
  /** Hands the queue back. Set once the stroke owns it. */
  release: () => void;
  ended: boolean;
  /** Whether a `down` reached the helper, so there may be a finger to lift. */
  touching: boolean;
  idle?: ReturnType<typeof setTimeout>;
  limit?: ReturnType<typeof setTimeout>;
};

const ended = () =>
  apiError("This stroke has ended and the finger was lifted", 409, "stroke ended");

export function createLiveTouch({
  send: deliver,
  enqueue,
  transportSignal,
  idleMs = 2000,
  maxMs = 60000,
  admitMs = 5000,
  eventMs = 3000,
  onBegin = () => {},
  onEnd = () => {},
}: {
  /** Sends one `pointer` operation to the helper. */
  send: (
    args: PointerArguments,
    options: { timeout: number; signal?: AbortSignal },
  ) => Promise<unknown>;
  enqueue: Enqueue;
  /** Aborts when the device route changes; a stroke never continues across one. */
  transportSignal: () => AbortSignal;
  /** How long a stroke may go without an event before it is cancelled. */
  idleMs?: number;
  /** The longest a stroke may hold the queue. */
  maxMs?: number;
  /** How long `down` may wait for the queue. A touch that starts late is not the touch the user made. */
  admitMs?: number;
  eventMs?: number;
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  let current: Stroke | null = null;

  // Only `down` belongs to the request that queued it. A later event, or a
  // timer armed while the queue is held, would otherwise inherit that
  // request's deadline and cancellation, both long past by then.
  const send: typeof deliver = (args, options) =>
    args.phase === "down"
      ? deliver(args, options)
      : commandContext.exit(() => deliver(args, options));

  /** Ends a stroke once. `lift` cancels the touch on the device first. */
  function end(stroke: Stroke, lift: boolean): Promise<void> {
    if (stroke.ended) return Promise.resolve();
    stroke.ended = true;
    clearTimeout(stroke.idle);
    clearTimeout(stroke.limit);
    if (current === stroke) current = null;
    // The cancel deliberately ignores the route's signal: after a route change
    // the same helper is still there, and this is the last chance to tell it.
    // If it cannot be told, its own watchdog lifts the finger.
    const lifted =
      lift && stroke.touching
        ? send({ stroke: stroke.id, phase: "cancel" }, { timeout: 1500 }).then(
            () => {},
            () => {},
          )
        : Promise.resolve();
    // The queue is handed back only after the lift, so the next command never
    // starts with a finger still down.
    return lifted.then(() => {
      stroke.release();
      if (stroke.touching) onEnd();
    });
  }

  function arm(stroke: Stroke) {
    clearTimeout(stroke.idle);
    if (stroke.ended) return;
    stroke.idle = setTimeout(() => void end(stroke, true), idleMs);
    stroke.idle.unref?.();
  }

  /** Runs one event after the stroke's previous ones. A failure ends the stroke. */
  function step(stroke: Stroke, event: () => Promise<unknown>): Promise<void> {
    const run = stroke.tail.then(async () => {
      if (stroke.ended) throw ended();
      arm(stroke);
      try {
        await event();
      } catch (error) {
        // The helper says so itself when the finger is already up.
        const gone = errorInfo(error).code === "stroke ended";
        await end(stroke, !gone);
        throw gone ? ended() : error;
      }
      arm(stroke);
    });
    stroke.tail = run.catch(() => {});
    return run;
  }

  async function down(body: PointerRequest, signal: AbortSignal): Promise<void> {
    // One stroke at a time. A new one replaces a stroke its client abandoned.
    if (current) await end(current, true);
    const stroke: Stroke = {
      id: body.stroke,
      tail: Promise.resolve(),
      release: () => {},
      ended: false,
      touching: false,
    };
    current = stroke;
    const transport = transportSignal();
    const started = new Promise<void>((resolve, reject) => {
      commandContext
        .run(
          {
            signal: AbortSignal.any([signal, transport]),
            deadline: performance.now() + admitMs,
            operationTimeoutMs: admitMs,
            priority: 5,
          },
          () =>
            enqueue(async () => {
              if (stroke.ended) throw ended();
              const held = new Promise<void>((release) => {
                stroke.release = release;
              });
              stroke.touching = true;
              try {
                await send(
                  {
                    stroke: stroke.id,
                    phase: "down",
                    points: body.points,
                    expectedBundleId: body.expectedApp,
                    expectedOrientation: body.expectedOrientation,
                  },
                  { timeout: eventMs },
                );
              } catch (error) {
                // A refused down touched nothing. Any other failure may have.
                if (errorInfo(error).outcome === "notExecuted") stroke.touching = false;
                await end(stroke, true);
                throw error;
              }
              if (stroke.ended) {
                // Replaced while its down was in flight. The cancel sent then
                // may have reached the helper before the down did.
                await send({ stroke: stroke.id, phase: "cancel" }, { timeout: 1500 }).catch(
                  () => {},
                );
                throw ended();
              }
              onBegin();
              arm(stroke);
              stroke.limit = setTimeout(() => void end(stroke, true), maxMs);
              stroke.limit.unref?.();
              transport.addEventListener("abort", () => void end(stroke, true), { once: true });
              resolve();
              // Keep the queue until the stroke ends.
              await held;
            }),
        )
        .catch((error) => {
          void end(stroke, false);
          reject(error);
        });
    });
    // Events sent before `down` was answered wait for it.
    stroke.tail = started.catch(() => {});
    return started;
  }

  return {
    get active() {
      return current !== null;
    },
    /** Handles one `POST /api/pointer` body. Resolves when the helper has taken the event. */
    async handle(body: PointerRequest, signal: AbortSignal): Promise<void> {
      if (body.phase === "down") return down(body, signal);
      const stroke = current;
      if (!stroke || stroke.id !== body.stroke) {
        // Cancelling a stroke that has already ended asks for nothing.
        if (body.phase === "cancel") return;
        throw ended();
      }
      const transport = transportSignal();
      if (body.phase === "move")
        return step(stroke, () =>
          send(
            { stroke: stroke.id, phase: "move", points: body.points },
            { timeout: eventMs, signal: transport },
          ),
        );
      if (body.phase === "up") {
        await step(stroke, () =>
          send(
            { stroke: stroke.id, phase: "up", points: body.points },
            { timeout: eventMs, signal: transport },
          ),
        );
        return end(stroke, false);
      }
      await stroke.tail;
      return end(stroke, true);
    },
    /** Ends any stroke, for example when the session closes. */
    stop: () => (current ? end(current, true) : Promise.resolve()),
  };
}
