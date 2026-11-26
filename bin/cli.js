#!/usr/bin/env node
// The `fastpipe` command. Service commands (on, off, status, pause, ...) go to the launcher in
// scripts/fastpipe-ctl.mjs; anything else runs the bundled proxy CLI, whose logic lives in src/node.ts.
import { COMMANDS, main } from '../scripts/fastpipe-ctl.mjs';

if (COMMANDS.includes(process.argv[2])) {
  await main(process.argv.slice(2));
} else {
  import('../dist/node.js').catch((err) => {
    console.error('[fastpipe] failed to start:', err);
    console.error('[fastpipe] did you forget to `npm run build`?');
    process.exit(1);
  });
}
