/**
 * Integration tests: real Express routes, real Mongoose models, real GridFS, real MongoDB
 * (in-memory). The only substitution is the inference provider, so that assertions can be about
 * the API's behaviour rather than about a model's opinion.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import sharp from 'sharp';
import type { Express } from 'express';
import { disc, lobedBlob } from '@caliper/core/testing';
import { CvHeuristicProvider, ImmediateJobQueue, MemoryEventBus } from '@caliper/service';
import type { InferenceProvider } from '@caliper/service';
import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { AnalysisModel, User } from './db/models.js';
import { sniffMediaType } from './upload.js';
import { mapToCatalogue, stripFences } from './providers/visionLlm.js';

let mongo: MongoMemoryServer;
let app: Express;
let events: MemoryEventBus;
let queue: ImmediateJobQueue;
// Rate limits are raised, not removed: the suite makes more auth calls in a minute than any
// human would, and a dedicated test below builds an app with a limit of 2 to prove the limiter
// still works.
const config: Config = {
  ...loadConfig({}),
  nodeEnv: 'test',
  jwtSecret: 'test-secret-that-is-long-enough-to-pass-validation',
  authRateLimit: 10000,
  apiRateLimit: 10000,
};

/** Encode a fixture as a real PNG, so multer, the sniffer and sharp all see genuine bytes. */
async function png(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<Buffer> {
  return sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } })
    .png()
    .toBuffer();
}

function build(provider: InferenceProvider = new CvHeuristicProvider()): void {
  events = new MemoryEventBus();
  queue = new ImmediateJobQueue();
  app = createApp({ config, events, provider, queue });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('caliper-test'));
  encoded.set('disc', await png(disc(70)));
  encoded.set('lobed', await png(lobedBlob(70)));
  build();
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await queue.drain();
  // The bus outlives an individual test, so its log has to be reset or sequence assertions
  // silently start matching the previous test's events.
  events.log.length = 0;
  await Promise.all([
    AnalysisModel.deleteMany({}),
    User.deleteMany({}),
    mongoose.connection.db!.collection('media.files').deleteMany({}),
    mongoose.connection.db!.collection('media.chunks').deleteMany({}),
  ]);
});

async function registerUser(email = 'clinician@example.test'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'a-long-enough-password', role: 'clinician' })
    .expect(201);
  return res.body.accessToken as string;
}

/** Fixtures encoded once; `submit` stays synchronous so callers can chain `.expect()`. */
const encoded = new Map<string, Buffer>();

function submit(token: string, key: 'disc' | 'lobed' = 'disc', extra: Record<string, string> = {}) {
  const body = encoded.get(key)!;
  const image = key === 'disc' ? disc(70) : lobedBlob(70);
  const req = request(app)
    .post('/api/v1/analyses')
    .set('Authorization', `Bearer ${token}`)
    .field('width', String(image.width))
    .field('height', String(image.height))
    .field('intake', JSON.stringify({ symptomsText: 'changing and bleeding', symptomIds: [] }));
  for (const [k, v] of Object.entries(extra)) req.set(k, v);
  return req.attach('media', body, 'lesion.png');
}

describe('health', () => {
  it('reports the active provider and mongo state', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', provider: 'cv-heuristic', mongo: 'connected' });
  });
});

