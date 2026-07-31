/**
 * Loopback MCP tool wiring — extracted from
 * `createMuseRuntimeAssembly` so the main assembly file no longer
 * carries 95 LOC of nearly-identical `createXxxMcpServer + wrap`
 * blocks. Each personal store / registry that exposes an MCP
 * loopback surface gets a small builder here; the assembly
 * destructures the bundle and hands the tool arrays to the
 * `DynamicToolRegistry`.
 *
 * Pure refactor — every existing env flag, gate, and option
 * spread is preserved line-for-line. The `contextReference`
 * loopback stays inline in the assembly because it's `let`-mutated
 * later (assigned after `activeContextProvider` is built).
 */

import {
  buildExperienceLearningProposalPreview,
  buildExperienceLearningReplayBundle,
  buildExperienceLearningReviewQueue,
  createExperienceLearningApprovalReceipt,
  createLocalExactArtifactResolver,
  fingerprintContinuityPolicy,
  projectExperienceLearningDegradationFromState,
  promoteApprovedExperienceLearningContinuityPolicy,
  rollbackExperienceLearningContinuityPolicyByHandleId,
  proposeExperienceLearningFromDelivery,
  readAttunementState,
  readPreparedContinuityPack,
  retryContinuityTaskCompletionInteractions,
  verifyExperienceLearningPromotionHandleBinding,
  type ExperienceLearningPromotionHandle,
  type ExperienceLearningPromotionReceipt,
  type ExperienceLearningProposalDraft,
  type ExperienceLearningRollbackProposal
} from "@muse/attunement";
import {
  createLocalAttunementSnapshotProvider,
  openProductionAuthorizedContinuityPack,
  prepareProductionAuthorizedContinuityTaskCompletionInteraction,
  recordProductionAuthorizedContinuityOutcome
} from "@muse/attunement/host";
import {
  createContinuityResumeRuntimeCaptureAdapter,
  createContinuityResumeRuntimeCoordinator,
  getContinuityResumeRuntimePack,
  type ContinuityResumeRuntimeBaselineStore
} from "@muse/attunegraph/continuity-resume-runtime";
import type {
  ContinuityObservationReceipt
} from "@muse/attunegraph/continuity-observations";
import {
  compileAttuneGraphPolicyCard
} from "@muse/attunegraph/policy-card";
import { createLoopbackMcpMuseTools } from "@muse/mcp";
import { createCalendarMcpServer, createEpisodesMcpServer, createFollowupsMcpServer, createHistoryMcpServer, createMathMcpServer, createMessagingMcpServer, createNotesMcpServer, createNotesRegistryMcpServer, createPatternsMcpServer, createProactiveMcpServer, createRemindersMcpServer, createStatusMcpServer, createTasksMcpServer, createTasksRegistryMcpServer, createSearchMcpServer, createWebReadMcpServer, type MessageApprovalGate } from "@muse/domain-tools";
import { mirrorNoteToApple, mirrorReminderToApple } from "@muse/macos";
import type { NotesProviderRegistry, TasksProviderRegistry } from "@muse/domain-tools";
import type { CalendarProviderRegistry } from "@muse/calendar";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { MuseTool } from "@muse/tools";
import { isInteractiveWebEgressAllowed } from "@muse/model";
import type { ModelProvider } from "@muse/model";

