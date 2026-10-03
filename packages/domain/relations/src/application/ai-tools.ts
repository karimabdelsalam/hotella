import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AiToolDefinition, AiToolRegistrar } from '@hotella/domain-ai/public';
import { COMPLAINT_SEVERITIES, type ComplaintSeverity } from '../domain/complaints';
import { STARTER_CATEGORIES } from '../domain/starter';
import { CandidateService } from './candidate.service';

interface SuggestArgs {
  category_code: string;
  severity: ComplaintSeverity;
  confidence: number;
  summary: string;
  reason: string;
  guest_words?: string;
}

/**
 * Guest relations' one AI tool (BUILD_PLAN 9.B): the concierge records a complaint **candidate** for its own guest's
 * stay — never a complaint. A person confirms or dismisses it; the guest is not told anything was filed.
 */
@Injectable()
export class RelationsAiTools {
  constructor(private readonly candidates: CandidateService) {}

  registerInto(registry: AiToolRegistrar): void {
    registry.register(this.suggestComplaint());
  }

  suggestComplaint(): AiToolDefinition<SuggestArgs> {
    return {
      code: 'relations.suggest_complaint',
      description: `Flags that the guest of this conversation is complaining (something went wrong or they are unhappy), so guest relations can follow up. It does not file a complaint: a staff member reviews it. category_code is usually one of ${STARTER_CATEGORIES.map((c) => c.code).join(', ')}. confidence is how sure you are that this is a complaint (0 to 1); a merely negative remark is not a complaint.`,
      risk: 'LOW',
      requiredPermission: 'complaint.suggest',
      needs: { guest: true },
      input: z
        .object({
          category_code: z
            .string()
            .trim()
            .regex(/^[A-Z][A-Z0-9_]{1,39}$/),
          severity: z.enum(COMPLAINT_SEVERITIES),
          confidence: z.number().min(0).max(1),
          summary: z.string().trim().min(3).max(300),
          reason: z.string().trim().min(3).max(500),
          guest_words: z.string().trim().min(1).max(1000).optional(),
        })
        .strict(),
      handle: async (args, ctx) => {
        const outcome = await this.candidates.suggest({
          tenantId: ctx.tenantId,
          propertyId: ctx.propertyId,
          stayId: ctx.guest!.stayId,
          guestId: ctx.guest!.guestId,
          conversationId: ctx.conversationId,
          executionId: ctx.executionId,
          categoryCode: args.category_code,
          severity: args.severity,
          confidence: args.confidence,
          summary: args.summary,
          reason: args.reason,
          guestWords: args.guest_words ?? null,
        });
        return outcome.recorded
          ? { flagged: true, already_flagged: outcome.duplicate }
          : {
              flagged: false,
              note: 'Not sure enough that this is a complaint; nothing was flagged.',
            };
      },
    };
  }
}
