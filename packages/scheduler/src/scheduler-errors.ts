/**
 * Scheduler error classes. Lifted out of `index.ts` so the helper
 * module can throw `SchedulerValidationError` without a circular
 * import.
 */

export class SchedulerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerValidationError";
  }
}

export class SchedulerExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerExecutionError";
  }
}
