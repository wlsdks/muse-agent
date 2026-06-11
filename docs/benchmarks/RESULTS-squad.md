# Muse grounding gate — architectural delta (gate ON vs OFF)

> Same fixed local model, same retrieval, same corpus — the ONLY variable is
> whether Muse's deterministic grounding gate runs. The Δ is the gate's
> contribution, isolated from the model. A bigger model would beat the absolute
> faithfulness number; it cannot beat this Δ without the same gate. (Same-model
> judge ⇒ an internal-validity delta, not a public-leaderboard rank.)

- model: `ollama/gemma4:12b`
- corpus: SQuAD-2.0 dev slice (8 paragraphs, pinned apps/cli/scripts/fixtures/squad-v2-slice.json; templated answers, no model-generation) — drift Δ = answer-faithfulness on adversarial public inputs (8 guardable + 8 answerable cases)
- generated: 2026-06-08T13:56:19.084Z by `pnpm eval:grounding-delta:squad` — regenerated, never hand-edited

| arm | faithfulness (fabrication caught) | false-refusal (in-corpus answer wrongly refused) |
|---|---|---|
| gate **ON** | 0.63 (5/8) | 0.00 (0/8) |
| gate **OFF** | 0.00 (0/8) | 0.00 (0/8) |
| **Δ (ON − OFF)** | **+0.63** | +0.00 |

**Reading:** with the gate OFF the fixed model lets 8/8 fabrications through; the gate ON catches 5/8 — a +0.63 faithfulness lift the SAME model cannot reach alone, at a +0.00 false-refusal cost.
