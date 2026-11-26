/**
 * Mid-conversation tool changes must survive history collapse.
 *
 * Claude Code announces a tool that appears or disappears during a session with a
 * `role: "system"` message carrying `tool_addition` / `tool_removal` blocks. The
 * API resolves every later reference against that running set, so a
 * `tool_removal` naming a tool it never saw added is refused with a 400
 * (`tool_reference_unresolved`). Collapsing the announcing message into a history
 * image used to erase the change and leave exactly that dangling reference.
 *
 * Message shapes and placement mirror captured Claude Code traffic: a system
 * message follows a user turn and holds a text block, then the tool blocks.
 */

import { describe, expect, it } from 'vitest';
import { collapseHistory } from '../src/core/history.js';
import { isCompressionProfitable } from '../src/core/transform.js';
import type { Message } from '../src/core/types.js';

type Block = Record<string, unknown>;

const usr = (text: string): Message => ({ role: 'user', content: text });
const asst = (text: string): Message => ({ role: 'assistant', content: text });
const sys = (content: string | Block[]): Message =>
  ({ role: 'system', content }) as unknown as Message;
const text = (t: string): Block => ({ type: 'text', text: t });
const addition = (name: string, extra: Block = {}): Block => ({
  type: 'tool_addition',
  tool: {
    type: 'tool_definition',
    definition: {
      name,
      description: `Does ${name}.`,
      input_schema: { type: 'object', properties: {} },
    },
  },
  ...extra,
});
const removal = (name: string, extra: Block = {}): Block => ({
  type: 'tool_removal',
  tool: { type: 'tool_reference', name },
  ...extra,
});

/** Twelve long alternating turns (user at even indices): enough text for the
 *  collapse to pay for itself. */
function longTurns(): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < 12; i++) {
    const body = `turn ${i}: ` + 'x'.repeat(2800);
    out.push(i % 2 === 0 ? usr(body) : asst(body));
  }
  return out;
}

/** `collapseChunk: 0` pins the boundary to `length - keepTail`, so each test
 *  decides exactly which messages stay live. */
const opts = (keepTail: number) => ({ keepTail, minCollapsePrefix: 5, cols: 100, collapseChunk: 0 });

interface ToolChange {
  at: number;
  kind: 'tool_addition' | 'tool_removal';
  name: string;
  block: Block;
}

function toolChanges(messages: Message[]): ToolChange[] {
  const found: ToolChange[] = [];
  messages.forEach((m, at) => {
    if (!Array.isArray(m.content)) return;
    for (const b of m.content as unknown as Block[]) {
      if (b.type !== 'tool_addition' && b.type !== 'tool_removal') continue;
      const tool = b.tool as { name?: string; definition?: { name?: string } };
      found.push({ at, kind: b.type, name: (tool.definition?.name ?? tool.name)!, block: b });
    }
  });
  return found;
}

/** Tools a `tool_removal` names without the API having seen them: not added
 *  earlier in the conversation and not in the request's own tools[]. Each one
 *  is a 400 from the API. */
function danglingRemovals(messages: Message[], requestTools: string[] = []): string[] {
  const known = new Set(requestTools);
  const dangling: string[] = [];
  for (const change of toolChanges(messages)) {
    if (change.kind === 'tool_addition') known.add(change.name);
    else if (!known.delete(change.name)) dangling.push(change.name);
  }
  return dangling;
}

/** The role just before and just after every system message. */
function systemNeighbours(messages: Message[]): Array<[string, string]> {
  const role = (i: number): string =>
    i < 0 ? 'start' : i >= messages.length ? 'end' : (messages[i]!.role as string);
  return messages.flatMap((m, i): Array<[string, string]> =>
    (m.role as string) === 'system' ? [[role(i - 1), role(i + 1)]] : [],
  );
}

