if (require.main !== module) process.exit(7);
process.stdout.write(JSON.stringify(process.argv.slice(2)));
