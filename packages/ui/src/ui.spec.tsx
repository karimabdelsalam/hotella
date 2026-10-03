import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttributionFooter, Badge, Button } from './index';

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
      </div>,
    );
    expect(html).not.toMatch(/\b(?:ml|mr|pl|pr|left|right|text-left|text-right)-/);
  });
});
