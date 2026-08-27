// RPC status is collected as part of the combined remote SSH call
// This module just provides a parser for the pgrep output

function parseRpcStatus(pgrepLine) {
  const count = parseInt(pgrepLine);
  return {
    running: !isNaN(count) && count > 0,
    processCount: isNaN(count) ? 0 : count,
  };
}

module.exports = { parseRpcStatus };
