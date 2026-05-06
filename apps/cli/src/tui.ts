import React from "react";
import { Box, Text, render } from "ink";

export interface MuseStatusTuiModel {
  readonly apiUrl: string;
  readonly configPath: string;
  readonly credentialPath: string;
  readonly mode: "local" | "remote";
  readonly workspaceRunsPath: string;
}

export function MuseStatusTui({ model }: { readonly model: MuseStatusTuiModel }): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, "Muse"),
    React.createElement(Text, null, `Mode: ${model.mode}`),
    React.createElement(Text, null, `API: ${model.apiUrl}`),
    React.createElement(Text, null, `Config: ${model.configPath}`),
    React.createElement(Text, null, `Credentials: ${model.credentialPath}`),
    React.createElement(Text, null, `Runs: ${model.workspaceRunsPath}`)
  );
}

export async function renderMuseStatusTui(model: MuseStatusTuiModel): Promise<void> {
  const instance = render(React.createElement(MuseStatusTui, { model }));
  await instance.waitUntilExit();
}
