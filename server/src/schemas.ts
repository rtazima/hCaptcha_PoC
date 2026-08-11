/** Validação de entrada com zod — limites existem para conter payloads absurdos. */
import { z } from 'zod';

const MAX_EVENTS_PER_KIND = 4000;

const keystrokeSchema = z.object({
  t: z.number().finite().min(0),
  cls: z.enum(['char', 'backspace', 'space', 'enter']),
});

const tapSchema = z.object({
  t: z.number().finite().min(0),
  dt: z.number().finite().min(0),
  x: z.number().finite(),
  y: z.number().finite(),
});

const strokePointSchema = z.object({
  t: z.number().finite().min(0),
  x: z.number().finite(),
  y: z.number().finite(),
});

const gestureSchema = z.object({
  points: z.array(strokePointSchema).max(2000),
});

const motionSchema = z.object({
  t: z.number().finite().min(0),
  ax: z.number().finite(),
  ay: z.number().finite(),
  az: z.number().finite(),
  gx: z.number().finite(),
  gy: z.number().finite(),
  gz: z.number().finite(),
});

export const rawSampleSchema = z.object({
  sessionId: z.string().min(8).max(128),
  task: z.string().min(1).max(64),
  device: z.object({
    os: z.string().min(1).max(32),
    osVersion: z.string().max(32).optional(),
    model: z.string().max(64).optional(),
    screenDiagonal: z.number().finite().positive().optional(),
  }),
  keystrokes: z.array(keystrokeSchema).max(MAX_EVENTS_PER_KIND),
  taps: z.array(tapSchema).max(MAX_EVENTS_PER_KIND),
  gestures: z.array(gestureSchema).max(500),
  motion: z.array(motionSchema).max(MAX_EVENTS_PER_KIND),
  timings: z.object({
    durationMs: z.number().finite().min(0).max(3_600_000),
    firstInteractionMs: z.number().finite().min(0).nullable(),
  }),
  journey: z.array(z.string().max(64)).max(200).optional(),
});

const captchaTokenSchema = z.string().min(1).max(8192);
const userIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, 'use apenas letras, números e . _ @ -');

export const enrollSchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(80).optional(),
  captchaToken: captchaTokenSchema,
  sample: rawSampleSchema,
});

export const verifySchema = z.object({
  userId: userIdSchema,
  captchaToken: captchaTokenSchema,
  sample: rawSampleSchema,
});

export const identifySchema = z.object({
  captchaToken: captchaTokenSchema,
  sample: rawSampleSchema,
  topK: z.number().int().min(1).max(25).optional(),
});
