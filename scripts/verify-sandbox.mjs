#!/usr/bin/env node
/**
 * Clean-Checkout & Source Transpilation Verifier
 * Uses `scripts/ts-loader.mjs` (resolving declared `typescript` or `@babel/core`
 * from root `package.json`) to verify that all 62 `.ts` and `.tsx` source and test files
 * across `packages/shared`, `apps/api`, and `apps/web` parse and transpile cleanly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveTranspilerKind, transpileTypeScriptSource } from './ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function collectTypeScriptFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, acc);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      acc.push(fullPath);
    }
  }
  return acc;
}

const files = [
  ...collectTypeScriptFiles(path.join(rootDir, 'packages')),
  ...collectTypeScriptFiles(path.join(rootDir, 'apps')),
];

let compiledCount = 0;
for (const filePath of files) {
  const code = fs.readFileSync(filePath, 'utf8');
  const output = transpileTypeScriptSource(code, filePath);

  if (!output || typeof output !== 'string') {
    throw new Error(`Failed to transpile ${filePath}`);
  }
  compiledCount += 1;
}

console.info(
  JSON.stringify(
    {
      status: 'OK',
      transpiler: getActiveTranspilerKind(),
      verifiedFilesCount: compiledCount,
      files: files.map((f) => path.relative(rootDir, f)),
    },
    null,
    2,
  ),
);
