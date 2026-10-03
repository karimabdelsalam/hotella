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

/** A document's identity (no content), e.g. for engineering to link a manual to an asset. */
export interface KnowledgeDocumentSummary {
  readonly id: string;
  readonly propertyId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
}

export interface KnowledgePublicApi {
  search(input: KnowledgeSearchInput): Promise<readonly KnowledgePassage[]>;
  /** Null for an unknown document or one of another tenant. */
  getDocument(tenantId: string, documentId: string): Promise<KnowledgeDocumentSummary | null>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const KNOWLEDGE_API = Symbol.for('hotella.domain.knowledge.api');

export { KNOWLEDGE_MANIFEST } from '../manifest';