import { parseBoolean, parseInteger } from "./env-parsers.js";
import {
  createContinuityPackOpenTool,
  createContinuityPackPreviewTool,
  type ContinuityPackOpenToolDeps,
  type ContinuityPackPreviewToolDeps
} from "./continuity-pack-tools.js";
import {
  createContinuityCapsulePreparationService,
  type ContinuityCapsulePreparationService
} from "./continuity-capsule-preparation-service.js";
import {
  createContinuityCapsulePrepareTool
} from "./continuity-capsule-prepare-tool.js";
import { createContinuityOutcomeTool } from "./continuity-outcome-tool.js";
import { createContinuityLearningOpportunityTool } from "./continuity-learning-opportunity-tool.js";
import { createContinuityLearningPreviewTool } from "./continuity-learning-preview-tool.js";
import { createContinuityLearningReplayPreviewTool } from "./continuity-learning-replay-preview-tool.js";
import { createContinuityLearningPolicyCardTool } from "./continuity-learning-policy-card-tool.js";
import { createContinuityLearningApplyTool } from "./continuity-learning-apply-tool.js";
import {
  createContinuityLearningDegradationTool
} from "./continuity-learning-degradation-tool.js";
import { createContinuityLearningRollbackTool } from "./continuity-learning-rollback-tool.js";
import { createQualificationLearningWriteGate } from "./qualification-learning-active-skill-write-gate.js";
import { resolveWeaknessesFile } from "./provider-paths.js";
import type { MuseEnvironment } from "./index.js";

import { continuityRuntimeSourceId } from "./continuity-attunegraph-composition.js";

export interface LoopbackToolsDeps {
  readonly attunementFile?: string;
  readonly continuityResumeBaselineStore?:
    ContinuityResumeRuntimeBaselineStore;
  readonly env: MuseEnvironment;
  readonly experienceLearningPromotionObserver?: (
    receipt: ExperienceLearningPromotionReceipt,
    handle: ExperienceLearningPromotionHandle
  ) => void;
  readonly experienceLearningRollbackProposalObserver?: (
    proposal: ExperienceLearningRollbackProposal
  ) => void;
  readonly projectCurrentGraphObservation?: (
    observation: ContinuityObservationReceipt
  ) => Promise<Readonly<{ readonly status: "projected" | "replayed" }>>;
  /** Optional LLM provider for `mode: "llm-judge"` paths on notes / episodes search. */
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  // File paths the assembly already resolved.
  readonly notesDir: string;
  readonly tasksFile: string;
  readonly remindersFile: string;
  readonly reminderHistoryFile: string;
  readonly proactiveHistoryFile: string;
  readonly followupsFile: string;
  readonly episodesFile: string;
  readonly patternsFiredFile: string;
  // Registries the assembly already constructed.
  readonly notesRegistry: NotesProviderRegistry | undefined;
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly tasksRegistry: TasksProviderRegistry | undefined;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly pollAll: (() => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>) | undefined;
  readonly pollNow: ((providerId: string, source?: string) => Promise<{ ingested: number }>) | undefined;
  // Outbound-safety: lets `muse.messaging.send` action-log every send.
  readonly actionLogFile: string;
  readonly userId: string;
  /**
   * Draft-first approval gate for the agent's `muse.messaging.send`. When the
   * CLI runs interactively it passes a clack-confirm gate (show the exact draft,
   * fire only on confirm). Absent (server/daemon, non-interactive) → the send
   * tool fail-closes (it never auto-sends — outbound-safety).
   */
  readonly messagingApprovalGate?: MessageApprovalGate;
}

export interface LoopbackToolsBundle {
  readonly notes: readonly MuseTool[];
  readonly continuity: readonly MuseTool[];
  readonly notesRegistry: readonly MuseTool[];
  readonly calendar: readonly MuseTool[];
  readonly tasks: readonly MuseTool[];
  readonly tasksRegistry: readonly MuseTool[];
  readonly messaging: readonly MuseTool[];
  readonly reminders: readonly MuseTool[];
  readonly proactive: readonly MuseTool[];
  readonly followups: readonly MuseTool[];
  readonly episodes: readonly MuseTool[];
  readonly patterns: readonly MuseTool[];
  readonly history: readonly MuseTool[];
  readonly status: readonly MuseTool[];
  readonly webRead: readonly MuseTool[];
  readonly math: readonly MuseTool[];
  readonly search: readonly MuseTool[];
  readonly continuityCapsulePreparation?:
    ContinuityCapsulePreparationService;
}

