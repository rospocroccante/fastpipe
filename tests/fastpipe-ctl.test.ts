/**
 * `fastpipe on/off/status/...` has to behave the same on macOS, Linux and
 * Windows. The parts that differ per system are small pure functions, tested
 * here by value. The background-process service, used wherever there is no
 * launchd or systemd, is driven end to end against a stand-in proxy inside a
 * throwaway home directory.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ctlPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'fastpipe-ctl.mjs',
);

interface Ctl {
  COMMANDS: string[];
  serviceEnv: (env: Record<string, string>) => Record<string, string>;
  pickBackend: (opts: {
    platform: string;
    forced?: string;
    recorded?: string;
    systemd?: () => boolean;
  }) => string;
  systemdUnit: (opts: {
    description: string;
    argv: string[];
    env?: Record<string, string>;
    logFile: string;
  }) => string;
  windowsStartupScript: (node: string, ctl: string) => string;
  xdgAutostartEntry: (node: string, ctl: string) => string;
  wrapperScript: (platform: string, node: string, cli: string) => string;
  detachedEnv: (
    procEnv: Record<string, string>,
    extra?: Record<string, string>,
  ) => Record<string, string>;
  quoteCmdArg: (arg: string) => string;
}

const ctl = (await import(pathToFileURL(ctlPath).href)) as Ctl;

describe('fastpipe service environment', () => {
  // PXPIPE_DEBUG_CAPTURE_4XX writes the full body of every failed request (the
  // whole conversation, and any secret in it) to disk, so the launcher may only
  // pass it through when the operator asks for it.
  it('leaves 4xx body capture off by default', () => {
    expect(ctl.serviceEnv({})).not.toHaveProperty('PXPIPE_DEBUG_CAPTURE_4XX');
  });

  it('turns 4xx body capture on when FASTPIPE_DEBUG_CAPTURE_4XX=1', () => {
    expect(ctl.serviceEnv({ FASTPIPE_DEBUG_CAPTURE_4XX: '1' })).toMatchObject({
      PXPIPE_DEBUG_CAPTURE_4XX: '1',
    });
  });

  it('keeps capture off for any other value of the switch', () => {
    expect(ctl.serviceEnv({ FASTPIPE_DEBUG_CAPTURE_4XX: 'true' })).not.toHaveProperty(
      'PXPIPE_DEBUG_CAPTURE_4XX',
    );
  });
});

describe('service backend choice', () => {
  const yes = () => true;
  const no = () => false;

  it('uses launchd on macOS', () => {
    expect(ctl.pickBackend({ platform: 'darwin', systemd: no })).toBe('launchd');
  });

  it('uses the systemd user manager on Linux when there is one', () => {
    expect(ctl.pickBackend({ platform: 'linux', systemd: yes })).toBe('systemd');
  });

  it('falls back to a background process on Linux without systemd', () => {
    expect(ctl.pickBackend({ platform: 'linux', systemd: no })).toBe('process');
  });

  it('uses a background process on Windows', () => {
    expect(ctl.pickBackend({ platform: 'win32', systemd: yes })).toBe('process');
  });

  it('keeps using the backend the service was started with', () => {
    expect(ctl.pickBackend({ platform: 'linux', recorded: 'process', systemd: yes })).toBe(
      'process',
    );
  });

  it('lets FASTPIPE_SERVICE override everything', () => {
    expect(
      ctl.pickBackend({ platform: 'darwin', forced: 'process', recorded: 'launchd', systemd: no }),
    ).toBe('process');
  });

  it('rejects an unknown FASTPIPE_SERVICE value', () => {
    expect(() => ctl.pickBackend({ platform: 'linux', forced: 'cron', systemd: no })).toThrow(
      /FASTPIPE_SERVICE/,
    );
  });
});

describe('systemd unit', () => {
  const unit = ctl.systemdUnit({
    description: 'fastpipe proxy',
    argv: ['/opt/node 24/bin/node', '/home/u/.fastpipe/app/node.js'],
    env: { PORT: '47821', LABEL: '50% off' },
    logFile: '/home/u/.fastpipe/proxy.log',
  });

  it('quotes every argument so a path with a space stays one argument', () => {
    expect(unit).toContain('ExecStart="/opt/node 24/bin/node" "/home/u/.fastpipe/app/node.js"');
  });

  it('passes the service environment and escapes systemd specifiers', () => {
    expect(unit).toContain('Environment="PORT=47821"');
    expect(unit).toContain('Environment="LABEL=50%% off"');
  });

  it('restarts the proxy when it dies and starts it at login', () => {
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('appends output to the log file', () => {
    expect(unit).toContain('StandardOutput=append:/home/u/.fastpipe/proxy.log');
    expect(unit).toContain('StandardError=append:/home/u/.fastpipe/proxy.log');
  });
});

describe('login autostart files', () => {
  it('writes a Windows Startup script that launches the launcher minimised', () => {
    const script = ctl.windowsStartupScript(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\a b\\.fastpipe\\app\\ctl.mjs',
    );
    expect(script).toContain(
      'start "" /min "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\.fastpipe\\app\\ctl.mjs" autostart',
    );
    // cmd.exe wants CRLF: no bare line feed may remain.
    expect(script.split('\r\n').join('')).not.toContain('\n');
  });

  it('doubles percent signs, which cmd.exe would otherwise expand', () => {
    const script = ctl.windowsStartupScript('C:\\node.exe', 'C:\\Users\\100%\\ctl.mjs');
    expect(script).toContain('C:\\Users\\100%%\\ctl.mjs');
  });

  it('writes an XDG autostart entry for Linux desktops', () => {
    const entry = ctl.xdgAutostartEntry('/usr/bin/node', '/home/u/.fastpipe/app/ctl.mjs');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('Exec="/usr/bin/node" "/home/u/.fastpipe/app/ctl.mjs" autostart');
  });
});

describe('fastpipe command wrapper', () => {
  it('is a batch file on Windows that forwards every argument', () => {
    const w = ctl.wrapperScript('win32', 'C:\\nodejs\\node.exe', 'C:\\Users\\u\\.fastpipe\\app\\cli.mjs');
    expect(w).toContain('"C:\\nodejs\\node.exe" "C:\\Users\\u\\.fastpipe\\app\\cli.mjs" %*');
    expect(w.split('\r\n').join('')).not.toContain('\n');
  });

  it('is a shell script elsewhere that forwards every argument', () => {
    const w = ctl.wrapperScript('linux', '/usr/bin/node', '/home/u/.fastpipe/app/cli.mjs');
    expect(w.startsWith('#!/bin/sh\n')).toBe(true);
    expect(w).toContain('exec "/usr/bin/node" "/home/u/.fastpipe/app/cli.mjs" "$@"');
  });
});

describe('environment of a background-process service', () => {
  const env = ctl.detachedEnv(
    {
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      HOME: '/home/u',
      SystemRoot: 'C:\\Windows',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      PXPIPE_MODELS: 'claude-fable-5',
    },
    { PORT: '47821' },
  );

  it('keeps what a process needs to run, whatever the case of the name', () => {
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      HOME: '/home/u',
      SystemRoot: 'C:\\Windows',
    });
  });

  it('adds the service settings', () => {
    expect(env.PORT).toBe('47821');
  });

  it('does not leak the calling shell into the proxy', () => {
    // Started from inside a Claude Code session, the shell already points at
    // the proxy: inheriting that would make the proxy call itself.
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env).not.toHaveProperty('PXPIPE_MODELS');
  });
});

describe('arguments handed to cmd.exe by `fastpipe direct`', () => {
  it('leaves a plain argument alone', () => {
    expect(ctl.quoteCmdArg('--model')).toBe('--model');
  });

  it('quotes a path with a space', () => {
    expect(ctl.quoteCmdArg('C:\\Users\\a b\\x.json')).toBe('"C:\\Users\\a b\\x.json"');
  });
});

describe('command routing', () => {
  it('lists the service commands the `fastpipe` command sends to the launcher', () => {
    for (const c of ['on', 'off', 'status', 'pause', 'resume', 'restart', 'direct', 'install', 'autostart']) {
      expect(ctl.COMMANDS).toContain(c);
    }
  });

  it('leaves the proxy CLI its own subcommands', () => {
    for (const c of ['stats', 'export', 'warp']) expect(ctl.COMMANDS).not.toContain(c);
  });
});

// A stand-in for dist/node.js: the launcher only needs something that listens
// on PORT and answers the liveness probe with its pid.
const STAND_IN_PROXY = `const { createServer } = require('node:http');
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ compression_enabled: true, pid: process.pid }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// spawnSync cannot drive this on Windows CI the same way (HOME is not what
// os.homedir() reads there); the Windows-specific pieces are covered above.
describe.skipIf(process.platform === 'win32')('background-process service, end to end', () => {
  let home = '';
  let port = 0;

  const fp = (...p: string[]) => path.join(home, '.fastpipe', ...p);
  const settingsFile = () => path.join(home, '.claude', 'settings.json');
  const base = () => `http://127.0.0.1:${port}`;

  async function setup(): Promise<void> {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fastpipe-ctl-')));
    port = await freePort();
    // The installed layout: launcher and proxy side by side in ~/.fastpipe/app.
    fs.mkdirSync(fp('app'), { recursive: true });
    fs.copyFileSync(ctlPath, fp('app', 'ctl.mjs'));
    fs.writeFileSync(fp('app', 'node.js'), STAND_IN_PROXY);
  }

  function run(...args: string[]) {
    return spawnSync(process.execPath, [fp('app', 'ctl.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 40_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        FASTPIPE_SERVICE: 'process',
        FASTPIPE_PORT: String(port),
        FASTPIPE_WATCHDOG_INTERVAL_MS: '200',
        FASTPIPE_NO_NOTIFY: '1',
      },
    });
  }

  async function probe(): Promise<{ pid: number } | undefined> {
    try {
      const res = await fetch(`${base()}/api/compression`, { signal: AbortSignal.timeout(1000) });
      return (await res.json()) as { pid: number };
    } catch {
      return undefined;
    }
  }

  function readPid(file: string): number | undefined {
    try {
      const n = Number(fs.readFileSync(file, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  afterEach(async () => {
    if (!home) return;
    const leftovers = [(await probe())?.pid, readPid(fp('proxy.pid')), readPid(fp('watchdog.pid'))];
    run('off');
    // Whatever a failed test left behind lives in this throwaway home, so these pids are ours.
    for (const pid of leftovers) {
      if (pid !== undefined && alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    home = '';
  });

  it('starts the proxy and hooks Claude Code, creating settings.json when there is none', async () => {
    await setup();
    const on = run('on');
    expect(on.status, on.stdout + on.stderr).toBe(0);

    expect((await probe())?.pid).toBeGreaterThan(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(base());

    const status = run('status').stdout;
    expect(status).toContain(`answering on ${base()}`);
    expect(status).toContain('hooked:   yes');
    expect(status).toContain('watchdog: running');
  });

  it('adds and removes only its own setting', async () => {
    await setup();
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, env: { FOO: '1' } }),
    );

    expect(run('on').status).toBe(0);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      env: { FOO: '1', ANTHROPIC_BASE_URL: base() },
    });

    expect(run('off').status).toBe(0);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      env: { FOO: '1' },
    });
  });

  it('brings the proxy back when its process dies', async () => {
    await setup();
    expect(run('on').status).toBe(0);
    const first = (await probe())!.pid;
    process.kill(first, 'SIGKILL');

    let second: number | undefined;
    for (let i = 0; i < 80 && (second === undefined || second === first); i++) {
      await sleep(100);
      second = (await probe())?.pid;
    }
    expect(second).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it('off stops the proxy and the watchdog, and nothing starts them again', async () => {
    await setup();
    expect(run('on').status).toBe(0);
    const proxyPid = (await probe())!.pid;
    const watchdogPid = readPid(fp('watchdog.pid'))!;
    expect(alive(watchdogPid)).toBe(true);

    const off = run('off');
    expect(off.status, off.stdout + off.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).env).toBeUndefined();

    // Longer than several watchdog intervals: a surviving watchdog would have restarted the proxy by now.
    await sleep(1200);
    expect(await probe()).toBeUndefined();
    expect(alive(proxyPid)).toBe(false);
    expect(alive(watchdogPid)).toBe(false);
    expect(run('status').stdout).toContain('watchdog: not running');
  });

  it('the login autostart command starts the service without touching the hook', async () => {
    await setup();
    const res = run('autostart');
    expect(res.status, res.stdout + res.stderr).toBe(0);

    expect((await probe())?.pid).toBeGreaterThan(0);
    expect(run('status').stdout).toContain('watchdog: running');
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('restart replaces the running proxy with a new process on the same port', async () => {
    await setup();
    expect(run('on').status).toBe(0);
    const first = (await probe())!.pid;

    const res = run('restart');
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const second = (await probe())?.pid;
    expect(second).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    expect(alive(first)).toBe(false);
  });

  it.runIf(process.platform === 'linux')(
    'registers a desktop autostart entry on Linux and removes it on off',
    async () => {
      await setup();
      const entry = path.join(home, '.config', 'autostart', 'fastpipe.desktop');
      expect(run('on').status).toBe(0);
      expect(fs.readFileSync(entry, 'utf8')).toContain('autostart');
      expect(run('off').status).toBe(0);
      expect(fs.existsSync(entry)).toBe(false);
    },
  );
});
