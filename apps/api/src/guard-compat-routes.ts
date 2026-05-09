/**
 * Reactor-compat input/output guard routes extracted from
 * reactor-compat-routes.ts.
 *
 * Wires:
 *   - GET    /api/admin/input-guard/pipeline
 *   - PUT    /api/admin/input-guard/settings
 *   - PUT    /api/admin/input-guard/pipeline/reorder
 *   - GET/PUT /api/admin/input-guard/stages/:stageName/config
 *   - GET    /api/admin/input-guard/audits
 *   - POST   /api/admin/input-guard/simulate
 *   - GET/POST/PUT/DELETE /api/admin/input-guard/rules (+ /:id)
 *   - GET    /api/output-guard/rules
 *   - GET    /api/output-guard/rules/audits
 *   - POST   /api/output-guard/rules
 *   - POST   /api/output-guard/rules/simulate
 *   - PUT/DELETE /api/output-guard/rules/:id
 */

import type { FastifyInstance } from "fastify";
import {
  createInputGuardRule,
  createOutputGuardRule,
  deleteInputGuardRule,
  deleteOutputGuardRule,
  errorResponse,
  getInputGuardRule,
  getOutputGuardRule,
  inputGuardStages,
  listInputGuardRules,
  listOutputGuardAudits,
  listOutputGuardRules,
  outputGuardRuleDetail,
  outputGuardRuleNotFound,
  readBoolean,
  readQueryInteger,
  readStringArray,
  recordOutputGuardAudit,
  simulateGuard,
  simulateOutputGuardRules,
  stageConfigResponse,
  stringField,
  stringMapField,
  toBody,
  toGuardStageResponse,
  toInputGuardRuleResponse,
  toOutputGuardAuditResponse,
  toOutputGuardRuleResponse,
  updateInputGuardRule,
  updateOutputGuardRule,
  validateInputGuardRule,
  validateOutputGuardRule,
  validateOutputGuardSimulation,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerGuardCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerInputGuardRuleRoutes(server, options);
  registerOutputGuardRuleRoutes(server, options);

  server.get("/api/admin/input-guard/pipeline", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return Promise.all(inputGuardStages.map((stage) => toGuardStageResponse(stage, options)));
  });

  server.put("/api/admin/input-guard/settings", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const settings = stringMapField(toBody(request.body).settings);
    let updated = 0;

    for (const [key, value] of Object.entries(settings)) {
      if (!key.startsWith("guard.")) {
        continue;
      }

      await options.runtimeSettings.set({
        category: "guard",
        key,
        type: "string",
        value
      });
      updated += 1;
    }

    return {
      note: "Some changes require a server restart",
      updated
    };
  });

  server.put("/api/admin/input-guard/pipeline/reorder", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const order = readStringArray(toBody(request.body).order) ?? [];
    const known = new Set(inputGuardStages.map((stage) => stage.name));
    const unknown = order.filter((stageName) => !known.has(stageName));

    if (order.length === 0 || unknown.length > 0) {
      const knownStages = [...known].join(", ");
      return reply.status(400).send(errorResponse(
        unknown.length > 0
          ? `알 수 없는 stage: [${unknown.join(", ")}] (등록된 stage: [${knownStages}])`
          : "요청 형식이 올바르지 않습니다"
      ));
    }

    await Promise.all(order.map((stageName, index) =>
      options.runtimeSettings.set({
        category: "guard",
        key: `guard.stage.${stageName}.order`,
        type: "number",
        value: String(index)
      })
    ));

    return {
      note: "Changed order applies after server restart",
      order
    };
  });

  server.get("/api/admin/input-guard/stages/:stageName/config", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { stageName } = request.params as { readonly stageName: string };
    const stage = inputGuardStages.find((item) => item.name === stageName);

    if (!stage) {
      return reply.status(404).send();
    }

    return stageConfigResponse(stage, options);
  });

  server.put("/api/admin/input-guard/stages/:stageName/config", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { stageName } = request.params as { readonly stageName: string };
    const stage = inputGuardStages.find((item) => item.name === stageName);

    if (!stage) {
      return reply.status(404).send();
    }

    const config = stringMapField(toBody(request.body).config);
    const allowed = new Set(stage.config.map((item) => item.key));
    const unknown = Object.keys(config).filter((key) => !allowed.has(key));

    if (stage.config.length === 0 || Object.keys(config).length === 0 || unknown.length > 0) {
      const allowedKeys = [...allowed].join(", ");
      return reply.status(400).send(errorResponse(
        unknown.length > 0
          ? `알 수 없는 config 키: [${unknown.join(", ")}] (허용: [${allowedKeys}])`
          : `${stageName} 에는 노출된 tunable 파라미터가 없습니다`
      ));
    }

    await Promise.all(Object.entries(config).map(([key, value]) =>
      options.runtimeSettings.set({
        category: "guard",
        key: `guard.stage.${stageName}.${key}`,
        type: "string",
        value
      })
    ));

    const restartRequired = stage.config
      .filter((item) => item.restartRequired && Object.prototype.hasOwnProperty.call(config, item.key))
      .map((item) => item.key);

    return {
      note: restartRequired.length === 0
        ? "Changes apply immediately"
        : `The following keys apply after restart: ${restartRequired.join(", ")}`,
      restartRequired,
      stageName,
      updated: Object.keys(config).length
    };
  });

  server.get("/api/admin/input-guard/audits", async (_request, reply) => {
    if (!options.authorizeAdmin(_request, reply)) {
      return reply;
    }

    return { audits: [], total: 0 };
  });

  server.post("/api/admin/input-guard/simulate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return simulateGuard(request.body, options);
  });
}

function registerInputGuardRuleRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/input-guard/rules", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const rules = (await listInputGuardRules(options)).map(toInputGuardRuleResponse);
    return { rules, total: rules.length };
  });
  server.get("/api/admin/input-guard/rules/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const rule = await getInputGuardRule(options, id);
    return rule ? toInputGuardRuleResponse(rule) : reply.status(404).send();
  });
  server.post("/api/admin/input-guard/rules", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const error = validateInputGuardRule(request.body);
    return error
      ? reply.status(400).send(error)
      : toInputGuardRuleResponse(await createInputGuardRule(options, request.body));
  });
  server.put("/api/admin/input-guard/rules/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = await getInputGuardRule(options, id);

    if (!existing) {
      return reply.status(404).send();
    }

    const error = validateInputGuardRule(request.body);
    return error
      ? reply.status(400).send(error)
      : toInputGuardRuleResponse(await updateInputGuardRule(options, existing, request.body));
  });
  server.delete("/api/admin/input-guard/rules/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const deleted = await deleteInputGuardRule(options, id);
    return deleted ? { deleted: true, id } : reply.status(404).send();
  });
}

function registerOutputGuardRuleRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/output-guard/rules", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return (await listOutputGuardRules(options)).map(toOutputGuardRuleResponse);
  });
  server.get("/api/output-guard/rules/audits", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = readQueryInteger(request, "limit", 100);
    return (await listOutputGuardAudits(options, limit)).map(toOutputGuardAuditResponse);
  });
  server.post("/api/output-guard/rules", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const error = validateOutputGuardRule(request.body);

    if (error) {
      return reply.status(400).send(error);
    }

    const rule = await createOutputGuardRule(options, request.body);
    await recordOutputGuardAudit(options, "CREATE", request, rule.id, outputGuardRuleDetail(rule));
    return reply.status(201).send(toOutputGuardRuleResponse(rule));
  });
  server.post("/api/output-guard/rules/simulate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const error = validateOutputGuardSimulation(request.body);

    if (error) {
      return reply.status(400).send(error);
    }

    const response = await simulateOutputGuardRules(options, request.body);
    await recordOutputGuardAudit(
      options,
      "SIMULATE",
      request,
      undefined,
      `blocked=${response.blocked}, matched=${response.matchedRules.length}, includeDisabled=${readBoolean(toBody(request.body).includeDisabled, false)}`
    );
    return response;
  });
  server.put("/api/output-guard/rules/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = await getOutputGuardRule(options, id);

    if (!existing) {
      return outputGuardRuleNotFound(reply, id);
    }

    const error = validateOutputGuardRule(request.body, true);

    if (error) {
      return reply.status(400).send(error);
    }

    const rule = await updateOutputGuardRule(options, existing, request.body);
    await recordOutputGuardAudit(options, "UPDATE", request, rule.id, outputGuardRuleDetail(rule));
    return toOutputGuardRuleResponse(rule);
  });
  server.delete("/api/output-guard/rules/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = await getOutputGuardRule(options, id);

    if (!existing) {
      return outputGuardRuleNotFound(reply, id);
    }

    await deleteOutputGuardRule(options, existing.id);
    await recordOutputGuardAudit(options, "DELETE", request, existing.id, `name=${stringField(existing.name, "")}`);
    return reply.status(204).send();
  });
}
