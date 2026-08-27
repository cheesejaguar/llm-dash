// Label block: bare chars or quoted strings, so an unescaped '}' inside a
// quoted label value (legal in the exposition format) does not end the block.
const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)({(?:[^"}]|"(?:\\.|[^"\\])*")*})?\s+(\S+)/;
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
const MODEL_TTL_MS = 60000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function round(v, decimals) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

async function fetchText(url, timeoutMs = 2500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  if (!res.body) return '';
  // Stream with a hard size cap so a misbehaving endpoint cannot exhaust the heap.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error(`response from ${url} exceeds ${MAX_BODY_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseLabels(str) {
  const labels = {};
  const body = str.slice(1, -1);
  LABEL_RE.lastIndex = 0;
  let m;
  while ((m = LABEL_RE.exec(body)) !== null) {
    labels[m[1]] = m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
  }
  return labels;
}

function parsePrometheus(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = SAMPLE_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    if (name.endsWith('_created')) continue;
    const value = parseFloat(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = m[2] ? parseLabels(m[2]) : {};
    if (!map.has(name)) map.set(name, []);
    map.get(name).push({ labels, value });
  }
  return map;
}

function metricValue(map, name, labelFilter = {}) {
  const samples = map.get(name);
  if (!samples) return null;
  let sum = null;
  for (const s of samples) {
    let match = true;
    for (const [k, v] of Object.entries(labelFilter)) {
      if (s.labels[k] !== v) {
        match = false;
        break;
      }
    }
    if (match) sum = (sum === null ? 0 : sum) + s.value;
  }
  return sum;
}

// Mean across label sets: correct for utilization-fraction gauges, which must
// not be summed per engine (metricValue sums, which is right for counters and
// queue-depth gauges but over-reports e.g. kv_cache_usage_perc under DP>1).
function metricMean(map, name, labelFilter = {}) {
  const samples = map.get(name);
  if (!samples) return null;
  let sum = 0;
  let count = 0;
  for (const s of samples) {
    let match = true;
    for (const [k, v] of Object.entries(labelFilter)) {
      if (s.labels[k] !== v) {
        match = false;
        break;
      }
    }
    if (match) {
      sum += s.value;
      count += 1;
    }
  }
  return count ? sum / count : null;
}

// [stateKey, metricName, labelFilter]
const COUNTER_SPECS = [
  ['computeTokens', 'vllm:prompt_tokens_by_source_total', { source: 'local_compute' }],
  ['cacheTokens', 'vllm:prompt_tokens_by_source_total', { source: 'local_cache_hit' }],
  ['genTokens', 'vllm:generation_tokens_total', null],
  ['draftTokens', 'vllm:spec_decode_num_draft_tokens_total', null],
  ['accepted', 'vllm:spec_decode_num_accepted_tokens_total', null],
  ['drafts', 'vllm:spec_decode_num_drafts_total', null],
  ['acceptedPos0', 'vllm:spec_decode_num_accepted_tokens_per_pos_total', { position: '0' }],
  ['acceptedPos1', 'vllm:spec_decode_num_accepted_tokens_per_pos_total', { position: '1' }],
  ['acceptedPos2', 'vllm:spec_decode_num_accepted_tokens_per_pos_total', { position: '2' }],
  ['prefixQueries', 'vllm:prefix_cache_queries_total', null],
  ['prefixHits', 'vllm:prefix_cache_hits_total', null],
  ['ttftSum', 'vllm:time_to_first_token_seconds_sum', null],
  ['ttftCount', 'vllm:time_to_first_token_seconds_count', null],
  ['itlSum', 'vllm:inter_token_latency_seconds_sum', null],
  ['itlCount', 'vllm:inter_token_latency_seconds_count', null],
];

class VllmDeriver {
  constructor({ windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
    this.reset();
  }

  reset() {
    this.prev = null;
    this.window = [];
    this.lastTtft = null;
    this.lastItl = null;
  }

  nulls(prefixLife = null) {
    return {
      genTps: null,
      computeTps: null,
      cacheTps: null,
      accept: null,
      meanLen: null,
      perPos: null,
      prefixRoll: null,
      prefixLife,
      ttft: null,
      itl: null,
    };
  }

  windowSum(key) {
    let sum = null;
    for (const e of this.window) {
      const v = e.delta[key];
      if (v !== null) sum = (sum === null ? 0 : sum) + v;
    }
    return sum;
  }

  windowDt() {
    let sum = 0;
    for (const e of this.window) sum += e.dt;
    return sum;
  }

  update(map, tsMs) {
    const cur = {};
    for (const [key, name, labels] of COUNTER_SPECS) {
      cur[key] = metricValue(map, name, labels || {});
    }

    const prefixLife = (cur.prefixHits !== null && cur.prefixQueries !== null && cur.prefixQueries > 0)
      ? round((100 * cur.prefixHits) / cur.prefixQueries, 1)
      : null;

    const prev = this.prev;
    this.prev = { values: cur, tsMs };

    if (!prev || tsMs <= prev.tsMs) {
      return this.nulls(prefixLife);
    }

    const dt = (tsMs - prev.tsMs) / 1000;
    const delta = {};
    for (const [key] of COUNTER_SPECS) {
      const a = prev.values[key];
      const b = cur[key];
      if (a === null || b === null) {
        delta[key] = null;
        continue;
      }
      const d = b - a;
      if (d < 0) {
        // Counter went backwards: vLLM restarted. Drop all derived state.
        this.reset();
        this.prev = { values: cur, tsMs };
        return this.nulls();
      }
      delta[key] = d;
    }

    this.window.push({ t: tsMs, dt, delta });
    const cutoff = tsMs - this.windowMs;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();

    const genTps = delta.genTokens !== null ? round(delta.genTokens / dt, 1) : null;

    // Prefill is bursty: a multi-thousand-token prompt finishes in well under
    // one poll tick, so the raw per-tick rate is 0 almost all the time even
    // though prompt tokens are being processed at a high rate in that instant.
    // Average over the rolling window instead, so a burst stays visible for
    // windowMs after it happens rather than showing on a single sample.
    const sWindowDt = this.windowDt();
    const sComputeTokens = this.windowSum('computeTokens');
    const computeTps = (sComputeTokens !== null && sWindowDt > 0)
      ? round(sComputeTokens / sWindowDt, 1)
      : null;
    const sCacheTokens = this.windowSum('cacheTokens');
    const cacheTps = (sCacheTokens !== null && sWindowDt > 0)
      ? round(sCacheTokens / sWindowDt, 1)
      : null;

    const sAccepted = this.windowSum('accepted');
    const sDraftTokens = this.windowSum('draftTokens');
    const sDrafts = this.windowSum('drafts');

    const accept = (sAccepted !== null && sDraftTokens !== null && sDraftTokens > 0)
      ? round((100 * sAccepted) / sDraftTokens, 1)
      : null;
    const meanLen = (sAccepted !== null && sDrafts !== null && sDrafts > 0)
      ? round(1 + sAccepted / sDrafts, 2)
      : null;

    let perPos = null;
    if (sDrafts !== null && sDrafts > 0) {
      perPos = ['acceptedPos0', 'acceptedPos1', 'acceptedPos2'].map((key) => {
        const v = this.windowSum(key);
        return v === null ? null : round((100 * v) / sDrafts, 1);
      });
    }

    const sPrefixHits = this.windowSum('prefixHits');
    const sPrefixQueries = this.windowSum('prefixQueries');
    const prefixRoll = (sPrefixHits !== null && sPrefixQueries !== null && sPrefixQueries > 0)
      ? round((100 * sPrefixHits) / sPrefixQueries, 1)
      : null;

    const sTtftSum = this.windowSum('ttftSum');
    const sTtftCount = this.windowSum('ttftCount');
    let ttft = this.lastTtft;
    if (sTtftSum !== null && sTtftCount !== null && sTtftCount > 0) {
      ttft = round(sTtftSum / sTtftCount, 3);
      this.lastTtft = ttft;
    }

    const sItlSum = this.windowSum('itlSum');
    const sItlCount = this.windowSum('itlCount');
    let itl = this.lastItl;
    if (sItlSum !== null && sItlCount !== null && sItlCount > 0) {
      itl = round((sItlSum / sItlCount) * 1000, 1);
      this.lastItl = itl;
    }

    return { genTps, computeTps, cacheTps, accept, meanLen, perPos, prefixRoll, prefixLife, ttft, itl };
  }
}

function downResult() {
  return {
    up: false,
    model: null,
    maxLen: null,
    maxSeqs: null,
    kvPct: null,
    running: null,
    waiting: null,
    preempt: null,
    computeTps: null,
    cacheTps: null,
    genTps: null,
    ttft: null,
    itl: null,
    spec: { accept: null, meanLen: null, perPos: null },
    prefix: { roll: null, life: null },
    success: null,
  };
}

async function refreshModelInfo(ctx, now) {
  if (ctx.modelInfo && now - ctx.modelInfo.fetchedAt < MODEL_TTL_MS) return;
  try {
    const json = JSON.parse(await fetchText(`${ctx.base}/v1/models`));
    const entry = json && Array.isArray(json.data) ? json.data[0] : null;
    if (entry) {
      ctx.modelInfo = {
        id: typeof entry.id === 'string' ? entry.id : null,
        maxLen: Number.isFinite(entry.max_model_len) ? entry.max_model_len : null,
        fetchedAt: now,
      };
    }
  } catch (err) {
    // Keep any stale cache; retry on a later cycle.
  }
}

async function collectLlm(ctx) {
  let map;
  try {
    map = parsePrometheus(await fetchText(`${ctx.base}/metrics`));
  } catch (err) {
    return downResult();
  }

  const now = Date.now();
  await refreshModelInfo(ctx, now);
  const d = ctx.deriver.update(map, now);

  const kvRaw = metricMean(map, 'vllm:kv_cache_usage_perc');
  const kvPct = kvRaw === null ? null : round(Math.min(100, Math.max(0, kvRaw * 100)), 1);

  return {
    up: true,
    model: ctx.modelInfo ? ctx.modelInfo.id : null,
    maxLen: ctx.modelInfo ? ctx.modelInfo.maxLen : null,
    maxSeqs: parseInt(process.env.VLLM_MAX_SEQS, 10) || 12,
    kvPct,
    running: metricValue(map, 'vllm:num_requests_running'),
    waiting: metricValue(map, 'vllm:num_requests_waiting'),
    preempt: metricValue(map, 'vllm:num_preemptions_total'),
    computeTps: d.computeTps,
    cacheTps: d.cacheTps,
    genTps: d.genTps,
    ttft: d.ttft,
    itl: d.itl,
    spec: { accept: d.accept, meanLen: d.meanLen, perPos: d.perPos },
    prefix: { roll: d.prefixRoll, life: d.prefixLife },
    success: metricValue(map, 'vllm:request_success_total'),
  };
}

module.exports = { fetchText, parsePrometheus, metricValue, VllmDeriver, collectLlm, downResult };
