/**
 * Deterministic casual / social-prompt detector for the recall surface. A bare
 * "hi" / "thanks" / "bye" is NOT a question about the user's notes, yet it
 * currently runs the whole grounding pipeline — retrieval, the empty-corpus
 * on-ramp, a fabricated `[action: …]` citation the gate then strips, and a
 * "treat as unverified" grounding warning on the word "Hello!". tool-calling.md
 * is explicit: do not invoke the retrieval machinery on a greeting. This
 * classifies a PURE social prompt so the caller can answer it conversationally
 * and skip all of that.
 *
 * PRECISION-FIRST: only a short query whose WHOLE content is a social phrase
 * matches (anchored), so "hi, what's my rent?" or "thanks — when is the dentist?"
 * fall through to the normal grounded path. A miss costs nothing (normal path);
 * a false positive would skip grounding on a real question, so the bar is high.
 */

export type CasualPromptKind = "greeting" | "thanks" | "farewell";

const CASUAL_PATTERNS: ReadonlyArray<{ readonly kind: CasualPromptKind; readonly re: RegExp }> = [
  { kind: "greeting", re: /^(hi+|hey+|hello+|helo|yo|hiya|howdy|sup|gm|good morning|good evening|good afternoon|안녕|안녕하세요|하이|헬로|여보세요|좋은\s?아침|좋은\s?저녁|좋은\s?밤|좋은\s?오후|좋은\s?하루|굿모닝|굿이브닝)( there| muse|이야|이에요|예요|요|입니다|하세요)?$/u },
  { kind: "thanks", re: /^(thanks?|thank you|thanks a lot|thank u|thx|ty|tysm|cheers|much appreciated|appreciate it|고마워|고마워요|고맙습니다|감사|감사해|감사해요|감사합니다|땡큐|수고(했어|했어요|하셨어요|해)?)$/u },
  { kind: "farewell", re: /^(bye+|bye bye|goodbye|good bye|see you|see ya|see you later|cya|later|good ?night|take care|잘있어|잘 있어|안녕히|안녕히 계세요|잘가|잘 가|바이|다음에 봐|잘\s?자(요|라)?|굿나잇|굿밤|푹\s?자(요)?)$/u }
];

function normalizeSocialPrompt(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[!?.…~,\s]+$/u, "")
    .replace(/\s+/gu, " ");
}

/**
 * The social kind of a prompt, or `null` for anything that carries an actual
 * request. Normalises case, collapses whitespace, and strips trailing social
 * punctuation ("hi!!!" → "hi") before matching the anchored patterns. A query
 * longer than 30 chars is never casual (it carries content).
 */
export function classifyCasualPrompt(query: string): CasualPromptKind | null {
  const normalized = normalizeSocialPrompt(query);
  if (normalized.length === 0 || normalized.length > 30) {
    return null;
  }
  for (const { kind, re } of CASUAL_PATTERNS) {
    if (re.test(normalized)) {
      return kind;
    }
  }
  return null;
}

// A self-referential question ABOUT Muse ("what can you do", "넌 뭐야") — not a
// question about the user's notes. The local model otherwise free-composes an
// aspirational, often OVER-CLAIMED answer ("I can manage your schedule…") and
// gets a grounding warning. Anchored so "what can you do about my taxes" or
// "how do you cook rice" never match — only a whole-query meta phrase does.
const META_PROMPT_RE =
  /^(what can you (do|help( me)? with)|what do you do|what are you|who are you|what'?s? (is )?muse|how (do|does) (you|this|it) work|what can (i|you) ask|help|(너|넌|니)?\s?뭐\s?할\s?수\s?있어|뭐\s?할\s?줄\s?알아|무엇을?\s?할\s?수\s?있어|넌?\s?뭐야|너\s?뭐야|누구야|어떻게\s?(작동|동작)해|뭐\s?하는\s?(애|거)야|도움말|사용법)$/u;

/** True when the prompt asks about MUSE ITSELF (capabilities / identity / usage). */
export function classifyMetaPrompt(query: string): boolean {
  const normalized = normalizeSocialPrompt(query);
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }
  return META_PROMPT_RE.test(normalized);
}

