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

/** Signal thrown when a step failed an attempt and has been scheduled for retry. */
export class StepRetryingSignal extends Error {
  constructor(
    public readonly step: string,
    public readonly attempt: number,
    public readonly runAt: Date,
  ) {
    super(`Step "${step}" failed attempt ${attempt}; retry scheduled at ${runAt.toISOString()}`);
    this.name = "StepRetryingSignal";
  }
}

export class StepTimeoutError extends Error {
  constructor(
    public readonly step: string,
    public readonly timeoutMs: number,
  ) {
    super(`Step "${step}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
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

export class FencingError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly workerId: string,
  ) {
    super(
      `Fencing check failed for task ${taskId}: worker ${workerId} is not the current lease owner`,
    );
    this.name = "FencingError";
  }
}

/** Thrown when a workflow pauses waiting for external human approval. */
export class ParkedSignal extends Error {
  constructor(public readonly approvalName: string) {
    super(`Run parked waiting for approval "${approvalName}"`);
    this.name = "ParkedSignal";
  }
}

/** Error thrown or returned when external approval was rejected. */
export class ApprovalRejectedError extends Error {
  constructor(
    public readonly approvalName: string,
    public readonly note?: string,
  ) {
    super(`Approval "${approvalName}" was rejected${note ? `: ${note}` : ""}`);
    this.name = "ApprovalRejectedError";
  }
}
