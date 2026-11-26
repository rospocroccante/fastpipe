#!/usr/bin/env node
// Local service control for the fastpipe proxy: a background service plus the Claude Code setting that points at it.
//
//   fastpipe status     what is running, hooked and paused
//   fastpipe pause      stop transforming now: every request passes through untouched, no restart
//   fastpipe resume     transform again
//   fastpipe off        kill switch: pause, unhook Claude Code, stop the service
//   fastpipe on         clean start: (re)start the service, wait until it answers, only then hook Claude Code
//   fastpipe restart    restart the service only; leaves hook and pause as they are
//   fastpipe direct     run one Claude Code session straight to Anthropic (extra args go to claude)
//   fastpipe install    copy this build into ~/.fastpipe/app and put a `fastpipe` command on PATH
//   fastpipe watchdog   foreground health loop (the service runs it after `on`): unhooks Claude Code after 2 failed probes 30s apart, re-hooks when the proxy is back
//   fastpipe autostart  what the login entry runs where no service manager exists: start the proxy and the watchdog
//
// The service runs under launchd on macOS, under the systemd user manager on Linux when there is one, and as a detached
// background process everywhere else (Windows, Linux without systemd). FASTPIPE_SERVICE=launchd|systemd|process overrides the choice.
//
// Run from a package or a source tree, `on` and `restart` first copy that build into ~/.fastpipe/app, so installing a newer
// package and running `fastpipe on` is the whole upgrade. The service always runs the copy, never the package.
//
// Pause works through a flag file the proxy checks on every request, so it reaches sessions that are already open.
// Hook and unhook edit env.ANTHROPIC_BASE_URL in ~/.claude/settings.json, which Claude Code reads when a session starts.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const FP_DIR = path.join(HOME, '.fastpipe');
const APP_DIR = path.join(FP_DIR, 'app');
const APP_ENTRY = path.join(APP_DIR, 'node.js');
const APP_CTL = path.join(APP_DIR, 'ctl.mjs');
const APP_CLI = path.join(APP_DIR, 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);
// Where the build sits when this file runs from a package or a source tree (scripts/ next to dist/).
const PACKAGED_ENTRY = path.resolve(path.dirname(SELF), '..', 'dist', 'node.js');
const PAUSE_FILE = path.join(FP_DIR, 'paused');
const LOG_FILE = path.join(FP_DIR, 'proxy.log');
// FASTPIPE_PORT exists so the watchdog and fallback can be tested against a throwaway proxy without touching the live one.
const PORT = Number(process.env.FASTPIPE_PORT) || 47821;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WATCHDOG_LOG = path.join(FP_DIR, 'watchdog.log');
// Present while the watchdog has unhooked Claude Code because the proxy was down; it re-hooks only when this marker exists.
const FALLBACK_MARKER = path.join(FP_DIR, 'fallback-active');
const WATCHDOG_INTERVAL_MS = Number(process.env.FASTPIPE_WATCHDOG_INTERVAL_MS) || 30_000;
const WATCHDOG_FAILS = 2;
const DIRECT_URL = 'https://api.anthropic.com';
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const SETTINGS_BACKUP = `${SETTINGS}.bak-fastpipe-ctl`;
const NODE = process.execPath;
// Which backend the running service was started with, so `off` and `status` talk to the same one `on` used.
const BACKEND_FILE = path.join(FP_DIR, 'service');

// launchd (macOS)
const LABEL = 'com.fastpipe.proxy';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const WATCHDOG_LABEL = 'com.fastpipe.watchdog';
const WATCHDOG_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);

// systemd user manager (Linux)
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const SYSTEMD_DIR = path.join(XDG_CONFIG, 'systemd', 'user');
const UNIT = 'fastpipe.service';
const WATCHDOG_UNIT = 'fastpipe-watchdog.service';

// detached background process (Windows, Linux without systemd)
const PROXY_PID_FILE = path.join(FP_DIR, 'proxy.pid');
const WATCHDOG_PID_FILE = path.join(FP_DIR, 'watchdog.pid');
// The proxy environment chosen at `on`, so a restart at login or by the watchdog uses the same one.
const SERVICE_ENV_FILE = path.join(FP_DIR, 'service-env.json');
// The detached watchdog touches its pid file every second; older than this, it is not running.
const WATCHDOG_STALE_MS = 10_000;

// Arguments of the command being run (after the command name is at index 0), set by main().
let ARGS = [];

