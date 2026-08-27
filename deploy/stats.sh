#!/usr/bin/env bash
# stats.sh — forced-command SSH agent for llm-dash.
#
# Lives at a fixed path (mode 755) on both cluster nodes — that path is
# whatever you reference in the authorized_keys `command=` entry, e.g.
# /opt/llm-dash-agent/stats.sh. Invoked via that entry, so SSH_ORIGINAL_COMMAND
# and any argv are DELIBERATELY IGNORED — this script always does exactly one
# thing: emit a single line of JSON on stdout.
#
# It must produce valid JSON even if every subcommand (nvidia-smi, free,
# nproc, docker) fails. Unknown values become null; containers become [].
#
# NOTE: no VRAM/memory query from nvidia-smi — GB10 returns [N/A] for those.

set -uo pipefail

# Fixed PATH: forced commands may run with a minimal environment.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- timestamp (epoch ms) & hostname -----------------------------------------
ts="$(date +%s%3N 2>/dev/null)" || ts=""
host="$(hostname 2>/dev/null)" || host=""

# --- GPU ----------------------------------------------------------------------
# One CSV line: temp, power, util, graphics clock, name. Any field may be
# "[N/A]" (mapped to null in jq via `tonumber? // null`). nvidia-smi failing
# entirely yields an empty string -> gpu:null.
gpu_csv="$(nvidia-smi \
  --query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.current.graphics,gpu_name \
  --format=csv,noheader,nounits 2>/dev/null | head -n1)" || gpu_csv=""

# --- memory (bytes, from `free -b` Mem: line: total=$2 used=$3 available=$7) --
mem_line="$(free -b 2>/dev/null | awk '/^Mem:/ {print $2, $3, $7; exit}' 2>/dev/null)" || mem_line=""

# --- load average (first 3 fields of /proc/loadavg) ---------------------------
load_line="$(awk '{print $1, $2, $3; exit}' /proc/loadavg 2>/dev/null)" || load_line=""

# --- cpu count -----------------------------------------------------------------
nproc_val="$(nproc 2>/dev/null)" || nproc_val=""

# --- docker containers ----------------------------------------------------------
containers_json="$(docker ps --format '{{json .}}' 2>/dev/null \
  | jq -cs 'map({name: .Names, image: .Image, status: .Status})' 2>/dev/null)" \
  || containers_json=""
# Guard: anything that is not parseable JSON collapses to [].
jq -e . >/dev/null 2>&1 <<<"$containers_json" || containers_json="[]"

# --- assemble one line of JSON ---------------------------------------------------
jq -cn \
  --arg ts "$ts" \
  --arg host "$host" \
  --arg gpu_csv "$gpu_csv" \
  --arg mem "$mem_line" \
  --arg load "$load_line" \
  --arg nproc "$nproc_val" \
  --argjson containers "$containers_json" \
  '
  def num: tonumber? // null;
  {
    v: 1,
    ts: (($ts | tonumber?) // 0),
    hostname: $host,
    gpu: (
      if $gpu_csv == "" then null
      else
        ($gpu_csv | split(", ")) as $f |
        {
          temp:        (($f[0] // "") | num),
          power:       (($f[1] // "") | num),
          utilization: (($f[2] // "") | num),
          clockMhz:    (($f[3] // "") | num),
          name:        (($f[4:] | join(", ")) as $n | if $n == "" then null else $n end)
        }
      end
    ),
    mem: (
      ($mem | split(" ")) as $m |
      {
        totalBytes:     (($m[0] // "") | num),
        usedBytes:      (($m[1] // "") | num),
        availableBytes: (($m[2] // "") | num)
      }
    ),
    load: (
      ($load | split(" ")) as $l |
      [ (($l[0] // "") | num),
        (($l[1] // "") | num),
        (($l[2] // "") | num) ]
    ),
    nproc: (($nproc | tonumber?) // null),
    containers: $containers
  }'
