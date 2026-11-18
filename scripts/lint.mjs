import process from 'node:process';

const DEFAULT_PATHS = [
  'packages/**/*.{js,mjs,cjs,ts,tsx}',
  'scripts/**/*.{js,mjs,cjs}',
];

async function runLint() {
  const [{ ESLint }, { LINT_CONFIG }] = await Promise.all([
    import('eslint'),
    import('./lint-config.mjs'),
  ]);
  const paths = process.argv.slice(2).filter((path) => path !== '--');
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: LINT_CONFIG,
    fix: false,
  });
  const results = await eslint.lintFiles(paths.length ? paths : DEFAULT_PATHS);
  const formatter = await eslint.loadFormatter('stylish');

  process.stdout.write(formatter.format(results));
  process.exitCode = results.some(
    (result) => result.errorCount > 0 || result.fatalErrorCount > 0,
  )
    ? 1
    : 0;
}

try {
  await runLint();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`Lint failed: ${message}\n`);
  process.exitCode = 1;
}
