import { describe, expect, it } from 'vitest';
import { createProxy, describeFetchError, isRetryableFetchFailure, type ProxyEvent } from '../src/core/proxy';

const BODY = JSON.stringify({
  model: 'gpt-5.6-sol',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
});
const request = () =>
  new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: BODY,
  });

function socketError(code = 'ECONNRESET'): TypeError {
  const cause = Object.assign(new Error('other side closed'), { code });
  return new TypeError('fetch failed', { cause });
}

function mockFetch(impl: (call: number) => Promise<Response>) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => impl(++calls)) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const ok = () =>
  new Response(JSON.stringify({ id: 'r', output: [] }), { headers: { 'content-type': 'application/json' } });

function proxyWithEvents() {
  const events: ProxyEvent[] = [];
  const proxy = createProxy({
    openAIUpstream: 'http://mock',
    transform: { compress: false },
    onRequest: (e) => {
      events.push(e);
    },
  });
  return { proxy, events };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('upstream connection retry', () => {
  it('retries once on a socket reset and succeeds', async () => {
    const m = mockFetch(async (n) => {
      if (n === 1) throw socketError();
      return ok();
    });
    try {
      const { proxy, events } = proxyWithEvents();
      const res = await proxy(request());
      await res.text();
      await settle();
      expect(res.status).toBe(200);
      expect(m.calls()).toBe(2);
      expect(events.at(-1)?.upstreamRetried).toBe(true);
    } finally {
      m.restore();
    }
  });

  it('gives up after one retry and reports the cause', async () => {
    const m = mockFetch(async () => {
      throw socketError('ECONNREFUSED');
    });
    try {
      const { proxy, events } = proxyWithEvents();
      const res = await proxy(request());
      await res.text();
      await settle();
      expect(res.status).toBe(502);
      expect(m.calls()).toBe(2);
      expect(events.at(-1)?.error).toContain('ECONNREFUSED');
      expect(events.at(-1)?.error).toContain('after 1 retry');
    } finally {
      m.restore();
    }
  });

  it('does not retry a plain HTTP error response', async () => {
    const m = mockFetch(async () => new Response('{"error":"x"}', { status: 500 }));
    try {
      const { proxy } = proxyWithEvents();
      const res = await proxy(request());
      await res.text();
      expect(res.status).toBe(500);
      expect(m.calls()).toBe(1);
    } finally {
      m.restore();
    }
  });
});

describe('fetch error helpers', () => {
  it('appends the underlying cause to "fetch failed"', () => {
    expect(describeFetchError(socketError())).toBe('fetch failed (ECONNRESET other side closed)');
    expect(describeFetchError(new Error('plain'))).toBe('plain');
  });

  it('classifies retryable failures', () => {
    expect(isRetryableFetchFailure(socketError(), '{}')).toBe(true);
    expect(isRetryableFetchFailure(socketError(), new ReadableStream())).toBe(false);
    expect(isRetryableFetchFailure(new Error('pxpipe: upstream headers timeout'), '{}')).toBe(false);
    expect(isRetryableFetchFailure(socketError('ERR_SOMETHING_ELSE'), '{}')).toBe(false);
  });
});