// A request to OVERVIEW the whole note corpus ("what's in my notes?", "summarize
// my notes", "list my notes", "what notes do I have") rather than a specific
// question. Top-K recall ranks every note weakly for such an aggregate query, so
// the confidence gate refuses and the warm-close tells a user WHO HAS NOTES to
// "add a note" — which is nonsensical. Detect it so the caller can list the
// corpus instead. Each pattern anchors the overview verb DIRECTLY on "(my)
// notes" (no topic between), so "summarize my VPN notes" (a subset) doesn't match.
const OVERVIEW_PATTERNS: readonly RegExp[] = [
  /\b(summar(y|ise|ize)|overview|list|show|catalog|inventory|recap)\s+(me\s+|of\s+)?(all\s+)?(my\s+|the\s+)?notes\b/u,
  /\bwhat'?s\s+in\s+(all\s+)?(my\s+)?notes\b/u,
  /\bwhat\s+(notes\s+(do\s+i\s+have|are\s+there|exist)|do\s+i\s+have\s+(in\s+)?(my\s+)?notes)\b/u,
  /\b(how\s+many|which)\s+notes\b/u,
  /(내|제)\s*노트(들)?\s*(요약|목록|뭐|어떤|몇|있|정리)/u,
  /노트\s*(목록|요약|정리)/u
];

// An IMPERATIVE request to DO something (set a reminder, add a task, send an
// email) rather than a question. On the chat-only (no-tools) path the model
// happily says "I'll remind you…" — a FALSE PROMISE, because nothing was
// actually done. Detect it so the caller can honestly point the user at the
// `--with-tools` path that can actually act. Anchored on the action verb at the
// start (after an optional polite/request lead) so a QUESTION about an action
// ("what reminders do I have?", "when is my dentist reminder?") does NOT match.
const ACTION_REQUEST_RE =
  /^(please\s+|pls\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i'?d?\s+(like|want)\s+(you\s+)?to\s+)?(remind\s+me|set\s+(up\s+)?(an?\s+)?reminder|add\s+(an?\s+)?(reminder|task|to-?do|event)|create\s+(an?\s+)?(reminder|task|event)|make\s+(an?\s+)?(reminder|task|note)|schedule\s+(an?\s+)?\w|book\s+\w|email\s+\w|send\s+\w+\s+(an?\s+)?(email|message|text|note)|text\s+\w|message\s+\w)/u;

// A code/file TOKEN: a filename ending in a CODE EXTENSION, optionally preceded
// by a path. The code-extension FILENAME is the unambiguous structural signal —
// no ordinary English word is "name.ts", so requiring it engages the code-fix
// backstop ONLY on a real file reference. A bare verb+noun heuristic cannot do
// this (every code noun class/test/error/variable/import has a non-code sense →
// "fix the variable rate mortgage"), and NEITHER can a bare path prefix
// (app/build/tests/lib are common words → "update my app/website",
// "change my tests/quizzes"). So a path is only a signal when it leads to a `name.<code-ext>`.
const FILE_PATH_TOKEN =
  "(?:[\\w.~/-]*/)?[\\w-]+\\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|cpp?|hpp?|cs|rb|php|swift|kt|scala|sh|bash|zsh|sql|md|json|ya?ml|toml|ini|cfg|conf|css|scss|html?|xml|svg)\\b";

// A COMPUTER-CONTROL code-fix request: an imperative edit verb (START-anchored,
// polite-lead optional, so a QUESTION — "how do I fix add.ts", "what's in
// add.ts" — never matches) + an explicit file/path within the clause.
const CODE_ACTION_REQUEST_RE = new RegExp(
  `^(?:please\\s+|pls\\s+|can\\s+you\\s+|could\\s+you\\s+|would\\s+you\\s+|i'?d?\\s+(?:like|want)\\s+(?:you\\s+)?to\\s+)?(?:fix|edit|modify|update|change|refactor|rename|implement|patch|correct|debug|rewrite|replace)\\b[^.?!]{0,80}?${FILE_PATH_TOKEN}`,
  "u"
);

// Korean code-fix request: an explicit file/path + a KO edit verb. Phrase-
// anchored on the file token, so a bare "수정해줘" (no file) does NOT match —
// same homonym-free discipline as the EN pattern.
const KO_CODE_ACTION_REQUEST_RE = new RegExp(
  `${FILE_PATH_TOKEN}[^?]{0,40}(?:고쳐|수정|편집|바꿔|변경|구현|리팩터|재작성|교체|작성)`,
  "u"
);

/** True when the prompt is an imperative request to DO something (needs tools), not a question. */
export function classifyActionRequest(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || q.length > 120) {
    return false;
  }
  return ACTION_REQUEST_RE.test(q) || CODE_ACTION_REQUEST_RE.test(q) || KO_CODE_ACTION_REQUEST_RE.test(q);
}

