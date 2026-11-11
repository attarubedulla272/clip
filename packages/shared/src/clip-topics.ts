import { z } from "zod";

export const clipTopicSegmentSchema = z.object({
  id: z.string().trim().min(1).max(40),
  index: z.number().int().min(0),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  label: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(20_000),
  boundaryDepthScore: z.number().finite().optional(),
  contextBefore: z.array(z.string().trim().min(1).max(500)).max(3).default([]),
  contextAfter: z.array(z.string().trim().min(1).max(500)).max(3).default([])
}).refine((segment) => segment.end > segment.start, "Topic segment end must follow its start");

export type ClipTopicSegment = z.infer<typeof clipTopicSegmentSchema>;
