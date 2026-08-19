/**
 * Express application assembly.
 *
 * `createApp` takes its dependencies rather than reaching for globals, which is what lets the
 * integration tests drive the real routes against an in-memory Mongo and a stub provider without
 * a single line of production code knowing it is under test.
 */
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import multer from 'multer';
import { IntakeSchema, MediaUploadSchema } from '@caliper/core';
import {
  CvHeuristicProvider, ImmediateJobQueue, NotFoundError, RandomIdGen, SystemClock,
  ValidationError, cancelAnalysis, getAnalysis, listAnalyses, submitAnalysis,
  type EventBus, type InferenceProvider, type JobQueue, type ServiceDeps,
} from '@caliper/service';
import type { Config } from './config.js';
import { CompositeFrameExtractor } from './adapters/frameExtractors.js';
import { GridFsMediaStore } from './adapters/gridfsMediaStore.js';
import { MongoAnalysisRepository } from './adapters/mongoRepository.js';
import { VisionLlmProvider } from './providers/visionLlm.js';
import { User } from './db/models.js';
import {
  CredentialsSchema, hashPassword, requireAuth, requireRole, signAccessToken, signRefreshToken,
  verifyPassword, verifyToken,
} from './auth.js';
import { UploadMetaSchema, sniffMediaType } from './upload.js';

export interface AppOptions {
  config: Config;
  events: EventBus;
  /** Overridable so tests can inject a deterministic or exploding provider. */
  provider?: InferenceProvider;
  queue?: JobQueue;
}

export function selectProvider(config: Config): InferenceProvider {
  if (config.provider === 'vision-llm' && config.visionApiKey) {
    return new VisionLlmProvider({
      apiKey: config.visionApiKey,
      baseUrl: config.visionBaseUrl,
      models: config.visionModels,
    });
  }
  return new CvHeuristicProvider();
}