// The ANSWER claims it performed (or will perform) a tool action — "I'll remind
// you…", "I've set a reminder", "I'll add a task". On the chat-only path nothing
// was actually done, so this is a FALSE PROMISE. Keyed off the answer (not the
// query) so it ALSO catches a MIXED "what's my rent AND remind me to pay it
// tomorrow" that classifyActionRequest (anchored at the start) misses. Anchored
// on the action-TOOL verbs (remind/reminder/task/event/schedule/book/email), so
// conversational "I'll add it to your notes" / "I'll explain" don't match.
const ACTION_PROMISE_RE =
  /\bi(?:'ll| will|'m going to| am going to)\s+(remind\s+you|set\s+(up\s+)?(an?\s+)?reminder|schedule\b|book\b|email\s+\w|send\s+\w+\s+(an?\s+)?(email|message|text)|add\s+(an?\s+)?(task|event|reminder|to-?do)|create\s+(an?\s+)?(task|event|reminder)|put\s+[^.]*\bon\b[^.]*\bcalendar)|\bi(?:'ve| have)\s+(set\s+(up\s+)?(an?\s+)?reminder|added\s+(an?\s+)?(task|event|reminder)|scheduled\b|booked\b|emailed\b|created\s+(an?\s+)?(task|event|reminder))/iu;

/** True when the answer CLAIMS it set/sent/scheduled a tool action — a false promise on a no-tools path. */
export function answerPromisesAction(answer: string): boolean {
  return ACTION_PROMISE_RE.test(answer);
}

// The desktop companion runs in KOREAN; the EN ACTION_*_RE above never match a
// Korean turn, so a false "…추가되었습니다" with no tool call went undetected.
// A scheduling/reminder/task NOUN the Korean action surfaces center on.
const KO_ACTION_NOUN = "일정|이벤트|약속|미팅|회의|리마인더|알림|할\\s*일|투두|태스크|예약";

// A Korean ACTION REQUEST: the noun + an action verb + an imperative ending
// (해줘 / 잡아줘 / 맞춰줘 …). A QUESTION ("회의 일정 추가했어?") lacks the
// imperative ending, so it stays out — the gate must not fire on questions, or
// a re-run would create a duplicate event.
const KO_ACTION_REQUEST_RE = new RegExp(
  `(${KO_ACTION_NOUN})[^?]{0,40}(추가|등록|설정|예약|잡아|맞춰|넣어|만들어|생성)\\s*(해|하)?\\s*(줘|주세요|줄래|드려|드릴래|라|자)`,
  "u"
);

/** True when the prompt imperatively asks Muse to DO a tool action — EN or KO. */
export function requestsToolAction(query: string): boolean {
  const q = query.trim();
  if (q.length === 0 || q.length > 200) {
    return false;
  }
  return classifyActionRequest(q) || KO_ACTION_REQUEST_RE.test(q);
}

// A Korean answer that CLAIMS the action is done (or imminently will be): the
// noun + an explicit completion/promise phrase. Phrase-list (not a strict
// adjacency regex) because Korean fuses tense into the verb stem
// (추가됐/맞췄/잡았). A conditional offer ("…추가하고 싶으면") has the noun but
// no done-phrase, so it does NOT match.
const KO_ACTION_DONE_RE =
  /(추가했|추가됐|추가되었|추가해\s*[드놨]|등록했|등록됐|등록되었|설정했|설정됐|예약했|예약됐|예약\s*완료|맞췄|맞춰\s*[놨드]|잡았|잡아\s*놨|넣었|넣어\s*놨|생성했|생성됐|완료했|완료됐|완료로\s*표시|추가할게|등록할게|맞춰\s*드릴게|추가해\s*드릴게|예약해\s*드릴게)/u;

// An OFFER / permission-question ("추가해 드릴까요?", "추가할까요?", "shall I add it?")
// is NOT a claim that the action happened — the KO interrogative `…까요?`/`…까?`
// is distinct from the declarative claim/promise `…했/…습니다/…게요`. Without this
// guard `추가해 드릴까요?` matched `추가해\s*[드놨]` and was logged as a false promise
// (a spurious unbacked-action). KO-focused: an EN offer ("shall I add") never
// matched ACTION_PROMISE_RE (which anchors on "I'll/I will"), so it's already excluded.
const ACTION_OFFER_RE = /(추가|등록|설정|예약|맞춰|잡아|넣어?|만들어?|생성|처리|완료)\s*(해|하|해\s*드릴|드릴)?\s*(까요|까|ㄹ까요|을까요|을까)\s*[?？]?/u;

// A COMPUTER-CONTROL completion claim in the ANSWER — "I fixed the bug", "I've
// edited the add function", "수정했습니다", "고쳤어요". The backstop's THIRD leg
// (with classifyActionRequest on the query + actionToolRan on the tools): when a
// code-fix request is answered with a done-claim but no actuator ran, it is a
// false done. Anchored on a FIRST-PERSON PAST-TENSE mutation verb so a future
// ("I will fix"), an offer ("shall I fix"), a capability ("I can fix"), advice
// ("you should edit", "to fix this, change…"), and a plain description ("the
// function returns…") do NOT match — their verbs are infinitive/future, never
// "I <verb-past>". This only fires when the request was already an action
// request (the callers AND-gate it), so it stays scoped to real code-fix turns.
const CODE_DONE_RE =
  /\bi(?:'ve|'d| have| had)?\s+(?:just\s+|already\s+|now\s+|successfully\s+)?(?:fixed|edited|updated|modified|changed|refactored|renamed|implemented|patched|corrected|rewrote|rewritten|written|replaced|created|added|removed|deleted|appended|inserted)\b|(?:수정|편집|변경|구현|리팩터|작성|교체|반영|완료)(?:했|됐|되었|함)|고쳤|고침/iu;

// A TERSE completion claim — the whole answer is just "Done." / "All done!" /
// "완료". WHOLE-ANSWER ANCHORED (`^…$`), NOT a bare `\bdone\b`: "done" is a
// high-frequency word whose non-completion senses (negation "I'm not done yet",
// partial "almost done", idiom "well done", question "are you done?", passive
// "done automatically by the framework") would otherwise be misread as a false
// claim and wrongly re-prompt an HONEST in-progress answer. The anchor admits
// only the terse-claim case. (JUDGE-DRILL #3 caught the `\bdone\b` substring
// form; this is the safe formulation it pointed to.)
const TERSE_DONE_RE = /^\s*(?:all\s+)?(?:done|완료(?:했|됐|되었|함)?)\s*[.!…]*\s*$/iu;

/** True when the answer CLAIMS it performed / will perform a tool action — EN or KO. NOT a mere offer ("…할까요?"). */
export function answerClaimsAction(answer: string): boolean {
  if (ACTION_OFFER_RE.test(answer)) {
    return false;
  }
  if (ACTION_PROMISE_RE.test(answer)) {
    return true;
  }
  if (TERSE_DONE_RE.test(answer)) {
    return true;
  }
  if (CODE_DONE_RE.test(answer)) {
    return true;
  }
  return new RegExp(`(${KO_ACTION_NOUN})`, "u").test(answer) && KO_ACTION_DONE_RE.test(answer);
}

// A state-CHANGING tool name: the `.add/.update/.delete/.complete/.save/.create/
// .remove` actuator verbs, a `_action` tool, or a @muse/fs computer-control
// mutator (`file_edit/file_write/file_multi_edit/file_delete/file_move`,
// `run_command`). A read/list tool (`muse.tasks.list`, `knowledge_search`,
// `file_read/file_grep/file_list`) is NOT one — so "did an actuator run?" stays
// distinct from "did any tool run?". Without the fs/run_command arm, a real
// `file_edit` on a code-fix task was misread as NO action, so the false-claim
// backstop wrongly flagged an honest "I fixed it" as unbacked.
const ACTION_TOOL_RE = /\.(add|update|delete|complete|save|create|remove)\b|_action\b|\b(?:file_(?:edit|write|multi_edit|delete|move)|run_command)\b/u;

/** True when at least one STATE-CHANGING (actuator) tool ran — used to tell a real action from a false promise. */
export function actionToolRan(toolNames: readonly string[]): boolean {
  return toolNames.some((tool) => ACTION_TOOL_RE.test(tool));
}

/**
 * The false-done backstop's composed condition: the user asked Muse to DO
 * something ({@link requestsToolAction}), the answer CLAIMS it was done
 * ({@link answerClaimsAction}), yet NO state-changing actuator ran
 * ({@link actionToolRan}) — a claimed-but-unbacked action. Extracted from the
 * three inlined call sites (commands-ask, chat-repl ×2) so every surface — and
 * a future AgentRuntime re-prompt — shares ONE definition; adding a leg can
 * never again diverge between sites.
 */
export function isUnbackedActionClaim(input: {
  readonly query: string;
  readonly answer: string;
  readonly toolNames: readonly string[];
}): boolean {
  return requestsToolAction(input.query) && answerClaimsAction(input.answer) && !actionToolRan(input.toolNames);
}

/** True when the prompt asks for a whole-corpus overview/listing, not a specific recall. */
export function classifyCorpusOverview(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || q.length > 80) {
    return false;
  }
  // A topic after "notes" makes it a SPECIFIC question, not a corpus overview.
  if (/\bnotes\s+(about|on|regarding|for|concerning|covering|re)\b/u.test(q)) {
    return false;
  }
  return OVERVIEW_PATTERNS.some((re) => re.test(q));
}

