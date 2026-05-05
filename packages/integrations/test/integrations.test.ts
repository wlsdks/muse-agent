import { describe, expect, it } from "vitest";
import {
  CommandRouter,
  FetchSlackResponseUrlTransport,
  FetchSlackWebApiMessageTransport,
  SlackInteractionDispatcher,
  SlackSignatureVerifier,
  WebhookDispatcher,
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
});

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
