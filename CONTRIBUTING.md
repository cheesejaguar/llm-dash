# Contributing to llm-dash

Thanks for taking a look. This is a small, purpose-built dashboard for one specific GPU
cluster — it isn't trying to be a general-purpose observability product — so the bar for changes
is "does this make the dashboard more correct or more useful for that cluster," not "is this a
generally good idea." Keep that in mind and most PRs will be easy calls.

## Ground rules

- **No database, no build step, no framework.** `public/app.js` is vanilla JS served as a static
  file under a strict CSP (`script-src 'self'`, no inline scripts, no eval). If your change needs
  a bundler, a UI framework, or a backend datastore, open an issue first and make the case — the
  zero-dependency-frontend property is load-bearing for the CSP and the "no build step" deploy
  story.
- **The wire contract is frozen.** `GET /events` (`hello` → `history` → `snapshot`...) is
  documented in the README under [Wire contract](README.md#-wire-contract-sse) and versioned
  (currently v2). If you add, rename, remove, or change the units of a field:
  1. Update `lib/history.js` / `lib/scheduler.js` / `lib/collectors/vllm.js` as needed.
  2. Update `public/app.js` in the **same PR** — server and client are not independently
     versioned, and a mismatch means either broken charts or silent wrong numbers.
  3. Bump the version marker in the README's wire-contract section and describe the change.
- **Null means unknown, not zero.** Every numeric field in the wire contract uses `null` to mean
  "this source was down or this metric isn't derivable yet" — never `0`, `NaN`, or a sentinel
  like `-1`. Charts and derived-rate math both rely on this. If you add a field, make sure its
  null case is reachable and tested by hand (kill the node/vLLM and confirm the field goes to
  `null`, not `0`).
- **Collectors must never throw across a poll tick.** `lib/scheduler.js`'s poll loops treat a
  collector failure as "this source is down" and keep looping — they must not crash the process.
  If you touch `lib/collectors/*.js`, keep every external call (`ssh`, `fetch`) wrapped so a
  timeout or malformed response degrades gracefully to `null`/`down`, not an unhandled rejection.
- **Security posture is intentional, not incidental.** The read-only container, `cap-drop ALL`,
  the forced-command SSH key, and "no auth on 9090 because it's LAN-only" are all deliberate
  trade-offs described in the README's [Security posture](README.md#-security-posture) section.
  Don't relax any of them (e.g. adding a general-purpose SSH key, widening the CSP, adding a
  write endpoint) without discussing it first — these choices were made with the actual threat
  model of "a container with SSH access to two GPU boxes," not a generic web app's.

## Dev setup

Requires **Node.js 22+** (matches the `node:22-slim` base image in the `Dockerfile`) and no other
tooling — no lockstep global CLI, no bundler.

```sh
npm install
```

Run against real hardware:

```sh
PORT=9091 SSH_KEY=~/.ssh/id_ed25519_llmdash node server.js
```

Run without SSH access (UI/vLLM-panel work only — node cards will show "down", which is fine for
frontend iteration):

```sh
PORT=9091 VLLM_BASE=http://<reachable-vllm-host>:8000 node server.js
```

There's no test suite or linter configured (`package.json` has no `test`/`lint` script) — this is
a small enough codebase that manual verification against the running dashboard is the practical
check. See [Verification quick-checks](README.md#-verification-quick-checks) in the README, and
before opening a PR:

1. Load the dashboard in a browser and watch at least one full ~3 s poll cycle land without
   console errors.
2. If you touched a collector, exercise both its up and down paths (e.g. temporarily point
   `VLLM_BASE` at a closed port, or revoke the SSH key) and confirm the affected fields go to
   `null` cleanly rather than crashing the server or corrupting the chart.
3. If you touched `lib/history.js` or the SSE payload shape, reload the page mid-session and
   confirm the `history` hydration still lines up with live `snapshot` data (no duplicate or
   skipped timestamps on the x-axis).

## Code style

Match what's already there rather than introducing a new convention:

- CommonJS (`require`/`module.exports`), not ESM — the whole codebase is CommonJS and there's no
  reason to mix module systems in one small server.
- Prefer explicit `null` checks over truthy/falsy shortcuts for metric values (a metric can
  legitimately be `0`, which is falsy but very much not "unknown").
- Keep `public/app.js` framework-free ES5-ish style consistent with the existing file (it already
  runs fine in evergreen browsers as-is — no need to modernize syntax for its own sake).
- Comments explain *why*, not *what* — see the existing files for the tone (e.g. the prefill
  windowing comment in `lib/collectors/vllm.js`). Don't add narration comments restating what the
  next line obviously does.

## Commit / PR conventions

- Keep commits focused; a mixed "fix bug + rename variables + reformat" commit is hard to review
  and hard to revert cleanly.
- Write commit messages and PR descriptions around **why**, not just what changed — especially
  for anything touching the wire contract, the collectors, or the security posture, where the
  "why" is often a specific hardware quirk (e.g. GB10's `nvidia-smi` returning `[N/A]` for memory)
  that isn't obvious from the diff alone.
- If a change affects the deploy runbook (`deploy/run.sh`, `deploy/stats.sh`, the `Dockerfile`,
  or SSH key setup), update the corresponding README section in the same PR — these docs go stale
  fast otherwise, and this dashboard has no CI to catch drift.

## Reporting bugs / requesting changes

Open an issue (or just describe it in your PR) with:

- What you observed vs. expected (ideally with the relevant `snapshot` JSON from `/events`, or a
  `docker logs` excerpt).
- Which node(s)/component(s) were affected — head, worker, or the vLLM metrics scrape.
- Whether it reproduces against real hardware or only in a modified/mocked setup.

## A note on dead code

`lib/collectors/gpu.js`, `lib/collectors/llm.js`, and `lib/collectors/rpc.js` are leftovers from
the pre-vLLM (`llama.cpp`-era) collector and are not imported anywhere (`lib/scheduler.js` only
pulls in `agent.js` and `vllm.js`). They're kept around as historical reference for now rather
than deleted. If you're touching this area and want to remove them, that's a welcome cleanup —
just do it as its own PR, separate from functional changes, so it's easy to review as "pure
deletion."

## Security issues

Please **do not** open a public issue for a security concern (e.g. a way to escape the container,
bypass the forced-command SSH restriction, or exfiltrate the SSH key). See
[`SECURITY.md`](SECURITY.md) for how to report those privately.
