/** Environment parsing. Fails loudly at boot rather than producing `undefined` at request time. */
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(4000),
  mongoUri: z.string().default('mongodb://localhost:27017/caliper'),
  // Long enough that a default cannot be mistaken for a real secret. `assertProductionSafe`
  // refuses to boot with this value when NODE_ENV is production.
  jwtSecret: z.string().min(32).default('development-only-secret-do-not-use-in-production'),
  corsOrigin: z.string().default('http://localhost:5173'),
  provider: z.enum(['cv-heuristic', 'vision-llm']).default('cv-heuristic'),
  visionApiKey: z.string().optional(),
  visionBaseUrl: z.string().default('https://openrouter.ai/api/v1'),
  visionModels: z.array(z.string()).default([
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
  ]),
  maxUploadBytes: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /** Requests per 15 minutes against the auth endpoints — the ones worth brute-forcing. */
  authRateLimit: z.coerce.number().int().positive().default(20),
  /** Requests per minute against everything else. */
  apiRateLimit: z.coerce.number().int().positive().default(120),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEV_JWT_SECRET = 'development-only-secret-do-not-use-in-production';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    port: env.PORT,
    mongoUri: env.MONGODB_URI,
    jwtSecret: env.JWT_SECRET,
    corsOrigin: env.CORS_ORIGIN,
    provider: env.AI_PROVIDER,
    visionApiKey: env.OPENROUTER_API_KEY || env.VISION_API_KEY,
    visionBaseUrl: env.VISION_BASE_URL,
    visionModels: env.VISION_MODELS?.split(',').map((s) => s.trim()).filter(Boolean),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    authRateLimit: env.AUTH_RATE_LIMIT,
    apiRateLimit: env.API_RATE_LIMIT,
    nodeEnv: env.NODE_ENV,
  });
}

/** Called by `server.ts` only. Tests construct configs directly and skip this deliberately. */
export function assertProductionSafe(config: Config): void {
  if (config.nodeEnv !== 'production') return;
  if (config.jwtSecret === DEV_JWT_SECRET) {
    throw new Error('JWT_SECRET is still the development default. Refusing to start in production.');
  }
  if (config.provider === 'vision-llm' && !config.visionApiKey) {
    throw new Error('AI_PROVIDER=vision-llm requires an API key.');
  }
}
