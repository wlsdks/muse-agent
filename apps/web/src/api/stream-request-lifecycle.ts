export interface StreamRequest {
  readonly controller: AbortController;
  readonly id: number;
}

/**
 * Owns one browser streaming request. Starting is synchronous so it closes the
 * pre-render re-entry window; aborting also invalidates late callbacks from a
 * response body that settles after reset or unmount.
 */
export function createStreamRequestLifecycle() {
  let active: StreamRequest | undefined;
  let nextId = 0;

  return {
    abort(): void {
      active?.controller.abort();
      active = undefined;
    },
    finish(request: StreamRequest): boolean {
      if (active?.id !== request.id) {
        return false;
      }
      active = undefined;
      return true;
    },
    isCurrent(request: StreamRequest): boolean {
      return active?.id === request.id;
    },
    start(): StreamRequest | undefined {
      if (active) {
        return undefined;
      }
      const request = { controller: new AbortController(), id: ++nextId };
      active = request;
      return request;
    }
  };
}
