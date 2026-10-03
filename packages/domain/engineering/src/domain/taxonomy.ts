/**
 * Failure taxonomy (Spec §10.5): four separate controlled lists so history can be counted (reliability intelligence),
 * never free text. The starter set is imported into a tenant on request and then belongs to the tenant.
 */

export const FAILURE_KINDS = ['SYMPTOM', 'FAILURE_MODE', 'CAUSE', 'RESOLUTION'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface StarterCode {
  readonly kind: FailureKind;
  readonly code: string;
  readonly en: string;
  readonly ar: string;
}

export const STARTER_FAILURE_CODES: readonly StarterCode[] = [
  { kind: 'SYMPTOM', code: 'NOT_COOLING', en: 'Not cooling', ar: 'لا يبرد' },
  { kind: 'SYMPTOM', code: 'NOT_HEATING', en: 'Not heating', ar: 'لا يسخن' },
  { kind: 'SYMPTOM', code: 'NOISY', en: 'Noisy', ar: 'صوت مزعج' },
  { kind: 'SYMPTOM', code: 'LEAKING', en: 'Leaking', ar: 'تسريب' },
  { kind: 'SYMPTOM', code: 'NO_POWER', en: 'No power', ar: 'لا توجد كهرباء' },
  { kind: 'SYMPTOM', code: 'NO_HOT_WATER', en: 'No hot water', ar: 'لا توجد مياه ساخنة' },
  { kind: 'SYMPTOM', code: 'BLOCKED', en: 'Blocked', ar: 'انسداد' },
  { kind: 'SYMPTOM', code: 'NOT_WORKING', en: 'Not working', ar: 'لا يعمل' },
  {
    kind: 'FAILURE_MODE',
    code: 'COMPRESSOR_NOT_STARTING',
    en: 'Compressor not starting',
    ar: 'الضاغط لا يعمل',
  },
  {
    kind: 'FAILURE_MODE',
    code: 'FAN_MOTOR_FAILED',
    en: 'Fan motor failed',
    ar: 'عطل في محرك المروحة',
  },
  {
    kind: 'FAILURE_MODE',
    code: 'LOW_REFRIGERANT',
    en: 'Low refrigerant',
    ar: 'نقص في غاز التبريد',
  },
  {
    kind: 'FAILURE_MODE',
    code: 'THERMOSTAT_FAULT',
    en: 'Thermostat fault',
    ar: 'عطل في الترموستات',
  },
  { kind: 'FAILURE_MODE', code: 'PIPE_LEAK', en: 'Pipe leak', ar: 'تسريب في المواسير' },
  { kind: 'FAILURE_MODE', code: 'DRAIN_BLOCKED', en: 'Drain blocked', ar: 'انسداد الصرف' },
  { kind: 'FAILURE_MODE', code: 'ELECTRICAL_FAULT', en: 'Electrical fault', ar: 'عطل كهربائي' },
  { kind: 'CAUSE', code: 'CAPACITOR_FAILED', en: 'Capacitor failed', ar: 'تلف المكثف' },
  { kind: 'CAUSE', code: 'FILTER_CLOGGED', en: 'Filter clogged', ar: 'انسداد الفلتر' },
  { kind: 'CAUSE', code: 'WEAR', en: 'Normal wear', ar: 'استهلاك طبيعي' },
  { kind: 'CAUSE', code: 'MISUSE', en: 'Misuse', ar: 'سوء استخدام' },
  { kind: 'CAUSE', code: 'WIRING', en: 'Wiring', ar: 'التوصيلات الكهربائية' },
  { kind: 'CAUSE', code: 'SCALE_BUILDUP', en: 'Scale build-up', ar: 'ترسبات' },
  { kind: 'CAUSE', code: 'UNKNOWN', en: 'Unknown', ar: 'غير معروف' },
  {
    kind: 'RESOLUTION',
    code: 'CAPACITOR_REPLACED',
    en: 'Capacitor replaced',
    ar: 'تم تغيير المكثف',
  },
  { kind: 'RESOLUTION', code: 'FILTER_CLEANED', en: 'Filter cleaned', ar: 'تم تنظيف الفلتر' },
  {
    kind: 'RESOLUTION',
    code: 'REFRIGERANT_RECHARGED',
    en: 'Refrigerant recharged',
    ar: 'تم شحن غاز التبريد',
  },
  { kind: 'RESOLUTION', code: 'PART_REPLACED', en: 'Part replaced', ar: 'تم تغيير قطعة' },
  { kind: 'RESOLUTION', code: 'REPAIRED', en: 'Repaired', ar: 'تم الإصلاح' },
  { kind: 'RESOLUTION', code: 'ADJUSTED', en: 'Adjusted', ar: 'تم الضبط' },
  { kind: 'RESOLUTION', code: 'CLEARED', en: 'Cleared', ar: 'تم التسليك' },
  { kind: 'RESOLUTION', code: 'NO_FAULT_FOUND', en: 'No fault found', ar: 'لا يوجد عطل' },
];
