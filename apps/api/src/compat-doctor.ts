/**
 * Reactor-compat admin doctor diagnostic helpers extracted from
 * reactor-compat-routes.ts.
 *
 * Generates the runtime-component health report exposed at
 * /api/admin/doctor (full report, JSON/text/markdown) and
 * /api/admin/doctor/summary (one-line status). Each `doctorSection`
 * inspects whether the corresponding ReactorCompatibilityRouteOptions
 * service is configured and reports OK/SKIPPED/WARN/ERROR.
 */

import type { JsonObject } from "@muse/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  isRecord,
  nowIso,
  stringField,
  toJsonObject,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function adminDiagnostic(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  mode: "report" | "summary"
) {
  if (!options.authorizeAdmin(request, reply)) {
    return reply;
  }

  const report = doctorReport(options);
  const status = doctorOverallStatus(report);
  reply.header("x-doctor-status", status);

  const format = resolveDoctorFormat(request);
  if (mode === "summary") {
    if (format === "text") {
      reply.header("content-type", "text/plain; charset=utf-8");
      return `${doctorSummary(report)} | ${doctorStatusLabel(report)} | ${stringField(report.generatedAt, nowIso())}`;
    }

    if (format === "markdown") {
      reply.header("content-type", "text/markdown; charset=utf-8");
      return `*[${status}]* ${doctorSummary(report)} _(${stringField(report.generatedAt, nowIso())})_`;
    }

    return {
      allHealthy: doctorAllHealthy(report),
      generatedAt: stringField(report.generatedAt, nowIso()),
      status,
      summary: doctorSummary(report)
    };
  }

  if (format === "text") {
    reply.header("content-type", "text/plain; charset=utf-8");
    return doctorHumanReadable(report);
  }

  if (format === "markdown") {
    reply.header("content-type", "text/markdown; charset=utf-8");
    return doctorMarkdown(report);
  }

  return report;
}

function doctorReport(options: ReactorCompatibilityRouteOptions): JsonObject {
  const traceSinkConfigured = Boolean(options.admin?.observability?.traceSink ?? options.admin?.observability?.tracer);

  return {
    generatedAt: nowIso(),
    sections: [
      doctorSection("Runtime Settings", "OK", "활성", [
        doctorCheck("runtimeSettings bean", "OK", "등록됨")
      ]),
      doctorSection(
        "Dynamic Scheduler",
        options.scheduler?.service ? "OK" : "SKIPPED",
        options.scheduler?.service ? "활성" : "비활성",
        [doctorCheck("scheduler service", options.scheduler?.service ? "OK" : "SKIPPED", options.scheduler?.service ? "등록됨" : "등록 안 됨")]
      ),
      doctorSection(
        "Model Provider",
        options.modelProvider ? "OK" : "SKIPPED",
        options.modelProvider ? "활성" : "비활성",
        [
          doctorCheck("model provider", options.modelProvider ? "OK" : "SKIPPED", options.modelProvider ? "등록됨" : "등록 안 됨"),
          doctorCheck(
            "model provider configured",
            options.modelProvider ? "OK" : "SKIPPED",
            options.modelProvider ? "configured" : "not configured"
          )
        ]
      ),
      doctorSection(
        "Database",
        "OK",
        options.historyStore ? "configured" : "in-memory",
        [
          doctorCheck(
            "database configured or in-memory",
            "OK",
            options.historyStore ? "configured" : "in-memory"
          )
        ]
      ),
      doctorSection(
        "Runner",
        "OK",
        "disabled",
        [doctorCheck("runner configured or disabled", "OK", "disabled")]
      ),
      doctorSection(
        "MCP Live Health",
        "OK",
        options.mcp?.manager ? "configured" : "empty",
        [
          doctorCheck("mcp manager", options.mcp?.manager ? "OK" : "SKIPPED", options.mcp?.manager ? "등록됨" : "등록 안 됨"),
          doctorCheck("MCP configured or empty", "OK", options.mcp?.manager ? "configured" : "empty")
        ]
      ),
      doctorSection(
        "Response Cache",
        options.admin?.cache?.responseCache ? "OK" : "SKIPPED",
        options.admin?.cache?.responseCache ? "활성" : "비활성",
        [doctorCheck("response cache", options.admin?.cache?.responseCache ? "OK" : "SKIPPED", options.admin?.cache?.responseCache ? "등록됨" : "등록 안 됨")]
      ),
      doctorSection(
        "Observability Assets",
        traceSinkConfigured ? "OK" : "SKIPPED",
        traceSinkConfigured ? "활성" : "비활성",
        [
          doctorCheck("observability state", options.admin?.observability ? "OK" : "SKIPPED", options.admin?.observability ? "등록됨" : "등록 안 됨"),
          doctorCheck("trace sink configured", traceSinkConfigured ? "OK" : "SKIPPED", traceSinkConfigured ? "configured" : "not configured")
        ]
      )
    ]
  };
}

