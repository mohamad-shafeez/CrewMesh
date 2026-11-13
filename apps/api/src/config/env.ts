import { z } from 'zod';

const INSECURE_PLACEHOLDER_PATTERNS = [
  'replace_with_at_least_32_characters',
  'changeme',
  'secret',
  'password123',
];

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    APP_ORIGIN: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: z
      .string()
      .min(12)
      .refine(
        (val) => val.startsWith('postgres://') || val.startsWith('postgresql://'),
        'DATABASE_URL must start with postgres:// or postgresql://',
      ),
    TEST_DATABASE_URL: z
      .string()
      .optional()
      .refine(
        (val) =>
          val === undefined || val.startsWith('postgres://') || val.startsWith('postgresql://'),
        'TEST_DATABASE_URL must start with postgres:// or postgresql:// when set',
      ),
    DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(25),
    SESSION_COOKIE_NAME: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('crewmesh_session'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters long'),
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    HACKATHON_SLUG: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
      .default('hack4hack-crew-2026'),
    HACKATHON_NAME: z.string().min(2).max(120).default('Hack4Hack Crew Hiring Challenge 2026'),
    HACKATHON_MIN_TEAM_SIZE: z.coerce.number().int().min(1).max(20).default(2),
    HACKATHON_MAX_TEAM_SIZE: z.coerce.number().int().min(1).max(20).default(5),
    HACKATHON_DEADLINE_ISO: z
      .string()
      .optional()
      .transform((val) => {
        if (val === undefined) {
          return null;
        }
        const trimmed = val.trim();
        return trimmed.length === 0 ? null : trimmed;
      })
      .refine(
        (val) => val === null || !Number.isNaN(Date.parse(val)),
        'HACKATHON_DEADLINE_ISO must be a valid ISO date when provided',
      )
      .default(''),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.HACKATHON_MAX_TEAM_SIZE < cfg.HACKATHON_MIN_TEAM_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HACKATHON_MAX_TEAM_SIZE'],
        message: 'HACKATHON_MAX_TEAM_SIZE must be greater than or equal to HACKATHON_MIN_TEAM_SIZE',
      });
    }

    if (cfg.NODE_ENV === 'production') {
      const lowerSecret = cfg.CSRF_SECRET.toLowerCase();
      for (const pattern of INSECURE_PLACEHOLDER_PATTERNS) {
        if (lowerSecret.includes(pattern)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CSRF_SECRET'],
            message: 'CSRF_SECRET contains an insecure placeholder value in production',
          });
        }
      }
      if (cfg.DATABASE_URL.includes('crewmesh_local_dev_password')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message: 'DATABASE_URL must not use the local development password in production',
        });
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

/**
 * Parses and validates environment variables. Fails fast on invalid or missing values.
 */
export function parseEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}

/**
 * Returns the validated singleton environment configuration.
 */
export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = parseEnv(process.env);
  }
  return cachedEnv;
}

/**
 * Resets cached environment for isolated unit/integration tests.
 */
export function resetEnvCache(): void {
  cachedEnv = null;
}
