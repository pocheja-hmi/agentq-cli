#!/usr/bin/env node
// Tiny shim — keeps the bin entry stable across builds.
// All real logic lives in dist/cli.js, compiled from src/cli.ts.
import('../dist/cli.js').catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to load agentq-cli:', err);
  process.exit(1);
});