function doctorSection(
  name: string,
  status: string,
  message: string,
  checks: readonly JsonObject[]
): JsonObject {
  return {
    checks: [...checks],
    message,
    name,
    status
  };
}

function doctorCheck(name: string, status: string, detail: string): JsonObject {
  return {
    detail,
    name,
    status
  };
}

function doctorSections(report: JsonObject): JsonObject[] {
  return Array.isArray(report.sections) ? report.sections.filter(isRecord).map(toJsonObject) : [];
}

function doctorSummary(report: JsonObject): string {
  const sections = doctorSections(report);
  const counts = new Map<string, number>();
  for (const section of sections) {
    const status = stringField(section.status, "OK");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const order = ["OK", "SKIPPED", "WARN", "ERROR"];
  const summary = order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${status} ${counts.get(status) ?? 0}`)
    .join(", ");
  return `${sections.length} 섹션 — ${summary}`;
}

function doctorOverallStatus(report: JsonObject): "ERROR" | "OK" | "WARN" {
  const statuses = doctorSections(report).map((section) => stringField(section.status, "OK"));
  if (statuses.includes("ERROR")) {
    return "ERROR";
  }

  if (statuses.includes("WARN")) {
    return "WARN";
  }

  return "OK";
}

function doctorAllHealthy(report: JsonObject): boolean {
  return doctorSections(report).every((section) => {
    const status = stringField(section.status, "OK");
    return status === "OK" || status === "SKIPPED";
  });
}

function doctorStatusLabel(report: JsonObject): string {
  const status = doctorOverallStatus(report);
  return status === "ERROR" ? "오류 포함" : status === "WARN" ? "경고 포함" : "정상";
}

function resolveDoctorFormat(request: FastifyRequest): "json" | "markdown" | "text" {
  const accept = String(request.headers.accept ?? "").toLowerCase();
  if (accept.includes("text/markdown") || accept.includes("text/x-markdown")) {
    return "markdown";
  }

  if (accept.includes("text/plain")) {
    return "text";
  }

  return "json";
}

function doctorHumanReadable(report: JsonObject): string {
  const lines = [
    "=== Reactor Doctor Report ===",
    `생성 시각: ${stringField(report.generatedAt, nowIso())}`,
    `요약: ${doctorSummary(report)}`,
    `전체 상태: ${doctorStatusLabel(report)}`,
    ""
  ];

  for (const section of doctorSections(report)) {
    lines.push(`[${doctorStatusShortCode(stringField(section.status, "OK"))}] ${stringField(section.name, "")}`);
    lines.push(`     ${stringField(section.message, "")}`);
    const checks = Array.isArray(section.checks) ? section.checks.filter(isRecord).map(toJsonObject) : [];
    for (const check of checks) {
      lines.push(
        `     [${doctorStatusShortCode(stringField(check.status, "OK"))}] ${stringField(check.name, "")}: ${stringField(check.detail, "")}`
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function doctorMarkdown(report: JsonObject): string {
  const lines = ["*Reactor Doctor Report*", `> ${doctorSummary(report)}`, ""];
  for (const section of doctorSections(report)) {
    lines.push(
      "`[" +
        doctorStatusShortCode(stringField(section.status, "OK")) +
        "]` *" +
        stringField(section.name, "") +
        "* — " +
        stringField(section.message, "")
    );
  }

  return lines.join("\n").trimEnd();
}

function doctorStatusShortCode(status: string): string {
  return status === "SKIPPED" ? "SKIP" : status;
}
