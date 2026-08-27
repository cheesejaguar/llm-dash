const { execFile } = require('child_process');
const { sshExec } = require('../ssh');

const QUERY = 'temperature.gpu,power.draw,utilization.gpu,clocks.current.graphics,memory.used,memory.total,gpu_name';

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

function parseGpuLine(line) {
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 7) return null;
  return {
    temp: num(parts[0]) ?? 0,
    power: num(parts[1]) ?? 0,
    utilization: num(parts[2]) ?? 0,
    clockMhz: parseInt(parts[3]) || 0,
    memUsedMB: num(parts[4]),
    memTotalMB: num(parts[5]),
    name: parts[6],
  };
}

function collectLocalGpu() {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', [
      '--query-gpu=' + QUERY,
      '--format=csv,noheader,nounits'
    ], { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      const gpu = parseGpuLine(stdout.trim());
      if (!gpu) return reject(new Error('Failed to parse nvidia-smi output'));
      resolve(gpu);
    });
  });
}

function parseRemoteGpu(nvidiaSmiLine) {
  return parseGpuLine(nvidiaSmiLine);
}

module.exports = { collectLocalGpu, parseRemoteGpu, QUERY };
