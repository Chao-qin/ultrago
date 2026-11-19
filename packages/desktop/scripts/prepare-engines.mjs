import { createRequire } from 'node:module';
import { mkdir, cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `node prepare-engines.mjs` stages the Windows x64 engines; `mac` stages one set per Mac architecture.
const mac = process.argv[2] === 'mac';
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
// The generated client is platform-neutral JavaScript; the engine it loads is named by PRISMA_QUERY_ENGINE_LIBRARY.
await cp(clientDirectory, new URL('../native/bin/prisma-client/', import.meta.url), {
  recursive: true, filter: (source) => !/\.(so|dll|dylib)\.node$/.test(source),
});
const targets = mac ? [['darwin-arm64', 'darwin-arm64/prisma'], ['darwin', 'darwin-x64/prisma']] : [['windows', 'prisma']];
for (const [target, folder] of targets) {
  const output = fileURLToPath(new URL(`../native/bin/${folder}/`, import.meta.url));
  await mkdir(output, { recursive: true });
  await download({
    binaries: { [BinaryType.QueryEngineLibrary]: output, [BinaryType.SchemaEngineBinary]: output },
    binaryTargets: [target], version: enginesVersion, showProgress: true,
  });
}
process.stdout.write(`${mac ? 'macOS（Apple 芯片与 Intel）' : 'Windows x64'} Prisma 引擎已准备（${enginesVersion}）。\n`);
