/**
 * Runs the whole backend with an ephemeral MongoDB, no Docker and no installed database.
 *
 * This exists so that "run the backend and try it" is one command on a machine that has nothing
 * set up, which is the situation a reviewer is actually in. Data vanishes on exit, by design.
 */
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { SocketEventBus, attachSocketAuth } from '../src/adapters/socketEventBus.js';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri('caliper'));

const config = { ...loadConfig(process.env), mongoUri: mongo.getUri('caliper') };
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });
attachSocketAuth(io, config.jwtSecret);
httpServer.on('request', createApp({ config, events: new SocketEventBus(io) }));

httpServer.listen(config.port, () => {
  console.log(`caliper api (standalone) on http://localhost:${config.port}`);
  console.log(`provider: ${config.provider}   mongo: ephemeral in-memory`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      httpServer.close();
      await mongoose.disconnect();
      await mongo.stop();
      process.exit(0);
    })();
  });
}
