import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

// Imported first by the server entry point, so a missing or malformed variable fails at boot
// instead of deep inside a scheduled run.
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Cloud Run routes traffic into the container on all interfaces; local runs stay on loopback.
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
    FIRESTORE_EMULATOR_HOST: z.string().min(1).optional(),
    // Service account email Cloud Scheduler signs its OIDC token with; the run endpoint accepts
    // no other caller.
    RUN_INVOKER_EMAIL: z.string().email().optional(),
    // Not BASE_URL: Vite and Vitest inject a BASE_URL of "/" into the process environment, which
    // would fail this schema in every test run and in any tooling built on Vite.
    SERVICE_BASE_URL: z.string().url().optional(),
    DEMO_REPO: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo')
      .optional(),
  },
  clientPrefix: 'PUBLIC_',
  client: {},
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
