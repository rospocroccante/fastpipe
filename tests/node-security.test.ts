import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// NTFS has no POSIX permission bits: Node reports 0o666 for every file and
// directory on Windows, and chmodSync() only toggles the read-only flag. The
// hardening in src/node.ts still runs there — only the assertion is moot, so
// we check the mode where the platform can actually express it.
const hasPosixModes = process.platform !== 'win32';

function expectMode(target: string, expected: number): void {
  if (!hasPosixModes) return;
  expect(fs.statSync(target).mode & 0o777).toBe(expected);
}

let child: ChildProcess | undefined;
let upstream: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  }
  child = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startNode(extraEnv: Record<string, string> = {}): Promise<{
  base: string;
  eventsFile: string;
  configFile: string;
}> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-node-security-'));
  const port = await freePort();
  const upstreamPort = await freePort();
  upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/count_tokens')) {
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve) => upstream!.listen(upstreamPort, '127.0.0.1', resolve));
  const eventsFile = path.join(dir, 'data', 'events.jsonl');
  const configFile = path.join(dir, 'config', 'config.json');
  child = spawn(process.execPath, [tsxCli, 'src/node.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PXPIPE_LOG: eventsFile,
      PXPIPE_CONFIG: configFile,
      // Session state persists to ~/.pxpipe/session-state.json by default; keep
      // test children off the developer's real file.
      PXPIPE_SESSION_STATE: 'off',
      PXPIPE_MODELS: 'claude-fable-5',
      ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (b) => output.push(String(b)));
  child.stderr?.on('data', (b) => output.push(String(b)));
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(output.join(''))), 10_000);
    const poll = () => {
      if (output.join('').includes('[fastpipe] listening on')) {
        clearTimeout(deadline);
        resolve();
        return;
      }
      if (child?.exitCode !== null) {
        clearTimeout(deadline);
        reject(new Error(output.join('')));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  return { base: `http://127.0.0.1:${port}`, eventsFile, configFile };
}

describe('Node dashboard security', () => {
  it('rejects cross-origin mutations and accepts same-origin mutations', async () => {
    const { base, configFile } = await startNode();
    const denied = await fetch(`${base}/fragments/models`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      body: 'list=off',
    });
    expect(denied.status).toBe(403);
    expect(fs.existsSync(configFile)).toBe(false);

    const allowed = await fetch(`${base}/fragments/models`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: base,
        'sec-fetch-site': 'same-origin',
      },
      body: 'list=claude-fable-5',
    });
    expect(allowed.status).toBe(200);
    expectMode(configFile, 0o600);
    expectMode(path.dirname(configFile), 0o700);
  });

  it('rejects dashboard requests with a non-loopback Host header', async () => {
    const { base } = await startNode();
    const response = await fetch(`${base}/fragments/models`, {
      method: 'POST',
      headers: {
        host: 'attacker.example',
        origin: 'http://attacker.example',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'list=off',
    });
    expect(response.status).toBe(403);
  });

  it('creates the event log and containing directory with private permissions', async () => {
    const { base, eventsFile } = await startNode();
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    for (let i = 0; i < 100 && !fs.existsSync(eventsFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expectMode(eventsFile, 0o600);
    expectMode(path.dirname(eventsFile), 0o700);
  });

  it('creates rendered PNG dumps with private permissions', async () => {
    const dumpDir = path.join(os.tmpdir(), `pxpipe-dumps-${process.pid}-${Date.now()}`);
    const { base } = await startNode({ PXPIPE_DUMP_DIR: dumpDir });
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 1,
        system: 'Sensitive system context. '.repeat(1000),
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    let files: string[] = [];
    for (let i = 0; i < 100 && files.length === 0; i++) {
      files = fs.readdirSync(dumpDir);
      if (files.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expectMode(dumpDir, 0o700);
    expect(files.length).toBeGreaterThan(0);
    expectMode(path.join(dumpDir, files[0]!), 0o600);
    fs.rmSync(dumpDir, { recursive: true, force: true });
  });
});

describe('Node request body limit', () => {
  const headers = { 'content-type': 'application/json', 'x-api-key': 'test' };

  /** A Messages request padded with one oversized base64 block. The model is
   *  outside PXPIPE_MODELS, so the proxy forwards it untransformed and the only
   *  thing under test is the inbound ceiling. */
  function paddedRequest(padBytes: number): string {
    return JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(padBytes) },
            },
          ],
        },
      ],
    });
  }

  /** Status the host answers to a declared body size. The limit is enforced on
   *  the declared length before any byte is read, so no body needs to be sent. */
  function statusForDeclaredLength(base: string, declaredBytes: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}/v1/messages`,
        { method: 'POST', headers: { ...headers, 'content-length': String(declaredBytes) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
  }

  it('forwards a request above 16 MiB by default', async () => {
    const { base } = await startNode();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: paddedRequest(17 << 20),
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
  });

  it('still refuses a request above the 32 MiB the Messages API accepts', async () => {
    const { base } = await startNode();
    expect(await statusForDeclaredLength(base, (32 << 20) + 1)).toBe(413);
  });
});

describe('Node liveness probe', () => {
  // On Windows and on Linux without systemd nothing supervises the proxy, so
  // `fastpipe off` has to stop it by pid. A pid file can outlive its process and
  // name an unrelated one; the proxy answering on its own port cannot.
  it('reports the pid of the proxy process', async () => {
    const { base } = await startNode();
    const res = await fetch(`${base}/api/compression`);
    const body = (await res.json()) as { compression_enabled: boolean; pid: number };
    expect(body.compression_enabled).toBe(true);
    expect(Number.isInteger(body.pid)).toBe(true);
    expect(body.pid).not.toBe(process.pid);
    // Signal 0 sends nothing: it only checks that the process exists.
    expect(() => process.kill(body.pid, 0)).not.toThrow();
  });
});
