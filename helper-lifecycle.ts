// Owner lifetime, helper boot, and route generations are independent. In
// particular, observing a different route never grants automation readiness.
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
  return {
    get state() {
      return { ...state };
    },
    begin() {
      if (state.phase === "stopping") return null;
      state = {
        ...state,
        launch: state.launch + 1,
        phase: "starting",
        locked: null,
        authorized: null,
      };
      return { ownerId, launch: state.launch };
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
      state = { ...state, boot: null, locked: null, authorized: null, phase: "stopped" };
      return true;
    },
    stop() {
      state = { ...state, phase: "stopping", launch: state.launch + 1 };
    },
  };
}
