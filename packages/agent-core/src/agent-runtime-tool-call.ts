/**
 * The gated tool-call path — Muse's outbound-safety chokepoint. Every tool the
 * model proposes passes through here: unknown-name repair, PTC interception,
 * argument canonicalisation, the injection-provenance gate, egress
 * authorisation, the approval gate, execution, and the afterTool hooks.
 *
 * Lifted out of `AgentRuntime` verbatim; the ONLY edits were `this.X` ->
 * `deps.X`. It reads instance state through an explicit deps bag so the gate
 * order and fail-close behaviour stay reviewable without the surrounding
 * 1,200-line runtime. `AgentRuntime.executeToolCall` remains as a delegate,
 * so every existing call site and type reference is untouched.
 */

import { errorMessage } from "@muse/shared";
import type { ModelTool, ModelToolCall } from "@muse/model";
import {
  ToolExecutor,
  authorizeEgressForValue,
  canonicalizeToolArgumentAliases,
  coerceToolArguments,
  coerceEnumArguments,
  collectNonUrlStringLeaves,
  nearestToolName,
  validateRequiredToolArguments
} from "@muse/tools";

import { sharesPrivateSpan } from "./actuator-provenance-gate.js";
import {
  actuatorProvenanceWarning,
  deepCloneAndFreeze,
  RUN_TOOL_PLAN_TOOL_NAME,
  settleWithin
} from "./agent-runtime-helpers.js";
import type {
  AgentRuntimeOptions,
  ToolApprovalGate,
  ToolApprovalGateDecision
} from "./agent-runtime-types.js";
import { joinUserMessages } from "./internals.js";
import { validateEnumArguments } from "./plan-execute.js";
import { metadataString } from "./runtime-helpers.js";
import { blockedToolResult, type ExecutedToolResult } from "./runtime-internals.js";
import { groundToolArguments } from "./tool-argument-grounding.js";
import type { AgentRunContext } from "./types.js";

export interface ExecuteToolCallDeps {
  readonly afterTool: (context: AgentRunContext, executed: ExecutedToolResult) => Promise<void>;
  readonly beforeTool: (context: AgentRunContext, toolCall: ModelToolCall) => Promise<void>;
  readonly resolveToolRisk: (name: string) => "read" | "write" | "execute";
  readonly runToolPlanTool: (
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: readonly ModelTool[]
  ) => Promise<ExecutedToolResult>;
  readonly toolApprovalGate?: ToolApprovalGate;
  readonly toolExecutor?: ToolExecutor;
  readonly toolOpportunityObserver?: AgentRuntimeOptions["toolOpportunityObserver"];
  readonly toolOpportunityObserverTimeoutMs: number;
}

