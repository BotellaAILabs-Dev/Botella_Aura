import { describe, expect, it } from 'vitest';

import { blogToHtml, clip, defaultPublishOptions, inlineHtml, plainText, resolveHref, sectionHtml, slugify } from '@/lib/blog-html';
import type { BlogBody } from '@/lib/validations/content';

/**
 * A blog as the HTML a CMS stores. The same function renders the preview, so
 * these are also the guarantees about what the person sees before publishing:
 * formatting is kept, nothing in the text becomes markup it didn't ask for,
 * and only safe links survive.
 */

const body = (over: Partial<BlogBody> = {}): BlogBody => ({
  headline: 'Ten Ways to Brew Better Coffee',
  subtitle: '',
  sections: [
    { heading: 'Start with beans', body: 'Fresh beans matter.' },
    { heading: 'Grind right', body: 'Burr grinders win.' },
  ],
  tags: ['coffee', 'brewing'],
  ...over,
});

describe('inline formatting', () => {
  it('keeps bold, italic, code and links', () => {
    expect(inlineHtml('**Bold** and *italic* and `x < y` [docs](https://example.com/a?b=1&c=2)')).toBe(
      '<strong>Bold</strong> and <em>italic</em> and <code>x &lt; y</code> <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
    );
  });

  it('escapes HTML in the text, so a draft can never inject markup', () => {
    const out = inlineHtml('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('drops javascript: and other unsafe link targets, keeping the label', () => {
    expect(inlineHtml('[click](javascript:alert(1))')).toBe('click');
    expect(inlineHtml('[x](data:text/html,hi)')).toBe('x');
    expect(inlineHtml('[x](//evil.example)')).toBe('x');
  });

  it('makes site-relative links absolute against the site (internal links)', () => {
    expect(inlineHtml('[pricing](/pricing)', 'https://shop.example.com')).toBe('<a href="https://shop.example.com/pricing">pricing</a>');
    expect(resolveHref('#faq', 'https://a.example')).toBe('#faq');
    expect(resolveHref('mailto:hi@a.example')).toBe('mailto:hi@a.example');
  });

  it('does not treat snake_case or 2*3*4 as emphasis', () => {
    expect(inlineHtml('use snake_case_names')).toBe('use snake_case_names');
    expect(inlineHtml('2*3*4')).toBe('2*3*4');
  });
});

describe('blocks', () => {
  it('turns paragraphs, lists, quotes and sub-headings into HTML', () => {
    const html = sectionHtml('Intro line\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n### Detail');
    expect(html).toBe(
      '<p>Intro line<br>second line</p>\n<ul><li>one</li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>\n<blockquote><p>quoted</p></blockquote>\n<h3>Detail</h3>',
    );
  });

  it('keeps a wrapped list item with its item', () => {
    expect(sectionHtml('- a long item\n  that wraps\n- next')).toBe('<ul><li>a long item that wraps</li><li>next</li></ul>');
  });
});

describe('blogToHtml', () => {
  it('renders sections as h2 + body, without the headline (the CMS shows the title)', () => {
    const html = blogToHtml({ body: body() });
    expect(html).not.toContain('Ten Ways');
    expect(html).toContain('<h2>Start with beans</h2>\n<p>Fresh beans matter.</p>');
  });

  it('spreads extra images between sections, each with alt text', () => {
    const html = blogToHtml({
      body: body({ sections: [1, 2, 3, 4].map((i) => ({ heading: `H${i}`, body: `B${i}` })) }),
      inlineImages: [{ url: 'https://cdn.example/a.png', alt: 'A "quoted" alt' }],
    });
    expect(html).toContain('<figure><img src="https://cdn.example/a.png" alt="A &quot;quoted&quot; alt" loading="lazy"></figure>');
    // One image across four sections lands in the middle, after section 2.
    expect(html.indexOf('<figure>')).toBeGreaterThan(html.indexOf('<h2>H2</h2>'));
    expect(html.indexOf('<figure>')).toBeLessThan(html.indexOf('<h2>H3</h2>'));
  });

  it('adds chosen internal links as Related reading, refusing unsafe ones', () => {
    const html = blogToHtml({
      body: body(),
      siteUrl: 'https://blog.example',
      relatedLinks: [
        { title: 'Our roastery', url: 'https://blog.example/roastery' },
        { title: 'Bad', url: 'javascript:alert(1)' },
      ],
    });
    expect(html).toContain('<h2>Related reading</h2>');
    expect(html).toContain('<a href="https://blog.example/roastery">Our roastery</a>');
    expect(html).not.toContain('javascript');
  });
});

describe('defaults', () => {
  it('slugifies headlines, including accents and ampersands', () => {
    expect(slugify('Café & Crème: 10 Tips!')).toBe('cafe-and-creme-10-tips');
    expect(slugify('a'.repeat(50) + ' ' + 'b'.repeat(50)).length).toBeLessThanOrEqual(80);
  });

  it('builds SEO defaults from the draft', () => {
    const o = defaultPublishOptions(
      body({ subtitle: '', sections: [{ heading: 'x', body: `**Fresh** beans ${'matter a great deal '.repeat(12)}` }, { heading: 'y', body: 'z' }] }),
      { featuredAlt: 'A pour-over', site: { categories: ['Guides'], author: '7' } },
    );
    expect(o.slug).toBe('ten-ways-to-brew-better-coffee');
    expect(o.seoTitle).toBe('Ten Ways to Brew Better Coffee');
    expect(o.metaDescription.length).toBeLessThanOrEqual(160);
    expect(o.metaDescription.startsWith('Fresh beans matter')).toBe(true);
    expect(o.focusKeyword).toBe('coffee');
    expect(o.tags).toEqual(['coffee', 'brewing']);
    expect(o.categories).toEqual(['Guides']);
    expect(o.author).toBe('7');
    expect(o.featuredImageAlt).toBe('A pour-over');
  });

  it('strips markdown for plain text and clips at a word boundary', () => {
    expect(plainText('**Bold** [link](https://x.y) and `code`')).toBe('Bold link and code');
    expect(clip('one two three four', 12)).toBe('one two');
  });
});
