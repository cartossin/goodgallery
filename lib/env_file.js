// The settings file shared by the systemd service and the login-link command.
//
// The unit loads it with `EnvironmentFile=`, so the server gets the settings
// as ordinary environment variables. `node server.js login-link` runs
// outside the unit, so it reads the same file itself; that way the command
// writes its link where the service looks (STATE_DIR) and prints the port the
// service listens on, without the operator repeating either.
//
// Imports nothing of ours: the command loads this file before lib/config.js
// reads the settings.

import fs from 'fs';

export const DEFAULT_ENV_FILE = '/etc/goodgallery.env';

// Which file: GG_ENV_FILE names another one (tests, or a second install).
export function envFilePath() {
  return process.env.GG_ENV_FILE || DEFAULT_ENV_FILE;
}

// Copy the file's settings into process.env. A variable that is already set
// keeps its value, so `PORT=4000 node server.js login-link` still works.
// Returns the path when a file was read, or null when there is none.
// Exits with a message when the file exists but cannot be read or parsed.
export function loadEnvFile() {
  const file = envFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error(`[fatal] cannot read the settings file ${file} (${error.code || error.message}). Run the command as root.`);
    process.exit(1);
  }
  const settings = parseEnvFile(text, file);
  for (const [name, value] of settings) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return file;
}

// The subset of systemd's EnvironmentFile= format the README documents: one
// VARIABLE=value per line, blank lines and lines starting with # or ; are
// ignored, and a value may be wrapped in single or double quotes.
function parseEnvFile(text, file) {
  const settings = new Map();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const equals = line.indexOf('=');
    const name = equals > 0 ? line.slice(0, equals).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      console.error(`[fatal] ${file} line ${index + 1}: expected VARIABLE=value, found ${JSON.stringify(line)}.`);
      process.exit(1);
    }
    settings.set(name, unquote(line.slice(equals + 1).trim()));
  }
  return settings;
}
function unquote(value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}
