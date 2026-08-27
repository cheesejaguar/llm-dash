# 🖥️ llm-dash

**A live, zero-dependency-database dashboard for a 2-node DGX Spark GB10 cluster** running
`DeepSeek-V4-Flash` under vLLM (tensor-parallel across both boxes).

Node.js streams **Server-Sent Events** straight to the browser on port `9090`. No database, no
build step, no auth — it's a LAN-only instrument panel for one cluster, not a product.

| Node | Role |
|---|---|
| head | runs vLLM API + `/metrics` |
| worker | hosts this dashboard container |

Nothing in this repo hardcodes a specific network — hosts, IPs, and the SSH user are all supplied
via environment variables (`NODES_JSON`, `VLLM_BASE`, `SSH_USER`; see
[Configuration](#-configuration)). The two-node "head + worker" shape is the only thing baked in.

---

## 📋 Table of contents

- [Why this exists](#-why-this-exists)
- [What it looks like](#-what-it-looks-like)
- [Architecture](#-architecture)
- [Quick start](#-quick-start)
- [Configuration](#-configuration)
- [Wire contract (SSE)](#-wire-contract-sse)
- [SSH agent key setup](#-ssh-agent-key-setup-one-time)
- [Deploy runbook](#-deploy-runbook)
- [Security posture](#-security-posture)
- [Verification quick-checks](#-verification-quick-checks)
- [Troubleshooting](#-troubleshooting)
- [Project layout](#-project-layout)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎯 Why this exists

Watching `nvidia-smi -l 1` in a tmux pane doesn't tell you whether the cluster is actually
*serving* well — queue depth, KV-cache pressure, speculative-decode acceptance, and prefix-cache
reuse all matter more than raw GPU utilization when you're running a production-shaped vLLM
deployment on hobbyist hardware. This dashboard exists to put those numbers on one screen, updated
every ~3 seconds, with zero moving parts to babysit.

## 📸 What it looks like

A single-page dashboard split into:

- **Generation** — tokens/sec being generated, live sparkline.
- **Prefill — Cache Hit** vs **Prefill — Compute** — prompt tokens served from the prefix cache
  (cheap, 10–50× faster) plotted separately from tokens that required a real forward pass.
- **Requests** — running vs. waiting request counts (queue pressure).
- **KV Cache %** — how full the KV cache pool is.
- **Spec-Decode Acceptance %** — how often the speculative decoder's draft tokens are accepted,
  plus mean accepted length and a per-position breakdown.
- **Per-node cards** (one per GPU box) — temp, power draw, utilization, clock, memory, CPU load,
  and container health.

Everything renders from a single columnar history payload on connect, then updates in place —
no polling, no page reload, no flash of empty charts.

## 🏗️ Architecture

```
┌─────────────┐   forced-command SSH    ┌──────────────────┐
│ head node   │ ◄──────────────────────►│                  │
│             │   (stats.sh, JSON/line) │                  │
│ vLLM API +  │                         │   llm-dash        │
│ /metrics    │ ◄── HTTP GET /metrics ──│   (Node.js,        │
└─────────────┘                         │   port 9090)      │
                                         │                  │
┌─────────────┐   forced-command SSH    │                  │
│ worker node │ ◄──────────────────────►│                  │──── SSE ───► Browser(s)
│             │   (stats.sh, JSON/line) │                  │
└─────────────┘                         └──────────────────┘
```

- **Two independent poll loops** run inside the server, each self-rescheduling with `setTimeout`
  so a slow tick never overlaps the next:
  1. **Node stats** — SSH to each node using a dedicated key whose `authorized_keys` entry is
     `restrict`-ed to a forced command running [`deploy/stats.sh`](deploy/stats.sh) from a fixed
     path you choose at install time. The agent
     ignores whatever command the client sends and returns one line of JSON: GPU temp / power /
     utilization / clock, memory, load average, core count, and Docker container status. No VRAM
     query — GB10's `nvidia-smi` returns `[N/A]` for memory fields on this hardware.
  2. **vLLM metrics** — a direct HTTP scrape of the head node's vLLM `/metrics` endpoint
     (Prometheus exposition format), parsed in-process and turned into derived rates: throughput,
     KV-cache occupancy, speculative-decode acceptance, TTFT / inter-token latency, prefix-cache
     hit rate, and queue depths.
- **SSE fan-out** — clients connect to `GET /events`; the server pushes `hello`, then `history`,
  then a `snapshot` roughly every 3 s, plus a `:hb` heartbeat comment every 15 s and a
  `retry: 2000` hint on connect so browsers reconnect quickly after a network blip.
- **In-memory ring buffer** (`lib/history.js`) keeps the last 600 snapshots (30 minutes at 3 s
  cadence) so a newly-connected client gets a full chart's worth of history in one shot, instead
  of an empty graph that slowly fills in.

## 🚀 Quick start

```sh
npm install
PORT=9091 SSH_KEY=~/.ssh/id_ed25519_llmdash node server.js
```

Then open `http://localhost:9091`. Without `SSH_KEY` set, the node-stats loop will fail closed
(nodes render as "down") but the vLLM metrics panel still works if `VLLM_BASE` is reachable — so
you can develop the UI without SSH access to real hardware.

Prefer containers? See [Deploy runbook](#-deploy-runbook) for the canonical `docker run` used in
production.

## ⚙️ Configuration

All configuration is via environment variables — there is no config file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9090` | HTTP/SSE listen port. |
| `SSH_KEY` | *(required)* | Path to the dedicated ed25519 private key used to reach both nodes. Node-stats collection fails (nodes render `down`) if unset. |
| `SSH_USER` | *(required)* | Remote user for the forced-command SSH session. No default — must match the account whose `authorized_keys` you restricted (see [SSH agent key setup](#-ssh-agent-key-setup-one-time)). |
| `KNOWN_HOSTS` | `/app/deploy/known_hosts` | Pinned host-key file passed to `ssh -o UserKnownHostsFile=`. |
| `VLLM_BASE` | `http://127.0.0.1:8000` | Base URL of the vLLM OpenAI-compatible server (scraped at `/metrics`, `/v1/models`). Set this to your head node's real address. |
| `VLLM_MAX_SEQS` | `12` | Reported max concurrent sequences (informational — not read from vLLM itself). |
| `NODES_JSON` | placeholder 2-node cluster (`10.0.0.10`/`10.0.0.11`) | Override the node list with your real cluster, e.g. `[{"host":"a","ip":"10.0.0.1","role":"head"},{"host":"b","ip":"10.0.0.2","role":"worker"}]`. First `role:"head"` entry (or the first entry) maps to history suffix `0`; the next maps to suffix `1`. **Always set this in production** — the built-in default is a non-functional placeholder, not a real cluster. |
| `NODE_OPTIONS` | — | Set to `--max-old-space-size=128` in production to keep the container's small memory cap honest. |

## 📡 Wire contract (SSE)

`GET /events` — all numbers are numeric, `null` means "unknown", timestamps are epoch-ms.

- **`hello`** *(once)* — server start time, model info (`deepseek-v4-flash`,
  `maxContext: 380000`), and the node list (`host`/`ip`/`role`).
- **`history`** *(once, right after `hello`)* — a **columnar** buffer of up to 600 points:
  ```json
  {"t":[...], "s":{"genTps":[], "computeTps":[], "cacheTps":[], "running":[],
  "waiting":[], "kvPct":[], "accept":[], "ttftMs":[], "tpotMs":[], "prefixHit":[],
  "temp0":[], "temp1":[], "power0":[], "power1":[], "cpu0":[], "cpu1":[],
  "mem0":[], "mem1":[]}}
  ```
  Every series array is index-aligned with `t`. Suffix `0` = head, `1` = worker, regardless of
  `NODES_JSON` ordering. `null` entries mean that source was down at that tick.
- **`snapshot`** *(every ~3 s)* — `t`, server uptime `up`, a per-node block keyed by hostname
  (`up`, `gpu{temp,power,util,clock}`, `mem{used,total,pct}`, `cpu{load1,cores,pct}`,
  `ctr{vllm}`), and a `vllm` block (`up`, `ageMs`, `model`, `maxLen`, `maxSeqs`, `kvPct`,
  `running`, `waiting`, `preempt`, `computeTps`, `cacheTps`, `genTps`, `ttft`, `itl`,
  `spec{accept,meanLen,perPos}`, `prefix{roll,life}`, `success`).

**`computeTps` vs. `cacheTps`** — these split what used to be a single `promptTps` field:
`computeTps` is prefill tokens that required a real forward pass
(`vllm:prompt_tokens_by_source_total{source="local_compute"}`); `cacheTps` is tokens served from
the prefix cache (`source="local_cache_hit"`) — cheap reuse, not compute, and typically 10–50×
higher throughput. Both are windowed averages (60 s) rather than a raw per-tick rate, because
prefill is bursty and a multi-thousand-token prompt finishes in well under one 3 s poll tick.

**Units** — temp °C, power W; `util`/`pct`/`kvPct`/`accept`/`perPos`/`prefix` are percent
0–100; mem in GB; **`ttft` in SECONDS**; **`itl` in MILLISECONDS**; spec `meanLen` ranges
1.0–4.0.

`vllm.up:false` ⇒ other `vllm` fields may be `null`. A node's `up:false` ⇒ its `gpu`/`mem`/`cpu`
are `null`.

> This contract is treated as **frozen** (currently v2). If you change field names, units, or
> shape, bump the version marker in this section and update `public/app.js` in the same change —
> the frontend and backend are not independently versioned.

## 🔑 SSH agent key setup (one-time)

The dashboard never uses a general-purpose SSH key. It uses one dedicated key, restricted on the
remote side to run exactly one forced command and nothing else.

Set these once for your own cluster and reuse them through the rest of this section:

```sh
export WORKER_IP=<worker-node-lan-ip>      # box that will run the dashboard container
export HEAD_IP=<head-node-lan-ip>          # box running vLLM
export REMOTE_USER=<remote-ssh-user>       # account the forced-command key authenticates as
export AGENT_PATH=<absolute-path-to-stats.sh-on-each-node>   # e.g. /opt/llm-dash-agent/stats.sh
```

On the **worker** (the box that will run the container), generate the dedicated key:

```sh
ssh-keygen -t ed25519 -N '' -C llm-dash-agent -f ~/.ssh/id_ed25519_llmdash
```

Install [`deploy/stats.sh`](deploy/stats.sh) on **both** nodes at `$AGENT_PATH`, mode `755`.

Append to `~/.ssh/authorized_keys` for `$REMOTE_USER` on the **head** node:

```
from="<worker-ip>",restrict,command="<agent-path>" ssh-ed25519 <PUB> llm-dash-agent
```

And on the **worker** itself (reached from the container bridge, the host, or loopback):

```
from="172.17.0.0/16,<worker-ip>,127.0.0.1",restrict,command="<agent-path>" ssh-ed25519 <PUB> llm-dash-agent
```

(`172.17.0.0/16` is Docker's default bridge subnet — adjust if your Docker network differs.)
Substitute in your real `$WORKER_IP` and `$AGENT_PATH` values for `<worker-ip>`/`<agent-path>`.
`<PUB>` is the key body from `~/.ssh/id_ed25519_llmdash.pub`. `restrict` disables PTY,
port/agent/X11 forwarding, and any other session extension; `command=` forces `stats.sh` to run
no matter what the client actually asked for.

**Rollback** — delete that one `authorized_keys` line on each node. The pre-existing shared key
(if any) is untouched by any of this.

[`deploy/known_hosts`](deploy/known_hosts) is a **template** — replace its placeholder
`HEAD_IP`/`WORKER_IP` entries with your own nodes' real pinned host keys (see the comment at the
top of that file) before deploying. Don't commit your real, populated copy to a public fork/repo.

## 🛠️ Deploy runbook

1. Install `deploy/stats.sh` on both nodes at your chosen `$AGENT_PATH` (mode `755`), then verify
   it end-to-end:
   ```sh
   ssh -i ~/.ssh/id_ed25519_llmdash $REMOTE_USER@$HEAD_IP anything | jq .
   ```
   (`anything` is ignored — the forced command always runs regardless of what's sent.)
2. Bare-metal smoke test on the worker:
   ```sh
   PORT=9091 SSH_KEY=~/.ssh/id_ed25519_llmdash SSH_USER=$REMOTE_USER node server.js
   ```
   then check `http://$WORKER_IP:9091`.
3. Build and run the container:
   ```sh
   DEPLOY_BIND_IP=$WORKER_IP SSH_KEY_PATH=~/.ssh/id_ed25519_llmdash SSH_USER=$REMOTE_USER ./deploy/run.sh
   ```
   (run **on** the worker, from the repo directory — see [`deploy/run.sh`](deploy/run.sh) for the
   exact `docker run` flags).

## 🔒 Security posture

- **Container hardening** — non-root (`1000:1000`), `--cap-drop ALL`, `no-new-privileges`,
  read-only root filesystem (only a 16 MB `noexec` `/tmp` tmpfs), 256 MB memory cap with no swap
  headroom, 128-pid limit, default bridge network.
- **SSH** — single-purpose ed25519 key, mounted read-only into the container; forced command +
  `restrict` + `from=` source pinning on both nodes; the agent script deliberately ignores
  `SSH_ORIGINAL_COMMAND` so a compromised client can't smuggle an alternate command through.
- **HTTP response headers** — `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  and a restrictive `Content-Security-Policy` (`default-src 'self'`, no inline scripts, no
  framing).
- **No auth on port 9090** — this is a deliberate LAN-only stance, not an oversight. **Do not**
  expose 9090 beyond the local network without adding an auth layer in front of it (reverse
  proxy + basic auth, VPN, etc.).

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability.

## ✅ Verification quick-checks

```sh
curl -s http://$WORKER_IP:9090/healthz          # server alive
curl -sN http://$WORKER_IP:9090/events | head   # hello -> history -> snapshots
docker logs -f llm-dash                         # poll-loop errors, if any
```

## 🩹 Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| A node card shows "down" | SSH agent key missing/expired, `stats.sh` not installed, or `restrict`/`from=` mismatch | `ssh -i $SSH_KEY -o UserKnownHostsFile=deploy/known_hosts $SSH_USER@<ip> anything \| jq .` |
| vLLM panel shows "down" | `VLLM_BASE` unreachable, vLLM not serving `/metrics`, or a firewall between the worker container and the head node | `curl -s $VLLM_BASE/metrics \| head` |
| Charts never populate on first load | `history` SSE event malformed or client JS error | Check the browser console; confirm `curl -sN .../events \| head` shows `event: history` before any `event: snapshot` |
| `503` on `/events` | Client cap (`MAX_CLIENTS = 20` in `lib/scheduler.js`) reached | Close stale dashboard tabs; the server also drops clients whose buffered output exceeds 1 MB (a stalled reader) |
| Container OOM-kills | 256 MB cap is intentionally tight | Check `docker logs`/`docker inspect` for an OOM event; raise `--memory` in `deploy/run.sh` if the workload genuinely needs more |

## 🗂️ Project layout

```
server.js                  Express app: static files, /healthz, /events (SSE)
lib/
  scheduler.js              Poll loops, SSE fan-out, snapshot assembly
  history.js                Ring buffer + columnar history serialization
  ssh.js                    execFile wrapper around the forced-command SSH call
  collectors/
    agent.js                 Parses/validates stats.sh JSON output
    vllm.js                   Prometheus text parser + derived-rate math for vLLM /metrics
public/
  index.html                 Dashboard markup
  app.js                      Chart rendering, DOM updates, SSE client
  chart.umd.min.js            Vendored charting lib (no CDN — CSP-clean, works offline)
deploy/
  run.sh                      Canonical build + `docker run` for production
  stats.sh                    Forced-command agent installed on both cluster nodes
  known_hosts                 Template for pinned host keys — replace with your own before deploying
```

> Note: `lib/collectors/gpu.js`, `lib/collectors/llm.js`, and `lib/collectors/rpc.js` are
> left over from the pre-vLLM (`llama.cpp`-era) collector and are **not imported by anything**.
> Treat them as historical reference, not live code — see [`CONTRIBUTING.md`](CONTRIBUTING.md#-a-note-on-dead-code).

## 🤝 Contributing

Bug reports, small fixes, and questions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md)
for dev setup, coding conventions, and how the wire contract's versioning works in practice.

## 📄 License

[MIT](LICENSE) © Aaron
