# Example contract (quickstart)

Tiny demo: bash may echo, one write must stay inside the root, then stop.
The web_search below is out of contract — the checker must flag it.

```yaml
session_contract: "0.1"
goal: "bash echoes once, write stays inside /tmp/session-contract-demo, then stop"
writable_roots:
  - /tmp/session-contract-demo
capabilities:
  fs.read: allow
  fs.write: allow
  exec: allow
  network: deny
redundant:
  n: 3
```
