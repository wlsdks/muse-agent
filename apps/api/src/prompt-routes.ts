/**
 * The S3 user-manageable prompt surface (docs/strategy/prompt-architecture.md
 * §S3): a persona editor, a read-only composed-prompt preview, and a local
 * A/B experiment runner over `~/.config/muse/PERSONA.md`.
 *
 * `GET`/`PUT /api/prompt/persona` both work over the raw markdown file text
 * (frontmatter fence + body) — the web's `prompt-lab-logic.ts` renders that
 * from separate register/maxWords/language form fields client-side, so the
 * wire contract stays the single canonical `parsePersonaMarkdown`/
 * `renderPersonaMarkdown` shape (`@muse/recall`'s `user-persona.ts`) and
 * `GET /api/prompt/persona` never exposes `identity-core` as editable — only
 * the user's own personality file.
 *
 * A successful `PUT` both persists the (scanned) body to disk AND
 * hot-applies it to the SAME `InMemoryPromptLayerRegistry` instance the
 * running `agentRuntime` resolves its L1 layer from
 * (`createMuseRuntimeAssembly`), so the very next chat turn picks it up —
 * no restart.
 */

import type { ModelProvider } from "@muse/model";
import {
  composeSurfacePrompt,
  MUSE_CACHE_BOUNDARY_MARKER,
  MUSE_IDENTITY_CORE,
  SURFACE_ROLES,
  type InMemoryPromptLayerRegistry,
  type MuseSurface,
  type PromptLayer
} from "@muse/prompts";
import {
  loadUserPersona,
  parsePersonaContent,
  renderPersonaMarkdown,
  resolvePersonaFilePath,
  writePersonaFile
} from "@muse/recall";
import type { FastifyInstance } from "fastify";

import { readBodyString, readQueryString } from "./compat-parsers.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server-options.js";

export interface PromptRoutesOptions {
  readonly authService: ServerOptions["authService"];
  /** Override the PERSONA.md path (tests). Defaults to `resolvePersonaFilePath()`. */
  readonly personaFilePath?: string;
  /** The SAME registry instance the assembled agentRuntime reads its L1 layer from. */
  readonly promptLayerRegistry?: InMemoryPromptLayerRegistry;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
}

const PERSONALITY_LAYER_ID = "personality";
const SURFACES = Object.keys(SURFACE_ROLES);

function isMuseSurface(value: unknown): value is MuseSurface {
  return typeof value === "string" && SURFACES.includes(value);
}

function findPersonalityLayer(registry: InMemoryPromptLayerRegistry | undefined): PromptLayer | undefined {
  return registry?.resolve({}).find((layer) => layer.id === PERSONALITY_LAYER_ID);
}

/** A registered layer with only whitespace content renders to nothing — treat it as "no override". */
function hasContent(layer: PromptLayer | undefined): layer is PromptLayer {
  return Boolean(layer) && layer!.content.trim().length > 0;
}

function applyPersonaToRegistry(registry: InMemoryPromptLayerRegistry | undefined, layer: PromptLayer): void {
  if (!registry) return;
  if (hasContent(layer)) {
    registry.register(layer);
  } else {
    registry.unregister(PERSONALITY_LAYER_ID);
  }
}

interface PreviewLayer {
  readonly layer: string;
  readonly text: string;
  readonly section: "stable" | "dynamic";
  readonly readOnly?: boolean;
}

/**
 * The layer-colored breakdown the web's Prompt Lab preview renders
 * (`prompt-lab-logic.ts`'s `layerLabelKey` matches on these exact ids:
 * `identity-core`, `personality`, and a `surface-role` prefix). Same order
 * `composeSurfacePrompt` assembles; `boundary`/`dynamic-placeholder` are
 * included for transparency even though a preview has no live turn to
 * fill the dynamic section with.
 */
function buildPreviewLayers(surface: MuseSurface, personality: PromptLayer | undefined): readonly PreviewLayer[] {
  return [
    { layer: "identity-core", readOnly: true, section: "stable", text: MUSE_IDENTITY_CORE },
    ...(hasContent(personality) ? [{ layer: PERSONALITY_LAYER_ID, section: "stable", text: personality.content }] : []),
    { layer: `surface-role:${surface}`, readOnly: true, section: "stable", text: SURFACE_ROLES[surface] },
    { layer: "boundary", readOnly: true, section: "dynamic", text: MUSE_CACHE_BOUNDARY_MARKER },
    {
      layer: "dynamic-placeholder",
      readOnly: true,
      section: "dynamic",
      text: "(this surface's live turn adds retrieved notes / tool results / memory here)"
    }
  ];
}

