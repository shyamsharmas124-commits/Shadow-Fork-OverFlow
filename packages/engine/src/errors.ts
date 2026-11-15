export class NonDeterminismError extends Error {
  constructor(
    public readonly seq: number,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Non-determinism at event ${seq}: history has ${expected} but code requested ${actual}`);
    this.name = "NonDeterminismError";
  }
}

/** Thrown by a step to simulate a process crash: the engine records nothing and rethrows. */
export class CrashSignal extends Error {
  constructor(msg = "simulated crash") {
    super(msg);
    this.name = "CrashSignal";
  }
}

export class StepFailedError extends Error {
  constructor(
    public readonly step: string,
    message: string,
  ) {
    super(`Step "${step}" failed: ${message}`);
    this.name = "StepFailedError";
  }
}

export class EventConflictError extends Error {
  constructor(runId: string) {
    super(`Concurrent append to run ${runId}`);
    this.name = "EventConflictError";
  }
}
