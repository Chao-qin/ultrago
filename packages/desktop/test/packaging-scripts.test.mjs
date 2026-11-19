import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workspace build regenerates the Prisma client before compiling the console', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { scripts: consoleScripts } = JSON.parse(await readFile(new URL('../../console/package.json', import.meta.url), 'utf8'));
  assert.match(scripts['workspace:build'], /--filter @bcp\/console build$/);
  assert.match(consoleScripts.build, /^pnpm run prisma:generate && /);
});
