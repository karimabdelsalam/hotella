import type { ComplaintSeverity } from './complaints';

/** The starter complaint categories (BUILD_PLAN 9.B), in English and Arabic; a hotel adds its own. */
export const STARTER_CATEGORIES: ReadonlyArray<{
  readonly code: string;
  readonly severity: ComplaintSeverity;
  readonly department: string | null;
  readonly names: ReadonlyArray<{ readonly locale: string; readonly name: string }>;
}> = [
  { code: 'NOISE', severity: 'MEDIUM', department: null, names: n('Noise', 'الضوضاء') },
  { code: 'CLEANLINESS', severity: 'MEDIUM', department: 'HK', names: n('Cleanliness', 'النظافة') },
  {
    code: 'MAINTENANCE',
    severity: 'MEDIUM',
    department: 'ENG',
    names: n('Maintenance', 'الصيانة'),
  },
  {
    code: 'STAFF',
    severity: 'HIGH',
    department: null,
    names: n('Staff behaviour', 'تعامل الموظفين'),
  },
  {
    code: 'FOOD',
    severity: 'MEDIUM',
    department: null,
    names: n('Food and drink', 'الطعام والشراب'),
  },
  { code: 'BILLING', severity: 'MEDIUM', department: null, names: n('Billing', 'الفاتورة') },
  { code: 'AMENITIES', severity: 'LOW', department: null, names: n('Amenities', 'المرافق') },
  { code: 'SAFETY', severity: 'CRITICAL', department: null, names: n('Safety', 'السلامة') },
  { code: 'OTHER', severity: 'MEDIUM', department: null, names: n('Other', 'أخرى') },
];

function n(en: string, ar: string) {
  return [
    { locale: 'en', name: en },
    { locale: 'ar', name: ar },
  ];
}
