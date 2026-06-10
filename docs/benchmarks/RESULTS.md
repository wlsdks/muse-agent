# Muse grounding gate — architectural delta (gate ON vs OFF)

> Same fixed local model, same retrieval, same corpus — the ONLY variable is
> whether Muse's deterministic grounding gate runs. The Δ is the gate's
> contribution, isolated from the model. A bigger model would beat the absolute
> faithfulness number; it cannot beat this Δ without the same gate. (Same-model
> judge ⇒ an internal-validity delta, not a public-leaderboard rank.)

- model: `ollama/gemma4:12b`
- corpus: bundled grounding corpus (self-authored — a public-dataset arm is the next slice) (17 guardable + 12 answerable cases)
- generated: 2026-06-10T11:58:57.661Z by `pnpm eval:grounding-delta` — regenerated, never hand-edited

| arm | faithfulness (fabrication caught) | false-refusal (in-corpus answer wrongly refused) |
|---|---|---|
| gate **ON** | 0.94 (16/17) | 0.00 (0/12) |
| gate **OFF** | 0.00 (0/17) | 0.00 (0/12) |
| **Δ (ON − OFF)** | **+0.94** | +0.00 |

**Reading:** with the gate OFF the fixed model lets 17/17 fabrications through; the gate ON catches 16/17 — a +0.94 faithfulness lift the SAME model cannot reach alone, at a +0.00 false-refusal cost.
