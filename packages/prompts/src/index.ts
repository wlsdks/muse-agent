export type ResponseFormat = "text" | "json" | "yaml";

export interface PromptBuildInput {
  readonly basePrompt?: string;
  readonly responseFormat?: ResponseFormat;
  readonly responseSchema?: string;
  readonly retrievedContext?: string;
  readonly toolResults?: string;
  readonly requesterContext?: string;
  readonly userMemoryContext?: string;
  readonly sessionMemoryContext?: string;
  readonly taskMemoryContext?: string;
  readonly providerStablePrefix?: string;
  readonly providerDynamicSuffix?: string;
  readonly delegatedAgent?: string;
  readonly includeCacheBoundary?: boolean;
}

export interface PromptContextPacket {
  readonly retrievedContext?: string;
  readonly toolResults?: string;
  readonly requesterContext?: string;
  readonly userMemoryContext?: string;
  readonly sessionMemoryContext?: string;
  readonly taskMemoryContext?: string;
  readonly delegatedAgent?: string;
}

export interface CacheBoundarySplit {
  readonly stablePrefix: string;
  readonly dynamicSuffix: string;
}

export const MUSE_CACHE_BOUNDARY_MARKER = "<!-- MUSE_CACHE_BOUNDARY -->";
export const DEFAULT_BASE_PROMPT =
  "You are Muse, a model-agnostic agent runtime. Be accurate, concise, and explicit about uncertainty.";

export function buildSystemPrompt(input: PromptBuildInput = {}): string {
  const stableSections = compactSections([
    input.providerStablePrefix,
    input.basePrompt ?? DEFAULT_BASE_PROMPT,
    renderResponseFormatInstruction(input.responseFormat, input.responseSchema)
  ]);
  const dynamicSections = compactSections([
    renderDelegatedAgent(input.delegatedAgent),
    input.requesterContext,
    renderMemoryContext("User Memory", input.userMemoryContext),
    renderMemoryContext("Session Memory", input.sessionMemoryContext),
    renderMemoryContext("Task Memory", input.taskMemoryContext),
    renderRetrievedContext(input.retrievedContext),
    renderToolResults(input.toolResults),
    input.providerDynamicSuffix
  ]);

  if (input.includeCacheBoundary) {
    return compactSections([
      stableSections.join("\n\n"),
      MUSE_CACHE_BOUNDARY_MARKER,
      dynamicSections.join("\n\n")
    ]).join("\n\n");
  }

  return compactSections([...stableSections, ...dynamicSections]).join("\n\n");
}

export function renderResponseFormatInstruction(
  responseFormat: ResponseFormat | undefined,
  responseSchema?: string
): string | undefined {
  if (responseFormat === "json") {
    return renderJsonInstruction(responseSchema);
  }

  if (responseFormat === "yaml") {
    return renderYamlInstruction(responseSchema);
  }

  return undefined;
}

export function renderJsonInstruction(responseSchema?: string): string {
  return compactLines([
    "[Response Format]",
    "Respond with valid JSON only.",
    "- Do not wrap the response in markdown code fences.",
    "- Do not include text before or after the JSON value.",
    "- The response must start with '{' or '[' and end with '}' or ']'.",
    responseSchema ? `Expected JSON schema:\n${responseSchema}` : undefined
  ]).join("\n");
}

export function renderYamlInstruction(responseSchema?: string): string {
  return compactLines([
    "[Response Format]",
    "Respond with valid YAML only.",
    "- Do not wrap the response in markdown code fences.",
    "- Do not include text before or after the YAML document.",
    "- Use 2 spaces for indentation.",
    responseSchema ? `Expected YAML structure:\n${responseSchema}` : undefined
  ]).join("\n");
}

export function renderRetrievedContext(retrievedContext?: string): string | undefined {
  const context = cleanBlock(retrievedContext);

  if (!context) {
    return undefined;
  }

  return compactLines([
    "[Retrieved Context]",
    "The following information was retrieved from a knowledge source and may be relevant.",
    "Use it when it directly supports the answer.",
    "If it does not contain the answer, say that the available sources do not answer it.",
    "Do not fill private workspace gaps with general knowledge.",
    "",
    context
  ]).join("\n");
}

export function renderToolResults(toolResults?: string): string | undefined {
  const context = cleanBlock(toolResults);

  if (!context) {
    return undefined;
  }

  return compactLines([
    "[Tool Results]",
    "The following information came from executed tools, not from retrieved documents.",
    "Use tool results as the primary source for current runtime facts.",
    "If tool results and retrieved context conflict, prefer the newer or more authoritative source.",
    "",
    context
  ]).join("\n");
}

export function mergePromptContext(primary?: string, secondary?: string): string | undefined {
  const parts = compactSections([primary, secondary]);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

export function splitPromptCacheBoundary(prompt: string): CacheBoundarySplit | undefined {
  const index = prompt.indexOf(MUSE_CACHE_BOUNDARY_MARKER);

  if (index < 0) {
    return undefined;
  }

  return {
    dynamicSuffix: prompt.slice(index + MUSE_CACHE_BOUNDARY_MARKER.length).trimStart(),
    stablePrefix: prompt.slice(0, index).trimEnd()
  };
}

export function stripPromptCacheBoundary(prompt: string): string {
  return prompt
    .replace(`\n${MUSE_CACHE_BOUNDARY_MARKER}\n`, "\n")
    .replace(MUSE_CACHE_BOUNDARY_MARKER, "");
}

export function buildPromptContextPacket(input: PromptBuildInput): PromptContextPacket {
  return {
    delegatedAgent: cleanBlock(input.delegatedAgent),
    requesterContext: cleanBlock(input.requesterContext),
    retrievedContext: cleanBlock(input.retrievedContext),
    sessionMemoryContext: cleanBlock(input.sessionMemoryContext),
    taskMemoryContext: cleanBlock(input.taskMemoryContext),
    toolResults: cleanBlock(input.toolResults),
    userMemoryContext: cleanBlock(input.userMemoryContext)
  };
}

function renderDelegatedAgent(delegatedAgent?: string): string | undefined {
  const value = cleanBlock(delegatedAgent);
  return value ? `[Delegated Agent]\n${value}` : undefined;
}

function renderMemoryContext(title: string, context?: string): string | undefined {
  const value = cleanBlock(context);
  return value ? `[${title}]\n${value}` : undefined;
}

function cleanBlock(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function compactSections(sections: readonly (string | undefined)[]): readonly string[] {
  return sections.map(cleanBlock).filter((section): section is string => section !== undefined);
}

function compactLines(lines: readonly (string | undefined)[]): readonly string[] {
  return lines.filter((line): line is string => line !== undefined);
}
