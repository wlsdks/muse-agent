import { describe, expect, it, vi } from "vitest";
import type { AgentRunContext } from "@muse/agent-core";
import type { MuseDatabase } from "@muse/db";
import type { ModelToolCall } from "@muse/model";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import {
  buildChannelFaqRegistrationUpsertQuery,
  buildSlackBotInstanceUpsertQuery,
  createSlackFeedbackEventInsert,
  createChannelFaqRegistrationInsert,
  createSlackBotInstanceInsert,
  createSlackResponseTrackingInsert,
  CommandRouter,
  createFollowupSuggestionInteractionHandler,
  createPromptDriftHook,
  createSlackProgressHook,
  createSlackReminderPoller,
  createSloAlertHook,
  handleSlackReminderCommand,
  InMemoryReminderStore,
  parseReminderTime,
  extractFollowupCategory,
  FetchSlackResponseUrlTransport,
  FetchSlackWebApiMessageTransport,
  FOLLOWUP_ACTION_PREFIX,
  FOLLOWUP_MAX_LABEL_LENGTH,
  FOLLOWUP_MAX_PER_MESSAGE,
  followupActionId,
  parseFollowupSuggestions,
  renderFollowupSuggestionBlocks,
  stripFollowupMarker,
  truncateFollowupLabel,
  InMemoryChannelFaqRegistrationStore,
  InMemorySlackFeedbackEventStore,
  InMemorySlackBotInstanceStore,
  InMemorySlackResponseTrackerStore,
  mapChannelFaqRegistrationRow,
  mapSlackFeedbackEventRow,
  mapSlackBotInstanceRow,
  mapSlackResponseTrackingRow,
  SlackBotResponseTracker,
  SlackFeedbackButtonHandler,
  SlackInteractionDispatcher,
  SlackSignatureVerifier,
  SlackSocketModeGateway,
  WebhookDispatcher,
  createFeedbackMetadataCaptureHook,
  createRagIngestionCaptureHook,
  createToolResponseSummaryHook,
  createUserMemoryInjectionHook,
  createWebhookNotificationHook,
  formatSlackMrkdwn,
  parseSlackInteractionPayload,
  parseSlackSlashCommand,
  parseSlackUrlEncodedBody,
  signSlackRequestBody,
  signWebhookPayload,
  toSlackCommandAck,
  verifySlackSignature,
  verifyWebhookSignature
} from "../src/index.js";

describe("Slack command parsing", () => {
  it("normalizes slash command payloads into command envelopes", () => {
    const envelope = parseSlackSlashCommand(
      {
        channel_id: "channel-1",
        command: "/muse",
        response_url: "https://example.invalid/respond",
        team_id: "workspace-1",
        text: " summarize status ",
        trigger_id: "trigger-1",
        user_id: "user-1"
      },
      () => new Date("2026-05-05T00:00:00.000Z")
    );

    expect(envelope).toMatchObject({
      channelId: "channel-1",
      command: "/muse",
      id: "trigger-1",
      source: "slack",
      text: "summarize status",
      userId: "user-1",
      workspaceId: "workspace-1"
    });
  });

  it("parses urlencoded Slack payloads and formats ack responses", () => {
    const raw = "command=%2Fmuse&text=hello+world&user_id=user-1&channel_id=channel-1";
    const payload = parseSlackUrlEncodedBody(raw);

    expect(payload).toMatchObject({
      channel_id: "channel-1",
      command: "/muse",
      text: "hello world",
      user_id: "user-1"
    });
    expect(toSlackCommandAck({ text: "ok", visibility: "public" })).toEqual({
      response_type: "in_channel",
      text: "ok"
    });
  });

  it("converts LLM markdown into Slack mrkdwn for command responses", () => {
    const ack = toSlackCommandAck({
      text: [
        "안녕하세요, 진안님! 📋",
        "### 요약",
        "문서는 [가이드](https://example.invalid/guide)를 보세요.",
        "**중요**: 담당자는 `U12345678` 입니다.",
        "",
        "| 상태 | 건수 |",
        "| --- | --- |",
        "| Done | 3 |"
      ].join("\n"),
      visibility: "public"
    });

    expect(ack).toEqual({
      response_type: "in_channel",
      text: [
        "*요약*",
        "",
        "문서는 <https://example.invalid/guide|가이드>를 보세요.",
        "*중요*: 담당자는 <@U12345678> 입니다.",
        "",
        "• *상태*: Done — *건수*: 3"
      ].join("\n")
    });
  });

  it("preserves fenced code while converting surrounding Slack text", () => {
    expect(
      formatSlackMrkdwn(
        [
          "### 결과",
          "```",
          "**keep** [link](https://example.invalid)",
          "```",
          "[문서](https://example.invalid/doc)"
        ].join("\n")
      )
    ).toBe(["*결과*", "```", "**keep** [link](https://example.invalid)", "```", "<https://example.invalid/doc|문서>"].join("\n"));
  });

  it("verifies Slack signatures and rejects replayed timestamps", () => {
    const raw = "command=%2Fmuse&text=hello";
    const timestamp = "1770000000";
    const signature = signSlackRequestBody(raw, timestamp, "signing-secret");
    const verifier = new SlackSignatureVerifier({
      nowSeconds: () => 1_770_000_010,
      signingSecret: "signing-secret"
    });

    expect(verifySlackSignature(raw, timestamp, signature, "signing-secret")).toBe(true);
    expect(verifier.verify(timestamp, signature, raw)).toEqual({ ok: true });
    expect(verifier.verify("1769990000", signature, raw)).toMatchObject({ ok: false });
    expect(verifier.verify(timestamp, "v0=bad", raw)).toMatchObject({ ok: false });
  });
});

describe("CommandRouter", () => {
  it("routes commands and falls back to wildcard handlers", async () => {
    const router = new CommandRouter();
    router.register("*", {
      handle: (command) => ({ text: `handled:${command.text}`, visibility: "ephemeral" })
    });

    await expect(router.handle(parseSlackSlashCommand({ text: "hello" }))).resolves.toMatchObject({
      text: "handled:hello"
    });
  });
});

