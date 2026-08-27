const { sshExec } = require('../ssh');

const BYTES_PER_GB = 1024 ** 3;
const MAX_CONTAINERS = 32;
const MAX_CONTAINER_NAME = 128;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function numOrNull(v) {
  return isNum(v) ? v : null;
}

// stats.sh maps any "[N/A]" or failed subcommand to null; per the wire
// contract null means unknown, so tolerate per-field nulls (null out the
// affected block) instead of marking the whole node down.
function normalizeAgentJson(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('agent: payload is not an object');
  if (raw.v !== 1) throw new Error(`agent: unsupported schema version ${raw && raw.v}`);

  let gpu = null;
  if (raw.gpu !== null && raw.gpu !== undefined) {
    const g = raw.gpu;
    if (typeof g !== 'object') throw new Error('agent: bad gpu shape');
    gpu = { temp: numOrNull(g.temp), power: numOrNull(g.power), util: numOrNull(g.utilization), clock: numOrNull(g.clockMhz) };
  }

  const m = raw.mem;
  let mem = null;
  if (m && typeof m === 'object' && isNum(m.totalBytes) && isNum(m.usedBytes) && m.totalBytes > 0) {
    mem = {
      used: round1(m.usedBytes / BYTES_PER_GB),
      total: round1(m.totalBytes / BYTES_PER_GB),
      pct: round1((m.usedBytes / m.totalBytes) * 100),
    };
  }

  let cpu = null;
  if (Array.isArray(raw.load) && isNum(raw.load[0]) && isNum(raw.nproc) && raw.nproc > 0) {
    cpu = {
      load1: raw.load[0],
      cores: raw.nproc,
      pct: round1((raw.load[0] / raw.nproc) * 100),
    };
  }

  if (!Array.isArray(raw.containers)) throw new Error('agent: bad containers shape');
  const containers = raw.containers.slice(0, MAX_CONTAINERS).map((c) => {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || typeof c.status !== 'string') {
      throw new Error('agent: bad container entry');
    }
    return { name: c.name.slice(0, MAX_CONTAINER_NAME), running: c.status.startsWith('Up') };
  });

  return { gpu, mem, cpu, containers };
}

async function collectNodeStats(host) {
  const out = await sshExec(host, 'stats');
  return normalizeAgentJson(JSON.parse(out));
}

module.exports = { collectNodeStats, normalizeAgentJson };
