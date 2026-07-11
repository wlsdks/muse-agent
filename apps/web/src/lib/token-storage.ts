export function readToken(): string {
  try {
    return window.localStorage.getItem("muse.token") ?? "";
  } catch {
    return "";
  }
}