// ---- small helpers --------------------------------------------------------

function say(msg) {
  process.stdout.write(`[fastpipe] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[fastpipe] ${msg}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  try {
    // In-memory endpoint: /api/stats.json re-reads the whole events file and 404s while it is empty, so it cannot double as a liveness probe.
    const res = await fetch(`${BASE_URL}/api/compression`, { signal: AbortSignal.timeout(1500) });
    // Any HTTP answer means the proxy is alive; older builds reply 405 here, so only the body is optional.
    return res.ok ? await res.json().catch(() => ({})) : {};
  } catch {
    return undefined;
  }
}

// Whether anything at all is listening on the proxy port, answering or not.
function portOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitUntilAnswering(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await probe();
    if (stats) return stats;
    await sleep(300);
  }
  return undefined;
}

function tailLog(lines) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
    return text.slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function renameOver(tmp, file) {
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows refuses to rename over a file another process holds open (an editor, an indexer). Losing atomicity beats losing the write.
    if (!WIN || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

function writeFileAtomic(file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  renameOver(tmp, file);
}

function writeFileIn(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content, mode);
}

function samePath(a, b) {
  try {
    const ra = fs.realpathSync(a);
    const rb = fs.realpathSync(b);
    return WIN ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

function readPid(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return e.code === 'EPERM';
  }
}

function kill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function ageMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

// ---- Claude Code hook ------------------------------------------------------

function readSettings() {
  let text;
  try {
    text = fs.readFileSync(SETTINGS, 'utf8');
  } catch (e) {
    // A fresh Claude Code install has no user settings file yet.
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return text.trim() === '' ? {} : JSON.parse(text);
}

function hookedUrl() {
  try {
    return readSettings().env?.ANTHROPIC_BASE_URL;
  } catch {
    return undefined;
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS_BACKUP);
  writeFileAtomic(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

function hook() {
  const settings = readSettings();
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (current === BASE_URL) return say('Claude Code already hooked');
  if (current) fail(`ANTHROPIC_BASE_URL is already set to ${current}; not overwriting it`);
  settings.env = { ...(settings.env ?? {}), ANTHROPIC_BASE_URL: BASE_URL };
  saveSettings(settings);
  say(`hooked: new Claude Code sessions go through ${BASE_URL}`);
}

function unhook() {
  const settings = readSettings();
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (current === undefined) return say('Claude Code not hooked');
  if (current !== BASE_URL) return say(`ANTHROPIC_BASE_URL points at ${current}, not fastpipe; left alone`);
  delete settings.env.ANTHROPIC_BASE_URL;
  if (Object.keys(settings.env).length === 0) delete settings.env;
  saveSettings(settings);
  say('unhooked: new Claude Code sessions talk to Anthropic directly');
}

// ---- service environment -----------------------------------------------------

// Upstream is Anthropic directly. Set FASTPIPE_UPSTREAM when running `on` to route through something else (e.g. a capture tap).
// Set FASTPIPE_DEBUG_CAPTURE_4XX=1 when running `on` to keep the full body of every failed request in
// ~/.fastpipe/4xx-bodies. Off by default: those files hold whole conversations and any secret in them.
export function serviceEnv(procEnv = process.env) {
  const env = { PORT: String(PORT) };
  if (procEnv.FASTPIPE_DEBUG_CAPTURE_4XX === '1') env.PXPIPE_DEBUG_CAPTURE_4XX = '1';
  if (procEnv.FASTPIPE_UPSTREAM) env.PXPIPE_UPSTREAM = procEnv.FASTPIPE_UPSTREAM;
  return env;
}

// What a detached process inherits from the shell that started it: enough to run and to reach the network, nothing that
// would configure the proxy by accident. Names are matched without case because Windows spells them `Path`, `SystemRoot`.
const KEEP_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_OPTIONS',
]);

export function detachedEnv(procEnv = process.env, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(procEnv)) {
    if (v !== undefined && KEEP_ENV.has(k.toUpperCase())) env[k] = v;
  }
  return { ...env, ...extra };
}

function readServiceEnv() {
  try {
    return JSON.parse(fs.readFileSync(SERVICE_ENV_FILE, 'utf8'));
  } catch {
    return serviceEnv();
  }
}

// ---- launchd (macOS) -----------------------------------------------------------

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchdPlist({ label, argv, env = {}, logFile }) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `\t\t<key>${escapeXml(k)}</key>\n\t\t<string>${escapeXml(v)}</string>`)
    .join('\n');
  const envBlock = envXml ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envXml}\n\t</dict>\n` : '';
  const args = argv.map((a) => `\t\t<string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${envBlock}\t<key>KeepAlive</key>
\t<true/>
\t<key>Label</key>
\t<string>${escapeXml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(logFile)}</string>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

function launchdBackend() {
  const domain = `gui/${process.getuid()}`;
  const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
  const loaded = (label) => launchctl('print', `${domain}/${label}`).status === 0;
  const stop = async (label) => {
    if (!loaded(label)) return false;
    launchctl('bootout', `${domain}/${label}`);
    for (let i = 0; i < 20 && loaded(label); i++) await sleep(250);
    return true;
  };
  const bootstrap = (plist) => {
    const r = launchctl('bootstrap', domain, plist);
    return r.status === 0 ? undefined : `launchctl bootstrap failed: ${(r.stderr || r.stdout || '').trim()}`;
  };
  return {
    name: 'launchd',
    // launchd restarts the proxy when it dies and loads it at login (KeepAlive, RunAtLoad).
    prepare() {
      writeFileIn(PLIST, launchdPlist({ label: LABEL, argv: [NODE, APP_ENTRY], env: serviceEnv(), logFile: LOG_FILE }));
    },
    async proxyState() {
      const r = launchctl('print', `${domain}/${LABEL}`);
      const m = r.status === 0 ? /\bpid = (\d+)/.exec(r.stdout) : null;
      return { loaded: r.status === 0, pid: m ? Number(m[1]) : undefined };
    },
    async startProxy() {
      await stop(LABEL);
      return bootstrap(PLIST);
    },
    stopProxy: () => stop(LABEL),
    async startWatchdog() {
      writeFileIn(
        WATCHDOG_PLIST,
        launchdPlist({ label: WATCHDOG_LABEL, argv: [NODE, APP_CTL, 'watchdog'], logFile: WATCHDOG_LOG }),
      );
      await stop(WATCHDOG_LABEL);
      return bootstrap(WATCHDOG_PLIST);
    },
    stopWatchdog: () => stop(WATCHDOG_LABEL),
    watchdogRunning: async () => loaded(WATCHDOG_LABEL),
    disable() {},
  };
}

// ---- systemd user manager (Linux) -------------------------------------------------

function systemctl(...args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
}

// True when this login has a systemd user manager to talk to. A machine can run systemd and still have none
// (a container, a bare `su` shell), in which case the background-process service is used instead.
export function hasSystemdUser() {
  const r = systemctl('show-environment');
  return !r.error && r.status === 0;
}

export function systemdUnit({ description, argv, env = {}, logFile }) {
  // systemd expands %-specifiers everywhere and $-variables in ExecStart; doubling them makes the value arrive verbatim.
  const specifiers = (s) => s.replace(/%/g, '%%');
  const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const exec = argv.map((a) => quote(specifiers(a).replace(/\$/g, '$$$$'))).join(' ');
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${quote(specifiers(`${k}=${v}`))}\n`)
    .join('');
  return `[Unit]
Description=${description}

[Service]
ExecStart=${exec}
${envLines}Restart=always
RestartSec=2
StandardOutput=append:${specifiers(logFile)}
StandardError=append:${specifiers(logFile)}

[Install]
WantedBy=default.target
`;
}

function systemdBackend() {
  const active = (unit) => systemctl('is-active', '--quiet', unit).status === 0;
  const enabled = (unit) => systemctl('is-enabled', '--quiet', unit).status === 0;
  // `enable` makes the unit start at login, `restart` starts it now whether or not it was running.
  const start = (unit) => {
    systemctl('daemon-reload');
    systemctl('enable', unit);
    const r = systemctl('restart', unit);
    return r.status === 0 ? undefined : `systemctl --user restart ${unit} failed: ${(r.stderr || r.stdout || '').trim()}`;
  };
  const stop = async (unit) => {
    if (!active(unit) && !enabled(unit)) return false;
    systemctl('disable', '--now', unit);
    return true;
  };
  return {
    name: 'systemd',
    prepare() {
      writeFileIn(
        path.join(SYSTEMD_DIR, UNIT),
        systemdUnit({ description: 'fastpipe proxy', argv: [NODE, APP_ENTRY], env: serviceEnv(), logFile: LOG_FILE }),
      );
    },
    async proxyState() {
      const pid = Number(systemctl('show', '-p', 'MainPID', '--value', UNIT).stdout?.trim());
      return { loaded: active(UNIT) || enabled(UNIT), pid: pid > 0 ? pid : undefined };
    },
    async startProxy() {
      return start(UNIT);
    },
    stopProxy: () => stop(UNIT),
    async startWatchdog() {
      writeFileIn(
        path.join(SYSTEMD_DIR, WATCHDOG_UNIT),
        systemdUnit({ description: 'fastpipe watchdog', argv: [NODE, APP_CTL, 'watchdog'], logFile: WATCHDOG_LOG }),
      );
      return start(WATCHDOG_UNIT);
    },
    stopWatchdog: () => stop(WATCHDOG_UNIT),
    watchdogRunning: async () => active(WATCHDOG_UNIT),
    disable() {},
  };
}

// ---- detached background process (Windows, Linux without systemd) ----------------------
//
// Nothing supervises the proxy here, so the launcher does the three jobs a service manager would:
//   - start at login: a Startup-folder script on Windows, an XDG autostart entry on Linux desktops, both running `autostart`;
//   - restart on crash: the watchdog starts the proxy again when its port goes quiet;
//   - stop: the proxy reports its own pid on the liveness probe, and that is the process stopped. A pid file can outlive
//     its process and name an unrelated one after a reboot, so a number read from disk is only signalled in the two cases
//     spelled out in stopProxy().

export function windowsStartupScript(node, ctl) {
  // cmd.exe expands %VAR% inside quotes too, so a literal percent sign has to be doubled.
  const q = (s) => `"${s.replace(/%/g, '%%')}"`;
  return [
    '@echo off',
    'rem Starts the fastpipe proxy at login. Written by `fastpipe on`, removed by `fastpipe off`.',
    `start "" /min ${q(node)} ${q(ctl)} autostart`,
    '',
  ].join('\r\n');
}

export function xdgAutostartEntry(node, ctl) {
  // Desktop Entry quoting: inside double quotes, backslash-escape " ` $ and \; %% is a literal percent sign.
  const q = (s) => `"${s.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
  return `[Desktop Entry]
Type=Application
Name=fastpipe
Comment=Starts the fastpipe proxy at login
Exec=${q(node)} ${q(ctl)} autostart
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

function autostartFile() {
  if (WIN) {
    const appData = process.env.APPDATA;
    return appData
      ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'fastpipe.cmd')
      : undefined;
  }
  if (process.platform === 'linux') return path.join(XDG_CONFIG, 'autostart', 'fastpipe.desktop');
  return undefined;
}

function spawnDetached(args, logFile, env) {
  fs.mkdirSync(FP_DIR, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  try {
    const child = spawn(NODE, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env,
      cwd: FP_DIR,
      windowsHide: true,
    });
    // A spawn that fails shows up as a service that never answers; the caller reports that with the log tail.
    child.on('error', () => {});
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

function processBackend() {
  const autostart = autostartFile();

  const spawnProxy = () => {
    const pid = spawnDetached([APP_ENTRY], LOG_FILE, detachedEnv(process.env, readServiceEnv()));
    if (pid) fs.writeFileSync(PROXY_PID_FILE, `${pid}\n`);
  };

  const stopProxy = async () => {
    const info = await probe();
    let pid = Number.isInteger(info?.pid) ? info.pid : undefined;
    if (pid === undefined) {
      // The proxy did not tell us its pid, so the pid file is all there is. It is trusted in two cases only: something
      // holds our port without answering (a hung proxy, or a build older than the pid field), or we spawned the process
      // seconds ago and it has not bound the port yet. After a reboot neither is true, so a stale number is never signalled.
      const filePid = readPid(PROXY_PID_FILE);
      const justSpawned = ageMs(PROXY_PID_FILE) < 20_000;
      if (filePid !== undefined && pidAlive(filePid) && (justSpawned || (await portOpen()))) pid = filePid;
    }
    fs.rmSync(PROXY_PID_FILE, { force: true });
    if (pid === undefined) return false;
    kill(pid);
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
    if (pidAlive(pid)) kill(pid, 'SIGKILL');
    for (let i = 0; i < 20 && (await portOpen()); i++) await sleep(100);
    return true;
  };

  const watchdogRunning = async () => ageMs(WATCHDOG_PID_FILE) < WATCHDOG_STALE_MS;

  // The watchdog exits by itself once its pid file is gone or names another process, so it is never signalled.
  const stopWatchdog = async () => {
    if (!fs.existsSync(WATCHDOG_PID_FILE)) return false;
    const pid = readPid(WATCHDOG_PID_FILE);
    fs.rmSync(WATCHDOG_PID_FILE, { force: true });
    for (let i = 0; i < 40 && pid !== undefined && pidAlive(pid); i++) await sleep(100);
    return true;
  };

  return {
    name: 'process',
    prepare() {
      writeFileIn(SERVICE_ENV_FILE, `${JSON.stringify(serviceEnv(), null, 2)}\n`, 0o600);
      if (!autostart) return say('no login autostart on this system: run `fastpipe on` again after a reboot');
      writeFileIn(autostart, WIN ? windowsStartupScript(NODE, APP_CTL) : xdgAutostartEntry(NODE, APP_CTL));
      if (!WIN) say('login autostart registered for desktop sessions; on a machine without one, run `fastpipe on` after a reboot');
    },
    async proxyState() {
      const info = await probe();
      const pid = Number.isInteger(info?.pid) ? info.pid : undefined;
      const registered = autostart !== undefined && fs.existsSync(autostart);
      return { loaded: pid !== undefined || registered || fs.existsSync(PROXY_PID_FILE), pid };
    },
    async startProxy() {
      await stopProxy();
      spawnProxy();
      return undefined;
    },
    stopProxy,
    spawnProxy,
    async startWatchdog() {
      await stopWatchdog();
      // The watchdog needs the FASTPIPE_* settings this command was given (port, interval), nothing else from the shell.
      const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FASTPIPE_')));
      spawnDetached(
        [APP_CTL, 'watchdog', '--detached'],
        WATCHDOG_LOG,
        detachedEnv(process.env, { ...own, FASTPIPE_SERVICE: 'process' }),
      );
      for (let i = 0; i < 50; i++) {
        if (await watchdogRunning()) return undefined;
        await sleep(100);
      }
      return `the watchdog process did not start; see ${WATCHDOG_LOG}`;
    },
    stopWatchdog,
    watchdogRunning,
    disable() {
      if (autostart) fs.rmSync(autostart, { force: true });
      fs.rmSync(SERVICE_ENV_FILE, { force: true });
    },
  };
}

// ---- backend choice ------------------------------------------------------------

const BACKENDS = { launchd: launchdBackend, systemd: systemdBackend, process: processBackend };

export function pickBackend({
  platform = process.platform,
  forced = process.env.FASTPIPE_SERVICE,
  recorded,
  systemd = hasSystemdUser,
} = {}) {
  if (forced) {
    if (!Object.hasOwn(BACKENDS, forced)) {
      throw new Error(`FASTPIPE_SERVICE must be one of ${Object.keys(BACKENDS).join(', ')}, not "${forced}"`);
    }
    return forced;
  }
  // A home directory can move between machines; a recorded backend only counts where it can exist.
  const usable =
    recorded === 'process' ||
    (recorded === 'launchd' && platform === 'darwin') ||
    (recorded === 'systemd' && platform === 'linux');
  if (usable) return recorded;
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux' && systemd()) return 'systemd';
  return 'process';
}

function recordedBackend() {
  try {
    return fs.readFileSync(BACKEND_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

let cachedBackend;

// `fresh` ignores what the last `on` recorded and looks at the machine again.
function getBackend({ fresh = false } = {}) {
  if (cachedBackend && !fresh) return cachedBackend;
  let name;
  try {
    name = pickBackend({ recorded: fresh ? undefined : recordedBackend() });
  } catch (e) {
    fail(e.message);
  }
  cachedBackend = BACKENDS[name]();
  return cachedBackend;
}

// ---- service start ---------------------------------------------------------------

// Best effort: the proxy is the product, the watchdog is a safety net, so a failure here only warns.
async function startWatchdog() {
  if (!fs.existsSync(APP_CTL)) return say(`watchdog not started: ${APP_CTL} missing (run install)`);
  const err = await getBackend().startWatchdog();
  if (err) return say(`WARNING: watchdog not started: ${err}`);
  say(`watchdog up: unhooks Claude Code if the proxy stops answering for ${(WATCHDOG_INTERVAL_MS * WATCHDOG_FAILS) / 1000}s`);
}

async function startService() {
  if (!fs.existsSync(APP_ENTRY)) fail(`${APP_ENTRY} missing; run \`fastpipe install\` from a built package or source tree`);
  const backend = getBackend();
  const err = await backend.startProxy();
  if (err) fail(err);
  const stats = await waitUntilAnswering(15000);
  if (!stats) {
    await backend.stopProxy();
    process.stderr.write(`${tailLog(20)}\n`);
    fail(`proxy did not answer on ${BASE_URL} within 15s; service stopped, Claude Code left as it was`);
  }
  return stats;
}

// ---- install -------------------------------------------------------------------

// The installed `fastpipe` command: service commands go to this launcher, everything else to the proxy CLI.
const ROUTER = `#!/usr/bin/env node
// Written by \`fastpipe install\`. Service commands go to the launcher, everything else to the proxy CLI.
import { COMMANDS, main } from './ctl.mjs';

if (COMMANDS.includes(process.argv[2])) await main(process.argv.slice(2));
else await import('./node.js');
`;

export function wrapperScript(platform, node, cli) {
  if (platform === 'win32') {
    const q = (s) => `"${s.replace(/%/g, '%%')}"`;
    return ['@echo off', `${q(node)} ${q(cli)} %*`, ''].join('\r\n');
  }
  return `#!/bin/sh\nexec "${node}" "${cli}" "$@"\n`;
}

// A directory for the `fastpipe` command that needs no administrator rights.
function wrapperDir() {
  if (process.env.FASTPIPE_BIN_DIR) return process.env.FASTPIPE_BIN_DIR;
  if (WIN) return path.join(FP_DIR, 'bin');
  const shared = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  for (const dir of shared) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // not there or not ours to write
    }
  }
  return path.join(HOME, '.local', 'bin');
}

function onPath(dir) {
  const norm = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
  return (process.env.PATH ?? '').split(path.delimiter).some((p) => p !== '' && norm(p) === norm(dir));
}

function copyInto(from, to) {
  fs.copyFileSync(from, `${to}.tmp`);
  renameOver(`${to}.tmp`, to);
}

function installApp() {
  if (!fs.existsSync(PACKAGED_ENTRY)) fail(`${PACKAGED_ENTRY} missing; run \`pnpm build\` first`);
  fs.mkdirSync(APP_DIR, { recursive: true });
  copyInto(PACKAGED_ENTRY, APP_ENTRY);
  copyInto(SELF, APP_CTL);
  writeFileAtomic(APP_CLI, ROUTER);
}

// Run from a package or a source tree that holds a build, bring ~/.fastpipe/app up to that build before starting it.
function refreshInstalledCopy() {
  if (samePath(SELF, APP_CTL) || !fs.existsSync(PACKAGED_ENTRY)) return;
  installApp();
  say(`installed this build into ${APP_DIR}`);
}

function install() {
  installApp();
  const dir = wrapperDir();
  const file = path.join(dir, WIN ? 'fastpipe.cmd' : 'fastpipe');
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(file, wrapperScript(process.platform, NODE, APP_CLI), 0o755);
    say(`installed ${APP_ENTRY}, ${APP_CTL} and ${file}`);
    if (!onPath(dir)) say(`${dir} is not on PATH: add it to call \`fastpipe\` from anywhere`);
  } catch (e) {
    say(`installed ${APP_ENTRY} and ${APP_CTL}`);
    say(`WARNING: could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  say('run `fastpipe restart` (or `fastpipe on`) to load the new build');
}

// ---- commands ----------------------------------------------------------------

async function status() {
  const backend = getBackend();
  const state = await backend.proxyState();
  const stats = await probe();
  const hooked = hookedUrl();
  const paused = fs.existsSync(PAUSE_FILE);
  say(`service:  ${state.loaded ? `loaded${state.pid ? ` (pid ${state.pid})` : ' (not running)'}` : 'not loaded'}, ${backend.name}`);
  say(`proxy:    ${stats ? `answering on ${BASE_URL}${stats.compression_enabled === false ? ' (dashboard toggle: off)' : ''}` : 'not answering'}`);
  say(`hooked:   ${hooked === BASE_URL ? 'yes' : hooked ? `no (ANTHROPIC_BASE_URL=${hooked})` : 'no'}`);
  say(`paused:   ${paused ? 'yes (passthrough)' : 'no'}`);
  say(`watchdog: ${(await backend.watchdogRunning()) ? 'running' : 'not running'}${fs.existsSync(FALLBACK_MARKER) ? ' (fallback active: proxy was down, Claude Code unhooked)' : ''}`);
  if (hooked === BASE_URL && !stats) say('WARNING: Claude Code is hooked but the proxy is down; new sessions will fail. Run `fastpipe on` or `fastpipe off`.');
}

function pause() {
  fs.mkdirSync(FP_DIR, { recursive: true });
  fs.writeFileSync(PAUSE_FILE, `${new Date().toISOString()}\n`);
  say('paused: from the next request on, everything passes through untouched (open sessions included)');
}

function resume() {
  fs.rmSync(PAUSE_FILE, { force: true });
  say('resumed: transforming again from the next request');
}

async function off() {
  const backend = getBackend();
  // Watchdog first, or it could re-hook (or restart the proxy) between the unhook and the service stop.
  await backend.stopWatchdog();
  fs.rmSync(FALLBACK_MARKER, { force: true });
  pause();
  unhook();
  const stopped = await backend.stopProxy();
  backend.disable();
  say(stopped ? 'service stopped' : 'service was not running');
  say('Claude Code sessions opened while hooked still point at the proxy: close and reopen them.');
}

async function on() {
  const startPaused = ARGS.includes('--paused');
  refreshInstalledCopy();
  const previous = recordedBackend();
  const backend = getBackend({ fresh: true });
  if (previous && previous !== backend.name && Object.hasOwn(BACKENDS, previous)) {
    // The machine changed since the last `on` (say a systemd user manager appeared): take the old kind of service down first.
    try {
      const old = BACKENDS[previous]();
      await old.stopWatchdog();
      await old.stopProxy();
      old.disable();
    } catch {
      // the old backend does not exist on this machine any more
    }
  }
  fs.mkdirSync(FP_DIR, { recursive: true });
  fs.writeFileSync(BACKEND_FILE, `${backend.name}\n`);
  backend.prepare();
  await startService();
  say(`service up on ${BASE_URL}`);
  if (startPaused) pause();
  else resume();
  hook();
  fs.rmSync(FALLBACK_MARKER, { force: true });
  await startWatchdog();
  say('already-open sessions keep the setting they started with; new sessions pick this up');
}

// Login-time start where no service manager does it: bring the proxy and the watchdog up, leave the hook as it is.
async function autostart() {
  if (!fs.existsSync(APP_ENTRY)) fail(`${APP_ENTRY} missing; run \`fastpipe install\` from a built package or source tree`);
  const err = await getBackend().startProxy();
  const up = err ? undefined : await waitUntilAnswering(15000);
  if (err) say(`WARNING: ${err}`);
  say(up ? `service up on ${BASE_URL}` : `proxy not answering on ${BASE_URL}; the watchdog will send new Claude Code sessions direct`);
  // Started even when the proxy is down: it is what unhooks Claude Code in that case.
  await startWatchdog();
}

function notify(msg) {
  say(msg);
  if (process.env.FASTPIPE_NO_NOTIFY) return;
  // Best effort: the same line is already in the watchdog log. Windows gets the log only.
  if (process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(msg)} with title "fastpipe"`;
    spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  } else if (process.platform === 'linux') {
    spawnSync('notify-send', ['fastpipe', msg], { encoding: 'utf8', timeout: 5000 });
  }
}

// One watchdog tick. Returns the new consecutive-failure count. Never throws and never exits: a crashing watchdog is no watchdog.
async function watchdogTick(fails) {
  const alive = (await probe()) !== undefined;
  try {
    if (alive) {
      if (fs.existsSync(FALLBACK_MARKER)) {
        const current = hookedUrl();
        // Re-hook only the state we undid. If the user (or something else) set a URL meanwhile, leave it.
        if (current === undefined) {
          const settings = readSettings();
          settings.env = { ...(settings.env ?? {}), ANTHROPIC_BASE_URL: BASE_URL };
          saveSettings(settings);
          notify('proxy back up: new Claude Code sessions go through fastpipe again');
        } else {
          say(`proxy back up; ANTHROPIC_BASE_URL is ${current}, left as is`);
        }
        fs.rmSync(FALLBACK_MARKER, { force: true });
      }
      return 0;
    }
    const n = fails + 1;
    // Log the run-up to the threshold, then roughly every 10 minutes at the default interval, not every probe.
    if (n <= WATCHDOG_FAILS || n % 20 === 0) say(`${new Date().toISOString()} proxy not answering on ${BASE_URL} (${n} in a row)`);
    if (n >= WATCHDOG_FAILS && hookedUrl() === BASE_URL && !fs.existsSync(FALLBACK_MARKER)) {
      const settings = readSettings();
      delete settings.env.ANTHROPIC_BASE_URL;
      if (Object.keys(settings.env).length === 0) delete settings.env;
      saveSettings(settings);
      fs.mkdirSync(FP_DIR, { recursive: true });
      fs.writeFileSync(FALLBACK_MARKER, `${new Date().toISOString()}\n`);
      notify('proxy down: new Claude Code sessions go direct to Anthropic. Open sessions: restart them or use `fastpipe direct`.');
    }
    return n;
  } catch (e) {
    say(`watchdog error: ${e instanceof Error ? e.message : String(e)}`);
    return alive ? 0 : fails + 1;
  }
}

async function watchdog() {
  // `--detached` is how the background-process service runs it: no service manager owns this process, so it owns a pid file,
  // exits when that file stops naming it, and restarts the proxy itself.
  const detached = ARGS.includes('--detached');
  const backend = detached ? getBackend() : undefined;
  const mine = () => readPid(WATCHDOG_PID_FILE) === process.pid;
  if (detached) {
    fs.mkdirSync(FP_DIR, { recursive: true });
    fs.writeFileSync(WATCHDOG_PID_FILE, `${process.pid}\n`);
  }
  say(`watchdog: probing ${BASE_URL} every ${WATCHDOG_INTERVAL_MS / 1000}s`);
  let fails = 0;
  for (;;) {
    fails = await watchdogTick(fails);
    if (!detached) {
      await sleep(WATCHDOG_INTERVAL_MS);
      continue;
    }
    if (!mine()) return;
    if (fails > 0 && typeof backend.spawnProxy === 'function' && !(await portOpen())) {
      say(`${new Date().toISOString()} proxy process gone; starting it again`);
      try {
        backend.spawnProxy();
      } catch (e) {
        say(`could not start the proxy: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (let left = WATCHDOG_INTERVAL_MS; left > 0; left -= 1000) {
      await sleep(Math.min(left, 1000));
      if (!mine()) return;
      const now = new Date();
      try {
        fs.utimesSync(WATCHDOG_PID_FILE, now, now);
      } catch {
        // removed between the check and the touch: the next check ends the loop
      }
    }
  }
}

// cmd.exe splits on spaces and treats & | < > ^ as syntax unless the argument is quoted.
export function quoteCmdArg(arg) {
  return /^[\w@+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

// Manual escape hatch: one Claude Code session straight to Anthropic, whatever settings.json says. --settings outranks the user settings file.
function direct() {
  const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: DIRECT_URL } });
  const bin = process.env.FASTPIPE_CLAUDE_BIN || 'claude';
  const extra = ARGS.slice(1);
  let r;
  if (WIN) {
    // On Windows `claude` is usually a .cmd shim, which only a shell can run, and cmd.exe mangles inline JSON:
    // hand the settings over as a file instead.
    const file = path.join(FP_DIR, 'direct-settings.json');
    writeFileIn(file, `${settings}\n`);
    r = spawnSync([bin, '--settings', file, ...extra].map(quoteCmdArg).join(' '), { stdio: 'inherit', shell: true });
  } else {
    r = spawnSync(bin, ['--settings', settings, ...extra], { stdio: 'inherit' });
  }
  if (r.error) fail(`could not run claude: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

async function restart() {
  refreshInstalledCopy();
  await startService();
  say(`service restarted on ${BASE_URL}`);
}

const commands = { status, pause, resume, off, on, restart, install, watchdog, direct, autostart };

// The command names the `fastpipe` command routes here; anything else belongs to the proxy CLI.
export const COMMANDS = Object.keys(commands);

export async function main(argv = []) {
  ARGS = argv;
  const cmd = argv[0] ?? 'status';
  if (!Object.hasOwn(commands, cmd)) fail(`unknown command "${cmd}"; use one of: ${COMMANDS.join(', ')}`);
  await commands[cmd]();
}

// Act only when run as a program. Importing this file (the tests and the command router do) must not touch the machine.
if (process.argv[1] !== undefined && samePath(process.argv[1], SELF)) {
  await main(process.argv.slice(2));
}
