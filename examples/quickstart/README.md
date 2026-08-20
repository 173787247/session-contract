# Quickstart example

Synthetic dsh log (not a real session). `pack/` is produced by the CLI, not hand-written.

```bash
node bin/session-contract.js adapt dsh examples/quickstart/session.jsonl \
  --contract examples/quickstart/contract.md --out examples/quickstart/pack
node bin/session-contract.js check examples/quickstart/pack
```

Expected check line: `outcome=incomplete compliance=overreach suspected_spin=false`.

The claim has three reasons: `overreach.capability` and `overreach.network` on `call_demo_3` (`web_search` vs `network: deny`), then `incomplete.goal`.

To regenerate, delete `examples/quickstart/pack/evidence.ndjson` first (0.1 adapt refuses overwrite).
