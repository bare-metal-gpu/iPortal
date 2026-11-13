// Owner lifetime, helper boot, and route generations are independent. In
// particular, observing a different route never grants automation readiness.
import type { StartupFailure } from "./helper-startup.ts";
type Ticket = { ownerId: string; launch: number };
type Status = import("effect").Schema.Schema.Type<
  typeof import("./helper-protocol.ts").HelperStatusSchema
>;
type LifecycleState = {
  ownerId: string;
  phase: Status["phase"];
  boot: string | null;
  transport: number;
  launch: number;
  locked: boolean | null;
  authorized: boolean | null;
};
// A probe that got no answer (a timeout, a reset tunnel) says nothing about the
// helper: it may be busy, or Wi-Fi dropped a packet. Any answer is evidence,
// including a refused credential, another build or a retired generation; those
// carry an API status and must be acted on at once.
export function unansweredProbe(error: unknown) {
  return (
    error === null ||
    typeof error !== "object" ||
    !("status" in error) ||
    typeof error.status !== "number"
  );
}
export function createHelperLifecycle(ownerId: string, now = Date.now) {
  let state: LifecycleState = {
    ownerId,
    phase: "stopped",
    boot: null,
    transport: 0,
    launch: 0,
    locked: null,
    authorized: null,
  };
  let recoveries: number[] = [];
  let launchDeadline = Infinity;
  let retryAt = 0;
  let failures = 0;
  let problem: StartupFailure | null = null;
  return {
    get problem() {
      return problem;
    },
    get canLaunch() {
      return state.phase !== "stopping" && now() >= retryAt;
    },
    get state() {
      return { ...state };
    },
    begin() {
      if (state.phase === "stopping" || now() < retryAt) return null;
      launchDeadline = now() + 10000; // Includes the bounded installation probe.
      state = {
        ...state,
        launch: state.launch + 1,
        phase: "starting",
        locked: null,
        authorized: null,
      };
      return { ownerId, launch: state.launch };
    },
    launched(ticket: Ticket | null, installing: boolean) {
      if (this.owns(ticket)) launchDeadline = now() + (installing ? 60000 : 20000);
    },
    timedOut(ticket: Ticket | null) {
      return this.owns(ticket) && now() >= launchDeadline;
    },
    unavailable() {
      // Losing readiness after a successful launch must not leave a live but
      // unreachable launcher holding Play forever. Normal handovers fit inside
      // this recovery window; a later authenticated status cancels it.
      if (launchDeadline === Infinity && state.phase !== "stopping") launchDeadline = now() + 20000;
    },
    failed(ticket: Ticket | null, failure: StartupFailure) {
      if (!this.exit(ticket)) return false;
      problem = failure;
      const delay =
        failure.kind === "locked"
          ? 3000
          : failure.kind === "setup" || failure.kind === "developer"
            ? 30000
            : ++failures >= 3
              ? 30000
              : 1000;
      retryAt = now() + delay;
      return true;
    },
    lockObserved(locked: boolean | null) {
      if (locked !== true && problem?.kind === "locked") {
        problem = null;
        if (locked === false) retryAt = 0;
      }
    },
    owns(ticket: Ticket | null) {
      return (
        ticket?.ownerId === ownerId && ticket.launch === state.launch && state.phase !== "stopping"
      );
    },
    routeChanged() {
      state = { ...state, transport: state.transport + 1 };
    },
    observe(status: Pick<Status, "generation" | "phase" | "locked" | "automationReady">) {
      if (state.phase === "stopping") return;
      state = {
        ...state,
        boot: status.generation,
        locked: status.locked,
        authorized: status.automationReady,
        phase:
          status.phase === "blocked"
            ? "blocked"
            : status.locked === true
              ? "locked"
              : status.automationReady === true && status.locked === false
                ? "ready"
                : "authenticating",
      };
      if (state.phase === "ready" || state.phase === "locked") {
        launchDeadline = Infinity;
        problem = null;
        retryAt = 0;
        failures = 0;
      } else {
        this.unavailable();
      }
      if (state.phase === "ready") recoveries = recoveries.filter((at) => now() - at < 60000);
    },
    recover() {
      recoveries = recoveries.filter((at) => now() - at < 60000);
      if (state.phase === "stopping") return false;
      if (recoveries.length >= 3) {
        state = { ...state, phase: "blocked" };
        return false;
      }
      recoveries.push(now());
      state = { ...state, phase: "recovering" };
      return true;
    },
    exit(ticket: Ticket | null) {
      if (!this.owns(ticket)) return false;
      launchDeadline = Infinity;
      state = { ...state, boot: null, locked: null, authorized: null, phase: "stopped" };
      return true;
    },
    stop() {
      state = { ...state, phase: "stopping", launch: state.launch + 1 };
    },
  };
}
