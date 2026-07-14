import { setTimeout as sleepWithTimer } from "node:timers/promises";

export function sleep(milliseconds: number): Promise<void> {
  return sleepWithTimer(milliseconds);
}

export function neverResolve(): Promise<never> {
  return new Promise<never>(() => {});
}