describe("SlackInteractionDispatcher", () => {
  it("parses block actions and dispatches by action id prefix", async () => {
    const handled: unknown[] = [];
    const dispatcher = new SlackInteractionDispatcher([
      {
        actionIdPrefix: "feedback",
        handle: (payload) => {
          handled.push(payload);
          return true;
        }
      }
    ]);
    const payload = {
      actions: [{ action_id: "feedback.up", value: "positive" }],
      channel: { id: "channel-1" },
      message: { ts: "1770000000.000100" },
      response_url: "https://example.invalid/respond",
      trigger_id: "trigger-1",
      type: "block_actions",
      user: { id: "user-1" }
    };

    await expect(dispatcher.dispatch({ payload: JSON.stringify(payload) })).resolves.toMatchObject({
      dispatched: true,
      payload: {
        actionId: "feedback.up",
        channelId: "channel-1",
        messageTs: "1770000000.000100",
        responseUrl: "https://example.invalid/respond",
        triggerId: "trigger-1",
        type: "block_actions",
        userId: "user-1",
        value: "positive"
      }
    });
    expect(handled).toHaveLength(1);
  });

  it("parses view submissions by callback id and continues after handler errors", async () => {
    const handled: unknown[] = [];
    const dispatcher = new SlackInteractionDispatcher([
      {
        actionIdPrefix: "marketing",
        handle: () => {
          throw new Error("boom");
        }
      },
      {
        actionIdPrefix: "marketing",
        handle: (payload) => {
          handled.push(payload);
          return true;
        }
      }
    ]);

    await expect(
      dispatcher.dispatch({
        type: "view_submission",
        user: { id: "user-1" },
        view: {
          callback_id: "marketing_submit",
          private_metadata: "{\"channel\":\"channel-1\"}",
          state: { values: { title: { value: "hello" } } }
        }
      })
    ).resolves.toMatchObject({
      dispatched: true,
      payload: {
        actionId: "marketing_submit",
        privateMetadata: "{\"channel\":\"channel-1\"}",
        type: "view_submission",
        userId: "user-1"
      }
    });
    expect(handled).toHaveLength(1);
  });

  it("returns parse and handler miss reasons without throwing", async () => {
    const dispatcher = new SlackInteractionDispatcher([]);

    expect(parseSlackInteractionPayload("{bad")).toBeUndefined();
    await expect(dispatcher.dispatch("{bad")).resolves.toEqual({
      dispatched: false,
      reason: "parse_failed"
    });
    await expect(
      dispatcher.dispatch({
        actions: [{ action_id: "feedback.up" }],
        type: "block_actions",
        user: { id: "user-1" }
      })
    ).resolves.toMatchObject({
      dispatched: false,
      reason: "no_handler"
    });
  });

  it("stores tracked feedback button clicks and posts an ack in thread", async () => {
    const feedback: unknown[] = [];
    const messages: unknown[] = [];
    const feedbackStore = new InMemorySlackFeedbackEventStore({
      idFactory: () => "feedback-1",
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });
    const tracker = new SlackBotResponseTracker({ now: () => 1_770_000_000_000 });
    tracker.track("channel-1", "1770000000.000100", "session-1", "original question", "original answer");
    const handler = new SlackFeedbackButtonHandler({
      feedbackStore,
      messageTransport: {
        postMessage: (input) => {
          messages.push(input);
          return { ok: true, statusCode: 200, ts: "1770000000.000200" };
        }
      },
      onFeedback: (input) => {
        feedback.push(input);
      },
      tracker
    });

    await expect(
      handler.handle({
        actionId: "feedback.down",
        channelId: "channel-1",
        messageTs: "1770000000.000100",
        type: "block_actions",
        userId: "user-1"
      })
    ).resolves.toBe(true);
    expect(feedback).toEqual([
      {
        channelId: "channel-1",
        messageTs: "1770000000.000100",
        metadata: {
          actionId: "feedback.down",
          responseUrl: null,
          type: "block_actions"
        },
        query: "original question",
        rating: "thumbs_down",
        response: "original answer",
        sessionId: "session-1",
        userId: "user-1"
      }
    ]);
    expect(messages).toEqual([
      {
        channelId: "channel-1",
        text: "Thanks for the candid feedback. I will do better next time.",
        threadTs: "1770000000.000100"
      }
    ]);
    expect(feedbackStore.listBySession("session-1")).toEqual([
      expect.objectContaining({
        channelId: "channel-1",
        id: "feedback-1",
        messageTs: "1770000000.000100",
        query: "original question",
        rating: "thumbs_down",
        response: "original answer",
        sessionId: "session-1",
        userId: "user-1"
      })
    ]);
  });

  it("backs response tracking with an injectable store and purges expired rows", async () => {
    const store = new InMemorySlackResponseTrackerStore();
    const tracker = new SlackBotResponseTracker({
      now: () => 1_770_000_000_000,
      store,
      ttlMs: 10
    });

    await tracker.track("channel-1", "1770000000.000100", "session-1", "question", "answer");
    expect(await tracker.lookup("channel-1", "1770000000.000100")).toEqual({
      expiresAt: 1_770_000_000_010,
      response: "answer",
      sessionId: "session-1",
      userPrompt: "question"
    });
    expect(store.purgeExpired(1_770_000_000_011)).toBe(1);
    expect(await tracker.lookup("channel-1", "1770000000.000100")).toBeUndefined();
  });

  it("acks expired feedback button clicks via response_url", async () => {
    const posts: unknown[] = [];
    const handler = new SlackFeedbackButtonHandler({
      onFeedback: () => {
        throw new Error("should not save");
      },
      responseTransport: {
        post: (url, body) => {
          posts.push({ body, url });
          return { statusCode: 200 };
        }
      },
      tracker: new SlackBotResponseTracker()
    });

    await expect(
      handler.handle({
        actionId: "feedback.up",
        channelId: "channel-1",
        messageTs: "1770000000.000100",
        responseUrl: "https://example.invalid/respond",
        type: "block_actions",
        userId: "user-1"
      })
    ).resolves.toBe(true);
    expect(posts).toEqual([
      {
        body: {
          response_type: "ephemeral",
          text: "This message is expired or no longer tracked."
        },
        url: "https://example.invalid/respond"
      }
    ]);
  });
});

describe("SlackSocketModeGateway", () => {
  it("acks socket envelopes and routes app mention events through the command handler", async () => {
    const sent: unknown[] = [];
    const handled: unknown[] = [];
    const gateway = new SlackSocketModeGateway({
      commandHandler: {
        handle: async (command) => {
          handled.push(command);
          return { text: `handled:${command.text}` };
        }
      },
      transport: {
        send: async (payload) => {
          sent.push(payload);
        }
      }
    });

    await gateway.handleEnvelope({
      envelope_id: "envelope-1",
      payload: {
        event: {
          channel: "channel-1",
          team: "workspace-1",
          text: "<@BOT> decide release plan",
          ts: "1770000000.000100",
          type: "app_mention",
          user: "user-1"
        },
        type: "event_callback"
      },
      type: "events_api"
    });

    expect(sent).toEqual([{ envelope_id: "envelope-1" }]);
    expect(handled).toEqual([
      {
        channelId: "channel-1",
        command: "app_mention",
        id: "1770000000.000100",
        metadata: {
          eventTs: "1770000000.000100",
          socketMode: true,
          type: "app_mention"
        },
        receivedAt: expect.any(Date),
        source: "slack_socket_mode",
        text: "decide release plan",
        userId: "user-1",
        workspaceId: "workspace-1"
      }
    ]);
  });

  it("acks duplicate socket envelopes without routing the same envelope twice", async () => {
    const sent: unknown[] = [];
    const handled: unknown[] = [];
    const gateway = new SlackSocketModeGateway({
      commandHandler: {
        handle: async (command) => {
          handled.push(command.id);
          return { text: "handled" };
        }
      },
      transport: {
        send: async (payload) => {
          sent.push(payload);
        }
      }
    });
    const envelope = {
      envelope_id: "envelope-duplicate",
      payload: {
        event: {
          channel: "channel-1",
          team: "workspace-1",
          text: "<@BOT> retry safe",
          ts: "1770000000.000200",
          type: "app_mention",
          user: "user-1"
        },
        type: "event_callback"
      },
      type: "events_api"
    };

    await gateway.handleEnvelope(envelope);
    await gateway.handleEnvelope(envelope);

    expect(sent).toEqual([{ envelope_id: "envelope-duplicate" }, { envelope_id: "envelope-duplicate" }]);
    expect(handled).toEqual(["1770000000.000200"]);
  });
});

