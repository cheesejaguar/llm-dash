const MAX_SIZE = 600; // 30 min at 3s intervals

class RingBuffer {
  constructor(maxSize = MAX_SIZE) {
    this.maxSize = maxSize;
    this.buffer = [];
  }

  push(item) {
    this.buffer.push(item);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getAll() {
    return this.buffer;
  }

  get length() {
    return this.buffer.length;
  }
}

const SERIES_KEYS = [
  'genTps', 'computeTps', 'cacheTps', 'running', 'waiting', 'kvPct', 'accept',
  'ttftMs', 'tpotMs', 'prefixHit',
  'temp0', 'temp1', 'power0', 'power1', 'cpu0', 'cpu1', 'mem0', 'mem1',
];

function round1(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

// Columnar history payload per the wire contract. Suffix 0 = head, 1 = worker;
// the caller passes hostOrder ([headHost, workerHost]) so the mapping is
// role-based, not nodes-object insertion order. Falls back to insertion order
// when hostOrder is omitted.
function historyToColumnar(snapshots, hostOrder) {
  const t = [];
  const s = {};
  for (const key of SERIES_KEYS) s[key] = [];

  for (const snap of snapshots) {
    t.push(snap.t);
    const v = snap.vllm || {};
    s.genTps.push(round1(v.genTps));
    s.computeTps.push(round1(v.computeTps));
    s.cacheTps.push(round1(v.cacheTps));
    s.running.push(round1(v.running));
    s.waiting.push(round1(v.waiting));
    s.kvPct.push(round1(v.kvPct));
    s.accept.push(round1(v.spec ? v.spec.accept : null));
    s.ttftMs.push(v.ttft === null || v.ttft === undefined ? null : round1(v.ttft * 1000));
    s.tpotMs.push(round1(v.itl));
    s.prefixHit.push(round1(v.prefix ? v.prefix.roll : null));

    const hosts = hostOrder || Object.keys(snap.nodes || {});
    for (let i = 0; i < 2; i++) {
      const node = hosts[i] !== undefined ? snap.nodes[hosts[i]] : null;
      const gpu = node && node.gpu ? node.gpu : null;
      s[`temp${i}`].push(round1(gpu ? gpu.temp : null));
      s[`power${i}`].push(round1(gpu ? gpu.power : null));
      s[`cpu${i}`].push(round1(node && node.cpu ? node.cpu.pct : null));
      s[`mem${i}`].push(round1(node && node.mem ? node.mem.used : null));
    }
  }

  return { t, s };
}

module.exports = { RingBuffer, historyToColumnar };
