import type { FastifyReply, FastifyRequest } from "fastify";

export interface HttpRequestAbortScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Abort an effect only when the client connection ends prematurely.
 *
 * Node's IncomingMessage `close` also fires for an ordinary completed
 * request, so request-close must be guarded by `raw.aborted`. Likewise a
 * ServerResponse `close` is cancellation only while `writableEnded` is false.
 * The caller owns the short lifetime and must dispose in `finally`.
 */
export function createHttpRequestAbortScope(
  request: FastifyRequest,
  reply: FastifyReply
): HttpRequestAbortScope {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const onRequestClose = (): void => {
    if (request.raw.aborted) abort();
  };
  const onReplyClose = (): void => {
    if (!reply.raw.writableEnded) abort();
  };

  request.raw.on("aborted", abort);
  request.raw.on("close", onRequestClose);
  reply.raw.on("close", onReplyClose);
  if (request.raw.aborted) abort();

  return {
    dispose() {
      request.raw.off("aborted", abort);
      request.raw.off("close", onRequestClose);
      reply.raw.off("close", onReplyClose);
    },
    signal: controller.signal
  };
}
