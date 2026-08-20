# session-contract

Portable **acceptance** for one human–agent session: a machine-checkable contract, a generated evidence log, and a two-axis verdict **claim**. Runtimes adapt to this spec; the spec does not embed a runtime.

AHP ([Agent Handoff Protocol](https://github.com/DeepJudge-Agent-Handoff-Protocol/agenthandoffprotocol)) moves work between agent apps. This spec **accepts or rejects a finished session**. It does not define HTTP handoff, Thread IDs, or encrypted A2A receipts.

## Chinese summary

人机一次会话怎样算做完、用什么证据验收。AHP 管搬家；本规范管验收。`contract.md` 里必须有可被检查器读取的 YAML（可写根、能力上限），散文只给人看。证据是 ndjson 事件日志，禁止事后作文。检查器只出 claim（0.1 默认 `incomplete`，禁止模型自述 pass）。人在同一 YAML 里写 `accept`：缺省=未发布，`false`=拒包，`true`=把 outcome **发布为 pass**。空转不是终态，是证据特征。重复调用必须同时满足：规范化参数相同、无状态推进、连续 N 次。0.1 只做会话后验，不做运行时拦截。

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

## Status

Spec **0.1** (`spec/0.1.md`). No checker yet. Next review: adapter input (dsh export, Claude Code hooks). Implementations must stay post-hoc; see [Claude Code Stop hook false negatives](https://github.com/anthropics/claude-code/issues/29881).

## Not this project

Another agent OS, another RAG, a DeepSeek Harness fork, or a fourth WSL plugin.
