// Simple in-memory stop-flag registry so a running scraper can be asked to
// wrap up early from an API call, without needing to kill the whole process.
const stopFlags = new Set();

function requestStop(key) {
  stopFlags.add(key);
}

function shouldStop(key) {
  return stopFlags.has(key);
}

function clearStop(key) {
  stopFlags.delete(key);
}

module.exports = { requestStop, shouldStop, clearStop };