describe("Slack persistence stores", () => {
  it("stores Slack bot instances and channel FAQ registrations in memory", async () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const botStore = new InMemorySlackBotInstanceStore({ now: () => now });
    const faqStore = new InMemoryChannelFaqRegistrationStore({ now: () => now });

    await botStore.save({
      appToken: "xapp-token",
      botToken: "xoxb-token",
      id: "bot-1",
      name: "Support Bot",
      personaId: "persona-1"
    });
    await faqStore.save({
      autoReplyMode: "ALWAYS",
      channelId: "channel-1",
      channelName: "support",
      registeredBy: "admin"
    });
    const updatedFaq = await faqStore.updateIngestResult({
      channelId: "channel-1",
      chunkCount: 3,
      messageCount: 2,
      status: "OK"
    });

    expect(await botStore.listEnabled()).toMatchObject([{ id: "bot-1", enabled: true }]);
    expect(updatedFaq).toMatchObject({
      channelId: "channel-1",
      lastChunkCount: 3,
      lastStatus: "OK"
    });
    expect(await faqStore.delete("channel-1")).toBe(true);
  });

  it("builds PostgreSQL upsert SQL and maps Slack persistence rows", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-05-06T00:00:00.000Z");
    const bot = createSlackBotInstanceInsert({
      appToken: "xapp-token",
      botToken: "xoxb-token",
      id: "bot-1",
      name: "Support Bot",
      personaId: "persona-1"
    }, { now: () => now });
    const faq = createChannelFaqRegistrationInsert({
      autoReplyMode: "ALWAYS",
      channelId: "channel-1",
      channelName: "support",
      registeredBy: "admin"
    }, { now: () => now });
    const responseTracking = createSlackResponseTrackingInsert({
      channelId: "channel-1",
      expiresAt: 1_770_086_400_000,
      messageTs: "1770000000.000100",
      response: "answer",
      sessionId: "session-1",
      userPrompt: "question"
    }, { now: () => now });
    const feedback = createSlackFeedbackEventInsert({
      channelId: "channel-1",
      createdAt: now,
      id: "feedback-1",
      messageTs: "1770000000.000100",
      query: "question",
      rating: "thumbs_up",
      response: "answer",
      sessionId: "session-1",
      userId: "user-1"
    });
    const botUpsert = buildSlackBotInstanceUpsertQuery(db, mapSlackBotInstanceRow(bot), { now: () => now }).compile();
    const faqUpsert = buildChannelFaqRegistrationUpsertQuery(db, mapChannelFaqRegistrationRow(faq), { now: () => now }).compile();

    expect(botUpsert.sql).toContain('insert into "slack_bot_instances"');
    expect(botUpsert.sql).toContain('on conflict ("id") do update');
    expect(faqUpsert.sql).toContain('insert into "channel_faq_registrations"');
    expect(faqUpsert.sql).toContain('on conflict ("channel_id") do update');
    expect(mapSlackBotInstanceRow(bot)).toMatchObject({ id: "bot-1", name: "Support Bot" });
    expect(mapChannelFaqRegistrationRow(faq)).toMatchObject({
      autoReplyMode: "ALWAYS",
      channelId: "channel-1"
    });
    expect(mapSlackResponseTrackingRow(responseTracking)).toMatchObject({
      expiresAt: 1_770_086_400_000,
      response: "answer",
      sessionId: "session-1",
      userPrompt: "question"
    });
    expect(mapSlackFeedbackEventRow(feedback)).toMatchObject({
      channelId: "channel-1",
      id: "feedback-1",
      messageTs: "1770000000.000100",
      rating: "thumbs_up"
    });
  });
});

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}

