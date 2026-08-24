import { z } from 'zod';

/** Connector credential input (Phase 2 — Connectors). */
export const saveApiKeySchema = z.object({
  apiKey: z.string().trim().min(8, 'That key looks too short.').max(500),
  /** Non-secret extras, e.g. a Google Custom Search engine id. */
  metadata: z.record(z.string().trim().max(200)).optional(),
});

export type SaveApiKeyInput = z.infer<typeof saveApiKeySchema>;
