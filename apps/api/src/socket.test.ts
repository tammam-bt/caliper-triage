/**
 * Socket.IO, over a real websocket.
 *
 * The rest of the API suite drives the pipeline through an in-memory event bus, which tests the
 * pipeline but says nothing about whether a browser could actually subscribe. This file starts a
 * real HTTP server, a real Socket.IO server with the real auth handshake, and connects a real
 * client over TCP.
 *
 * It exists because "Socket.IO" was on the requirements list and was, until this file, the one
 * named technology in the stack with no test behind it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Server } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import sharp from 'sharp';
import { disc } from '@caliper/core/testing';
import type { PipelineEvent } from '@caliper/core';
import { CvHeuristicProvider, ImmediateJobQueue } from '@caliper/service';
import { createApp } from './app.js';
import { SocketEventBus, attachSocketAuth } from './adapters/socketEventBus.js';
import { loadConfig, type Config } from './config.js';
import { AnalysisModel, User } from './db/models.js';

const config: Config = {
  ...loadConfig({}),
  nodeEnv: 'test',
  jwtSecret: 'socket-test-secret-that-is-long-enough-to-pass',
  authRateLimit: 10000,
  apiRateLimit: 10000,
};

let mongo: MongoMemoryServer;
let httpServer: HttpServer;
let io: Server;
let queue: ImmediateJobQueue;
let baseUrl: string;
let png: Buffer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('caliper-socket-test'));

  const image = disc(70);
  png = await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png().toBuffer();

  httpServer = createServer();
  io = new Server(httpServer, { cors: { origin: '*' } });
  attachSocketAuth(io, config.jwtSecret);
  queue = new ImmediateJobQueue();
  httpServer.on(
    'request',
    createApp({ config, events: new SocketEventBus(io), queue, provider: new CvHeuristicProvider() }),
  );

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}, 60000);

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  // Clean up before tearing the connection down, not after.
  await Promise.all([AnalysisModel.deleteMany({}), User.deleteMany({})]);
  await mongoose.disconnect();
  await mongo.stop();
});

async function register(email: string): Promise<string> {
  const res = await request(baseUrl)
    .post('/api/v1/auth/register')
    .send({ email, password: 'a-long-enough-password', role: 'clinician' })
    .expect(201);
  return res.body.accessToken as string;
}

function connect(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => reject(error));
  });
}

describe('Socket.IO', () => {
  it('refuses a connection with no token', async () => {
    await expect(connect('')).rejects.toThrow(/unauthenticated/i);
  });

  it('refuses a connection with a forged token', async () => {
    await expect(connect('not.a.jwt')).rejects.toThrow(/invalid_token/i);
  });

  it('streams the whole stage sequence to a subscribed client', async () => {
    const token = await register('socket-a@example.test');
    const socket = await connect(token);

    const events: PipelineEvent[] = [];
    socket.on('analysis:event', (event: PipelineEvent) => events.push(event));

    const accepted = await request(baseUrl)
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .field('width', '256')
      .field('height', '256')
      .field('intake', JSON.stringify({ symptomsText: 'changing', symptomIds: [] }))
      .attach('media', png, 'lesion.png')
      .expect(202);

    socket.emit('analysis:subscribe', accepted.body.analysisId);
    // Give the join a round trip before the pipeline starts emitting.
    await new Promise((r) => setTimeout(r, 50));
    await queue.drain();
    await new Promise((r) => setTimeout(r, 200));

    const mine = events.filter((e) => e.analysisId === accepted.body.analysisId);
    expect(mine.map((e) => e.stage)).toContain('complete');
    const terminal = mine.at(-1)!;
    expect(terminal.status).toBe('complete');
    expect(terminal.result!.candidates.length).toBe(8);
    expect(terminal.result!.confidence).toBeGreaterThan(0);

    socket.disconnect();
  }, 30000);

  it('does not deliver another user’s analysis to an unsubscribed client', async () => {
    // Rooms are the isolation boundary. Without the join, nothing should arrive.
    const alice = await register('socket-alice@example.test');
    const bob = await register('socket-bob@example.test');
    const bobSocket = await connect(bob);

    const heard: PipelineEvent[] = [];
    bobSocket.on('analysis:event', (event: PipelineEvent) => heard.push(event));

    await request(baseUrl)
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${alice}`)
      .field('width', '256')
      .field('height', '256')
      .attach('media', png, 'lesion.png')
      .expect(202);

    await queue.drain();
    await new Promise((r) => setTimeout(r, 200));

    expect(heard).toHaveLength(0);
    bobSocket.disconnect();
  }, 30000);

  it('stops delivering after unsubscribe', async () => {
    const token = await register('socket-unsub@example.test');
    const socket = await connect(token);

    const accepted = await request(baseUrl)
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .field('width', '256')
      .field('height', '256')
      .attach('media', png, 'lesion.png')
      .expect(202);

    socket.emit('analysis:subscribe', accepted.body.analysisId);
    await new Promise((r) => setTimeout(r, 50));
    socket.emit('analysis:unsubscribe', accepted.body.analysisId);
    await new Promise((r) => setTimeout(r, 50));

    const heard: PipelineEvent[] = [];
    socket.on('analysis:event', (event: PipelineEvent) => heard.push(event));

    await queue.drain();
    await new Promise((r) => setTimeout(r, 200));

    expect(heard.filter((e) => e.analysisId === accepted.body.analysisId)).toHaveLength(0);
    socket.disconnect();
  }, 30000);
});