describe("WebhookDispatcher", () => {
  it("dispatches matching lifecycle events with signatures", async () => {
    const posts: Array<{ headers: Record<string, string>; url: string }> = [];
    const dispatcher = new WebhookDispatcher({
      endpoints: [
        {
          enabled: true,
          events: ["after_complete"],
          id: "endpoint-1",
          secret: "secret-1",
          url: "https://example.invalid/webhook"
        },
        {
          enabled: true,
          events: ["on_error"],
          id: "endpoint-2",
          url: "https://example.invalid/error"
        }
      ],
      idFactory: () => "event-1",
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      transport: {
        post: async (url, _body, headers) => {
          posts.push({ headers, url });
          return { statusCode: 204 };
        }
      }
    });

    const deliveries = await dispatcher.dispatch({
      payload: { output: "ok" },
      runId: "run-1",
      type: "after_complete"
    });

    expect(deliveries).toEqual([
      { endpointId: "endpoint-1", eventId: "event-1", status: "delivered", statusCode: 204 },
      { endpointId: "endpoint-2", eventId: "event-1", status: "skipped" }
    ]);
    expect(posts[0]?.headers["x-muse-signature"]).toMatch(/^sha256=/u);
  });

  it("verifies webhook signatures with constant-time comparison", () => {
    const signature = signWebhookPayload("{\"ok\":true}", "secret-1");

    expect(verifyWebhookSignature("{\"ok\":true}", signature, "secret-1")).toBe(true);
    expect(verifyWebhookSignature("{\"ok\":false}", signature, "secret-1")).toBe(false);
  });

  it("creates a lifecycle hook that dispatches webhook notifications", async () => {
    const dispatches: unknown[] = [];
    const hook = createWebhookNotificationHook({
      dispatcher: {
        dispatch: async (event) => {
          dispatches.push(event);
          return [];
        }
      }
    });
    const context = {
      input: {
        messages: [{ content: "hello", role: "user" }],
        metadata: { tenantId: "example-tenant" },
        model: "test-model"
      },
      runId: "run-1",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    };

    await hook.beforeStart?.(context);
    await hook.afterComplete?.(context, {
      id: "response-1",
      model: "test-model",
      output: "done"
    });
    await hook.onError?.(context, new Error("failed"));

    expect(hook.id).toBe("webhook-notification");
    expect(dispatches).toEqual([
      {
        payload: {
          metadata: { tenantId: "example-tenant" },
          model: "test-model",
          startedAt: "2026-05-06T00:00:00.000Z"
        },
        runId: "run-1",
        type: "before_start"
      },
      {
        payload: {
          model: "test-model",
          outputPreview: "done",
          responseId: "response-1"
        },
        runId: "run-1",
        type: "after_complete"
      },
      {
        payload: {
          error: "failed",
          name: "Error"
        },
        runId: "run-1",
        type: "on_error"
      }
    ]);
  });

  it("creates a tool response summary hook for completed tool results", async () => {
    const summaries: unknown[] = [];
    const hook = createToolResponseSummaryHook({
      onSummary: (summary) => {
        summaries.push(summary);
      },
      previewLength: 20
    });

    await hook.afterTool?.(
      {
        input: {
          messages: [{ content: "find issues", role: "user" }],
          model: "test-model"
        },
        runId: "run-1",
        startedAt: new Date("2026-05-06T00:00:00.000Z")
      },
      {
        arguments: { jql: "project = MUSE" },
        id: "tool-call-1",
        name: "jira.search"
      },
      {
        id: "tool-call-1",
        name: "jira.search",
        output: "{\"issues\":[{\"key\":\"MUSE-1\"},{\"key\":\"MUSE-2\"}]}",
        status: "completed"
      }
    );

    expect(hook.id).toBe("tool-response-summary");
    expect(summaries).toEqual([
      {
        itemCount: 2,
        outputPreview: "{\"issues\":[{\"key\":\"M",
        runId: "run-1",
        status: "completed",
        toolCallId: "tool-call-1",
        toolName: "jira.search"
      }
    ]);
  });

  it("captures eligible completed runs as RAG ingestion candidates", async () => {
    const saved: unknown[] = [];
    const hook = createRagIngestionCaptureHook({
      candidateStore: {
        save: async (candidate) => {
          saved.push(candidate);
          return {
            ...candidate,
            capturedAt: new Date("2026-05-06T00:00:00.000Z"),
            id: "rag-candidate-1",
            ingestedDocumentId: null,
            reviewedAt: null,
            reviewedBy: null,
            reviewComment: null,
            status: "PENDING"
          };
        }
      },
      policyStore: {
        getOrNull: async () => ({
          allowedChannels: ["slack"],
          blockedPatterns: ["secret"],
          enabled: true,
          minQueryChars: 5,
          minResponseChars: 5,
          requireReview: true
        })
      }
    });

    await hook.afterComplete?.(
      {
        input: {
          messages: [{ content: "How should the release checklist work?", role: "user" }],
          metadata: {
            channel: "slack",
            sessionId: "session-1",
            userId: "example-user"
          },
          model: "test-model"
        },
        runId: "run-1",
        startedAt: new Date("2026-05-06T00:00:00.000Z")
      },
      {
        id: "response-1",
        model: "test-model",
        output: "Use a deterministic checklist with explicit owner and rollback fields."
      }
    );

    expect(hook.id).toBe("rag-ingestion-capture");
    expect(saved).toEqual([
      {
        channel: "slack",
        query: "How should the release checklist work?",
        response: "Use a deterministic checklist with explicit owner and rollback fields.",
        runId: "run-1",
        sessionId: "session-1",
        status: "PENDING",
        userId: "example-user"
      }
    ]);
  });

  it("captures feedback metadata from completed runs", async () => {
    const saved: unknown[] = [];
    const hook = createFeedbackMetadataCaptureHook({
      feedbackStore: {
        save: async (record) => {
          saved.push(record);
          return record;
        }
      }
    });

    await hook.afterComplete?.(
      {
        input: {
          messages: [{ content: "Which option should I choose?", role: "user" }],
          metadata: {
            channel: "slack",
            intent: "decision",
            sessionId: "session-1",
            templateId: "template-1",
            userId: "example-user"
          },
          model: "test-model"
        },
        runId: "run-1",
        startedAt: new Date("2026-05-06T00:00:00.000Z")
      },
      {
        id: "response-1",
        model: "test-model",
        output: "Choose the lower-risk option."
      }
    );

    expect(hook.id).toBe("feedback-metadata-capture");
    expect(saved).toEqual([
      {
        channel: "slack",
        intent: "decision",
        model: "test-model",
        query: "Which option should I choose?",
        response: "Choose the lower-risk option.",
        runId: "run-1",
        sessionId: "session-1",
        templateId: "template-1",
        timestamp: "2026-05-06T00:00:00.000Z",
        userId: "example-user"
      }
    ]);
  });

  it("injects user memory as a bounded system message before model invocation", async () => {
    const hook = createUserMemoryInjectionHook({
      memoryStore: {
        findByUserId: async () => ({
          facts: { role: "planner" },
          preferences: { tone: "concise" },
          recentTopics: ["migration"],
          updatedAt: new Date("2026-05-06T00:00:00.000Z"),
          userId: "example-user"
        })
      },
      maxEntries: 2
    });
    const context = {
      input: {
        messages: [{ content: "Help me decide", role: "user" }],
        metadata: { userId: "example-user" },
        model: "test-model"
      },
      runId: "run-1",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    };

    await hook.beforeStart?.(context);

    expect(hook.id).toBe("user-memory-injection");
    expect(context.input.messages).toEqual([
      {
        content: [
          "Relevant user memory:",
          "- Fact role: planner",
          "- Preference tone: concise"
        ].join("\n"),
        role: "system"
      },
      { content: "Help me decide", role: "user" }
    ]);
  });

  it("posts Slack response_url payloads as formatted JSON", async () => {
    const posts: Array<{ body: string | undefined; headers: HeadersInit | undefined; url: string }> = [];
    const transport = new FetchSlackResponseUrlTransport(async (url, init) => {
      posts.push({
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
        url: String(url)
      });

      return new Response(null, { status: 204 });
    });

    await expect(
      transport.post("https://example.invalid/respond", { response_type: "in_channel", text: "### ok\n**done**" })
    ).resolves.toEqual({
      statusCode: 204
    });
    expect(posts).toEqual([
      {
        body: "{\"response_type\":\"in_channel\",\"text\":\"*ok*\\n\\n*done*\"}",
        headers: { "content-type": "application/json" },
        url: "https://example.invalid/respond"
      }
    ]);
  });

  it("posts Slack Web API thread replies as formatted chat.postMessage payloads", async () => {
    const posts: Array<{ body: string | undefined; headers: HeadersInit | undefined; url: string }> = [];
    const transport = new FetchSlackWebApiMessageTransport("xoxb-token", async (url, init) => {
      posts.push({
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
        url: String(url)
      });

      return Response.json({ ok: true, ts: "1770000000.000300" }, { status: 200 });
    });

    await expect(
      transport.postMessage({
        channelId: "channel-1",
        text: "### ok\n**done**",
        threadTs: "1770000000.000100"
      })
    ).resolves.toEqual({
      ok: true,
      statusCode: 200,
      ts: "1770000000.000300"
    });
    expect(posts).toEqual([
      {
        body: "{\"channel\":\"channel-1\",\"text\":\"*ok*\\n\\n*done*\",\"thread_ts\":\"1770000000.000100\"}",
        headers: {
          authorization: "Bearer xoxb-token",
          "content-type": "application/json; charset=utf-8"
        },
        url: "https://slack.com/api/chat.postMessage"
      }
    ]);
  });

  it("posts assistant.threads.setStatus with channel_id, thread_ts, and status", async () => {
    const calls: Array<{ body: string | undefined; headers: HeadersInit | undefined; url: string }> = [];
    const transport = new FetchSlackWebApiMessageTransport("xoxb-token", async (url, init) => {
      calls.push({
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
        url: String(url)
      });
      return Response.json({ ok: true }, { status: 200 });
    });

    await expect(
      transport.setStatus({ channelId: "C1", status: "thinking", threadTs: "1.23" })
    ).resolves.toEqual({ ok: true, statusCode: 200 });

    expect(calls).toEqual([
      {
        body: "{\"channel_id\":\"C1\",\"thread_ts\":\"1.23\",\"status\":\"thinking\"}",
        headers: {
          authorization: "Bearer xoxb-token",
          "content-type": "application/json; charset=utf-8"
        },
        url: "https://slack.com/api/assistant.threads.setStatus"
      }
    ]);
  });

  it("returns slack_bot_token_missing for setStatus when bot token is empty", async () => {
    const transport = new FetchSlackWebApiMessageTransport("");
    await expect(
      transport.setStatus({ channelId: "C1", status: "x", threadTs: "1.23" })
    ).resolves.toEqual({ error: "slack_bot_token_missing", ok: false, statusCode: 0 });
  });
});

