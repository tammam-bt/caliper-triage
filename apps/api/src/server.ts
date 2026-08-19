/** Process entry point. Everything interesting is in `app.ts`; this only wires it to the world. */
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { assertProductionSafe, loadConfig } from './config.js';
import { createApp } from './app.js';
import { SocketEventBus, attachSocketAuth } from './adapters/socketEventBus.js';

const config = loadConfig();
assertProductionSafe(config);

await mongoose.connect(config.mongoUri);

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: config.corsOrigin.split(',').map((s) => s.trim()), credentials: true },
});
attachSocketAuth(io, config.jwtSecret);

const app = createApp({ config, events: new SocketEventBus(io) });
httpServer.on('request', app);

httpServer.listen(config.port, () => {
  console.log(`caliper api listening on :${config.port} (provider: ${config.provider})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close(() => {
      void mongoose.disconnect().then(() => process.exit(0));
    });
  });
}
