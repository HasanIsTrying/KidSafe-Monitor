import { z } from 'zod';
import { insertAlertSchema, alerts } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  alerts: {
    list: {
      method: 'GET' as const,
      path: '/alerts', 
      responses: {
        200: z.array(z.custom<typeof alerts.$inferSelect>()),
      },
    },
    receive: {
      method: 'POST' as const,
      path: '/receive-alert',
      input: insertAlertSchema,
      responses: {
        200: z.custom<typeof alerts.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
  },
};

// Helper for frontend
export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
