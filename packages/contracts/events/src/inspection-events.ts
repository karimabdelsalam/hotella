import { z } from 'zod';
import { defineEvent } from './registry';

/** Inspection events (Spec §11, BUILD_PLAN Phase 9): ids, codes and results only, never the inspector's notes. */

export const INSPECTION_SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL'] as const;

export const InspectionCompleted = defineEvent({
  type: 'inspection.inspection.completed',
  version: 1,
  description:
    'An inspection was completed: its pinned checklist version, score, result and finding counts.',
  payload: z.object({
    inspection_id: z.uuid(),
    template_code: z.string(),
    template_version_id: z.uuid(),
    location_id: z.uuid(),
    asset_id: z.uuid().nullable(),
    source: z.enum(['STAFF', 'SCHEDULE', 'HK_JOB', 'WORK_ORDER']),
    source_ref: z.string().nullable(),
    score: z.number().int().min(0).max(100),
    result: z.enum(['PASS', 'FAIL']),
    findings: z.object({
      info: z.number().int().min(0),
      minor: z.number().int().min(0),
      major: z.number().int().min(0),
      critical: z.number().int().min(0),
    }),
  }),
});

export const InspectionFindingRaised = defineEvent({
  type: 'inspection.finding.raised',
  version: 1,
  description:
    'A failed checklist item became a finding; critical ones carry the urgent work opened for them.',
  payload: z.object({
    finding_id: z.uuid(),
    inspection_id: z.uuid(),
    item_code: z.string(),
    severity: z.enum(INSPECTION_SEVERITIES),
    location_id: z.uuid(),
    asset_id: z.uuid().nullable(),
    work_item_id: z.uuid().nullable(),
  }),
});
