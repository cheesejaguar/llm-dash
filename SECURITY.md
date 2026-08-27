# Security Policy

## Scope and threat model

`llm-dash` is a **LAN-only** dashboard with **no authentication** on its HTTP port (`9090`) by
design — see [Security posture](README.md#-security-posture) in the README. It runs a
non-root, read-only, capability-dropped container that holds SSH access to two GPU nodes via a
dedicated key restricted (via `restrict` + `command=` + `from=` in `authorized_keys`) to a single
forced command.

The interesting attack surface, in rough order of impact:

1. **Escaping the forced SSH command** to run arbitrary commands on either cluster node as the
   `SSH_USER`-configured remote account.
2. **Escaping the container** to reach the host or the mounted read-only SSH private key.
3. **Crashing or resource-exhausting the server** (the poll loops, the SSE fan-out, or the
   Prometheus-text parser in `lib/collectors/vllm.js`) from a malicious/malformed `/metrics`
   response or a malicious SSE client.
4. **Information disclosure** beyond what the dashboard already intentionally exposes on the LAN
   (GPU/CPU/memory stats, vLLM request-level aggregates — no prompts or completions are ever
   collected or transmitted).

Given the deliberate "no auth, LAN-only" stance, exposing port `9090` beyond the local network is
**out of scope** as a vulnerability in itself — that's a documented deployment requirement, not a
bug. A report that boils down to "there's no login page" won't lead anywhere; a report that shows
how to pivot from the dashboard's *intended* LAN exposure into something outside its threat model
(remote code execution, SSH key exfiltration, container escape, forced-command bypass) is exactly
what this policy is for.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security report.

Instead, email **cheesejaguar@gmail.com** with:

- A description of the issue and its impact.
- Steps to reproduce (a `curl`/`ssh` transcript is ideal — this is a small server, so most issues
  are reproducible in a few commands).
- Which component is affected: the Express server (`server.js`), a poll loop or collector
  (`lib/scheduler.js`, `lib/collectors/*.js`), the SSH wrapper (`lib/ssh.js`), the forced-command
  agent (`deploy/stats.sh`), or the container/deploy configuration (`Dockerfile`,
  `deploy/run.sh`).

You should get an acknowledgment within a few days. Since this is a small, single-maintainer
project (not a funded product), there's no formal SLA or bug-bounty program — but real reports
will be taken seriously and fixed.

## Supported versions

This project doesn't cut releases or maintain multiple branches — there is one supported version:
the current `main`/`master` tip. Fixes land there; there's no backport policy.

## Known, accepted trade-offs (not bugs)

These are documented deliberately in the README and are not considered vulnerabilities to report:

- No authentication or TLS on port `9090` (LAN-only by design).
- The SSH agent key has no passphrase (`ssh-keygen -N ''`) — it's a forced-command key with no
  interactive login capability, mounted read-only into a container with no shell access exposed
  to the network.
- `deploy/stats.sh` deliberately ignores `SSH_ORIGINAL_COMMAND` — this is the point, not an
  oversight; it's what makes the forced command actually forced.