// "내 할일 뭐 있어?" wants the to-do LIST, but the local model reads the
// possessive "뭐 있어" as a memory question and won't call tasks.list (whereas
// it DOES call calendar.list for the identical "내 일정 뭐 있어?" — a stubborn
// selection asymmetry that tool descriptions don't move). So the chat surface
// short-circuits this intent to a deterministic list, the same way
// `classifyCorpusOverview` handles "내 노트 뭐 있어?".
const TASK_LIST_PATTERNS: readonly RegExp[] = [
  /(내|제)?\s*(할\s*일|할일|투두|to-?dos?|tasks?)\s*(이|가|들|은|는)?\s*(뭐|목록|어떤|몇|있|남았|알려|보여|정리)/u,
  /\bwhat\s+(tasks?|to-?dos?)\s+(do\s+i\s+have|are\s+there|are\s+left)\b/u,
  /\b(list|show|view)\s+(me\s+)?(all\s+)?(my\s+)?(open\s+)?(tasks?|to-?dos?)\b/u
];

/** True when the prompt asks to SEE the task list — not to add / complete / move one. */
export function classifyTaskListQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || q.length > 80) {
    return false;
  }
  // A clear write/mutate intent is NOT a list request.
  if (/추가|등록|기억해|완료|끝냈|다\s*했|삭제|지워|제거|없애|미뤄|미루|연기|바꿔|변경|옮겨|\b(add|create|complete|done|finish|delete|remove|reschedule|move|change)\b/u.test(q)) {
    return false;
  }
  return TASK_LIST_PATTERNS.some((re) => re.test(q));
}

