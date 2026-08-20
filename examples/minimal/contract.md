# Example contract (minimal)

Print proxy env from a WSL bash child, then stop. Writes only under the writable root.
Do not scan `$HOME` (human-only in 0.1; `forbidden` is not enforced).

```yaml
session_contract: "0.1"
goal: "bash node prints NODE_USE_ENV_PROXY=1 and the proxy URL, then stop"
writable_roots:
  - /home/rchua/GO
capabilities:
  fs.read: allow
  fs.write: allow
  exec: allow
  network: deny
redundant:
  n: 6
forbidden:
  - scan_home
```