export function buildLoopbackTools(deps: LoopbackToolsDeps): LoopbackToolsBundle {
  const { env } = deps;
  // Trusted interactive-web posture. Local-only dominates a permissive
  // MUSE_WEB_EGRESS value before these tools can reach model projection.
  const webEgress = isInteractiveWebEgressAllowed(env);
  const llmJudge = deps.modelProvider && deps.defaultModel
    ? { model: deps.defaultModel, modelProvider: deps.modelProvider }
    : {};

  const notes = parseBoolean(env.MUSE_NOTES_ENABLED, true)
    ? createLoopbackMcpMuseTools(createNotesMcpServer({
        notesDir: deps.notesDir,
        // LLM-judge search mode opts in only when modelProvider +
        // defaultModel are wired (same gate as episodes). Substring
        // mode keeps working without a model.
        ...llmJudge,
        // Opt-in one-way create-only mirror into Apple Notes.app (visible across
        // the Apple ecosystem). Injected ONLY when MUSE_APPLE_NOTES_MIRROR is on,
        // so an off/absent switch never reaches osascript. Self-gates on env too
        // (defence in depth).
        ...(parseBoolean(env.MUSE_APPLE_NOTES_MIRROR, false)
          ? { mirror: (note) => mirrorNoteToApple(note, { env }) }
          : {})
      }))
    : [];
  let continuityCapsulePreparation:
    ContinuityCapsulePreparationService | undefined;
  const continuity: readonly MuseTool[] = deps.attunementFile
    ? (() => {
        const resolveExactArtifact = createLocalExactArtifactResolver({
          notesDir: deps.notesDir,
          remindersFile: deps.remindersFile,
          tasksFile: deps.tasksFile
        });
        const snapshotProvider = createLocalAttunementSnapshotProvider({
          attunementFile: deps.attunementFile!,
          sourceId: continuityRuntimeSourceId
        });
        const resumeCoordinator =
          createContinuityResumeRuntimeCoordinator({
            ...(deps.continuityResumeBaselineStore === undefined
              ? {}
              : { baselineStore: deps.continuityResumeBaselineStore }),
            captureCurrent:
              createContinuityResumeRuntimeCaptureAdapter({
                captureHeadRevalidation:
                  snapshotProvider.captureHeadRevalidation,
                resolveExactArtifact
              }),
            ...(deps.projectCurrentGraphObservation === undefined
              ? {}
              : {
                  projectCurrentGraphObservation:
                    deps.projectCurrentGraphObservation
                })
          });
        continuityCapsulePreparation =
          createContinuityCapsulePreparationService({
            attunementFile: deps.attunementFile!,
            sourceId: continuityRuntimeSourceId,
            resumeCoordinator,
            ...(deps.modelProvider === undefined
              ? {}
              : { modelProvider: deps.modelProvider }),
            ...(deps.defaultModel === undefined
              ? {}
              : { model: deps.defaultModel })
          });
        const openPackDeps: ContinuityPackOpenToolDeps = {
          openPack: (threadId, runId) => openProductionAuthorizedContinuityPack(
            deps.attunementFile!,
            threadId,
            resolveExactArtifact,
            { runId }
          ),
          previewPack: (threadId) => readPreparedContinuityPack(
            deps.attunementFile!,
            threadId,
            resolveExactArtifact
          )
        };
        const previewPackDeps: ContinuityPackPreviewToolDeps = {
          previewPack: (threadId) => readPreparedContinuityPack(
            deps.attunementFile!,
            threadId,
            resolveExactArtifact
          ),
          previewResume: async (threadId) => {
            const resume = await resumeCoordinator.preview({
              sourceId: continuityRuntimeSourceId,
              threadId
            });
            const pack = getContinuityResumeRuntimePack(resume);
            return {
              ...(pack === undefined ? {} : { pack }),
              resume
            };
          }
        };
        const policyWriteGate = createQualificationLearningWriteGate(env);
        const resolveLearningProposal = async (
          opportunityId: string,
          draft: ExperienceLearningProposalDraft
        ) => {
          const state = await readAttunementState(deps.attunementFile!);
          const queue = buildExperienceLearningReviewQueue(state);
          const opportunity = queue.items.find((entry) =>
            entry.opportunityId === opportunityId
          );
          if (!opportunity) return undefined;
          const delivery = state.deliveries.find((entry) =>
            entry.id === opportunity.deliveryId
          );
          const thread = state.threads.find((entry) =>
            entry.id === opportunity.scope.threadId
          );
          if (!delivery || !thread) return undefined;
          const proposal = proposeExperienceLearningFromDelivery({
            activeBehaviorDigest: fingerprintContinuityPolicy(thread.policy),
            delivery,
            draft
          });
          if (proposal.status === "held"
            || proposal.candidate.outcome.outcomeId !== opportunity.outcome.outcomeId) {
            return undefined;
          }
          const preview = buildExperienceLearningProposalPreview(proposal.candidate);
          return preview
            ? {
                candidate: proposal.candidate,
                currentPolicy: thread.policy,
                nextPolicyVersion: state.nextPolicyVersion,
                preview
              }
            : undefined;
        };
        const resolveLearningReplay = async (
          opportunityId: string,
          draft: ExperienceLearningProposalDraft,
          evidenceCases: unknown
        ) => {
          const resolved = await resolveLearningProposal(opportunityId, draft);
          if (!resolved) return undefined;
          const replayBundle = buildExperienceLearningReplayBundle(
            resolved.candidate,
            evidenceCases
          );
          return replayBundle ? { ...resolved, replayBundle } : undefined;
        };
        return [
          createContinuityPackPreviewTool(previewPackDeps),
          createContinuityCapsulePrepareTool(
            continuityCapsulePreparation
          ),
          createContinuityPackOpenTool(openPackDeps),
          createContinuityLearningOpportunityTool({
            readQueue: async () => buildExperienceLearningReviewQueue(
              await readAttunementState(deps.attunementFile!)
            )
          }),
          createContinuityLearningPreviewTool({
            preview: async ({ draft, opportunityId }) => {
              return (await resolveLearningProposal(opportunityId, draft))?.preview;
            }
          }),
          createContinuityLearningReplayPreviewTool({
            previewReplay: async ({ draft, evidenceCases, opportunityId }) => {
              const resolved = await resolveLearningReplay(
                opportunityId,
                draft,
                evidenceCases
              );
              return resolved
                ? { preview: resolved.preview, replayBundle: resolved.replayBundle }
                : undefined;
            }
          }),
          createContinuityLearningPolicyCardTool({
            previewPolicyCard: async ({
              draft,
              evidenceCases,
              locale,
              opportunityId
            }) => {
              const queue = buildExperienceLearningReviewQueue(
                await readAttunementState(deps.attunementFile!)
              );
              const matches = queue.items.filter((item) =>
                item.opportunityId === opportunityId
              );
              if (matches.length !== 1) {
                return Object.freeze({
                  reason: "opportunity-not-found" as const,
                  status: "held" as const
                });
              }
              const headRevalidation =
                await snapshotProvider.captureHeadRevalidation(
                  {
                    sourceId: continuityRuntimeSourceId,
                    threadId: matches[0]!.scope.threadId
                  },
                  { maxCaptureSpanMs: 1_000 }
                );
              return compileAttuneGraphPolicyCard({
                schemaVersion: 1,
                draft,
                evidenceCases,
                headRevalidation,
                locale,
                opportunityId
              });
            }
          }),
          createContinuityLearningApplyTool({
            apply: async ({
              draft,
              evidenceCases,
              opportunityId,
              previewId,
              replayInputHash
            }) => {
              const resolved = await resolveLearningReplay(
                opportunityId,
                draft,
                evidenceCases
              );
              if (!resolved
                || resolved.preview.previewId !== previewId
                || resolved.replayBundle.replay.inputHash !== replayInputHash) {
                return undefined;
              }
              const approvedAt = new Date().toISOString();
              const approval = createExperienceLearningApprovalReceipt(
                resolved.preview,
                resolved.replayBundle,
                approvedAt
              );
              if (!approval) return undefined;
              const promotion = await promoteApprovedExperienceLearningContinuityPolicy(
                deps.attunementFile!,
                {
                  approvalReceipt: approval,
                  appliedAt: approvedAt,
                  candidate: resolved.candidate,
                  currentPolicy: resolved.currentPolicy,
                  nextPolicyVersion: resolved.nextPolicyVersion,
                  preview: resolved.preview,
                  replayBundle: resolved.replayBundle
                },
                policyWriteGate
              );
              const stateAfter = await readAttunementState(deps.attunementFile!);
              const handles = (stateAfter.experienceLearningPromotionHandles ?? [])
                .filter((handle) =>
                  verifyExperienceLearningPromotionHandleBinding(promotion, handle)
                );
              if (handles.length !== 1) return undefined;
              const handle = handles[0]!;
              const policyAudit = (stateAfter.experienceLearningPolicyAudits ?? [])
                .find((audit) =>
                  audit.id === handle.promotionAuditId
                  && audit.kind === "promotion"
                  && audit.candidateId === promotion.candidateId
                  && audit.policyAfter.version === promotion.policyAfter.version
                );
              if (!policyAudit) return undefined;
              try {
                deps.experienceLearningPromotionObserver?.(promotion, handle);
              } catch {
                // Health observation is deliberately fail-open after committed CAS.
              }
              return {
                approval,
                handleId: handle.handleId,
                policyAuditId: policyAudit.id,
                promotion
              };
            }
          }),
          createContinuityLearningDegradationTool({
            assess: async (handleId) =>
              projectExperienceLearningDegradationFromState(
                await readAttunementState(deps.attunementFile!),
                handleId
              ),
            observeProposal: deps.experienceLearningRollbackProposalObserver
          }),
          createContinuityLearningRollbackTool({
            rollback: async (handleId) => {
              const stateBefore = await readAttunementState(deps.attunementFile!);
              const handles = (stateBefore.experienceLearningPromotionHandles ?? [])
                .filter((handle) => handle.handleId === handleId);
              if (handles.length !== 1) return undefined;
              const handle = handles[0]!;
              const rolledBackAt = new Date().toISOString();
              const rollback = await rollbackExperienceLearningContinuityPolicyByHandleId(
                deps.attunementFile!,
                handleId,
                rolledBackAt,
                policyWriteGate
              );
              const policyAuditId = (await readAttunementState(deps.attunementFile!))
                .experienceLearningPolicyAudits
                ?.find((audit) =>
                  audit.kind === "rollback"
                  && audit.sourceId === handle.promotionAuditId
                  && audit.policyAfter.version === rollback.policyAfter.version
                )?.id;
              return policyAuditId ? { policyAuditId, rollback } : undefined;
            }
          }),
          createContinuityOutcomeTool({
            recordOutcome: (deliveryId, outcome, ownerNote) =>
              recordProductionAuthorizedContinuityOutcome(
                deps.attunementFile!,
                deliveryId,
                outcome,
                policyWriteGate,
                ownerNote ? { ownerNote } : {}
              )
          })
        ];
      })()
    : [];

  // Notes registry MCP surface (`muse.notes-multi`): only registered
  // when the user opts into >1 provider via MUSE_NOTES_PROVIDERS.
  const notesRegistry = deps.notesRegistry && deps.notesRegistry.list().length >= 2
    ? createLoopbackMcpMuseTools(createNotesRegistryMcpServer({ registry: deps.notesRegistry }))
    : [];

  const calendar = parseBoolean(env.MUSE_CALENDAR_ENABLED, true) && deps.calendarRegistry.list().length > 0
    ? createLoopbackMcpMuseTools(createCalendarMcpServer({ registry: deps.calendarRegistry, remindersFile: deps.remindersFile }))
    : [];

  const tasks = parseBoolean(env.MUSE_TASKS_ENABLED, true)
    ? createLoopbackMcpMuseTools(
        createTasksMcpServer({
          file: deps.tasksFile,
          maxListEntries: parseInteger(env.MUSE_TASKS_LIST_MAX, 12),
          ...(deps.attunementFile ? {
            onTaskCompleted: () => retryContinuityTaskCompletionInteractions(
              deps.attunementFile!, deps.tasksFile
            ).then(() => undefined),
            onTaskCompletionPrepared: (taskId: string, completedAt: string) =>
              prepareProductionAuthorizedContinuityTaskCompletionInteraction(
                deps.attunementFile!,
                { completedAt, taskId }
              ).then(() => undefined)
          } : {})
        })
      )
    : [];

  // Tasks registry MCP surface (`muse.tasks-multi`): symmetric with
  // notesRegistry — only when the user opts into >1 provider.
  const tasksRegistry = deps.tasksRegistry && deps.tasksRegistry.list().length >= 2
    ? createLoopbackMcpMuseTools(createTasksRegistryMcpServer({ registry: deps.tasksRegistry }))
    : [];

  // Messaging loopback: only registered when at least one provider
  // is configured, so the LLM doesn't see a tool that always
  // errors with "no providers configured".
  const messaging = deps.messagingRegistry.list().length > 0 && deps.pollAll && deps.pollNow
    ? createLoopbackMcpMuseTools(createMessagingMcpServer({
        actionLogFile: deps.actionLogFile,
        ...(deps.messagingApprovalGate ? { approvalGate: deps.messagingApprovalGate } : {}),
        pollAll: deps.pollAll,
        pollNow: deps.pollNow,
        registry: deps.messagingRegistry,
        userId: deps.userId
      }))
    : [];

  // Reminders loopback: always registered. The store self-creates
  // on first write; the file may be absent on fresh installs.
  const reminders = createLoopbackMcpMuseTools(
    createRemindersMcpServer({
      file: deps.remindersFile,
      historyFile: deps.reminderHistoryFile,
      maxListEntries: parseInteger(env.MUSE_REMINDERS_LIST_MAX, 12),
      // Whetstone: an agent `reminder add` with an unparseable dueAt records a
      // time-parse weakness (the agent-path sibling of CLI `calendar add`).
      weaknessesFile: resolveWeaknessesFile(env),
      // Opt-in one-way mirror into Apple Reminders.app (iPhone/Watch). Injected
      // ONLY when MUSE_APPLE_REMINDERS_MIRROR is on, so an off/absent switch
      // never reaches osascript. Self-gates on env too (defence in depth).
      ...(parseBoolean(env.MUSE_APPLE_REMINDERS_MIRROR, false)
        ? { mirror: (reminder) => mirrorReminderToApple(reminder, { env }) }
        : {})
    })
  );

  // Proactive audit loopback — `muse.proactive.history`.
  const proactive = createLoopbackMcpMuseTools(
    createProactiveMcpServer({ historyFile: deps.proactiveHistoryFile })
  );

  // Self-followup loopback — list / cancel / snooze the agent's
  // own captured promises.
  const followups = createLoopbackMcpMuseTools(
    createFollowupsMcpServer({
      file: deps.followupsFile,
      maxListEntries: parseInteger(env.MUSE_FOLLOWUPS_LIST_MAX, 12)
    })
  );

  // Episode loopback — read-shaped tools plus user-revocable
  // remove/clear. No agent-side `add` (capture is automatic at
  // REPL exit; manual add would let the LLM lie about history).
  const episodes = createLoopbackMcpMuseTools(
    createEpisodesMcpServer({
      file: deps.episodesFile,
      ...llmJudge
    })
  );

  // Pattern loopback — run detectors on demand, audit fired
  // history, reset cooldown. The daemon stays the sole firer.
  const patterns = createLoopbackMcpMuseTools(
    createPatternsMcpServer({
      file: deps.patternsFiredFile,
      notesDir: deps.notesDir,
      tasksFile: deps.tasksFile
    })
  );

  // Unified activity-feed loopback — `muse.history.recent`.
  // Mirrors the `muse history` CLI; lets a chat-REPL or external
  // agent answer "what did you do last night?" without fanning
  // out across muse.reminders.history / muse.proactive.history /
  // muse.followups.list / etc.
  const history = createLoopbackMcpMuseTools(
    createHistoryMcpServer({
      episodesFile: deps.episodesFile,
      followupsFile: deps.followupsFile,
      patternsFiredFile: deps.patternsFiredFile,
      proactiveHistoryFile: deps.proactiveHistoryFile,
      reminderHistoryFile: deps.reminderHistoryFile
    })
  );

  // JARVIS self-observability loopback — `muse.status.snapshot`.
  // The `model` field is the autoconfigure-resolved defaultModel
  // (which already merges ~/.muse/models.json's suggestedModel),
  // so an external Claude-Desktop agent calling this tool sees the
  // same model the runtime actually uses — not the env-only view
  // that previously misreported "null" for wizard-only setups.
  // Passes every dashboard store-path resolved by autoconfigure so
  // the snapshot covers the same surface as `muse status` CLI
  // (reminders + followups + episodes + patterns). userMemoryFile
  // + trustFile fall back to ~/.muse/*.json inside the loopback
  // server.
  const status = createLoopbackMcpMuseTools(
    createStatusMcpServer({
      episodesFile: deps.episodesFile,
      followupsFile: deps.followupsFile,
      historyFile: deps.proactiveHistoryFile,
      patternsFiredFile: deps.patternsFiredFile,
      remindersFile: deps.remindersFile,
      tasksFile: deps.tasksFile,
      ...(deps.defaultModel ? { model: deps.defaultModel } : {})
    })
  );

  // Readable web-page reader — `muse.web.read`. Default-on perception so
  // "summarize this URL" works without a running Chrome or a per-host
  // fetch allowlist; SSRF-guarded to public hosts inside the server.
  // web_read describes an IMAGE URL with the local vision model when one is
  // wired (the same model the assembly resolved) — @muse/mcp stays model-free.
  const webReadVision = deps.modelProvider && deps.defaultModel
    ? async (input: { readonly imageBase64: string; readonly mimeType: string }) => {
        const { describeImage } = await import("@muse/agent-core");
        return describeImage(deps.modelProvider!, { imageBase64: input.imageBase64, mimeType: input.mimeType, model: deps.defaultModel! });
      }
    : undefined;
  const webRead = webEgress && parseBoolean(env.MUSE_WEB_READ_ENABLED, true)
    ? createLoopbackMcpMuseTools(createWebReadMcpServer(webReadVision ? { describeImage: webReadVision } : {}))
    : [];

  // Deterministic arithmetic — `muse.math.evaluate`. Default-on: a local 8B is
  // unreliable at digits, so any answer that depends on a calculation should go
  // through the exact evaluator. Dependency-free + input-validated (never an
  // always-erroring tool), so it's always safe to expose.
  const math = parseBoolean(env.MUSE_MATH_ENABLED, true)
    ? createLoopbackMcpMuseTools(createMathMcpServer())
    : [];

  // Web search — `muse.search`. Default-on with a zero-config DuckDuckGo
  // fallback (no API key); a self-hosted SearXNG instance takes over when
  // MUSE_SEARXNG_URL is set. A JARVIS-class assistant on a local model has no
  // built-in web_search, so without this it can't answer "what did Apple
  // announce today?". Read-only + outbound to the public web like muse.web.read
  // Local-only also removes this public-web surface before the model sees it.
  const searxngUrl = env.MUSE_SEARXNG_URL?.trim();
  const searxngEngines = env.MUSE_SEARXNG_ENGINES?.trim();
  const search = webEgress && parseBoolean(env.MUSE_SEARCH_ENABLED, true)
    ? createLoopbackMcpMuseTools(createSearchMcpServer({
        ...(searxngUrl && searxngUrl.length > 0 ? { searxngUrl } : {}),
        ...(searxngEngines && searxngEngines.length > 0 ? { searxngEngines } : {})
      }))
    : [];

  return {
    calendar,
    continuity,
    episodes,
    followups,
    history,
    math,
    messaging,
    notes,
    notesRegistry,
    patterns,
    proactive,
    reminders,
    status,
    search,
    tasks,
    tasksRegistry,
    webRead,
    ...(continuityCapsulePreparation === undefined
      ? {}
      : { continuityCapsulePreparation })
  };
}
