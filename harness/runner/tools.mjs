// Tool registry runtime — the deterministic mechanics of the Tools layer.
// Grounded in the references: Anthropic "writing tools for agents" (verb_noun /
// service_resource namespacing, explicit param names, actionable errors, FEW
// thoughtful tools), OpenAI Agents SDK (auto schema + validation), and MCP
// registry guidance (denylist wins over allowlist; empty allowlist = opt-in).
// Our tool-calling.md: expose <=5-7, required-bearing schemas, use-when/not-when.
//
// The MODEL picks/fills a tool; this CODE validates registration + arguments,
// gates by allow/deny, and exposes a small projection. Zero deps.

const NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // verb_noun / service_resource
const RISKS = new Set(['read', 'write', 'execute', 'outbound', 'banking']);

function typeOk(val, type) {
  switch (type) {
    case 'string': return typeof val === 'string';
    case 'number': return typeof val === 'number' && !Number.isNaN(val);
    case 'integer': return Number.isInteger(val);
    case 'boolean': return typeof val === 'boolean';
    case 'array': return Array.isArray(val);
    case 'object': return !!val && typeof val === 'object' && !Array.isArray(val);
    default: return true; // unknown type -> don't block
  }
}

export function createToolRegistry(opts = {}) {
  const { allow = [], deny = [], maxExposed = 7 } = opts;
  const tools = new Map();

  // denylist wins over allowlist; empty allowlist = everything allowed (opt-in).
  const allowed = (name) => !deny.includes(name) && (allow.length === 0 || allow.includes(name));

  return {
    get size() { return tools.size; },

    // Register a tool. Fail-closed: a malformed declaration is rejected, never
    // silently accepted. Returns {ok, enabled} or throws on a bad declaration.
    register(tool) {
      const { name, description, inputSchema, risk = 'read', useWhen, notWhen } = tool || {};
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`tool name must be verb_noun (got: ${name})`);
      if (tools.has(name)) throw new Error(`tool already registered: ${name}`);
      if (typeof description !== 'string' || !description.trim()) throw new Error(`tool ${name}: description required`);
      if (!inputSchema || typeof inputSchema !== 'object') throw new Error(`tool ${name}: inputSchema required`);
      if (!RISKS.has(risk)) throw new Error(`tool ${name}: unknown risk '${risk}'`);
      tools.set(name, { name, description, inputSchema, risk, useWhen: useWhen ?? null, notWhen: notWhen ?? null });
      return { ok: true, enabled: allowed(name) };
    },

    has(name) { return tools.has(name); },
    isAllowed(name) { return tools.has(name) && allowed(name); },
    riskOf(name) { return tools.get(name)?.risk; },

    // Validate args against the tool's schema. Returns actionable errors
    // (Anthropic: specific, fixable), not opaque failures.
    validateArgs(name, args = {}) {
      const t = tools.get(name);
      if (!t) return { ok: false, errors: [`unknown tool: ${name}`] };
      const schema = t.inputSchema;
      const props = schema.properties || {};
      const required = schema.required || [];
      const errors = [];
      for (const r of required) if (!(r in args)) errors.push(`missing required '${r}'`);
      for (const [k, v] of Object.entries(args)) {
        const spec = props[k];
        if (!spec) continue; // unknown extra arg: ignore (lenient on extras)
        if (spec.type && !typeOk(v, spec.type)) errors.push(`'${k}' expected ${spec.type}`);
        if (spec.enum && !spec.enum.includes(v)) errors.push(`'${k}' must be one of ${JSON.stringify(spec.enum)}`);
        if (typeof spec.minimum === 'number' && typeof v === 'number' && v < spec.minimum) errors.push(`'${k}' < min ${spec.minimum}`);
        if (typeof spec.maximum === 'number' && typeof v === 'number' && v > spec.maximum) errors.push(`'${k}' > max ${spec.maximum}`);
      }
      return { ok: errors.length === 0, errors };
    },

    // Expose a SMALL projection for the model (the "keep the set tight" rule).
    // Over the cap it truncates but REPORTS how many were dropped — never a
    // silent cap.
    expose(names) {
      const candidates = (names ? names.map((n) => tools.get(n)).filter(Boolean) : [...tools.values()]).filter((t) => allowed(t.name));
      const shown = candidates.slice(0, maxExposed);
      return {
        tools: shown.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, risk: t.risk, useWhen: t.useWhen, notWhen: t.notWhen })),
        dropped: candidates.length - shown.length,
      };
    },
  };
}