// "리마인더 뭐 있어?" wants the reminder LIST, but — exactly like the task case
// above — the local model reads the possessive "뭐 있어" as a memory question and
// won't call reminders.list, so the recall gate wrongly abstains "없습니다" while
// pending reminders sit on disk. Short-circuit it to a deterministic list.
const REMINDER_LIST_PATTERNS: readonly RegExp[] = [
  /(내|제)?\s*(리마인더|알림|reminders?)\s*(이|가|들|은|는)?\s*(뭐|목록|어떤|몇|있|남았|알려|보여|정리)/u,
  /\bwhat\s+reminders?\s+(do\s+i\s+have|are\s+there|are\s+set)\b/u,
  /\b(list|show|view)\s+(me\s+)?(all\s+)?(my\s+)?reminders?\b/u
];

// "박지훈 전화번호 알려줘" / "박지훈은 나랑 무슨 관계?" — a lookup of ONE contact's
// details. The 8B won't reliably call find_contact for these (it reads them as
// memory questions and abstains, even claiming it has no contact feature), so the
// chat surface extracts the candidate name and resolves it deterministically. The
// name is a single token (the char class excludes spaces) so a multi-word phrase
// ("이 식당 전화번호") isn't captured; resolveContact is the precision gate (an
// unknown name falls through to recall).
const CONTACT_LOOKUP_PATTERNS: readonly RegExp[] = [
  /^([가-힣A-Za-z][가-힣A-Za-z·.]{1,18})(?:의|님|씨|은|는|이|가)?\s*(?:전화번호|연락처|핸드폰|휴대폰|이메일|메일\s*주소|메일|생일)/u,
  /^([가-힣A-Za-z][가-힣A-Za-z·.]{1,18})(?:은|는|이|가)\s+(?:나|저)(?:랑|와|하고)?\s*(?:무슨\s*)?관계/u,
  /^(?:what(?:'s| is)?\s+)?([A-Za-z가-힣][A-Za-z가-힣·.]{1,18})(?:'s|s)?\s+(?:phone|number|email|birthday|contact|handle)\b/iu
];

/** The candidate contact NAME if the prompt asks for ONE person's details, else null. */
export function classifyContactLookup(query: string): string | null {
  const q = query.trim();
  if (q.length === 0 || q.length > 60) {
    return null;
  }
  // An outbound ACTION (call/text/email someone) is not a detail lookup.
  if (/전화\s*해|문자\s*(?:보내|해)|메시지\s*보내|연락\s*해|(?:이메일|메일)\s*보내|\b(?:call|text|email|message|dm)\s+/iu.test(q)) {
    return null;
  }
  for (const re of CONTACT_LOOKUP_PATTERNS) {
    const m = re.exec(q);
    if (m?.[1]) {
      return m[1].trim();
    }
  }
  return null;
}

/** True when the prompt asks to SEE the reminder list — not to set / snooze / clear one. */
export function classifyReminderListQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || q.length > 80) {
    return false;
  }
  // A clear write/mutate intent is NOT a list request. NOTE: bare "set" is
  // excluded from the anywhere-in-prompt verbs because "what reminders are set"
  // is a legitimate LIST phrasing — "set" there is a past participle, not the
  // write verb. Write-intent "set" is only the LEADING command verb ("set a
  // reminder"), checked separately below.
  if (/추가|등록|설정|만들|기억해|삭제|지워|제거|없애|취소|미뤄|미루|연기|스누즈|바꿔|변경|\b(add|create|delete|remove|clear|cancel|snooze|reschedule|change)\b/u.test(q)) {
    return false;
  }
  if (/^set\b/u.test(q)) {
    return false;
  }
  return REMINDER_LIST_PATTERNS.some((re) => re.test(q));
}