describe('collapseHistory with mid-conversation tool changes', () => {
  const profitable = isCompressionProfitable;

  /** A tool added early (index 3), removed by the last message (index 14). */
  function addedEarlyRemovedLast(additionExtra: Block = {}): Message[] {
    const msgs = longTurns();
    msgs.splice(
      3,
      0,
      sys([
        text('The following tools just became available and are ready to use:\nZZTool'),
        addition('ZZTool', additionExtra),
      ]),
    );
    msgs.push(
      usr('latest request'),
      sys([
        text('The following tools are no longer available. Do not call them:\nZZTool'),
        removal('ZZTool'),
      ]),
    );
    return msgs;
  }

  it('keeps a tool added in the collapsed history defined for a later removal', async () => {
    // Live tail: [assistant, user, system(removal)].
    const { messages: out, info } = await collapseHistory(addedEarlyRemovedLast(), profitable, opts(3));
    expect(info.reason).toBeUndefined();
    expect(info.collapsedTurns).toBe(12);

    expect(danglingRemovals(out)).toEqual([]);
    const carried = toolChanges(out).find((c) => c.kind === 'tool_addition');
    expect(carried?.block.tool).toEqual(addition('ZZTool').tool);
  });

  it('leaves no dangling removal when the removing message opens the live tail', async () => {
    // Live tail: [user, system(removal)], the shape of the 400s seen in real use.
    const { messages: out, info } = await collapseHistory(addedEarlyRemovedLast(), profitable, opts(2));
    expect(info.collapsedTurns).toBe(13);

    expect(danglingRemovals(out)).toEqual([]);
    expect(systemNeighbours(out)).toEqual([['user', 'end']]);
  });

  it('carries nothing for a tool both added and removed inside the collapsed history', async () => {
    const msgs = longTurns();
    msgs.splice(3, 0, sys([text('ZZTool is available.'), addition('ZZTool')]));
    msgs.splice(6, 0, sys([text('ZZTool is gone.'), removal('ZZTool')]));
    const { messages: out, info } = await collapseHistory(msgs, profitable, opts(2));
    expect(info.collapsedTurns).toBe(12);

    expect(toolChanges(out)).toEqual([]);
    expect(systemNeighbours(out)).toEqual([]);
  });

  it('keeps a request tool removed in the collapsed history removed', async () => {
    const msgs = longTurns();
    msgs.splice(3, 0, sys([text('BaseTool is gone.'), removal('BaseTool')]));
    // Live tail: [user, assistant].
    const { messages: out, info } = await collapseHistory(msgs, profitable, opts(2));
    expect(info.collapsedTurns).toBe(11);

    expect(toolChanges(out).map((c) => [c.kind, c.name])).toEqual([['tool_removal', 'BaseTool']]);
    expect(danglingRemovals(out, ['BaseTool'])).toEqual([]);
    // Between the tail's user turn and its assistant turn, where the client puts them.
    expect(systemNeighbours(out)).toEqual([['user', 'assistant']]);
  });

  it('announces the carried change in a leading text block', async () => {
    const msgs = longTurns();
    msgs.splice(3, 0, sys([text('BaseTool is gone.'), removal('BaseTool')]));
    const { messages: out } = await collapseHistory(msgs, profitable, opts(2));

    const carried = out.find((m) => (m.role as string) === 'system');
    const first = (carried?.content as unknown as Block[])[0]!;
    expect(first.type).toBe('text');
    expect(first.text).toContain('BaseTool');
  });

  it('folds the carried change into a system message that opens the live tail', async () => {
    const msgs = longTurns();
    msgs.splice(3, 0, sys([text('ZZTool is available.'), addition('ZZTool')]));
    // Index 12 follows the user turn at 11: live tail is [system, assistant, user].
    msgs.splice(12, 0, sys('# Environment update'));
    msgs.push(usr('latest request'));
    const { messages: out, info } = await collapseHistory(msgs, profitable, opts(3));
    expect(info.collapsedTurns).toBe(12);

    // One system message, not two in a row.
    expect(systemNeighbours(out)).toEqual([['user', 'assistant']]);
    const merged = out.find((m) => (m.role as string) === 'system')!;
    expect(JSON.stringify(merged.content)).toContain('# Environment update');
    expect(toolChanges(out).map((c) => [c.kind, c.name])).toEqual([['tool_addition', 'ZZTool']]);
  });

  it('does not carry the client cache breakpoint along with the block', async () => {
    const msgs = addedEarlyRemovedLast({ cache_control: { type: 'ephemeral', ttl: '1h' } });
    const { messages: out } = await collapseHistory(msgs, profitable, opts(3));

    const carried = toolChanges(out).find((c) => c.kind === 'tool_addition');
    expect(carried).toBeDefined();
    expect(carried!.block).not.toHaveProperty('cache_control');
  });
});
