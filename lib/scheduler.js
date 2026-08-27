const { collectNodeStats } = require('./collectors/agent');
const { collectLlm, VllmDeriver, downResult } = require('./collectors/vllm');
const { RingBuffer, historyToColumnar } = require('./history');

const INTERVAL_MS = 3000;
const HEARTBEAT_MS = 15000;
const MAX_CLIENTS = 20;
const MAX_BUFFERED_BYTES = 1024 * 1024; // drop clients that stop reading
const VLLM_BASE = process.env.VLLM_BASE || 'http://127.0.0.1:8000';

const MODEL = { id: 'deepseek-v4-flash', maxContext: 380000 };

// Placeholder cluster, used only when NODES_JSON is unset. Real deployments
// should always set NODES_JSON with the actual node hosts/IPs/roles.
const DEFAULT_NODES = [
  { host: 'node-head', ip: '10.0.0.10', role: 'head' },
  { host: 'node-worker', ip: '10.0.0.11', role: 'worker' },
];

function loadNodes() {
  if (process.env.NODES_JSON) {
    try {
      const nodes = JSON.parse(process.env.NODES_JSON);
      if (Array.isArray(nodes) && nodes.length) return nodes;
      console.error('[scheduler] NODES_JSON is not a non-empty array, using defaults');
    } catch (err) {
      console.error(`[scheduler] Invalid NODES_JSON, using defaults: ${err.message}`);
    }
  }
  return DEFAULT_NODES;
}

const NODES = loadNodes();

// History suffix 0 = head, 1 = worker per the wire contract, regardless of
// NODES_JSON order. Mirrors the frontend's hello-node ordering.
function historyHosts() {
  let head = null;
  let worker = null;
  for (const n of NODES) {
    if (n.role === 'head' && !head) head = n;
    else if (!worker) worker = n;
  }
  if (!head) head = NODES[0];
  if (!worker) worker = NODES[1] || NODES[0];
  return [head.host, worker.host];
}

const HISTORY_HOSTS = historyHosts();
const history = new RingBuffer(600);
const clients = new Set();

const state = {
  serverStart: Date.now(),
  nodeStats: {}, // host -> normalized agent stats, or null when down
  llm: null,     // latest collectLlm result
  llmTs: 0,      // when llm was last collected (epoch ms)
};

const upState = { nodes: {}, llm: undefined };
const llmCtx = { base: VLLM_BASE, deriver: new VllmDeriver(), modelInfo: null };

function logNodeTransition(host, up) {
  if (upState.nodes[host] === up) return;
  upState.nodes[host] = up;
  console.log(`[scheduler] node ${host} is ${up ? 'up' : 'down'}`);
}

function logLlmTransition(up) {
  if (upState.llm === up) return;
  upState.llm = up;
  console.log(`[scheduler] vllm at ${VLLM_BASE} is ${up ? 'up' : 'down'}`);
}

function sseWrite(res, payload) {
  if (res.writableEnded || res.destroyed) {
    clients.delete(res);
    return;
  }
  if (res.writableLength > MAX_BUFFERED_BYTES) {
    // Stalled reader: stop buffering on its behalf and disconnect it.
    clients.delete(res);
    res.destroy();
    return;
  }
  try {
    res.write(payload);
  } catch (err) {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) sseWrite(res, payload);
}

function atCapacity() {
  return clients.size >= MAX_CLIENTS;
}

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
  sseWrite(res, 'retry: 2000\n\n');
  const hello = { serverStart: state.serverStart, model: MODEL, nodes: NODES };
  sseWrite(res, `event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  sseWrite(res, `event: history\ndata: ${JSON.stringify(historyToColumnar(history.getAll(), HISTORY_HOSTS))}\n\n`);
}

function heartbeat() {
  for (const res of clients) sseWrite(res, ':hb\n\n');
}

async function collectNode(node) {
  try {
    const stats = await collectNodeStats(node.ip);
    state.nodeStats[node.host] = stats;
    logNodeTransition(node.host, true);
  } catch (err) {
    state.nodeStats[node.host] = null;
    logNodeTransition(node.host, false);
  }
}

function assembleSnapshot() {
  const now = Date.now();
  const nodes = {};
  for (const node of NODES) {
    const stats = state.nodeStats[node.host];
    if (stats) {
      const ctr = {};
      for (const c of stats.containers) {
        // Wire contract key is `vllm`; the real containers are named vllm-*.
        if (c.name.startsWith('vllm')) ctr.vllm = !!(ctr.vllm || c.running);
        else ctr[c.name] = c.running;
      }
      nodes[node.host] = { up: true, gpu: stats.gpu, mem: stats.mem, cpu: stats.cpu, ctr };
    } else {
      nodes[node.host] = { up: false, gpu: null, mem: null, cpu: null, ctr: null };
    }
  }

  let vllm;
  if (state.llm) {
    vllm = { ...state.llm, ageMs: now - state.llmTs };
  } else {
    vllm = { ...downResult(), ageMs: null };
  }

  const snapshot = { t: now, up: now - state.serverStart, nodes, vllm };
  history.push(snapshot);
  broadcast('snapshot', snapshot);
}

async function nodesLoop() {
  try {
    await Promise.all(NODES.map(collectNode));
    assembleSnapshot();
  } catch (err) {
    // Per-node failures are handled in collectNode; never log per-cycle.
  } finally {
    setTimeout(nodesLoop, INTERVAL_MS);
  }
}

async function llmLoop() {
  try {
    const result = await collectLlm(llmCtx);
    state.llm = result;
    state.llmTs = Date.now();
    logLlmTransition(result.up);
  } catch (err) {
    state.llm = null;
    state.llmTs = Date.now();
    logLlmTransition(false);
  } finally {
    setTimeout(llmLoop, INTERVAL_MS);
  }
}

function start() {
  state.serverStart = Date.now();
  nodesLoop();
  llmLoop();
  setInterval(heartbeat, HEARTBEAT_MS);
  console.log(`[scheduler] started: ${NODES.length} nodes, vllm at ${VLLM_BASE}, ${INTERVAL_MS / 1000}s cadence`);
}

module.exports = { start, addClient, atCapacity };
