import { createRequire } from 'node:module';
import { mkdir, cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const prismaRequire = createRequire(require.resolve('prisma/package.json'));
const { download, BinaryType } = prismaRequire('@prisma/fetch-engine');
const { enginesVersion } = prismaRequire('@prisma/engines');
const consoleRequire = createRequire(require.resolve('@bcp/console/package.json'));
const clientRequire = createRequire(consoleRequire.resolve('@prisma/client'));
const clientDirectory = dirname(clientRequire.resolve('.prisma/client/default'));
const currentSchema = await readFile(join(clientDirectory, 'schema.prisma'));
const sourceSchema = await readFile(join(dirname(require.resolve('@bcp/console/package.json')), 'prisma/schema.prisma'));
if (!currentSchema.equals(sourceSchema)) throw new Error('Prisma client 与当前 schema 不一致，请先自行运行 Console 的 prisma:generate。');
await cp(clientDirectory, new URL('../native/bin/prisma-client/', import.meta.url), {
  recursive: true, filter: (source) => !source.endsWith('.so.node') && !source.endsWith('.dll.node'),
});
const output = fileURLToPath(new URL('../native/bin/prisma/', import.meta.url));
await mkdir(output, { recursive: true });
await download({
  binaries: { [BinaryType.QueryEngineLibrary]: output, [BinaryType.SchemaEngineBinary]: output },
  binaryTargets: ['windows'], version: enginesVersion, showProgress: true,
});
process.stdout.write(`Windows x64 Prisma 引擎已准备（${enginesVersion}）。\n`);
