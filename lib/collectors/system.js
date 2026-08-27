const { execFile } = require('child_process');
const os = require('os');

function collectLocalSystem() {
  return new Promise((resolve, reject) => {
    execFile('free', ['-b'], { timeout: 3000 }, (err, stdout) => {
      if (err) return reject(err);
      const memLine = stdout.split('\n').find(l => l.startsWith('Mem:'));
      if (!memLine) return reject(new Error('Failed to parse free output'));
      const parts = memLine.split(/\s+/);
      const totalBytes = parseInt(parts[1]) || 0;
      const usedBytes = parseInt(parts[2]) || 0;
      const loadavg = os.loadavg();
      const cpuCount = os.cpus().length;
      resolve({
        ram: {
          totalGB: +(totalBytes / 1073741824).toFixed(1),
          usedGB: +(usedBytes / 1073741824).toFixed(1),
          pct: totalBytes > 0 ? +((usedBytes / totalBytes) * 100).toFixed(1) : 0,
        },
        cpu: {
          load1: +loadavg[0].toFixed(2),
          load5: +loadavg[1].toFixed(2),
          load15: +loadavg[2].toFixed(2),
          cores: cpuCount,
          pct: +((loadavg[0] / cpuCount) * 100).toFixed(1),
        },
      });
    });
  });
}

function parseRemoteSystem(freeLine, loadavgLine, nprocLine) {
  const parts = freeLine.split(/\s+/);
  const totalBytes = parseInt(parts[0]) || 0;
  const usedBytes = parseInt(parts[1]) || 0;
  const loadParts = loadavgLine.split(/\s+/);
  const cores = parseInt(nprocLine) || 1;
  const load1 = parseFloat(loadParts[0]) || 0;
  return {
    ram: {
      totalGB: +(totalBytes / 1073741824).toFixed(1),
      usedGB: +(usedBytes / 1073741824).toFixed(1),
      pct: totalBytes > 0 ? +((usedBytes / totalBytes) * 100).toFixed(1) : 0,
    },
    cpu: {
      load1: +load1.toFixed(2),
      load5: +(parseFloat(loadParts[1]) || 0).toFixed(2),
      load15: +(parseFloat(loadParts[2]) || 0).toFixed(2),
      cores,
      pct: +((load1 / cores) * 100).toFixed(1),
    },
  };
}

module.exports = { collectLocalSystem, parseRemoteSystem };