describe('auth', () => {
  it('registers and returns a usable access token', async () => {
    const token = await registerUser();
    await request(app).get('/api/v1/analyses').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('rejects a duplicate email', async () => {
    await registerUser('dupe@example.test');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'dupe@example.test', password: 'a-long-enough-password' })
      .expect(409);
  });

  it('refuses to mint an admin through self-service registration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'sneaky@example.test', password: 'a-long-enough-password', role: 'admin' })
      .expect(201);
    expect(res.body.user.role).toBe('patient');
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    await registerUser('real@example.test');
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.test', password: 'a-long-enough-password' })
      .expect(401);
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'real@example.test', password: 'the-wrong-password' })
      .expect(401);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('rejects an unauthenticated submission', async () => {
    await request(app).post('/api/v1/analyses').expect(401);
  });

  it('will not accept a refresh token as an access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'refresh@example.test', password: 'a-long-enough-password' })
      .expect(201);
    const denied = await request(app)
      .get('/api/v1/analyses')
      .set('Authorization', `Bearer ${res.body.refreshToken}`)
      .expect(401);
    expect(denied.body.error.code).toBe('wrong_token_type');
  });

  it('exchanges a refresh token for a fresh access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'rt@example.test', password: 'a-long-enough-password' })
      .expect(201);
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: res.body.refreshToken })
      .expect(200);
    await request(app)
      .get('/api/v1/analyses')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(200);
  });

  it('denies the admin route to a clinician', async () => {
    const token = await registerUser();
    await request(app).get('/api/v1/admin/stats').set('Authorization', `Bearer ${token}`).expect(403);
  });
});

