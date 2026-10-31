const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');

function spawnServer(args, options = {}) {
  // Explicit fixtures are caller-owned; inherited CV_MODEL_DIR is never safe for tests.
  const { modelDir, ...spawnOptions } = options;
  const ownedModelDir = modelDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-e2e-models-'));
  const cleanup = () => {
    if (ownedModelDir) fs.rmSync(ownedModelDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  let child;
  try {
    child = spawn(process.execPath, args, {
      ...spawnOptions,
      env: { ...process.env, ...options.env, PORT: '0', HTTPS_PORT: '', CV_MODEL_DIR: modelDir || ownedModelDir },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  child.closed = new Promise((resolve, reject) => child.once('close', code => {
    try { cleanup(); resolve(code); }
    catch (error) { reject(error); }
  }));
  child.closed.catch(() => {});
  child.ready = new Promise((resolve, reject) => {
    const controller = new AbortController();
    const finish = (error, port) => {
      clearTimeout(timeout);
      if (controller.signal.aborted) return;
      controller.abort();
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(port);
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`Server exited before readiness (${signal || code}): ${stderr}`));
    const onMessage = async message => {
      if (message?.type !== 'listening' || !Number.isInteger(message.port) || message.port <= 0) return;
      child.off('message', onMessage);
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`http://127.0.0.1:${message.port}/api/health`, { signal: controller.signal });
          await res.text();
          if (res.ok) return finish(null, message.port);
        } catch { /* retry until readiness, exit, or timeout */ }
        try { await delay(100, undefined, { signal: controller.signal }); } catch { return; }
      }
    };
    const timeout = setTimeout(() => finish(new Error(`Server did not start in time: ${stderr}`)), 15000);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
  // Capture failures even if a caller is still finishing setup before awaiting readiness.
  child.ready.catch(() => {});
  return child;
}

function waitForServer(child) {
  return child.ready;
}

async function stopServer(child) {
  // SIGKILL avoids sqlite3 teardown crashes on Windows; close confirms file handles are gone.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await child.closed;
}

module.exports = { spawnServer, waitForServer, stopServer };
