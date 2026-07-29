/**
 * Core100-061 read-only projection.
 *
 * Reuses the exact public tool inventory and reviewed authority classes from
 * Task 012. It never infers authority from a name, risk label, or action verb.
 */

import { createPermissionGapReport } from "./permission-gap-report.mjs";

const ACTION_FAMILIES = Object.freeze([
  Object.freeze({
    action: "inspect",
    publicTools: Object.freeze([
      "browser_open",
      "browser_read",
      "browser_back",
      "browser_look",
      "browser_scroll",
      "browser_wait",
      "browser_hover"
    ])
  }),
  Object.freeze({
    action: "fill",
    publicTools: Object.freeze(["browser_type", "browser_fill_form"])
  }),
  Object.freeze({
    action: "submit",
    publicTools: Object.freeze([
      "browser_click",
      "browser_key",
      "browser_dialog_decide",
      "web_action"
    ])
  }),
  Object.freeze({
    action: "upload",
    publicTools: Object.freeze(["browser_upload"])
  }),
  Object.freeze({
    action: "download",
    publicTools: Object.freeze(["web_download"])
  }),
  Object.freeze({
    action: "clipboard",
    publicTools: Object.freeze(["mac_clipboard_set", "win_clipboard_set"])
  }),
  Object.freeze({
    action: "screen",
    publicTools: Object.freeze(["mac_screen_read", "mac_screenshot", "win_screenshot"])
  }),
  Object.freeze({
    action: "process",
    publicTools: Object.freeze([
      "mac_app_open",
      "mac_media_control",
      "mac_say",
      "mac_shortcut_run",
      "mac_system_set",
      "win_app_open",
      "win_media_control",
      "win_say",
      "win_system_set"
    ])
  })
]);

/**
 * @param {{ readonly env?: Record<string, string | undefined> }} [options]
 */
export async function createBrowserComputerAuthorityGapReport(options = {}) {
  const source = await createPermissionGapReport(options);
  const toolRows = new Map(
    source.rows
      .filter((row) => row.surface === "tool")
      .map((row) => [row.name, row])
  );
  const actions = ACTION_FAMILIES.map((family) => {
    const tools = family.publicTools.map((name) => {
      const row = toolRows.get(name);
      return Object.freeze({
        authorityClass: row?.authorityClass ?? "unmapped",
        cataloguedInPermissionReport: row !== undefined,
        name
      });
    });
    const classes = new Set(tools.map((tool) => tool.authorityClass));
    const authorityClass = tools.every(
      (tool) => tool.cataloguedInPermissionReport && tool.authorityClass !== "unmapped"
    ) && classes.size === 1
      ? tools[0].authorityClass
      : "unmapped";
    return Object.freeze({
      action: family.action,
      authorityClass,
      tools: Object.freeze(tools)
    });
  });
  return Object.freeze({
    actions: Object.freeze(actions),
    schemaVersion: 1,
    sourcePermissionReportSchemaVersion: source.schemaVersion
  });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.stdout.write(
    `${JSON.stringify(await createBrowserComputerAuthorityGapReport(), null, 2)}\n`
  );
}
