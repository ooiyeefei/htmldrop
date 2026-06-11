import { z } from 'zod';

export const AnchorSchema = z.object({
  type: z.enum(['text_range', 'element_rect', 'page_level']),
  selector: z.string().optional(),
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
  selectedText: z.string().max(2000).optional(),
  // The text under an element_rect box, captured at draw time so the AI converge
  // step can pinpoint what the box covers.
  capturedText: z.string().max(2000).optional(),
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
  // Commenter-held secret enabling delete/edit-own-comment. Stored only as a
  // SHA-256 hash (editTokenHash) — the raw token never persists or returns.
  editToken: z.string().min(16).max(128).optional(),
  // Fingerprint of the doc's normalized visible text, computed by the widget at
  // load. Pins the comment to the exact doc state it was made against, so "has
  // the text changed since?" is a hash comparison, not a substring guess.
  docHash: z.string().max(64).optional(),
});

// PATCH body for editing an existing comment's content in place.
export const EditSchema = z.object({
  content: ContentSchema,
});

// Replies are threaded under a parent comment (the parent id comes from the URL),
// so they carry NO anchor of their own — validate them without one. (Validating
// replies against FeedbackItemSchema, which requires an anchor, 400'd every reply.)
export const ReplySchema = z.object({
  content: ContentSchema,
  author: z.object({
    displayName: z.string().max(100),
  }),
  editToken: z.string().min(16).max(128).optional(),
});

export const FeedbackStoredSchema = FeedbackItemSchema.omit({ editToken: true }).extend({
  id: z.string().uuid(),
  docId: z.string(),
  createdAt: z.string(),
  resolved: z.boolean(),
  editTokenHash: z.string().optional(),
  // Set when the comment text was edited in place (rendered as "· edited").
  editedAt: z.string().optional(),
});

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;
export type FeedbackStored = z.infer<typeof FeedbackStoredSchema>;