describe("createSlackProgressHook", () => {
  type StatusCall = { channelId: string; status: string; threadTs: string };

  function makeStatusTransport(behavior: "ok" | "throw" = "ok"): {
    transport: {
      setStatus: (input: { channelId: string; status: string; threadTs: string }) => Promise<{
        ok: boolean;
        statusCode: number;
      }>;
    };
    calls: StatusCall[];
  } {
    const calls: StatusCall[] = [];
    const transport = {
      setStatus: async (input: { channelId: string; status: string; threadTs: string }) => {
        calls.push({ channelId: input.channelId, status: input.status, threadTs: input.threadTs });
        if (behavior === "throw") {
          throw new Error("slack down");
        }
        return { ok: true, statusCode: 200 };
      }
    };
    return { calls, transport };
  }

  function makeContext(metadata: Record<string, unknown> = {}, runId = "run-1"): AgentRunContext {
    return {
      input: {
        messages: [],
        metadata: metadata as Record<string, unknown> as AgentRunContext["input"]["metadata"],
        model: "test-model"
      },
      runId,
      startedAt: new Date("2026-05-07T00:00:00.000Z")
    };
  }

  function makeToolCall(name: string): ModelToolCall {
    return { arguments: {}, id: `call-${name}`, name };
  }

  function makeResult(status: "completed" | "failed" | "blocked"): {
    error?: string;
    id: string;
    name: string;
    output: string;
    status: "completed" | "failed" | "blocked";
  } {
    return { id: "tool-result-1", name: "tool", output: "", status };
  }

  it("calls setStatus on beforeTool with friendly Korean label when slack metadata is present", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ minUpdateIntervalMs: 0, transport });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.beforeTool?.(context, makeToolCall("jira_search"));

    expect(calls).toEqual([{ channelId: "C1", status: "🔍 Jira 검색 중…", threadTs: "1.23" }]);
  });

  it("calls setStatus on afterTool with success message when status is completed", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ minUpdateIntervalMs: 0, transport });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.afterTool?.(context, makeToolCall("jira_search"), makeResult("completed"));

    expect(calls).toEqual([
      { channelId: "C1", status: "✓ Jira 검색 완료 — 다음 단계 진행 중…", threadTs: "1.23" }
    ]);
  });

  it("calls setStatus on afterTool with failure message when status is failed", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ minUpdateIntervalMs: 0, transport });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.afterTool?.(context, makeToolCall("jira_search"), makeResult("failed"));

    expect(calls).toEqual([
      { channelId: "C1", status: "⚠️ Jira 검색 실패 — 복구 중…", threadTs: "1.23" }
    ]);
  });

  it("is a no-op when slackChannelId is missing", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ minUpdateIntervalMs: 0, transport });

    await hook.beforeTool?.(makeContext({ slackThreadTs: "1.23" }), makeToolCall("rag_search"));
    await hook.afterTool?.(
      makeContext({ slackThreadTs: "1.23" }),
      makeToolCall("rag_search"),
      makeResult("completed")
    );

    expect(calls).toHaveLength(0);
  });

  it("is a no-op when slackThreadTs is missing", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ minUpdateIntervalMs: 0, transport });

    await hook.beforeTool?.(makeContext({ slackChannelId: "C1" }), makeToolCall("rag_search"));

    expect(calls).toHaveLength(0);
  });

  it("throttles repeated calls within minUpdateIntervalMs for the same runId", async () => {
    let now = 1_000_000;
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({
      minUpdateIntervalMs: 1500,
      now: () => now,
      transport
    });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.beforeTool?.(context, makeToolCall("rag_search"));
    now += 500;
    await hook.afterTool?.(context, makeToolCall("rag_search"), makeResult("completed"));
    expect(calls).toHaveLength(1);

    now += 1500;
    await hook.beforeTool?.(context, makeToolCall("rag_search"));
    expect(calls).toHaveLength(2);
  });

  it("isolates throttle state per runId", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({
      minUpdateIntervalMs: 1500,
      now: () => 100,
      transport
    });

    await hook.beforeTool?.(
      makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" }, "run-a"),
      makeToolCall("rag_search")
    );
    await hook.beforeTool?.(
      makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" }, "run-b"),
      makeToolCall("rag_search")
    );

    expect(calls).toHaveLength(2);
  });

  it("swallows transport errors and reports them via the onError callback", async () => {
    const errors: unknown[] = [];
    const { transport } = makeStatusTransport("throw");
    const hook = createSlackProgressHook({
      minUpdateIntervalMs: 0,
      onError: (err) => errors.push(err),
      transport
    });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await expect(hook.beforeTool?.(context, makeToolCall("rag_search"))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("humanizes unknown snake_case tool names via Title Case fallback", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ minUpdateIntervalMs: 0, transport });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.beforeTool?.(context, makeToolCall("custom_widget_check"));

    expect(calls[0]?.status).toBe("🔍 Custom Widget Check 중…");
  });

  it("respects custom friendlyNames overrides", async () => {
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({
      friendlyNames: { custom_check: "맞춤 점검" },
      minUpdateIntervalMs: 0,
      transport
    });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.beforeTool?.(context, makeToolCall("custom_check"));

    expect(calls[0]?.status).toBe("🔍 맞춤 점검 중…");
  });

  it("truncates status text to 100 characters", async () => {
    const longLabel = "X".repeat(120);
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({
      friendlyNames: { huge_tool: longLabel },
      minUpdateIntervalMs: 0,
      transport
    });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.beforeTool?.(context, makeToolCall("huge_tool"));

    expect(calls[0]?.status.length).toBeLessThanOrEqual(100);
  });

  it("clears throttle state on afterComplete so the next run can update immediately", async () => {
    let now = 1_000_000;
    const { calls, transport } = makeStatusTransport();
    const hook = createSlackProgressHook({
      minUpdateIntervalMs: 1500,
      now: () => now,
      transport
    });
    const context = makeContext({ slackChannelId: "C1", slackThreadTs: "1.23" });

    await hook.beforeTool?.(context, makeToolCall("rag_search"));
    expect(calls).toHaveLength(1);

    now += 100;
    await hook.afterTool?.(context, makeToolCall("rag_search"), makeResult("completed"));
    expect(calls).toHaveLength(1);

    now += 100;
    await hook.afterComplete?.(context, { id: "r", model: "m", output: "" });

    now += 100;
    await hook.beforeTool?.(context, makeToolCall("rag_search"));
    expect(calls).toHaveLength(2);
  });

  it("exposes a stable hook id", () => {
    const { transport } = makeStatusTransport();
    const hook = createSlackProgressHook({ transport });
    expect(hook.id).toBe("slack-progress");
  });
});

