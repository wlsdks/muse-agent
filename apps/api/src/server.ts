import Fastify, { type FastifyInstance } from "fastify";

export interface ServerOptions {
  readonly logger?: boolean;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({
    logger: options.logger ?? true
  });

  server.get("/health", async () => ({
    service: "muse-api",
    status: "ok"
  }));

  server.get("/spec", async () => ({
    agentCore: "model-agnostic",
    database: "postgresql",
    runner: "rust",
    server: "fastify"
  }));

  return server;
}
