import { z } from 'zod';

export const AnchorSchema = z.object({
  type: z.enum(['text_range', 'element_rect', 'page_level']),
  selector: z.string().optional(),
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
  selectedText: z.string().max(2000).optional(),
  // For element_rect anchors: a box as percentages (0–100) of the document's
  // scroll dimensions, so it re-renders at the same relative spot on any screen.
  rect: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }).optional(),
});

export const ContentSchema = z.object({
  type: z.enum(['text', 'voice', 'text+voice']),
  text: z.string().max(10000).optional(),
  voiceUrl: z.string().url().optional(),
  voiceDurationMs: z.number().max(120000).optional(),
});

export const FeedbackItemSchema = z.object({
  anchor: AnchorSchema,
  content: ContentSchema,
  author: z.object({
    displayName: z.string().max(100),
  }),
  parentId: z.string().uuid().nullable().optional(),
});

export const FeedbackStoredSchema = FeedbackItemSchema.extend({
  id: z.string().uuid(),
  docId: z.string(),
  createdAt: z.string(),
  resolved: z.boolean(),
});

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;
export type FeedbackStored = z.infer<typeof FeedbackStoredSchema>;