describe("Slack followup suggestions", () => {
  describe("parseFollowupSuggestions", () => {
    it("extracts well-formed suggestions from the FOLLOWUPS HTML comment marker", () => {
      const text = [
        "Here is the answer.",
        '<!--FOLLOWUPS:[{"id":"jira_detail_X-1","label":"🔍 X-1 상세","prompt":"X-1 이슈 상세","category":"jira_detail"}]-->'
      ].join("\n");
      expect(parseFollowupSuggestions(text)).toEqual([
        {
          category: "jira_detail",
          id: "jira_detail_X-1",
          label: "🔍 X-1 상세",
          prompt: "X-1 이슈 상세"
        }
      ]);
    });

    it("returns an empty array when no marker is present", () => {
      expect(parseFollowupSuggestions("plain text only")).toEqual([]);
    });

    it("tolerates whitespace and multi-line JSON inside the marker", () => {
      const text = [
        "<!--FOLLOWUPS: [",
        '  { "id": "a_b", "label": "L", "prompt": "P", "category": "a" },',
        '  { "id": "c_d", "label": "L2", "prompt": "P2", "category": "c" }',
        "] -->"
      ].join("\n");
      expect(parseFollowupSuggestions(text)).toHaveLength(2);
    });

    it("filters out entries with missing or blank required fields", () => {
      const text =
        '<!--FOLLOWUPS:[{"id":"","label":"l","prompt":"p","category":"c"},{"id":"a_b","label":"","prompt":"p","category":"c"},{"id":"x_y","label":"L","prompt":"P","category":"x"}]-->';
      expect(parseFollowupSuggestions(text)).toEqual([
        { category: "x", id: "x_y", label: "L", prompt: "P" }
      ]);
    });

    it("caps the result at FOLLOWUP_MAX_PER_MESSAGE", () => {
      const entries = Array.from({ length: 8 }, (_, index) => ({
        category: "c",
        id: `tag_${index}`,
        label: `L${index}`,
        prompt: `P${index}`
      }));
      const text = `<!--FOLLOWUPS:${JSON.stringify(entries)}-->`;
      expect(parseFollowupSuggestions(text)).toHaveLength(FOLLOWUP_MAX_PER_MESSAGE);
    });

    it("returns an empty array when the JSON inside the marker is malformed", () => {
      expect(parseFollowupSuggestions("<!--FOLLOWUPS:[invalid json]-->")).toEqual([]);
    });
  });

  describe("stripFollowupMarker", () => {
    it("removes the marker and trims trailing whitespace", () => {
      const text = "Body text\n<!--FOLLOWUPS:[{\"id\":\"a_b\",\"label\":\"L\",\"prompt\":\"P\",\"category\":\"a\"}]-->\n\n";
      expect(stripFollowupMarker(text)).toBe("Body text");
    });

    it("returns the original text untouched when no marker is present", () => {
      expect(stripFollowupMarker("clean body")).toBe("clean body");
    });
  });

  describe("followupActionId / truncateFollowupLabel / extractFollowupCategory", () => {
    it("prefixes the action_id with FOLLOWUP_ACTION_PREFIX and a dot", () => {
      expect(followupActionId({ category: "c", id: "tag_x", label: "L", prompt: "P" })).toBe("followup.tag_x");
      expect(FOLLOWUP_ACTION_PREFIX).toBe("followup");
    });

    it("preserves labels at or below the 75-character Slack limit", () => {
      const exact = "X".repeat(FOLLOWUP_MAX_LABEL_LENGTH);
      expect(truncateFollowupLabel(exact)).toBe(exact);
      expect(truncateFollowupLabel("short")).toBe("short");
    });

    it("truncates and appends a single-character ellipsis when label exceeds the limit", () => {
      const long = "X".repeat(FOLLOWUP_MAX_LABEL_LENGTH + 50);
      const result = truncateFollowupLabel(long);
      expect(result.length).toBe(FOLLOWUP_MAX_LABEL_LENGTH);
      expect(result.endsWith("…")).toBe(true);
    });

    it("derives the category from the prefix before the first underscore", () => {
      expect(extractFollowupCategory("jira_detail_X-1")).toBe("jira");
      expect(extractFollowupCategory("noprefix")).toBe("other");
      expect(extractFollowupCategory("_leading")).toBe("other");
    });
  });

  describe("renderFollowupSuggestionBlocks", () => {
    it("returns an empty array when no suggestions are provided", () => {
      expect(renderFollowupSuggestionBlocks([])).toEqual([]);
    });

    it("emits a single Block Kit actions block with one button per suggestion", () => {
      const blocks = renderFollowupSuggestionBlocks([
        { category: "a", id: "a_x", label: "Label A", prompt: "Prompt A" },
        { category: "b", id: "b_y", label: "Label B", prompt: "Prompt B" }
      ]);
      expect(blocks).toEqual([
        {
          elements: [
            {
              action_id: "followup.a_x",
              text: { emoji: true, text: "Label A", type: "plain_text" },
              type: "button",
              value: "Prompt A"
            },
            {
              action_id: "followup.b_y",
              text: { emoji: true, text: "Label B", type: "plain_text" },
              type: "button",
              value: "Prompt B"
            }
          ],
          type: "actions"
        }
      ]);
    });

    it("caps rendered buttons at FOLLOWUP_MAX_PER_MESSAGE", () => {
      const suggestions = Array.from({ length: 8 }, (_, index) => ({
        category: "c",
        id: `tag_${index}`,
        label: `L${index}`,
        prompt: `P${index}`
      }));
      const blocks = renderFollowupSuggestionBlocks(suggestions);
      const block = blocks[0] as { elements: unknown[] };
      expect(block.elements).toHaveLength(FOLLOWUP_MAX_PER_MESSAGE);
    });
  });

  describe("createFollowupSuggestionInteractionHandler", () => {
    function makePayload(overrides: Partial<{
      actionId: string;
      channelId: string;
      messageTs: string;
      userId: string;
      value: string;
    }> = {}): {
      actionId: string;
      channelId: string;
      messageTs: string;
      type: "block_actions";
      userId: string;
      value: string;
    } {
      return {
        actionId: overrides.actionId ?? "followup.jira_detail_X-1",
        channelId: overrides.channelId ?? "C1",
        messageTs: overrides.messageTs ?? "1.000",
        type: "block_actions" as const,
        userId: overrides.userId ?? "U1",
        value: overrides.value ?? "Show me X-1 details"
      };
    }

    it("records a click event with the extracted suggestion id and category, then runs the agent and posts the reply", async () => {
      const clicks: unknown[] = [];
      const ranWith: unknown[] = [];
      const posts: unknown[] = [];
      const store = {
        aggregateStats: () => ({ byCategory: [], ctr: 0, totalClicks: 0, totalImpressions: 0 }),
        recordClick: (event: unknown) => clicks.push(event),
        recordImpression: () => undefined
      };
      const handler = createFollowupSuggestionInteractionHandler({
        messageTransport: {
          postMessage: async (input) => {
            posts.push(input);
            return { ok: true, statusCode: 200, ts: "2.000" };
          }
        },
        runAgent: async (input) => {
          ranWith.push(input);
          return { text: "Detailed answer." };
        },
        store
      });

      const handled = await handler.handle(makePayload());
      expect(handled).toBe(true);
      expect(clicks).toEqual([
        {
          category: "jira",
          channelId: "C1",
          messageTs: "1.000",
          suggestionId: "jira_detail_X-1",
          userId: "U1"
        }
      ]);
      expect(ranWith).toEqual([
        expect.objectContaining({
          category: "jira",
          prompt: "Show me X-1 details",
          suggestionId: "jira_detail_X-1"
        })
      ]);
      expect(posts).toEqual([
        { channelId: "C1", text: "Detailed answer.", threadTs: "1.000" }
      ]);
    });

    it("is a no-op when the payload value (prompt) is missing", async () => {
      const ran = vi.fn(async () => ({ text: "won't run" }));
      const handler = createFollowupSuggestionInteractionHandler({ runAgent: ran });
      await handler.handle(makePayload({ value: "" }));
      expect(ran).not.toHaveBeenCalled();
    });

    it("does not post when the agent returns an empty response", async () => {
      const posts: unknown[] = [];
      const handler = createFollowupSuggestionInteractionHandler({
        messageTransport: {
          postMessage: async (input) => {
            posts.push(input);
            return { ok: true, statusCode: 200 };
          }
        },
        runAgent: async () => ({ text: "   " })
      });
      await handler.handle(makePayload());
      expect(posts).toHaveLength(0);
    });

    it("swallows agent execution errors via the logger callback", async () => {
      const errors: unknown[] = [];
      const handler = createFollowupSuggestionInteractionHandler({
        logger: (_message, error) => errors.push(error),
        runAgent: async () => {
          throw new Error("agent down");
        }
      });
      await expect(handler.handle(makePayload())).resolves.toBe(true);
      expect(errors).toHaveLength(1);
    });

    it("strips the followup. prefix from the action_id when computing the suggestion id", async () => {
      const ran = vi.fn(async () => ({ text: "ok" }));
      const handler = createFollowupSuggestionInteractionHandler({ runAgent: ran });
      await handler.handle(makePayload({ actionId: "followup.confluence_search_quick" }));
      expect(ran).toHaveBeenCalledWith(
        expect.objectContaining({ category: "confluence", suggestionId: "confluence_search_quick" })
      );
    });

    it("registers the FOLLOWUP_ACTION_PREFIX as the dispatcher actionIdPrefix", () => {
      const handler = createFollowupSuggestionInteractionHandler({ runAgent: async () => null });
      expect(handler.actionIdPrefix).toBe(FOLLOWUP_ACTION_PREFIX);
    });
  });
});

