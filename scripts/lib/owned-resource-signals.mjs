const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143
});

/**
 * Install exactly-once signal cleanup. A second signal cannot bypass the
 * in-flight owned-resource close or cause a second exit call.
 */
export function installOwnedResourceSignalHandlers({
  close,
  exit = (code) => process.exit(code),
  onCleanupError = () => {},
  signalSource = process
}) {
  if (typeof close !== "function" || typeof exit !== "function") {
    throw new TypeError("signal cleanup close and exit must be functions");
  }
  let shutdownPromise;
  const handlers = new Map();

  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    const handler = () => {
      shutdownPromise ??= Promise.resolve()
        .then(close)
        .then(
          () => exit(exitCode),
          (error) => {
            onCleanupError(error);
            exit(1);
          }
        );
    };
    handlers.set(signal, handler);
    // Keep the listener installed throughout cleanup. EventEmitter.once()
    // removes it before invoking the first handler, so a repeated identical
    // signal would fall back to Node's default immediate termination.
    signalSource.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      signalSource.removeListener(signal, handler);
    }
  };
}