describe('submit, poll, complete', () => {
  it('accepts with 202 and completes through the pipeline', async () => {
    const token = await registerUser();
    const accepted = await submit(token).expect(202);
    expect(accepted.body.status).toBe('queued');
    expect(accepted.body.channel).toBe(`analysis:${accepted.body.analysisId}`);

    await queue.drain();

    const final = await request(app)
      .get(`/api/v1/analyses/${accepted.body.analysisId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(final.body.status).toBe('complete');
    expect(final.body.result.candidates).toHaveLength(8);
    expect(final.body.result.confidence).toBeGreaterThan(0);
    expect(final.body.result.features.borderIrregularity).toBeGreaterThan(0);
  });

  it('emits the full stage sequence on the event bus', async () => {
    const token = await registerUser();
    const accepted = await submit(token).expect(202);
    await queue.drain();
    const mine = events.log.filter((e) => e.analysisId === accepted.body.analysisId);
    expect(mine.map((e) => e.stage)).toEqual([
      'received', 'preprocess', 'features', 'inference', 'fusion', 'complete',
    ]);
  });

  it('round-trips real image bytes through GridFS and measures them', async () => {
    // Proves the media actually survived storage: two different pictures must not produce
    // the same measurements.
    const token = await registerUser();
    const a = await submit(token, 'disc').expect(202);
    await queue.drain();
    const b = await submit(token, 'lobed').expect(202);
    await queue.drain();

    const get = async (id: string) =>
      (await request(app).get(`/api/v1/analyses/${id}`).set('Authorization', `Bearer ${token}`)).body;

    const ra = await get(a.body.analysisId);
    const rb = await get(b.body.analysisId);
    expect(ra.result.features.borderIrregularity).not.toBe(rb.result.features.borderIrregularity);
    expect(rb.result.features.borderIrregularity).toBeGreaterThan(ra.result.features.borderIrregularity);
  });

  it('honours an Idempotency-Key on replay', async () => {
    const token = await registerUser();
    const first = await submit(token, 'disc', { 'Idempotency-Key': 'abc12345678' }).expect(202);
    await queue.drain();
    const second = await submit(token, 'disc', { 'Idempotency-Key': 'abc12345678' }).expect(202);
    expect(second.body.analysisId).toBe(first.body.analysisId);
    expect(await AnalysisModel.countDocuments()).toBe(1);
  });

  it('cancels a queued analysis', async () => {
    const token = await registerUser();
    const accepted = await submit(token).expect(202);
    const cancelled = await request(app)
      .post(`/api/v1/analyses/${accepted.body.analysisId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(['cancelled', 'complete']).toContain(cancelled.body.status);
    await queue.drain();
  });
});

describe('ownership', () => {
  it('does not let one user read another user’s analysis', async () => {
    const alice = await registerUser('alice@example.test');
    const bob = await registerUser('bob@example.test');
    const accepted = await submit(alice).expect(202);
    await queue.drain();
    await request(app)
      .get(`/api/v1/analyses/${accepted.body.analysisId}`)
      .set('Authorization', `Bearer ${bob}`)
      .expect(404);
  });

  it('does not list another user’s analyses', async () => {
    const alice = await registerUser('alice2@example.test');
    const bob = await registerUser('bob2@example.test');
    await submit(alice).expect(202);
    await queue.drain();
    const list = await request(app).get('/api/v1/analyses').set('Authorization', `Bearer ${bob}`).expect(200);
    expect(list.body.analyses).toHaveLength(0);
  });
});

describe('upload validation', () => {
  it('rejects a file whose bytes are not a supported medium, whatever the header claims', async () => {
    const token = await registerUser();
    const res = await request(app)
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .field('width', '256')
      .field('height', '256')
      // A text file, announced as a PNG. The declared type must not be believed.
      .attach('media', Buffer.from('this is definitely not a png, honestly'), {
        filename: 'evil.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(res.body.error.message).toMatch(/leading bytes/i);
  });

  it('rejects a submission with no file', async () => {
    const token = await registerUser();
    await request(app)
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .field('width', '256')
      .field('height', '256')
      .expect(400);
  });

  it('rejects a file over the size limit with 413', async () => {
    events = new MemoryEventBus();
    queue = new ImmediateJobQueue();
    const tiny = createApp({
      config: { ...config, maxUploadBytes: 1024 },
      events, queue, provider: new CvHeuristicProvider(),
    });
    const res = await request(tiny)
      .post('/api/v1/auth/register')
      .send({ email: 'big@example.test', password: 'a-long-enough-password' })
      .expect(201);
    await request(tiny)
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .field('width', '256')
      .field('height', '256')
      .attach('media', encoded.get('disc')!, 'big.png')
      .expect(413);
    build();
  });

  it('sniffs the supported signatures and refuses the rest', () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mimeType).toBe('image/jpeg');
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))?.kind).toBe('image');
    expect(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))?.kind).toBe('video');
    expect(sniffMediaType(new TextEncoder().encode('<?php echo 1; ?>            '))).toBeNull();
    expect(sniffMediaType(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('rate limiting', () => {
  it('returns 429 once the auth budget is spent', async () => {
    const strict = createApp({
      config: { ...config, authRateLimit: 2 },
      events: new MemoryEventBus(),
      queue: new ImmediateJobQueue(),
      provider: new CvHeuristicProvider(),
    });
    const attempt = (n: number) =>
      request(strict).post('/api/v1/auth/login').send({ email: `x${n}@example.test`, password: 'a-long-enough-password' });
    await attempt(1);
    await attempt(2);
    await attempt(3).expect(429);
  });
});

describe('failure surfaces', () => {
  it('records a failed analysis when the provider throws, and still answers GET', async () => {
    build({
      id: 'exploding', modelId: 'boom-v1',
      async infer() { throw new Error('upstream model returned 503'); },
    });
    const token = await registerUser('fail@example.test');
    const accepted = await submit(token).expect(202);
    await queue.drain();
    const final = await request(app)
      .get(`/api/v1/analyses/${accepted.body.analysisId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(final.body.status).toBe('failed');
    expect(final.body.error).toMatch(/503/);
    build();
  });

  it('404s an unknown analysis and an unknown route', async () => {
    const token = await registerUser();
    await request(app).get('/api/v1/analyses/nope').set('Authorization', `Bearer ${token}`).expect(404);
    await request(app).get('/api/v1/nonsense').expect(404);
  });
});

describe('vision LLM response handling', () => {
  // Both behaviours were observed against live free models in Gate 0.4.
  it('strips the markdown fences models add despite being told not to', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });

  it('maps display names and ids onto the catalogue', () => {
    expect(mapToCatalogue([{ condition: 'Melanoma', probability: 0.8 }])).toEqual({ melanoma: 0.8 });
    expect(mapToCatalogue([{ condition: 'melanoma', probability: 0.5 }])).toEqual({ melanoma: 0.5 });
  });

  it('drops labels it does not recognise rather than guessing', () => {
    // A general model volunteers conditions outside the catalogue ("Lentigo Simplex"). Fuzzy
    // matching one of those onto a diagnosis would be inventing evidence.
    expect(mapToCatalogue([{ condition: 'Lentigo Simplex', probability: 0.9 }])).toEqual({});
  });
});
