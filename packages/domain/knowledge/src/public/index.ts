/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export type KnowledgeAudience = 'GUEST' | 'STAFF' | 'ALL';
export type KnowledgeClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';

export interface KnowledgeSearchInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly query: string;
  /** Who will read the answer: guest-facing searches see GUEST and ALL documents only. */
  readonly audience: 'GUEST' | 'STAFF';
  /** The most sensitive classification the caller may receive. */
  readonly maxClassification: KnowledgeClassification;
  /** Preferred language; other languages are used only when it has no match. */
  readonly language?: string | null;
  readonly departmentCode?: string | null;
  readonly limit?: number;
}

/** A retrieved passage with the exact document version it came from (Spec §38). */
export interface KnowledgePassage {
  readonly chunkId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly title: string;
  readonly kind: string;
  readonly language: string;
  readonly text: string;
  readonly score: number;
  /** Which signals found it. */
  readonly matchedBy: ReadonlyArray<'KEYWORD' | 'VECTOR'>;
}

export interface KnowledgePublicApi {
  search(input: KnowledgeSearchInput): Promise<readonly KnowledgePassage[]>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const KNOWLEDGE_API = Symbol.for('hotella.domain.knowledge.api');

export { KNOWLEDGE_MANIFEST } from '../manifest';
