// A synthetic request shaped like a long Claude Code session: a large system prompt, 40 tool
// definitions and a history of tool calls with code and shell output. The content comes from a
// seeded generator, so every run and every source tree gets the same bytes. No real transcript
// is involved.

export interface BenchRequest {
  model: string;
  max_tokens: number;
  system: unknown[];
  tools: unknown[];
  messages: Array<{ role: string; content: unknown[] }>;
}

export function buildRequest(model: string, turns: number): BenchRequest {
  let seed = 1;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const word = (): string => Math.floor(rnd() * 1e9).toString(36);
  const para = (n: number): string => Array.from({ length: n }, word).join(' ');
  const code = (lines: number): string =>
    Array.from(
      { length: lines },
      (_, i) => `${i + 1}\t  const v${i} = fn_${word()}(${word()}, ${Math.floor(rnd() * 1e5)});`,
    ).join('\n');

  const tools = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: para(120),
    input_schema: {
      type: 'object',
      properties: { a: { type: 'string', description: para(20) }, b: { type: 'number' } },
      required: ['a'],
    },
  }));
  const messages: BenchRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: para(80) }] }];
  for (let t = 0; t < turns; t++) {
    const id = `toolu_${t}`;
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: para(30) },
        { type: 'tool_use', id, name: t % 2 ? 'Bash' : 'Read', input: { command: para(15) } },
      ],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: t % 2 ? para(400) : code(120) }],
    });
    if (t % 10 === 9) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: para(40) }] });
      messages.push({ role: 'user', content: [{ type: 'text', text: para(15) }] });
    }
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: para(20) }] });
  messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  return { model, max_tokens: 8000, system: [{ type: 'text', text: para(6000) }], tools, messages };
}

export const encode = (req: BenchRequest): Uint8Array => new TextEncoder().encode(JSON.stringify(req));
