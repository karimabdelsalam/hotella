/** Usage periods (Spec §61): UTC days and months, so every process and report agrees on the boundaries. */
export function periodStart(granularity: 'DAY' | 'MONTH', at: Date): Date {
  return granularity === 'DAY'
    ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
    : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export const usageKey = (propertyKey: string, granularity: 'DAY' | 'MONTH'): string =>
  `${propertyKey}/${granularity}`;
