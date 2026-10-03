import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns, getTableName } from 'drizzle-orm';

/** Spec §67 data classifications. Every column carries one (CLAUDE.md rule 21). */
export type DataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'SENSITIVE' | 'RESTRICTED';

export interface TableClassification {
  readonly table: string;
  readonly columns: Readonly<Record<string, DataClass>>;
}

const registry = new Map<string, TableClassification>();

/**
 * Declares the data class of every column of a table and registers it.
 * Throws at module load if a column is missing or unknown, so an unclassified column cannot ship.
 * The registry feeds log redaction, AI redaction policy (Phase 6) and retention (Phase 1).
 */
export function classify<T extends PgTable>(
  table: T,
  classes: Record<keyof T['_']['columns'] & string, DataClass>,
): T {
  const name = getTableName(table);
  const columns = getTableColumns(table) as Record<string, AnyPgColumn>;
  const declared = new Set(Object.keys(classes));
  const missing = Object.keys(columns).filter((c) => !declared.has(c));
  const unknown = [...declared].filter((c) => !(c in columns));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Data classification for table "${name}" is incomplete. Missing: [${missing.join(', ')}]; unknown: [${unknown.join(', ')}].`,
    );
  }
  const byColumnName: Record<string, DataClass> = {};
  for (const [prop, column] of Object.entries(columns)) {
    const cls = classes[prop as keyof typeof classes];
    byColumnName[column.name] = cls;
  }
  registry.set(name, { table: name, columns: byColumnName });
  return table;
}

export function getDataClassRegistry(): ReadonlyMap<string, TableClassification> {
  return registry;
}

/** Column names (across registered tables) whose class is SENSITIVE or RESTRICTED — used for log redaction. */
export function sensitiveColumnNames(): string[] {
  const out = new Set<string>();
  for (const t of registry.values()) {
    for (const [col, cls] of Object.entries(t.columns)) {
      if (cls === 'SENSITIVE' || cls === 'RESTRICTED') out.add(col);
    }
  }
  return [...out].sort();
}