describe("Slack reminders", () => {
  describe("parseReminderTime", () => {
    const baseNow = new Date("2026-05-07T01:00:00.000Z");

    it("parses an English 'at HH:mm' suffix and removes it from the text", () => {
      const result = parseReminderTime("Coffee with team at 18:30", { now: () => baseNow, timezone: "UTC" });
      expect(result.cleanText).toBe("Coffee with team");
      expect(result.dueAt?.toISOString()).toBe("2026-05-07T18:30:00.000Z");
    });

    it("parses a Korean 'N시 M분에' suffix and removes it from the text", () => {
      const result = parseReminderTime("회의 준비 9시 30분에", { now: () => baseNow, timezone: "UTC" });
      expect(result.cleanText).toBe("회의 준비");
      expect(result.dueAt?.toISOString()).toBe("2026-05-07T09:30:00.000Z");
    });

    it("rolls past times to the next day", () => {
      const result = parseReminderTime("Standup at 0:30", {
        now: () => new Date("2026-05-07T01:00:00.000Z"),
        timezone: "UTC"
      });
      expect(result.dueAt?.toISOString()).toBe("2026-05-08T00:30:00.000Z");
    });

    it("returns the original text without dueAt when no time expression is present", () => {
      const result = parseReminderTime("just a note", { now: () => baseNow, timezone: "UTC" });
      expect(result).toEqual({ cleanText: "just a note" });
    });

    it("rejects malformed time values (hour out of range)", () => {
      const result = parseReminderTime("bad at 99:00", { now: () => baseNow, timezone: "UTC" });
      expect(result.dueAt).toBeUndefined();
    });
  });

  describe("InMemoryReminderStore", () => {
    it("assigns sequential per-user ids and returns them sorted", () => {
      const store = new InMemoryReminderStore({ now: () => new Date("2026-05-07T00:00:00.000Z"), timezone: "UTC" });
      store.add("U1", "first");
      store.add("U1", "second");
      store.add("U2", "other");
      expect(store.list("U1").map((r) => `${r.id}:${r.text}`)).toEqual(["1:first", "2:second"]);
      expect(store.list("U2").map((r) => `${r.id}:${r.text}`)).toEqual(["1:other"]);
    });

    it("trims overflow once max-per-user is exceeded", () => {
      const store = new InMemoryReminderStore({
        maxPerUser: 2,
        now: () => new Date("2026-05-07T00:00:00.000Z"),
        timezone: "UTC"
      });
      store.add("U1", "a");
      store.add("U1", "b");
      store.add("U1", "c");
      expect(store.list("U1").map((r) => r.text)).toEqual(["b", "c"]);
    });

    it("removes a reminder by id with done() and reports null when missing", () => {
      const store = new InMemoryReminderStore({ now: () => new Date(), timezone: "UTC" });
      const created = store.add("U1", "do");
      expect(store.done("U1", created.id)?.text).toBe("do");
      expect(store.done("U1", created.id)).toBeUndefined();
    });

    it("clears all reminders for a user and returns the prior count", () => {
      const store = new InMemoryReminderStore({ now: () => new Date(), timezone: "UTC" });
      store.add("U1", "a");
      store.add("U1", "b");
      expect(store.clear("U1")).toBe(2);
      expect(store.list("U1")).toEqual([]);
    });

    it("collectDue returns and removes reminders whose dueAt has passed", () => {
      let now = new Date("2026-05-07T00:00:00.000Z");
      const store = new InMemoryReminderStore({ now: () => now, timezone: "UTC" });
      store.add("U1", "early at 0:30");
      store.add("U1", "later at 23:30");
      now = new Date("2026-05-07T01:00:00.000Z");
      const due = store.collectDue(now);
      expect(due.map((entry) => `${entry.userId}:${entry.reminder.text}`)).toEqual(["U1:early"]);
      expect(store.list("U1").map((r) => r.text)).toEqual(["later"]);
    });
  });

  describe("createSlackReminderPoller", () => {
    it("dispatches due reminders as bell DMs via the message transport", async () => {
      const posted: { channelId: string; text: string }[] = [];
      const transport = {
        postMessage: async (input: { channelId: string; text: string }) => {
          posted.push({ channelId: input.channelId, text: input.text });
          return { ok: true, statusCode: 200 };
        }
      };
      let now = new Date("2026-05-07T00:00:00.000Z");
      const store = new InMemoryReminderStore({ now: () => now, timezone: "UTC" });
      store.add("U1", "review at 0:30");
      now = new Date("2026-05-07T01:00:00.000Z");

      const poller = createSlackReminderPoller({ messageTransport: transport, now: () => now, store });
      await poller.tick();

      expect(posted).toEqual([
        {
          channelId: "U1",
          text: ":bell: *Reminder #1*\nreview"
        }
      ]);
    });

    it("does not throw when the transport rejects (logger receives the error)", async () => {
      const errors: unknown[] = [];
      let now = new Date("2026-05-07T00:00:00.000Z");
      const store = new InMemoryReminderStore({ now: () => now, timezone: "UTC" });
      store.add("U1", "review at 0:30");
      now = new Date("2026-05-07T01:00:00.000Z");
      const poller = createSlackReminderPoller({
        logger: (_message, error) => errors.push(error),
        messageTransport: {
          postMessage: async () => {
            throw new Error("slack down");
          }
        },
        now: () => now,
        store
      });

      await expect(poller.tick()).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
    });
  });

  describe("handleSlackReminderCommand", () => {
    it("registers a reminder with `add` and echoes the assigned id", () => {
      const store = new InMemoryReminderStore({ now: () => new Date("2026-05-07T00:00:00.000Z"), timezone: "UTC" });
      const result = handleSlackReminderCommand(store, "U1", "add 회의 9시 30분에");
      expect(result.text).toContain("리마인더 #1 등록");
      expect(result.text).toContain("회의");
    });

    it("returns 'no reminders' when the user has none and `list` is requested", () => {
      const store = new InMemoryReminderStore({ now: () => new Date(), timezone: "UTC" });
      expect(handleSlackReminderCommand(store, "U1", "list").text).toBe("리마인더가 없어요.");
    });

    it("removes a reminder via `done <id>` and reports missing ids gracefully", () => {
      const store = new InMemoryReminderStore({ now: () => new Date(), timezone: "UTC" });
      store.add("U1", "task");
      expect(handleSlackReminderCommand(store, "U1", "done 1").text).toContain("완료 처리");
      expect(handleSlackReminderCommand(store, "U1", "done 1").text).toContain("찾을 수 없어요");
    });

    it("clears all reminders via `clear`", () => {
      const store = new InMemoryReminderStore({ now: () => new Date(), timezone: "UTC" });
      store.add("U1", "a");
      store.add("U1", "b");
      expect(handleSlackReminderCommand(store, "U1", "clear").text).toContain("2건 삭제");
      expect(store.list("U1")).toEqual([]);
    });

    it("returns help text for unknown subcommands", () => {
      const store = new InMemoryReminderStore({ now: () => new Date(), timezone: "UTC" });
      expect(handleSlackReminderCommand(store, "U1", "explode").text).toContain("지원하는 명령");
    });
  });
});

