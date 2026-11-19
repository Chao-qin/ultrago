import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Where the bundled native pieces sit on each system. A Mac package carries the build of its own architecture;
 * from source they come from native/bin/darwin-<arch>, as `build-native.mjs mac` and the prepare scripts stage them.
 */
function nativeLayout(platform, arch, packaged, root) {
  if (platform === 'darwin') {
    const engine = arch === 'arm64' ? 'darwin-arm64' : 'darwin';
    const staged = join(root, 'native/bin', `darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`);
    return {
      native: packaged ? join(root, 'native/bcp-native-host') : join(staged, 'bcp-native-host'),
      python: packaged ? join(root, 'runtime/python/bin/python3') : join(staged, 'python/bin/python3'),
      engines: packaged ? join(root, 'prisma-engines') : join(staged, 'prisma'),
      // From source the Prisma engines in node_modules already match this Mac; only a package brings its own.
      engineFiles: packaged ? { query: `libquery_engine-${engine}.dylib.node`, schema: `schema-engine-${engine}` } : null,
    };
  }
  return {
    native: packaged ? join(root, 'native/bcp-native-host.exe') : join(root, 'native/bin/bcp-native-host.exe'),
    python: packaged ? join(root, 'runtime/python/python.exe') : join(root, 'native/bin/python/python.exe'),
    engines: packaged ? join(root, 'prisma-engines') : join(root, 'native/bin/prisma'),
    engineFiles: platform === 'win32' ? { query: 'query_engine-windows.dll.node', schema: 'schema-engine-windows.exe' } : null,
  };
}

export function applicationPaths(userData, resources, packaged, platform = process.platform, arch = process.arch) {
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
    ...nativeLayout(platform, arch, packaged, root),
    entries: {
      backend: join(packageDir('@bcp/backend'), 'dist/index.js'),
      console: join(packageDir('@bcp/console'), 'dist/main.js'),
      llm: join(packageDir('@bcp/llm'), 'dist/gateway.js'),
      migrate: require.resolve('prisma/build/index.js'),
    },
  };
}
