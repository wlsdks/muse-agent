import React, { useState } from "react";
import { Box, Text, render, useInput } from "ink";

export interface MuseStatusTuiModel {
  readonly apiUrl: string;
  readonly auth?: {
    readonly hasToken: boolean;
  };
  readonly chat?: {
    readonly defaultModel?: string;
  };
  readonly configPath: string;
  readonly credentialPath: string;
  readonly mode: "local" | "remote";
  readonly workspaceRunsPath: string;
}

export function MuseStatusTui({ model }: { readonly model: MuseStatusTuiModel }): React.ReactElement {
  const [panel, setPanel] = useState<"auth" | "chat" | "config">("chat");

  useInput((input, key) => {
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
        React.createElement(Text, null, `Runs: ${model.workspaceRunsPath}`))
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

export async function renderMuseStatusTui(model: MuseStatusTuiModel): Promise<void> {
  const instance = render(React.createElement(MuseStatusTui, { model }));
  await instance.waitUntilExit();
}
