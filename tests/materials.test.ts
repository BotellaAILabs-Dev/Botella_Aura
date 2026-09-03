import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';

import {
  MATERIAL_CATEGORIES,
  guessCategory,
  materialCategory,
  isMaterialCategory,
} from '@/lib/materials';
import { officeToText, OfficeParseError } from '@/server/knowledge/office';
import { chunksToContext, type RetrievedChunk } from '@/server/knowledge/retrieve';

/**
 * Aura learns from real business documents. Two things have to hold for that
 * to be true rather than aspirational: the formats those documents arrive in
 * must actually parse, and knowing WHAT a document is has to change how it is
 * used. A category that only rendered as a badge would be decoration.
 */

// ---- A real ZIP, built here so the parser is tested against the real thing --

function buildZip(files: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, content } of files) {
    const raw = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += 30 + nameBuf.length + deflated.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

describe('officeToText — Word', () => {
  const docx = (body: string) =>
    buildZip([{ name: 'word/document.xml', content: `<w:document><w:body>${body}</w:body></w:document>` }]);

  it('reads the text of a document', () => {
    const text = officeToText(
      docx('<w:p><w:r><w:t>Our tone is direct.</w:t></w:r></w:p>'),
      'docx',
    );
    expect(text).toBe('Our tone is direct.');
  });

  it('keeps paragraphs apart', () => {
    // Collapsed into one line, a brand guide's headings read as a sentence and
    // the structure that makes it usable is gone.
    const text = officeToText(
      docx(
        '<w:p><w:r><w:t>Voice</w:t></w:r></w:p><w:p><w:r><w:t>Never use hype.</w:t></w:r></w:p>',
      ),
      'docx',
    );
    expect(text).toBe('Voice\nNever use hype.');
  });

  it('honours explicit line breaks', () => {
    const text = officeToText(
      docx('<w:p><w:r><w:t>One</w:t></w:r><w:br/><w:r><w:t>Two</w:t></w:r></w:p>'),
      'docx',
    );
    expect(text).toBe('One\nTwo');
  });

  it('decodes XML entities rather than leaking markup', () => {
    const text = officeToText(
      docx('<w:p><w:r><w:t>Fast &amp; direct &lt;always&gt;</w:t></w:r></w:p>'),
      'docx',
    );
    expect(text).toBe('Fast & direct <always>');
  });

  it('includes headers, where brand rules often live', () => {
    const file = buildZip([
      { name: 'word/document.xml', content: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>' },
      { name: 'word/header1.xml', content: '<w:p><w:r><w:t>Confidential</w:t></w:r></w:p>' },
    ]);
    expect(officeToText(file, 'docx')).toContain('Confidential');
  });
});

describe('officeToText — PowerPoint', () => {
  it('reads slides in presentation order, not string order', () => {
    // slide2 must come before slide10. Sorting these as strings reverses the
    // second half of any deck with more than nine slides.
    const deck = buildZip([
      { name: 'ppt/slides/slide10.xml', content: '<a:p><a:r><a:t>Traction</a:t></a:r></a:p>' },
      { name: 'ppt/slides/slide2.xml', content: '<a:p><a:r><a:t>Problem</a:t></a:r></a:p>' },
    ]);
    const text = officeToText(deck, 'pptx');
    expect(text.indexOf('Problem')).toBeLessThan(text.indexOf('Traction'));
  });

  it('labels each slide so ideas keep their boundaries', () => {
    const deck = buildZip([
      { name: 'ppt/slides/slide1.xml', content: '<a:p><a:r><a:t>Problem</a:t></a:r></a:p>' },
    ]);
    expect(officeToText(deck, 'pptx')).toContain('Slide 1');
  });

  it('keeps speaker notes, and files them under their slide', () => {
    // In a real deck the slide has three words and the notes carry the
    // argument. Dropping them loses most of the document's value.
    const deck = buildZip([
      { name: 'ppt/slides/slide1.xml', content: '<a:p><a:r><a:t>Problem</a:t></a:r></a:p>' },
      {
        name: 'ppt/notesSlides/notesSlide1.xml',
        content: '<a:p><a:r><a:t>Ops leads lose six hours a week.</a:t></a:r></a:p>',
      },
      { name: 'ppt/slides/slide2.xml', content: '<a:p><a:r><a:t>Solution</a:t></a:r></a:p>' },
    ]);
    const text = officeToText(deck, 'pptx');
    expect(text).toContain('six hours a week');
    expect(text.indexOf('six hours')).toBeGreaterThan(text.indexOf('Problem'));
    expect(text.indexOf('six hours')).toBeLessThan(text.indexOf('Solution'));
  });

  it('ignores slide layouts and masters, which are boilerplate', () => {
    const deck = buildZip([
      { name: 'ppt/slides/slide1.xml', content: '<a:p><a:r><a:t>Real content</a:t></a:r></a:p>' },
      {
        name: 'ppt/slideLayouts/slideLayout1.xml',
        content: '<a:p><a:r><a:t>Click to edit Master title style</a:t></a:r></a:p>',
      },
    ]);
    expect(officeToText(deck, 'pptx')).not.toContain('Master title');
  });
});

describe('officeToText — failure is explained, not swallowed', () => {
  it('rejects a file that is not a ZIP at all', () => {
    expect(() => officeToText(Buffer.from('not a document'), 'docx')).toThrow(
      OfficeParseError,
    );
  });

  it('says what to do when a deck has no slides', () => {
    const empty = buildZip([{ name: 'docProps/app.xml', content: '<Properties/>' }]);
    // The message has to name the fix — an older .ppt saved as .pptx — because
    // "parse failed" leaves the user with nothing to try.
    expect(() => officeToText(empty, 'pptx')).toThrow(/\.pptx/);
  });

  it('says what to do when a deck has only images', () => {
    const imagesOnly = buildZip([
      { name: 'ppt/slides/slide1.xml', content: '<p:sld><p:pic/></p:sld>' },
    ]);
    expect(() => officeToText(imagesOnly, 'pptx')).toThrow(/only images/);
  });
});

describe('material categories', () => {
  it('has no duplicate ids', () => {
    const ids = MATERIAL_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ranks differentiators and ICP highest', () => {
    // These are the direct answer to content that is accurate, well-formed and
    // says nothing only this company could say.
    const first = MATERIAL_CATEGORIES[0];
    expect(first?.id).toBe('DIFFERENTIATORS');
    const icp = materialCategory('AUDIENCE_ICP');
    const docs = materialCategory('PRODUCT_DOCS');
    expect(icp!.weight).toBeGreaterThan(docs!.weight);
  });

  it('is listed in descending weight, so the first gap is the costliest', () => {
    const weights = MATERIAL_CATEGORIES.map((c) => c.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it('treats positioning as timeless and announcements as perishable', () => {
    // Brand guidelines written two years ago are exactly as binding today;
    // a product update from two years ago is not.
    expect(materialCategory('BRAND_GUIDELINES')!.timeless).toBe(true);
    expect(materialCategory('DIFFERENTIATORS')!.timeless).toBe(true);
    expect(materialCategory('PRODUCT_DOCS')!.timeless).toBe(false);
    expect(materialCategory('PAST_CAMPAIGN')!.timeless).toBe(false);
  });

  it('warns the model not to adopt competitor material as ours', () => {
    // The dangerous failure is silent: fluent copy repeating a rival's
    // marketing as our own claim.
    expect(materialCategory('COMPETITOR_INTEL')!.promptLabel).toMatch(/never/i);
  });

  it('rejects an unknown category from a form field', () => {
    expect(isMaterialCategory('BRAND_GUIDELINES')).toBe(true);
    expect(isMaterialCategory('NOT_A_CATEGORY')).toBe(false);
  });
});

describe('guessCategory', () => {
  it('recognises the documents people actually upload', () => {
    expect(guessCategory('Acme-Pitch-Deck-2026.pptx')).toBe('PITCH_DECK');
    expect(guessCategory('brand-guidelines.pdf')).toBe('BRAND_GUIDELINES');
    expect(guessCategory('ICP-definition.docx')).toBe('AUDIENCE_ICP');
    expect(guessCategory('competitor-battlecard.pdf')).toBe('COMPETITOR_INTEL');
    expect(guessCategory('positioning.md')).toBe('DIFFERENTIATORS');
  });

  it('assumes a bare .pptx is a deck', () => {
    expect(guessCategory('untitled.pptx')).toBe('PITCH_DECK');
  });

  it('falls back rather than guessing wildly', () => {
    // A wrong guess is worse than none: a deck mislabelled as brand guidelines
    // would then be treated as binding voice rules.
    expect(guessCategory('scan_0042.pdf')).toBe('OTHER');
  });
});

describe('chunksToContext', () => {
  const chunk = (over: Partial<RetrievedChunk>): RetrievedChunk => ({
    id: 'c1',
    title: null,
    content: 'body text',
    sourceType: 'UPLOAD',
    category: null,
    score: 1,
    ...over,
  });

  it('tells the model what each excerpt IS', () => {
    const out = chunksToContext([chunk({ category: 'BRAND_GUIDELINES' })]);
    expect(out).toContain('BRAND RULES');
  });

  it('marks competitor material as not ours', () => {
    const out = chunksToContext([chunk({ category: 'COMPETITOR_INTEL' })]);
    expect(out).toMatch(/never adopt their voice/i);
  });

  it('groups by kind so one instruction covers a block', () => {
    const out = chunksToContext([
      chunk({ id: 'a', category: 'BRAND_GUIDELINES', content: 'first' }),
      chunk({ id: 'b', category: 'COMPETITOR_INTEL', content: 'second' }),
      chunk({ id: 'c', category: 'BRAND_GUIDELINES', content: 'third' }),
    ]);
    // Two headings for three chunks, not three.
    expect(out.match(/BRAND RULES/g)).toHaveLength(1);
    expect(out.match(/COMPETITOR MATERIAL/g)).toHaveLength(1);
  });

  it('numbers every excerpt exactly once across groups', () => {
    const out = chunksToContext([
      chunk({ id: 'a', category: 'BRAND_GUIDELINES' }),
      chunk({ id: 'b', category: 'COMPETITOR_INTEL' }),
      chunk({ id: 'c', category: 'BRAND_GUIDELINES' }),
    ]);
    expect(out).toContain('[1]');
    expect(out).toContain('[2]');
    expect(out).toContain('[3]');
    expect(out).not.toContain('[4]');
  });

  it('still handles chunks ingested before categories existed', () => {
    const out = chunksToContext([chunk({ category: null })]);
    expect(out).toContain('COMPANY MATERIAL');
    expect(out).toContain('body text');
  });

  it('says so plainly when there is nothing', () => {
    expect(chunksToContext([])).toContain('No company knowledge base content');
  });
});
