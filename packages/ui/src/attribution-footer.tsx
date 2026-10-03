/** Fixed by the product (Spec "Product identity", CLAUDE.md rule 15): label and link are not configurable. */
export const PLANOVA_LABEL = 'Powered by Planova';
export const PLANOVA_HREF = 'https://planova.com.eg';

/**
 * The attribution footer. Brand settings cannot change its text or link; only the platform's attribution policy
 * (hidden solely with a licensed entitlement) decides `show`. Direction-neutral, so it reads correctly in LTR and RTL.
 */
export function AttributionFooter({ show = true }: { readonly show?: boolean }) {
  if (!show) return null;
  return (
    <footer className="py-3 text-center text-xs text-slate-500" data-testid="attribution">
      <a href={PLANOVA_HREF} target="_blank" rel="noopener" dir="ltr" className="hover:underline">
        {PLANOVA_LABEL}
      </a>
    </footer>
  );
}