describe("createSloAlertHook", () => {
  function makeEvaluator(): {
    samples: { latencies: number[]; results: boolean[]; alerts: number };
    evaluator: {
      recordLatency: (ms: number) => void;
      recordResult: (success: boolean) => void;
      evaluate: () => Array<{ type: string; currentValue: number; threshold: number; message: string; at: Date }>;
    };
  } {
    const latencies: number[] = [];
    const results: boolean[] = [];
    let alertsRequested = 0;
    return {
      evaluator: {
        evaluate: () => {
          alertsRequested += 1;
          return alertsRequested === 2
            ? [{ at: new Date(), currentValue: 5_000, message: "P95 too high", threshold: 1_000, type: "latency" }]
            : [];
        },
        recordLatency: (ms) => {
          latencies.push(ms);
        },
        recordResult: (success) => {
          results.push(success);
        }
      },
      samples: {
        get alerts() {
          return alertsRequested;
        },
        latencies,
        results
      }
    };
  }

  function makeContext(runId: string, startedAtMs: number): AgentRunContext {
    return {
      input: { messages: [], model: "test-model" },
      runId,
      startedAt: new Date(startedAtMs)
    };
  }

  it("records a successful latency and result on afterComplete", async () => {
    const { evaluator, samples } = makeEvaluator();
    let now = 1_000_000;
    const hook = createSloAlertHook({ evaluator: evaluator as never, now: () => now });
    const context = makeContext("run-ok", now);

    await hook.beforeStart?.(context);
    now += 750;
    await hook.afterComplete?.(context, { id: "r", model: "m", output: "" });

    expect(samples.latencies).toEqual([750]);
    expect(samples.results).toEqual([true]);
  });

  it("records a failed latency and result on onError", async () => {
    const { evaluator, samples } = makeEvaluator();
    let now = 1_000_000;
    const hook = createSloAlertHook({ evaluator: evaluator as never, now: () => now });
    const context = makeContext("run-fail", now);

    await hook.beforeStart?.(context);
    now += 1_500;
    await hook.onError?.(context, new Error("boom"));

    expect(samples.latencies).toEqual([1_500]);
    expect(samples.results).toEqual([false]);
  });

  it("invokes the notify callback when the evaluator surfaces violations", async () => {
    const { evaluator } = makeEvaluator();
    const notified: unknown[] = [];
    let now = 1_000_000;
    const hook = createSloAlertHook({
      evaluator: evaluator as never,
      notify: async (violations) => {
        notified.push(violations);
      },
      now: () => now
    });

    const ctx1 = makeContext("r1", now);
    await hook.beforeStart?.(ctx1);
    now += 500;
    await hook.afterComplete?.(ctx1, { id: "r", model: "m", output: "" });

    now += 100;
    const ctx2 = makeContext("r2", now);
    await hook.beforeStart?.(ctx2);
    now += 6_000;
    await hook.afterComplete?.(ctx2, { id: "r", model: "m", output: "" });

    expect(notified).toHaveLength(1);
    expect((notified[0] as Array<{ type: string }>)[0]).toMatchObject({ type: "latency" });
  });

  it("swallows notify errors and reports through the optional logger", async () => {
    const { evaluator } = makeEvaluator();
    const errors: unknown[] = [];
    let now = 1_000_000;
    const hook = createSloAlertHook({
      evaluator: evaluator as never,
      logger: (_message, error) => errors.push(error),
      notify: async () => {
        throw new Error("notify down");
      },
      now: () => now
    });

    const ctx1 = makeContext("r1", now);
    await hook.beforeStart?.(ctx1);
    now += 100;
    await hook.afterComplete?.(ctx1, { id: "r", model: "m", output: "" });

    now += 100;
    const ctx2 = makeContext("r2", now);
    await hook.beforeStart?.(ctx2);
    now += 100;
    await expect(hook.afterComplete?.(ctx2, { id: "r", model: "m", output: "" })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("uses the configurable hook id", () => {
    const { evaluator } = makeEvaluator();
    const hook = createSloAlertHook({ evaluator: evaluator as never, id: "custom-slo" });
    expect(hook.id).toBe("custom-slo");
  });
});

describe("createPromptDriftHook", () => {
  function makeDetector(): {
    detector: {
      recordInput: (length: number) => void;
      recordOutput: (length: number) => void;
      evaluate: () => Array<{ type: string }>;
    };
    inputs: number[];
    outputs: number[];
    queue: Array<Array<{ type: string }>>;
  } {
    const inputs: number[] = [];
    const outputs: number[] = [];
    const queue: Array<Array<{ type: string }>> = [];
    return {
      detector: {
        evaluate: () => queue.shift() ?? [],
        recordInput: (length) => {
          inputs.push(length);
        },
        recordOutput: (length) => {
          outputs.push(length);
        }
      },
      inputs,
      outputs,
      queue
    };
  }

  function makeContext(messages: Array<{ role: "user" | "system"; content: string }>): AgentRunContext {
    return {
      input: { messages, model: "test-model" },
      runId: "drift-run",
      startedAt: new Date()
    };
  }

  it("records the total input length on beforeStart and the output length on afterComplete", async () => {
    const { detector, inputs, outputs } = makeDetector();
    const hook = createPromptDriftHook({ detector: detector as never });
    const context = makeContext([
      { content: "hello", role: "user" },
      { content: "world!", role: "user" }
    ]);

    await hook.beforeStart?.(context);
    await hook.afterComplete?.(context, { id: "r", model: "m", output: "response text" });

    expect(inputs).toEqual([11]); // "hello" + "world!"
    expect(outputs).toEqual(["response text".length]);
  });

  it("forwards drift anomalies through the notify callback", async () => {
    const { detector, queue } = makeDetector();
    queue.push([{ type: "input_length" }]);
    const notified: unknown[] = [];
    const hook = createPromptDriftHook({
      detector: detector as never,
      notify: async (anomalies) => {
        notified.push(anomalies);
      }
    });
    await hook.beforeStart?.(makeContext([{ content: "x", role: "user" }]));
    await hook.afterComplete?.(
      makeContext([{ content: "x", role: "user" }]),
      { id: "r", model: "m", output: "y" }
    );
    expect(notified).toHaveLength(1);
  });

  it("swallows notify failures via the optional logger", async () => {
    const { detector, queue } = makeDetector();
    queue.push([{ type: "output_length" }]);
    const errors: unknown[] = [];
    const hook = createPromptDriftHook({
      detector: detector as never,
      logger: (_message, error) => errors.push(error),
      notify: async () => {
        throw new Error("notify down");
      }
    });
    await hook.beforeStart?.(makeContext([{ content: "x", role: "user" }]));
    await expect(
      hook.afterComplete?.(
        makeContext([{ content: "x", role: "user" }]),
        { id: "r", model: "m", output: "y" }
      )
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("does not call notify when no anomalies are returned", async () => {
    const { detector } = makeDetector();
    const notified: unknown[] = [];
    const hook = createPromptDriftHook({
      detector: detector as never,
      notify: async (anomalies) => {
        notified.push(anomalies);
      }
    });
    await hook.beforeStart?.(makeContext([{ content: "x", role: "user" }]));
    await hook.afterComplete?.(
      makeContext([{ content: "x", role: "user" }]),
      { id: "r", model: "m", output: "y" }
    );
    expect(notified).toHaveLength(0);
  });
});
