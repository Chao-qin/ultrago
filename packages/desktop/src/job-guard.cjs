let heartbeat = Date.now();
process.on('message', (message) => { if (message?.type === 'heartbeat') heartbeat = Date.now(); });
process.on('disconnect', () => process.exit(1));
process.channel?.unref();
setInterval(() => { if (Date.now() - heartbeat > 20_000) process.exit(1); }, 3000).unref();
