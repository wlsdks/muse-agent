import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
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
  FetchSlackResponseUrlTransport,
  FetchSlackWebApiMessageTransport,
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
});
