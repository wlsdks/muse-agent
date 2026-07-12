import type { ModelTool } from "@muse/model";
import { isRecord, truncateUtf16Safe } from "@muse/shared";

import { ToolRegistryError, type MuseTool, type ToolDescriptionIssue } from "./index.js";

export function toModelTool(tool: MuseTool): ModelTool {
  return {
    description: shortenToolDescription(tool.definition.description),
    inputSchema: tool.definition.inputSchema,
    name: tool.definition.name,
    risk: tool.definition.risk,
    ...(tool.definition.groundedArgs ? { groundedArgs: tool.definition.groundedArgs } : {})
  };
}

export function validateToolDefinitions(tools: readonly MuseTool[]): readonly ToolDescriptionIssue[] {
  const issues: ToolDescriptionIssue[] = [];
  const seen = new Set<string>();
  const names = new Set(tools.map((tool) => tool.definition.name));

  for (const tool of tools) {
    const { definition } = tool;

    if (seen.has(definition.name)) {
      issues.push({
        code: "duplicate_name",
        message: `Duplicate tool name: ${definition.name}`,
        toolName: definition.name
      });
    }
    seen.add(definition.name);

    if (definition.description.trim().length < 12) {
      issues.push({
        code: "missing_description",
        message: `Tool '${definition.name}' needs a concrete user-facing description`,
        toolName: definition.name
      });
    }

    if (!isRecord(definition.inputSchema) || definition.inputSchema.type !== "object") {
      issues.push({
        code: "missing_input_schema",
        message: `Tool '${definition.name}' must expose an object input schema`,
        toolName: definition.name
      });
    } else if (isRecord(definition.inputSchema.properties)) {
      // tool-calling.md rule 3: every parameter the local model fills
      // needs a concrete description, or it guesses the argument.
      for (const [param, schema] of Object.entries(definition.inputSchema.properties)) {
        const description = isRecord(schema) ? schema.description : undefined;
        if (typeof description !== "string" || description.trim().length === 0) {
          issues.push({
            code: "undescribed_parameter",
            message: `Tool '${definition.name}' parameter '${param}' needs a description (an example helps the local model fill it)`,
            toolName: definition.name
          });
        }
      }
    }

    if (!["read", "write", "execute"].includes(definition.risk)) {
      issues.push({
        code: "ambiguous_risk",
        message: `Tool '${definition.name}' has an unsupported risk level`,
        toolName: definition.name
      });
    }

    for (const dependency of definition.dependsOn ?? []) {
      if (!names.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          message: `Tool '${definition.name}' depends on unknown tool '${dependency}'`,
          toolName: definition.name
        });
      }
    }
  }

  return issues;
}

export function planToolExecutionOrder(tools: readonly MuseTool[]): readonly string[] {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: string[] = [];

  for (const tool of tools) {
    visitTool(tool.definition.name, byName, temporary, permanent, ordered);
  }

  return ordered;
}

export function shortenToolDescription(text: string, maxChars = 200): string {
  if (text.trim().length === 0) {
    return text;
  }

  const firstParagraph = text.split(/\n\s*\n/u)[0]?.trim() ?? "";

  if (firstParagraph.length <= maxChars) {
    return firstParagraph;
  }

  return `${truncateUtf16Safe(firstParagraph, Math.max(0, maxChars - 1))}...`;
}

function visitTool(
  name: string,
  byName: ReadonlyMap<string, MuseTool>,
  temporary: Set<string>,
  permanent: Set<string>,
  ordered: string[]
): void {
  if (permanent.has(name)) {
    return;
  }

  if (temporary.has(name)) {
    throw new ToolRegistryError(`Tool dependency cycle detected at: ${name}`);
  }

  const tool = byName.get(name);

  if (!tool) {
    return;
  }

  temporary.add(name);

  for (const dependency of tool.definition.dependsOn ?? []) {
    visitTool(dependency, byName, temporary, permanent, ordered);
  }

  temporary.delete(name);
  permanent.add(name);
  ordered.push(name);
}
