// SEA entry for the packaged Windows, Linux, and macOS servers.
//
// The exe is a Node Single Executable Application whose bundled blob is ONLY
// this launcher (pure JS, node: builtins). It boots the REAL server from the
// `app/backend` folder shipped beside it, so native modules (sqlite3, sharp,
// onnxruntime-node) load from real on-disk node_modules exactly as under plain
// `node` — SEA's no-native-addon limit never bites, because none of them are
// in the blob. server.js is
// unmodified: __dirname resolves to the real app/backend/src, so
// ../../frontend/dist and ./data resolve too.
const { createRequire } = require('node:module');
const path = require('node:path');

// Double-clicked from Explorer, the console window dies with the process — so a
// startup crash showed as a window that "opens and closes really quick" with no
// clue what went wrong. Print the error and wait for a keypress instead.
function fatal(err) {
  console.error('\nManafolio could not start.\n');
  console.error(err && err.stack ? err.stack : String(err));
  if (err && err.code === 'MODULE_NOT_FOUND') {
    console.error(
      '\nA file the server needs is missing from this download. Please report this\n' +
      'to your Manafolio administrator with the text above.'
    );
  }
  console.error('\nPress any key to close...');
  try {
    // Raw mode gives us a single keypress; falls through if stdin is not a TTY
    // (piped/service), where exiting immediately is the right behaviour.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
      return;
    }
  } catch { /* not interactive — fall through */ }
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

try {
  const appBackend = path.join(path.dirname(process.execPath), 'app', 'backend');
  const req = createRequire(path.join(appBackend, 'launch-anchor.js'));
  if (process.env.APPIMAGE || process.env.MANAFOLIO_MAC_APP === '1' || process.env.MANAFOLIO_LINUX_APP === '1' || process.env.MANAFOLIO_WINDOWS_APP === '1') {
    const fs = require('node:fs');
    const home = require('node:os').homedir();
    const dataDir = process.env.MANAFOLIO_MAC_APP === '1'
      ? path.join(home, 'Library', 'Application Support', 'Manafolio')
      : process.env.MANAFOLIO_WINDOWS_APP === '1'
        ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Manafolio')
        : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'manafolio');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    process.chdir(dataDir);
    req('dotenv').config();
    process.env.DB_PATH ||= path.join(dataDir, 'manafolio.db');
    process.env.CV_MODEL_DIR ||= path.join(dataDir, 'models');
  } else {
    process.chdir(appBackend); // Preserve archive configuration and relative paths.
  }
  req(path.join(appBackend, 'src', 'server.js'));
} catch (err) {
  fatal(err);
}
