import { parseBooleanFromEnv } from "@muse/shared";

/**
 * Deterministic, env-aware "here's what I can actually DO" describer — the ONE
 * honest capability answer every meta surface ("뭐 할 수 있어?" / "what can you
 * do?") returns instead of a notes-only static string or a free-composed
 * over-claim on the local model. Job-grouped (memory · calendar/reminders ·
 * briefings · grounded search · actions · chat channel · orchestration) so a
 * user (and Muse itself) can state the product's real value, and env-aware so
 * an integration that needs setup is shown as "available — set X", never as
 * "connected" (this is the surface that must NOT over-claim). It replaced a
 * string written precisely to stop the local model inventing capabilities, so
 * it is pure code — never model-generated.
 *
 * Lives in @muse/prompts because BOTH apps/cli (ask + chat fast-paths) and
 * apps/api (the Telegram channel meta path) must share ONE describer; drifting
 * copies would re-open the exact "each surface answers differently" legibility
 * gap this closes.
 */

/**
 * Only the env fields the describer reads — a narrow shape so this module adds
 * no dependency on @muse/autoconfigure. `MuseEnvironment` (an index signature)
 * and `process.env` are both structurally assignable to it.
 */
export interface CapabilityEnv {
  readonly MUSE_GMAIL_TOKEN?: string;
  readonly MUSE_HOMEASSISTANT_URL?: string;
  readonly MUSE_HOMEASSISTANT_TOKEN?: string;
  readonly MUSE_TELEGRAM_BOT_TOKEN?: string;
  readonly MUSE_MACOS_ACTUATORS?: string;
}

function present(value?: string): boolean {
  return Boolean(value?.trim());
}

function enabled(value?: string): boolean {
  return parseBooleanFromEnv(value, false);
}

/**
 * Honest status of one integration: "connected" when its env is armed, else the
 * exact setup command to arm it — never claiming a capability the user hasn't
 * set up.
 */
function status(armed: boolean, setupEnv: string, korean: boolean): string {
  if (armed) {
    return korean ? "연결됨" : "connected";
  }
  return korean ? `사용 가능 — \`set ${setupEnv}\`` : `available — \`set ${setupEnv}\``;
}

function describeKo(env: CapabilityEnv): string {
  const email = status(present(env.MUSE_GMAIL_TOKEN), "MUSE_GMAIL_TOKEN", true);
  const home = status(present(env.MUSE_HOMEASSISTANT_URL) && present(env.MUSE_HOMEASSISTANT_TOKEN), "MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN", true);
  const mac = status(enabled(env.MUSE_MACOS_ACTUATORS), "MUSE_MACOS_ACTUATORS=1", true);
  const telegram = status(present(env.MUSE_TELEGRAM_BOT_TOKEN), "MUSE_TELEGRAM_BOT_TOKEN", true);
  return [
    "네 기기에서만 도는 개인 JARVIS — 근거를 대며 답하고, 승인을 받고 실행하며, 너를 학습해. 내가 해줄 수 있는 것:",
    "• 기억·노트 — 무엇이든 기억하고(`muse remember`) 의미로 다시 찾아줘(`muse recall`), 한 줄 캡처는 `muse note`",
    "• 일정·리마인더 — 일정·할 일·알림을 관리해(`muse calendar`, `muse tasks`, `muse remind`)",
    "• 브리핑·다이제스트 — 아침 브리핑과 하루 요약을 알아서 챙겨(`muse brief`, `muse today`)",
    "• 검색·근거 — 네 노트에 근거해 출처까지 인용해 답하고, 모르면 \"잘 모르겠어\"라고 솔직히 말해(`muse ask`)",
    `• 실행 (승인 후에만) — 이메일: ${email} · 브라우저 제어: 사용 가능(\`muse ask --with-tools\`) · 스마트홈: ${home} · macOS 제어: ${mac}`,
    `• 대화 채널 — 텔레그램으로 어디서든 대화: ${telegram}`,
    "• 오케스트레이션 — 큰 일을 여러 하위 에이전트로 나눠 수행(`muse orchestrate`, `muse board`)",
    "전부 이 기기 안에서 로컬로 처리되고, 밖으로 나가지 않아."
  ].join("\n");
}

function describeEn(env: CapabilityEnv): string {
  const email = status(present(env.MUSE_GMAIL_TOKEN), "MUSE_GMAIL_TOKEN", false);
  const home = status(present(env.MUSE_HOMEASSISTANT_URL) && present(env.MUSE_HOMEASSISTANT_TOKEN), "MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN", false);
  const mac = status(enabled(env.MUSE_MACOS_ACTUATORS), "MUSE_MACOS_ACTUATORS=1", false);
  const telegram = status(present(env.MUSE_TELEGRAM_BOT_TOKEN), "MUSE_TELEGRAM_BOT_TOKEN", false);
  return [
    "Your personal JARVIS that runs only on your machine — I answer with grounded citations, act only with your approval, and learn you. Here's what I can do:",
    "• Memory & notes — remember anything (`muse remember`) and find it again by meaning (`muse recall`); quick capture with `muse note`",
    "• Calendar & reminders — manage your calendar, tasks, and reminders (`muse calendar`, `muse tasks`, `muse remind`)",
    "• Briefings & digests — a morning brief and a daily recap, handled for you (`muse brief`, `muse today`)",
    "• Search & grounding — answer from your own notes and quote the exact source, and say \"I'm not sure\" instead of guessing (`muse ask`)",
    `• Actions (only after you approve) — Email: ${email} · Browser control: available (\`muse ask --with-tools\`) · Smart home: ${home} · macOS control: ${mac}`,
    `• Chat channel — talk to me anywhere over Telegram: ${telegram}`,
    "• Orchestration — break a big job across sub-agents (`muse orchestrate`, `muse board`)",
    "Everything runs locally on this device and nothing leaves it."
  ].join("\n");
}

/** Korean capability answer for the given armed-integration env. Deterministic. */
export function describeCapabilitiesKo(env: CapabilityEnv): string {
  return describeKo(env);
}

/** English capability answer for the given armed-integration env. Deterministic. */
export function describeCapabilitiesEn(env: CapabilityEnv): string {
  return describeEn(env);
}

/**
 * The honest, job-grouped capability answer — Korean by default (Muse's default
 * language), English when `korean` is false. Deterministic: same env + language
 * always yields the same string.
 */
export function describeCapabilities(env: CapabilityEnv, korean = true): string {
  return korean ? describeKo(env) : describeEn(env);
}