export async function executeToolCall(
  deps: ExecuteToolCallDeps,
  context: AgentRunContext,
  proposedToolCall: ModelToolCall,
  activeTools: readonly ModelTool[]
): Promise<ExecutedToolResult> {
  if (!activeTools.some((tool) => tool.name === proposedToolCall.name)) {
    // A small model HALLUCINATES tool names (`node_run` for `run_command`); a
    // bare "not exposed" is a dead-end. Suggest the nearest ACTIVE tool by
    // token overlap so the next turn self-corrects (the executor's
    // not-registered path already does this — this is its not-EXPOSED sibling).
    const suggestion = nearestToolName(proposedToolCall.name, activeTools.map((tool) => tool.name));
    // A small model sometimes emits a whole COMMAND LINE as the tool name
    // (`node --exec "…"`) — a name with whitespace is never a valid identifier,
    // and token-overlap won't match `run_command` (observed live in
    // eval:edit-run-verify). Point it at the active execute tool so it re-issues
    // the command through that tool's ARGUMENTS instead of as a bogus name.
    const commandShaped = !suggestion && /\s/u.test(proposedToolCall.name.trim());
    const execTool = commandShaped ? activeTools.find((tool) => tool.risk === "execute") : undefined;
    const recovery = suggestion
      ? `. Did you mean '${suggestion}'? Call that exact name.`
      : execTool
        ? `. A tool name must be a single identifier, not a command line — to run a command, call '${execTool.name}' with the command in its arguments.`
        : "";
    const executed = blockedToolResult(
      proposedToolCall,
      `Error: tool was not exposed to the model: ${proposedToolCall.name}${recovery}`
    );
    await deps.afterTool(context, executed);
    return executed;
  }

  // PTC interception (run BEFORE this tool's own approval/grounding): run_tool_plan is an
  // orchestrator, not a leaf tool — its EXECUTE handler is a dead-end. Parse the plan, then run
  // every step through this same gated path (executeToolPlanGated → executeToolCall), and return
  // the PROJECTED result as a normal COMPLETED tool result so the model loop binds it as a
  // citable tool message (capToolOutput) and the grounding gate scores the final answer against
  // it. knownTools excludes run_tool_plan itself, so a nested PTC plan is an unknown-tool parse
  // error (no recursion). A parse error / blocked step becomes a normal blocked tool result —
  // never a throw that crashes the model loop.
  //
  // Budget invariant: a run_tool_plan call costs exactly ONE tool-call budget slot no matter how
  // many steps its plan runs — programmatic tool calling is one budget action, not N. The model
  // loop's toolCallCount is advanced once, for this single call, before this method ever runs; the
  // plan's steps execute inside runToolPlanTool below and never re-enter the loop's counter.
  if (proposedToolCall.name === RUN_TOOL_PLAN_TOOL_NAME) {
    return deps.runToolPlanTool(context, proposedToolCall, activeTools);
  }

  const exposed = activeTools.find((tool) => tool.name === proposedToolCall.name);
  const aliasRepair = canonicalizeToolArgumentAliases(
    exposed?.argumentAliases,
    proposedToolCall.arguments
  );
  if (!aliasRepair.ok) {
    const executed = blockedToolResult(proposedToolCall, `Error: ${aliasRepair.reason}`);
    await deps.afterTool(context, executed);
    return executed;
  }
  const toolCall: ModelToolCall = aliasRepair.args === proposedToolCall.arguments
    ? proposedToolCall
    : { ...proposedToolCall, arguments: aliasRepair.args };

  await deps.beforeTool(context, toolCall);

  // Observe only canonical, schema-valid proposals. This deliberately does
  // NOT move the existing validation failures ahead of the approval gate:
  // invalid-call gate count/order/results remain byte-identical. The pure
  // checks are computed early for observer eligibility, then their existing
  // results are consumed at the historical validation point below.
  const coercedArguments = coerceEnumArguments(
    exposed?.inputSchema,
    coerceToolArguments(exposed?.inputSchema, toolCall.arguments)
  );
  const argCheck = validateRequiredToolArguments(exposed?.inputSchema, coercedArguments);
  const enumErrors = validateEnumArguments(exposed?.inputSchema, coercedArguments);
  if (argCheck.ok && enumErrors.length === 0 && deps.toolOpportunityObserver) {
    try {
      const opportunityUserId = metadataString(context.input.metadata, "userId");
      const observation = Promise.resolve(deps.toolOpportunityObserver({
        arguments: deepCloneAndFreeze(coercedArguments),
        runId: context.runId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ...(opportunityUserId ? { userId: opportunityUserId } : {})
      })).catch(() => undefined);
      await settleWithin(observation, deps.toolOpportunityObserverTimeoutMs);
    } catch {
      // Fail-soft: evidence collection must never affect tool behavior.
    }
  }

  // Injection-provenance gate (outbound-send OR execute class): if this
  // actuator's sink args (a send's to/subject/body/url, or an execute tool's
  // command/code payload) carry content that traces to UNTRUSTED tool output
  // and NOT to the user's own message, the call must not proceed silently — a
  // poisoned tool result must never supply a send's recipient nor an RCE
  // command on the agent's own judgement (outbound-safety.md, FIDES-style
  // taint gate arXiv:2505.23643). The warning is threaded INTO the single
  // approval confirm below (no second prompt); with no confirm path at all it
  // fail-closes. Execute-risk tools are already always gated, so this enriches
  // that existing confirm. `risk` is resolved once here so both the warning
  // and the gate call use it — computed BEFORE the gate.
  const risk = deps.resolveToolRisk(toolCall.name);
  const provenanceWarning = actuatorProvenanceWarning(context, toolCall, risk);
  // Egress authorization (S5): detect a sink by ARG VALUE SHAPE (every string
  // leaf, objects/arrays included) — never by tool name/risk, since an
  // external MCP server names and risk-classes itself. `undefined` means no
  // http(s)/ws(s) URL anywhere in this call's args — byte-identical to
  // today. This runs for READ-risk calls too: that is the whole point — a
  // read-class fetch/browser tool is exactly the exfil sink this closes.
  const egressDecision = context.egressAuthority
    ? authorizeEgressForValue(toolCall.arguments ?? {}, context.egressAuthority)
    : undefined;
  const egressBlocked = egressDecision?.decision === "deny";
  const egressUserId = metadataString(context.input.metadata, "userId");
  // Audit trail (fire-and-record, never gates): "allow" is a trusted-typed
  // fetch and stays silent (logging every ordinary fetch would be noise —
  // testing.md AC17's byte-identical-on-no-URL contract extends to this).
  // "confirm"/"deny" get NO other durable record anywhere else today, so
  // this is the one place either surfaces. Runs regardless of what the
  // approval gate below decides — a gate isn't required for read-risk
  // calls, so this can't be folded into that block.
  if (egressDecision && egressDecision.decision !== "allow" && context.egressAdvisorySink) {
    try {
      await context.egressAdvisorySink({
        decision: egressDecision.decision,
        reason: egressDecision.reason,
        runId: context.runId,
        toolName: toolCall.name,
        url: egressDecision.url,
        ...(egressUserId ? { userId: egressUserId } : {})
      });
    } catch {
      // Fail-soft: an audit sink must never crash or block the run.
    }
  }
  // Confidentiality axis (S5 follow-up, fire-1 redo): the URL rule above only
  // inspects URL leaves, so a private phrase placed in a NON-URL leaf of this
  // SAME egress-candidate call (a header value, a form field) is invisible to
  // it. `egressDecision` truthy already means this call carries a URL — i.e.
  // it IS a network call; a pure non-network call never reaches here. Fire-
  // and-record only, same sink, never blocks — the URL rule alone owns
  // allow/confirm/deny.
  if (egressDecision && context.egressAdvisorySink) {
    const privateHaystack = context.taintLedger?.firstPartyHaystack() ?? "";
    if (privateHaystack.trim().length > 0) {
      const typedHaystack = joinUserMessages(context.input.messages);
      const leaves = collectNonUrlStringLeaves(toolCall.arguments ?? {});
      const flagged = leaves.find((leaf) => sharesPrivateSpan(leaf.text, privateHaystack, typedHaystack));
      if (flagged) {
        try {
          await context.egressAdvisorySink({
            decision: "confidentiality",
            reason: `\`${flagged.path}\` carries content from your own notes/records that you did not type in this message`,
            runId: context.runId,
            toolName: toolCall.name,
            ...(egressUserId ? { userId: egressUserId } : {})
          });
        } catch {
          // Fail-soft: an audit sink must never crash or block the run.
        }
      }
    }
  }

  const approvalGate = context.input.toolApprovalGate ?? deps.toolApprovalGate;
  if (risk !== "read" && !approvalGate) {
    const executed = blockedToolResult(
      toolCall,
      "Error: non-read tool call requires an approval gate"
    );
    await deps.afterTool(context, executed);
    return executed;
  }

  if (approvalGate) {
    let decision: ToolApprovalGateDecision;
    try {
      decision = await approvalGate({
        risk,
        runId: context.runId,
        toolCall,
        userId: egressUserId,
        ...(provenanceWarning ? { provenanceWarning } : {}),
        ...(egressDecision && egressDecision.decision !== "allow" ? { egressWarning: egressDecision.reason, egressBlocked } : {})
      });
    } catch (error) {
      // Fail-close: a throwing gate (e.g. a corrupt
      // ~/.muse/trust.json, the gate's data source) must BLOCK
      // the tool, never crash the run or let the call through.
      decision = {
        allowed: false,
        reason: `approval gate error: ${errorMessage(error)}`
      };
    }
    // Runtime-enforced hard deny: an egress "deny" is authoritative
    // regardless of what the surface gate returned. A gate that blindly
    // trusts risk === "read" (the CLI's silent-read shape, or any future
    // surface with the same shape) must never launder a model-composed URL
    // into an HTTP call — the ONE chokepoint every surface shares is here,
    // in the runtime, not re-implemented per surface.
    if (egressBlocked) {
      decision = { allowed: false, reason: `egress denied: ${egressDecision!.reason}` };
    }
    if (!decision.allowed) {
      const reason = decision.reason ?? "tool call rejected by approval gate";
      const executed = blockedToolResult(toolCall, `Error: ${reason}`);
      await deps.afterTool(context, executed);
      return executed;
    }
  } else if (provenanceWarning || egressBlocked) {
    // A tainted actuator call (or an egress-denied one) with NO approval
    // gate has no confirm to route to — fail-close, never a silent send,
    // execute, or fetch. An egress "confirm" (link-following under the
    // fan-out cap) is NOT fail-closed here: a read tool with no approval
    // gate at all already runs silently today (nothing to route a confirm
    // to either), and "confirm" is by definition an OBSERVED source, not a
    // model-composed one.
    const reason = egressBlocked ? `egress denied: ${egressDecision!.reason}` : provenanceWarning;
    const executed = blockedToolResult(
      toolCall,
      `Error: actuator call blocked (injection-provenance): ${reason}. Confirm this content explicitly before proceeding.`
    );
    await deps.afterTool(context, executed);
    return executed;
  }

  // Deterministic arg repair + validation (tool-calling.md): first losslessly
  // coerce a right-value/wrong-type arg to the schema's type ("5" → 5), then
  // check required. A missing required arg returns the missing list so the
  // model re-calls correctly (bounded by maxToolCalls) — never execute with
  // bad args.
  if (!argCheck.ok) {
    const executed = blockedToolResult(
      toolCall,
      `Error: missing required argument(s) for ${toolCall.name}: ${argCheck.missing.join(", ")}. Call it again with those argument(s).`
    );
    await deps.afterTool(context, executed);
    return executed;
  }

  // Then enforce closed-vocabulary (enum/const) constraints — the plan-execute
  // path validates these (validateEnumArguments), but the default ReAct path did
  // not, so an 8B that fabricated an out-of-schema enum value ("from":"base64"
  // for an enum of binary/octal/decimal/hex) reached the handler (crash, or a
  // write/actuator running a meaningless mode). tool-calling.md #3: invalid args
  // are the 2nd-biggest failure mode — fail-close here and feed the constraint
  // back so the model's bounded retry self-corrects, never execute on a bad value.
  if (enumErrors.length > 0) {
    const executed = blockedToolResult(
      toolCall,
      `Error: invalid argument(s) for ${toolCall.name}: ${enumErrors.join("; ")}. Call it again with a valid value.`
    );
    await deps.afterTool(context, executed);
    return executed;
  }

  if (!deps.toolExecutor) {
    const executed = blockedToolResult(toolCall, "Error: tool executor is not configured");
    await deps.afterTool(context, executed);
    return executed;
  }

  // Deterministic arg grounding: drop a free-text actuator arg the 8B
  // fabricated (a calendar location/notes the user never said) — a schema
  // "omit if unspecified" instruction is ~0% effective on a small model, so
  // the fabrication=0 edge is enforced in code at the tool boundary.
  const groundedArgs = exposed?.groundedArgs ?? [];
  const finalArguments = groundedArgs.length > 0
    ? (groundToolArguments(coercedArguments, groundedArgs, joinUserMessages(context.input.messages)).args as typeof coercedArguments)
    : coercedArguments;

  const result = await deps.toolExecutor.execute({
    arguments: finalArguments,
    context: {
      runId: context.runId,
      userId: metadataString(context.input.metadata, "userId")
    },
    id: toolCall.id,
    name: toolCall.name
  });

  await deps.afterTool(context, { result, toolCall });
  return { result, toolCall };
}
