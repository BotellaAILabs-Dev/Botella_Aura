// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { TrendCard } from '@/components/dashboard/trends/trend-card';
import type { DigestItem } from '@/server/trends/types';

/**
 * Third-party links as rendered: a real story keeps its link; a story whose
 * feed supplied a script URL is shown without one (docs/DATA-ACCESS-SECURITY.md).
 */

afterEach(cleanup);

const item = (url: string): DigestItem => ({
  id: 'i1',
  title: 'Specialty coffee prices climb',
  url,
  source: 'news',
  sourceLabel: 'News',
  score: 10,
  publishedAt: new Date().toISOString(),
  aiSummary: 'Why it matters',
  suggestedAngle: 'An angle',
});

describe('trend story links', () => {
  it('keeps a real web link', () => {
    render(<TrendCard item={item('https://news.example/story')} />);
    expect(
      screen.getByText('Specialty coffee prices climb').closest('a'),
    ).toHaveAttribute('href', 'https://news.example/story');
  });

  it('renders no link for a script URL from a feed', () => {
    render(<TrendCard item={item('javascript:alert(document.cookie)')} />);
    const a = screen.getByText('Specialty coffee prices climb').closest('a');
    expect(a).not.toHaveAttribute('href');
    expect(document.body.innerHTML).not.toContain('javascript:');
  });
});