export function createApp({ config, events, provider, queue }: AppOptions): Express {
  const app = express();
  const jobQueue = queue ?? new ImmediateJobQueue();
  const inference = provider ?? selectProvider(config);
  const clock = new SystemClock();
  const ids = new RandomIdGen();

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  // Auth endpoints are the ones worth brute-forcing, so they get their own tighter budget.
  // Both limits are configurable because the integration suite makes far more auth calls in a
  // minute than any human will, and because production tuning belongs in the environment.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: config.authRateLimit, standardHeaders: true, legacyHeaders: false,
  });
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, limit: config.apiRateLimit, standardHeaders: true, legacyHeaders: false,
  });

  const depsFor = (ownerId: string): ServiceDeps => ({
    repository: new MongoAnalysisRepository(ownerId),
    mediaStore: new GridFsMediaStore(),
    frameExtractor: new CompositeFrameExtractor(),
    provider: inference,
    events,
    queue: jobQueue,
    clock,
    ids,
  });

  app.get('/api/v1/health', (_req, res) => {
    res.json({
      status: 'ok',
      provider: inference.id,
      modelId: inference.modelId,
      mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    });
  });

  // --- auth ------------------------------------------------------------------
  app.post('/api/v1/auth/register', authLimiter, async (req, res, next) => {
    try {
      const parsed = CredentialsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid credentials', parsed.error.flatten());
      const { email, password, role } = parsed.data;

      if (await User.findOne({ email })) {
        res.status(409).json({ error: { code: 'email_taken', message: 'That email is already registered' } });
        return;
      }
      const user = await User.create({
        email,
        passwordHash: await hashPassword(password),
        // Self-service registration cannot mint an admin. Only `clinician` is selectable.
        role: role === 'clinician' ? 'clinician' : 'patient',
      });
      const principal = { userId: String(user._id), email: user.email, role: user.role };
      res.status(201).json({
        user: principal,
        accessToken: signAccessToken(principal, config.jwtSecret),
        refreshToken: signRefreshToken(principal, config.jwtSecret),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/auth/login', authLimiter, async (req, res, next) => {
    try {
      const parsed = CredentialsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid credentials', parsed.error.flatten());
      const user = await User.findOne({ email: parsed.data.email });
      // One message for both "no such user" and "wrong password": distinguishing them is a
      // free account-enumeration oracle.
      const ok = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
      if (!user || !ok) {
        res.status(401).json({ error: { code: 'invalid_credentials', message: 'Email or password is incorrect' } });
        return;
      }
      const principal = { userId: String(user._id), email: user.email, role: user.role };
      res.json({
        user: principal,
        accessToken: signAccessToken(principal, config.jwtSecret),
        refreshToken: signRefreshToken(principal, config.jwtSecret),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/auth/refresh', authLimiter, (req, res) => {
    try {
      const claims = verifyToken(String(req.body?.refreshToken ?? ''), config.jwtSecret);
      if (claims.typ !== 'refresh') throw new Error('not a refresh token');
      const principal = { userId: claims.userId, email: claims.email, role: claims.role };
      res.json({ accessToken: signAccessToken(principal, config.jwtSecret) });
    } catch {
      res.status(401).json({ error: { code: 'invalid_token', message: 'Refresh token is invalid or expired' } });
    }
  });

  // --- analyses --------------------------------------------------------------
  const auth = requireAuth(config.jwtSecret);

  app.post('/api/v1/analyses', apiLimiter, auth, upload.single('media'), async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) throw new ValidationError('A media file is required under the "media" field');

      const sniffed = sniffMediaType(new Uint8Array(file.buffer));
      if (!sniffed) {
        throw new ValidationError(
          'Unsupported file type. Accepted: JPEG, PNG, WebP, MP4, WebM. ' +
            'The declared Content-Type is ignored; the file\'s leading bytes are what count.',
        );
      }

      const meta = UploadMetaSchema.safeParse(req.body);
      if (!meta.success) throw new ValidationError('Invalid media metadata', meta.error.flatten());

      const intakeRaw = typeof req.body.intake === 'string' ? JSON.parse(req.body.intake) : req.body.intake;
      const intake = IntakeSchema.parse(intakeRaw ?? {});

      const media = MediaUploadSchema.parse({
        kind: sniffed.kind,
        mimeType: sniffed.mimeType,
        byteSize: file.size,
        ...meta.data,
      });

      const result = await submitAnalysis(depsFor(req.principal!.userId), {
        intake,
        media,
        bytes: new Uint8Array(file.buffer),
        ...(req.get('Idempotency-Key') ? { idempotencyKey: req.get('Idempotency-Key')! } : {}),
      });

      res.status(202).json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/v1/analyses', apiLimiter, auth, async (req, res, next) => {
    try {
      const limit = Math.min(100, Number(req.query.limit) || 20);
      res.json({ analyses: await listAnalyses(depsFor(req.principal!.userId), limit) });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/analyses/:id', apiLimiter, auth, async (req, res, next) => {
    try {
      res.json(await getAnalysis(depsFor(req.principal!.userId), req.params.id!));
    } catch (error) { next(error); }
  });

  app.post('/api/v1/analyses/:id/cancel', apiLimiter, auth, async (req, res, next) => {
    try {
      res.json(await cancelAnalysis(depsFor(req.principal!.userId), req.params.id!));
    } catch (error) { next(error); }
  });

  // --- admin -------------------------------------------------------------------
  app.get('/api/v1/admin/stats', apiLimiter, auth, requireRole('admin'), async (_req, res, next) => {
    try {
      const { AnalysisModel } = await import('./db/models.js');
      const [total, byStatus, users] = await Promise.all([
        AnalysisModel.countDocuments(),
        AnalysisModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        User.countDocuments(),
      ]);
      res.json({ totalAnalyses: total, byStatus, users });
    } catch (error) { next(error); }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such route' } });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof NotFoundError) {
      res.status(404).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof multer.MulterError) {
      const tooBig = error.code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({
        error: {
          code: tooBig ? 'file_too_large' : 'upload_error',
          message: tooBig
            ? `File exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit`
            : error.message,
        },
      });
      return;
    }
    // Never leak an internal message to a client; the detail goes to the log instead.
    if (config.nodeEnv !== 'test') console.error(error);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  };
  app.use(errorHandler);

  return app;
}
