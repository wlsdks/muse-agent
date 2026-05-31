// Memory runtime — the deterministic component behind the memory layer
// (memory-layers.md). The MODEL decides WHAT is worth remembering (the curator
// role); this CODE does the deterministic mechanics the references prescribe:
// write-time storage with durability/confidence, read-time relevance retrieval,
// consolidation (dedup), decay (confidence half-life for inferences), and
// promotion (often-recalled -> always-on core). Anthropic context-engineering:
// "curating and maintaining the optimal set of tokens." Zero deps.

function tokenize(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z0-9가-힣]+/i).filter(Boolean);
}
function norm(s) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

export function createMemory(opts = {}) {
  const { now = () => 0, halfLifeMs = 1000, floor = 0.1 } = opts;
  const records = [];
  let id = 0;

  return {
    get records() { return records; },

    // write-time. durable=false (one-off detail) is NOT kept in long-term — the
    // deterministic bloat-prevention rule. Empty text is rejected (fail-closed).
    write({ text, kind = 'fact', durable = true, confidence = 1, source = null, at = now() } = {}) {
      if (!text || !norm(text)) throw new Error('memory.write: empty text');
      if (durable === false) return { stored: false, reason: 'transient (not kept in long-term)' };
      const rec = { id: id++, text, kind, confidence, source, at, lastSeen: at, recalls: 0, core: false };
      records.push(rec);
      return { stored: true, id: rec.id };
    },

    // read-time relevance retrieval: token overlap with the query, tie-broken by
    // recency then confidence. Returned records get a recall bump (feeds promote).
    read(query, { limit = 5, at = now() } = {}) {
      const q = new Set(tokenize(query));
      if (q.size === 0) return [];
      const scored = records
        .map((r) => {
          const toks = tokenize(r.text);
          const hits = toks.filter((t) => q.has(t)).length;
          return { r, score: hits / q.size };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.r.at - a.r.at || b.r.confidence - a.r.confidence)
        .slice(0, limit);
      for (const { r } of scored) { r.recalls += 1; r.lastSeen = at; }
      return scored.map((x) => x.r);
    },

    // consolidate near-duplicates (same normalized text): keep the highest
    // confidence, sum recalls, drop the rest. Prevents memory bloat.
    consolidate() {
      const byKey = new Map();
      let merged = 0;
      for (const r of records) {
        const k = norm(r.text);
        const keep = byKey.get(k);
        if (!keep) { byKey.set(k, r); continue; }
        keep.confidence = Math.max(keep.confidence, r.confidence);
        keep.recalls += r.recalls;
        keep.lastSeen = Math.max(keep.lastSeen, r.lastSeen);
        r._drop = true;
        merged += 1;
      }
      if (merged) { for (let i = records.length - 1; i >= 0; i--) if (records[i]._drop) records.splice(i, 1); }
      return { merged };
    },

    // decay: inferred items fade by a confidence half-life and drop below floor;
    // explicit facts/preferences are durable and do not decay.
    decay({ at = now() } = {}) {
      let decayed = 0; let dropped = 0;
      for (const r of records) {
        if (r.kind !== 'inference') continue;
        const elapsed = at - r.lastSeen;
        if (elapsed <= 0) continue;
        r.confidence *= 0.5 ** (elapsed / halfLifeMs);
        decayed += 1;
      }
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].kind === 'inference' && records[i].confidence < floor) { records.splice(i, 1); dropped += 1; }
      }
      return { decayed, dropped };
    },

    // promote often-recalled records to the always-on core.
    promote({ minRecalls = 3 } = {}) {
      let promoted = 0;
      for (const r of records) if (!r.core && r.recalls >= minRecalls) { r.core = true; promoted += 1; }
      return { promoted };
    },

    core() { return records.filter((r) => r.core); },
  };
}
