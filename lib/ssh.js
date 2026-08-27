const { execFile } = require('child_process');

function sshExec(host, command, { timeoutMs = 5000 } = {}) {
  const sshKey = process.env.SSH_KEY;
  if (!sshKey) {
    return Promise.reject(new Error('SSH_KEY environment variable is required'));
  }
  const sshUser = process.env.SSH_USER;
  if (!sshUser) {
    return Promise.reject(new Error('SSH_USER environment variable is required'));
  }
  const knownHosts = process.env.KNOWN_HOSTS || '/app/deploy/known_hosts';
  const args = [
    '-i', sshKey,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=3',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=/tmp/ssh-mux-%r@%h-%p',
    '-o', 'ControlPersist=5m',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    `${sshUser}@${host}`,
    command,
  ];
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

module.exports = { sshExec };
