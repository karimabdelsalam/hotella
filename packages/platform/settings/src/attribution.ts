/** Spec invariant 33 / CLAUDE.md rule 15. The label and link are fixed; only visibility is a (licensed) policy. */
export const PLANOVA_ATTRIBUTION = Object.freeze({
  label: 'Powered by Planova',
  href: 'https://planova.com.eg',
});

export interface Attribution {
  readonly show: boolean;
  readonly label: string;
  readonly href: string;
}

/** Hidden only when the tenant's policy says so AND it references the entitlement that allows it. */
export function attributionFor(
  policy: { showPoweredBy: boolean; overrideEntitlementRef: string | null } | null | undefined,
): Attribution {
  const hidden = !!policy && !policy.showPoweredBy && !!policy.overrideEntitlementRef;
  return { show: !hidden, ...PLANOVA_ATTRIBUTION };
}
