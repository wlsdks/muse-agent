import React, { useState } from "react";
import { Box, Text, render, useInput } from "ink";

export interface MuseTuiChatTurn {
  readonly assistant: string;
  readonly user: string;
}

export interface MuseStatusTuiModel {
  readonly apiUrl: string;
  readonly auth?: {
    readonly hasToken: boolean;
  };
  readonly chat?: {
    readonly defaultModel?: string;
    readonly submit?: (message: string) => Promise<string>;
  };
  readonly configPath: string;
  readonly credentialPath: string;
  readonly mode: "local" | "remote";
  readonly workspaceRunsPath: string;
}

function MuseStatusTui({ model }: { readonly model: MuseStatusTuiModel }): React.ReactElement {
  const [panel, setPanel] = useState<"auth" | "chat" | "config">("chat");
  const [chatInput, setChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState<"idle" | "running">("idle");
  const [chatTurns, setChatTurns] = useState<readonly MuseTuiChatTurn[]>([]);
  const [chatError, setChatError] = useState<string | undefined>();

  useInput((input, key) => {
    if (panel === "chat" && model.chat?.submit) {
      if (key.return && chatInput.trim().length > 0 && chatStatus !== "running") {
        const message = chatInput.trim();
        setChatInput("");
        setChatError(undefined);
        setChatStatus("running");
        void model.chat.submit(message)
          .then((assistant) => {
            setChatTurns((turns) => appendChatTurn(turns, { assistant, user: message }));
          })
          .catch((error: unknown) => {
            setChatError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => setChatStatus("idle"));
        return;
      }

      if (key.backspace || key.delete) {
        setChatInput((current) => current.slice(0, -1));
        return;
      }

      if (!key.ctrl && !key.meta && input.length > 0) {
        setChatInput((current) => `${current}${input}`);
        return;
      }
    }

    if (key.tab) {
      setPanel((current) => current === "chat" ? "auth" : current === "auth" ? "config" : "chat");
    }

    if (input === "1") {
      setPanel("chat");
    }

    if (input === "2") {
      setPanel("auth");
    }

    if (input === "3") {
      setPanel("config");
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, "Muse"),
    React.createElement(Text, null, "[1] Chat  [2] Auth  [3] Config  [tab] switch"),
    React.createElement(Text, null, `Mode: ${model.mode}`),
    React.createElement(Text, null, `API: ${model.apiUrl}`),
    panel === "chat"
      ? React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { bold: true }, "Chat"),
        React.createElement(Text, null, `Default model: ${model.chat?.defaultModel ?? "not configured"}`),
        React.createElement(Text, null, `Runs: ${model.workspaceRunsPath}`),
        React.createElement(Text, null, `Status: ${chatStatus}`),
        React.createElement(Text, null, `> ${chatInput}`),
        ...chatTurns.map((turn, index) => React.createElement(Box, {
          flexDirection: "column",
          key: `turn-${index}`,
          marginTop: 1
        },
        React.createElement(Text, null, `You: ${turn.user}`),
        React.createElement(Text, null, `Muse: ${turn.assistant}`))),
        chatError ? React.createElement(Text, { color: "red" }, `Error: ${chatError}`) : undefined)
      : undefined,
    panel === "auth"
      ? React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { bold: true }, "Auth"),
        React.createElement(Text, null, model.auth?.hasToken ? "Stored token: yes" : "Stored token: no"),
        React.createElement(Text, null, `Credentials: ${model.credentialPath}`))
      : undefined,
    panel === "config"
      ? React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { bold: true }, "Config"),
        React.createElement(Text, null, `Config: ${model.configPath}`))
      : undefined
  );
}

export function appendChatTurn(
  turns: readonly MuseTuiChatTurn[],
  turn: MuseTuiChatTurn
): readonly MuseTuiChatTurn[] {
  return [...turns, turn];
}

export async function renderMuseStatusTui(model: MuseStatusTuiModel): Promise<void> {
  const instance = render(React.createElement(MuseStatusTui, { model }));
  await instance.waitUntilExit();
}