export function registerPromptRoutes(server: FastifyInstance, options: PromptRoutesOptions): void {
  const personaFile = options.personaFilePath ?? resolvePersonaFilePath();

  server.get("/api/prompt/persona", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) return reply;

    const result = await loadUserPersona(personaFile);
    if (!result.exists) {
      return reply.status(200).send({ defaultInEffect: true, frontmatter: {}, raw: "" });
    }
    if (!result.ok) {
      return reply.status(200).send({ defaultInEffect: true, frontmatter: {}, parseError: result.reason, raw: "" });
    }

    return reply.status(200).send({
      defaultInEffect: false,
      frontmatter: result.frontmatter,
      raw: renderPersonaMarkdown(result.frontmatter, result.body)
    });
  });

  server.put("/api/prompt/persona", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) return reply;

    const raw = readBodyString(request.body, "raw");
    if (raw === undefined) {
      return reply.status(400).send({ message: "raw must be a string" });
    }

    const parsed = parsePersonaContent(raw);
    if (!parsed.ok) {
      return reply.status(400).send({ message: parsed.reason });
    }

    await writePersonaFile(personaFile, parsed.frontmatter, parsed.body);
    applyPersonaToRegistry(options.promptLayerRegistry, parsed.layer);

    return reply.status(200).send({
      frontmatter: parsed.frontmatter,
      raw: renderPersonaMarkdown(parsed.frontmatter, parsed.body),
      sanitized: parsed.sanitized
    });
  });

  server.get("/api/prompt/preview", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) return reply;

    const surfaceQuery = readQueryString(request, "surface");
    if (surfaceQuery !== undefined && !isMuseSurface(surfaceQuery)) {
      return reply.status(400).send({ message: `surface must be one of: ${SURFACES.join(", ")}` });
    }
    const surface: MuseSurface = isMuseSurface(surfaceQuery) ? surfaceQuery : "chat";

    const personality = findPersonalityLayer(options.promptLayerRegistry);
    const layers = hasContent(personality) ? [personality] : [];

    return reply.status(200).send({
      layers: buildPreviewLayers(surface, personality),
      prompt: composeSurfacePrompt(surface, {}, { layers }),
      surface
    });
  });

  server.post("/api/prompt/experiment", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) return reply;

    const { modelProvider, defaultModel } = options;
    if (!modelProvider || !defaultModel) {
      return reply.status(503).send({
        message: "local model not configured — start Ollama / set MUSE_DEFAULT_MODEL"
      });
    }

    const question = readBodyString(request.body, "question");
    if (question === undefined) {
      return reply.status(400).send({ message: "question must be a non-empty string" });
    }
    const draftPersonaRaw = readBodyString(request.body, "draftPersonaRaw");
    if (draftPersonaRaw === undefined) {
      return reply.status(400).send({ message: "draftPersonaRaw must be a string" });
    }

    // Scanned before use, per the persona contract — this endpoint never
    // persists the draft; it is a disposable A/B probe.
    const draft = parsePersonaContent(draftPersonaRaw);
    if (!draft.ok) {
      return reply.status(400).send({ message: draft.reason });
    }

    const currentPersonality = findPersonalityLayer(options.promptLayerRegistry);
    const currentLayers = hasContent(currentPersonality) ? [currentPersonality] : [];
    const draftLayers = hasContent(draft.layer) ? [draft.layer] : [];

    const currentPrompt = composeSurfacePrompt("chat", {}, { layers: currentLayers });
    const draftPrompt = composeSurfacePrompt("chat", {}, { layers: draftLayers });

    const [currentResponse, draftResponse] = await Promise.all([
      modelProvider.generate({
        messages: [
          { content: currentPrompt, role: "system" },
          { content: question, role: "user" }
        ],
        model: defaultModel
      }),
      modelProvider.generate({
        messages: [
          { content: draftPrompt, role: "system" },
          { content: question, role: "user" }
        ],
        model: defaultModel
      })
    ]);

    return reply.status(200).send({
      current: { answer: currentResponse.output },
      draft: { answer: draftResponse.output }
    });
  });
}
