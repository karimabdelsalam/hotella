import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttributionFooter, Badge, BrandMark, Button, ChevronIcon, initials } from './index';

describe('ui primitives', () => {
  it('the attribution footer always carries the fixed label and link; only the policy can hide it', () => {
    const html = renderToStaticMarkup(<AttributionFooter />);
    expect(html).toContain('href="https://planova.com.eg"');
    expect(html).toContain('Powered by Planova');
    expect(renderToStaticMarkup(<AttributionFooter show={false} />)).toBe('');
  });

  it('uses no physical left/right styling, so components mirror in RTL', () => {
    const html = renderToStaticMarkup(
      <div>
        <Button>Send</Button>
        <Button variant="danger">Close</Button>
        <Badge tone="warning">Waiting</Badge>
        <AttributionFooter />
        <BrandMark name="Nile View" />
        <BrandMark name="Nile View" logoUrl="/logo.png" />
        <ChevronIcon />
      </div>,
    );
    expect(html).not.toMatch(/\b(?:ml|mr|pl|pr|left|right|text-left|text-right)-/);
  });

  it('the brand mark shows the logo when there is one, else the hotel initials', () => {
    expect(initials('Nile View Hotel')).toBe('NV');
    expect(initials('  فندق النيل ')).toBe('فا');
    expect(renderToStaticMarkup(<BrandMark name="Nile View" />)).toContain('>NV<');
    const logo = renderToStaticMarkup(<BrandMark name="Nile View" logoUrl="/x.png" />);
    expect(logo).toContain('src="/x.png"');
    expect(logo).toContain('alt="Nile View"');
  });
});
