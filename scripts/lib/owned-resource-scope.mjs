const exactOwnershipReceipts = new WeakSet();
const cleanupFailuresByPrimaryError = new WeakMap();

const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_CLEANUP_TIMEOUT_MS = 2_000;

export class OwnedResourceCleanupTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Owned-resource cleanup exceeded ${timeoutMs.toString()}ms`);
    this.name = "OwnedResourceCleanupTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class OwnedResourceForceRefusedError extends Error {
  constructor(label) {
    super(`Forced cleanup refused for '${label}': no exact ownership receipt`);
    this.name = "OwnedResourceForceRefusedError";
    this.label = label;
  }
}

/**
 * Brand concrete process/resource identity after it has been observed.
 * A caller cannot turn a path, process name, or other inference into a receipt:
 * the exact kind, stable id, and acquisition-time identity are all required.
 */
export function createExactOwnershipReceipt({ acquiredAt, id, kind }) {
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new TypeError("ownership kind must be a non-empty string");
  }
  if ((typeof id !== "string" && typeof id !== "number") || String(id).trim().length === 0) {
    throw new TypeError("ownership id must be a non-empty string or number");
  }
  if (typeof acquiredAt !== "string" || acquiredAt.trim().length === 0) {
    throw new TypeError("ownership acquiredAt must be a non-empty string");
  }
  const receipt = Object.freeze({ acquiredAt, id, kind });
  exactOwnershipReceipts.add(receipt);
  return receipt;
}

export function isExactOwnershipReceipt(value) {
  return typeof value === "object" && value !== null && exactOwnershipReceipts.has(value);
}

/**
 * Return cleanup failures associated with an authoritative primary error.
 * The primary error itself is rethrown unchanged, including when it is frozen.
 */
export function ownedResourceCleanupFailures(error) {
  return typeof error === "object" && error !== null
    ? cleanupFailuresByPrimaryError.get(error) ?? []
    : [];
}

/**
 * Own resources acquired by a smoke/qualification run.
 *
 * `acquire()` registers its cleanup slot before invoking the asynchronous
 * acquisition callback. `close()` is idempotent, runs graceful cleanup in
 * reverse acquisition order, and has a bounded forced-cleanup phase. Forced
 * cleanup is never called without a branded exact ownership receipt.
 */
export class OwnedResourceScope {
  #cleanupTimeoutMs;
  #closePromise;
  #closing = false;
  #entries = [];
  #forceCleanupTimeoutMs;

  constructor({
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    forceCleanupTimeoutMs = DEFAULT_FORCE_CLEANUP_TIMEOUT_MS
  } = {}) {
    requirePositiveTimeout(cleanupTimeoutMs, "cleanupTimeoutMs");
    requirePositiveTimeout(forceCleanupTimeoutMs, "forceCleanupTimeoutMs");
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
    this.#forceCleanupTimeoutMs = forceCleanupTimeoutMs;
  }

  async acquire({ acquire, forceRelease, label, release }) {
    if (this.#closing) {
      throw new Error("Cannot acquire a resource after owned-resource cleanup has started");
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new TypeError("resource label must be a non-empty string");
    }
    if (typeof acquire !== "function" || typeof release !== "function") {
      throw new TypeError("resource acquire and release must be functions");
    }
    if (forceRelease !== undefined && typeof forceRelease !== "function") {
      throw new TypeError("resource forceRelease must be a function when provided");
    }

    const entry = {
      acquired: false,
      acquisition: undefined,
      forceRelease,
      forceStarted: false,
      label,
      lateForceScheduled: false,
      ownership: undefined,
      acquisitionFailed: false,
      release,
      releasePromise: undefined,
      released: false,
      value: undefined
    };
    this.#entries.push(entry);

    entry.acquisition = Promise.resolve()
      .then(acquire)
      .then((acquired) => {
        entry.acquired = true;
        if (
          typeof acquired === "object" &&
          acquired !== null &&
          Object.hasOwn(acquired, "value")
        ) {
          entry.value = acquired.value;
          entry.ownership = acquired.ownership;
        } else {
          entry.value = acquired;
        }
        return entry.value;
      }, (error) => {
        entry.acquisitionFailed = true;
        throw error;
      });

    const value = await entry.acquisition;
    if (this.#closing) {
      await this.#release(entry);
    }
    return value;
  }

  close({ primaryError } = {}) {
    this.#closing = true;
    this.#closePromise ??= this.#close(primaryError);
    return this.#closePromise;
  }

  async #close(primaryError) {
    const cleanupErrors = [];
    // Start every cleanup in reverse ownership order, but do not let one
    // pending acquisition prevent an older, already-owned resource from
    // releasing. Each release still waits for its own acquisition.
    const gracefulCleanup = Promise.allSettled(
      this.#entries.toReversed().map((entry) => this.#release(entry))
    ).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    });

    try {
      await withDeadline(
        gracefulCleanup,
        this.#cleanupTimeoutMs,
        () => new OwnedResourceCleanupTimeoutError(this.#cleanupTimeoutMs)
      );
    } catch (error) {
      cleanupErrors.push(error);
      await this.#forcePending(cleanupErrors);
    }

    if (primaryError !== undefined) {
      if (typeof primaryError === "object" && primaryError !== null && cleanupErrors.length > 0) {
        cleanupFailuresByPrimaryError.set(primaryError, Object.freeze([...cleanupErrors]));
      }
      throw primaryError;
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Owned-resource cleanup failed");
    }
  }

  #release(entry) {
    entry.releasePromise ??= entry.acquisition.then(
      async (value) => {
        await entry.release(value);
        entry.released = true;
      },
      (error) => {
        if (!entry.acquisitionFailed) throw error;
      }
    );
    return entry.releasePromise;
  }

  async #forcePending(cleanupErrors) {
    const pending = this.#entries.toReversed().filter((entry) => !entry.released);
    const operations = pending.map(async (entry) => {
      if (entry.forceStarted || entry.forceRelease === undefined) return;
      if (!entry.acquired) {
        cleanupErrors.push(new OwnedResourceForceRefusedError(entry.label));
        this.#scheduleLateForce(entry);
        return;
      }
      if (!isExactOwnershipReceipt(entry.ownership)) {
        entry.forceStarted = true;
        cleanupErrors.push(new OwnedResourceForceRefusedError(entry.label));
        return;
      }
      entry.forceStarted = true;
      try {
        await entry.forceRelease(entry.value, entry.ownership);
      } catch (error) {
        cleanupErrors.push(error);
      }
    });

    try {
      await withDeadline(
        Promise.all(operations),
        this.#forceCleanupTimeoutMs,
        () => new OwnedResourceCleanupTimeoutError(this.#forceCleanupTimeoutMs)
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  #scheduleLateForce(entry) {
    if (entry.lateForceScheduled || entry.forceRelease === undefined) return;
    entry.lateForceScheduled = true;
    void entry.acquisition.then(async () => {
      if (entry.released || entry.forceStarted) return;
      try {
        await withDeadline(
          entry.releasePromise,
          this.#forceCleanupTimeoutMs,
          () => new OwnedResourceCleanupTimeoutError(this.#forceCleanupTimeoutMs)
        );
        return;
      } catch {
        // The main close already reported its timeout. This fallback is solely
        // about safely reclaiming a resource that became owned afterwards.
      }
      if (!isExactOwnershipReceipt(entry.ownership)) return;
      entry.forceStarted = true;
      try {
        await withDeadline(
          Promise.resolve(entry.forceRelease(entry.value, entry.ownership)),
          this.#forceCleanupTimeoutMs,
          () => new OwnedResourceCleanupTimeoutError(this.#forceCleanupTimeoutMs)
        );
      } catch {
        // No unhandled rejection: the authoritative close already failed.
      }
    }, () => {});
  }
}

function requirePositiveTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function withDeadline(operation, timeoutMs, errorFactory) {
  let deadline;
  const timeout = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(errorFactory()), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(deadline));
}
