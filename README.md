# Session Contract

Portable acceptance for one human–agent session: machine-checkable contract, generated evidence, two-axis verdict claim.

Slug: `session-contract`. Runtimes adapt to this spec; the spec does not embed a runtime. Do not abbreviate as SCP.

AHP ([Agent Handoff Protocol](https://github.com/DeepJudge-Agent-Handoff-Protocol/agenthandoffprotocol)) moves work between agent apps. This spec **accepts or rejects a finished session**. It does not define HTTP handoff, Thread IDs, or encrypted A2A receipts.

## Chinese summary

人机一次会话怎样算做完、用什么证据验收。AHP 管搬家；本规范管验收。`contract.md` 里必须有可被检查器读取的 YAML（可写根、能力上限），散文只给人看。证据是 ndjson 事件日志，禁止事后作文。检查器只出 claim（0.1 默认 `incomplete`，禁止模型自述 pass）。人在同一 YAML 里写 `accept`：缺省=未发布，`false`=拒包，`true`=把 outcome **发布为 pass**。空转不是终态，是证据特征。重复调用必须同时满足：规范化参数相同、无状态推进、连续 N 次。0.1 只做会话后验，不做运行时拦截。上手见 Quick start，跑通无需 dsh：`examples/quickstart`。

## Artifacts

One directory is one portable pack:

| File | Role |
|---|---|
| `contract.md` | Goal prose + fenced YAML machine subset |
| `evidence.ndjson` | Generated event log |
| `evidence.ndjson.sha256` | SHA-256 of the log bytes and the hash-chain tip |
| `verdict.md` | Checker **claim** + human **accept** (same YAML fence) |

Extra files in the pack directory are allowed and ignored.

Effective verdict: missing `accept` = unpublished; `accept: false` = rejected; `accept: true` = published pass.

## Quick start

Node >= 22.15. Install straight from this repo (no npm publish yet):

```bash
npm install -g github:173787247/session-contract
```

Export one session from dsh (Web: `Session log` button or the `/export` command) — you get a `dsh-session-<id>.zip`. Then:

```bash
session-contract adapt dsh ./dsh-session-<id>.zip --contract contract.md --out ./pack
session-contract check ./pack
```

`check` prints one line: `outcome=incomplete compliance=overreach suspected_spin=false verdict=…`. Exit 0 means "an auditable claim was written", not "the session passed". To publish a pass, open `verdict.md` and append to the claim fence:

```yaml
accept: true
note: "proxy print matched"
```

A pack without `accept` is unpublished; `accept: false` rejects it.

Run the example without any dsh at hand:

```bash
session-contract adapt dsh examples/quickstart/session.jsonl \
  --contract examples/quickstart/contract.md --out /tmp/pack-demo
session-contract check /tmp/pack-demo
```

Path matching is lexical only (spec §3.2): the checker never touches the filesystem, so `/tmp/...` roots work on Windows too.

## Status

Spec **0.1** (`spec/0.1.md`). Adapter input: `spec/0.1-adapter.md`. CLI: `spec/0.1-cli.md`.

## Not this project

Another agent OS, another RAG, a DeepSeek Harness fork, or a fourth WSL plugin.
