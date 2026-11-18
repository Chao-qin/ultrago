import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export function applicationPaths(userData, resources, packaged) {
  const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));
  const root = packaged ? resources : fileURLToPath(new URL('../', import.meta.url));
  return {
    userData, db: join(userData, 'resource', 'db', 'console.db'),
    settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json'),
    extension: packaged ? join(root, 'extension') : join(root, '../extension/.output/chrome-mv3'),
    web: packaged ? join(root, 'console-web') : join(root, '../console/dist-web'),
    schema: packaged ? join(root, 'prisma/schema.prisma') : join(root, '../console/prisma/schema.prisma'),
    templates: join(root, 'templates'),
    library: packaged ? join(root, 'templates') : join(root, '../../resource/playbooks'),
    rawOfferSchema: packaged ? join(root, 'contracts/raw-1688-offer@2.json') : join(root, '../../.claude/skills/product-preprocess/raw-1688-offer.schema.json'),
    engines: packaged ? join(root, 'prisma-engines') : join(root, 'native/bin/prisma'),
    native: packaged ? join(root, 'native/bcp-native-host.exe') : join(root, 'native/bin/bcp-native-host.exe'),
    python: packaged ? join(root, 'runtime/python/python.exe') : join(root, 'native/bin/python/python.exe'),
    entries: {
      backend: join(packageDir('@bcp/backend'), 'dist/index.js'),
      console: join(packageDir('@bcp/console'), 'dist/main.js'),
      llm: join(packageDir('@bcp/llm'), 'dist/gateway.js'),
      migrate: require.resolve('prisma/build/index.js'),
    },
  };
}
