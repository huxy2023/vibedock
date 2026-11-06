import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '39090', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const instance = createApp();

const server = serve(
  {
    fetch: instance.app.fetch,
    hostname: host,
    port,
  },
  (info) => {
    console.log(`${instance.vibeConfig.brandName} portal is running at http://${info.address}:${info.port}`);
  },
);

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`);
  instance.close();
  server.close((error) => {
    if (error) {
      console.error('Shutdown failed', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
