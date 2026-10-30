// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import type { ZodTypeAny } from 'zod';

import { DRAFT_FIELDS, issueKey, parseTags } from '@/lib/draft-fields';
import { bodySchemaFor, CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { DraftFieldsEditor } from '@/components/dashboard/content/draft-fields-editor';

/**
 * Editing a draft as a form instead of raw JSON. The form must stay in step
 * with the content rules: same fields, same limits, so it never lets through
 * something the save will refuse, or refuses something it would accept.
 */

afterEach(cleanup);

/** Unwrap defaults and optionals to the underlying type. */
function inner(t: ZodTypeAny): ZodTypeAny {
  let cur = t;
  while (cur._def.innerType) cur = cur._def.innerType as ZodTypeAny;
  return cur;
}
const maxOf = (t: ZodTypeAny): number | undefined =>
  (inner(t)._def.checks as { kind: string; value: number }[] | undefined)?.find((c) => c.kind === 'max')?.value;
const arrayMax = (t: ZodTypeAny): number | undefined => inner(t)._def.maxLength?.value;
const arrayMin = (t: ZodTypeAny): number => inner(t)._def.minLength?.value ?? 0;

describe('form fields match the content rules', () => {
  it.each(CONTENT_TYPES.map((t) => [t]))('%s', (type) => {
    const shape = (bodySchemaFor(type as ContentTypeKey) as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const fields = DRAFT_FIELDS[type as ContentTypeKey];
    // Every body field is in the form (post details are carried through).
    expect(fields.map((f) => f.key).sort()).toEqual(Object.keys(shape).filter((k) => k !== 'details').sort());
    for (const f of fields) {
      const s = shape[f.key]!;
      if (f.kind === 'text' || f.kind === 'textarea') expect(f.max, f.key).toBe(maxOf(s));
      if (f.kind === 'tags') expect(f.maxItems, f.key).toBe(arrayMax(s));
      if (f.kind === 'list' || f.kind === 'group') {
        expect(f.maxItems, f.key).toBe(arrayMax(s));
        expect(f.min, f.key).toBe(arrayMin(s));
      }
      if (f.kind === 'list') expect(f.max, f.key).toBe(maxOf(inner(s)._def.type));
      if (f.kind === 'group') {
        const sub = inner(s)._def.type.shape as Record<string, ZodTypeAny>;
        for (const g of f.fields) expect(g.max, `${f.key}.${g.key}`).toBe(maxOf(sub[g.key]!));
      }
    }
  });
});

describe('helpers', () => {
  it('reads tags from one comma-separated line', () => {
    expect(parseTags('#coffee, #Coffee , , #morning ritual')).toEqual(['#coffee', '#morning ritual']);
  });
  it('keys an error by its path', () => {
    expect(issueKey(['slides', 2, 'headline'])).toBe('slides.2.headline');
  });
});

function Harness({ initial, onChange }: { initial: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [v, setV] = useState(initial);
  return (
    <DraftFieldsEditor
      type="LINKEDIN_POST"
      value={v}
      onChange={(next) => {
        setV(next);
        onChange(next);
      }}
      errors={{ 'paragraphs.1': 'This can’t be empty.' }}
    />
  );
}

describe('the form', () => {
  const body = {
    hook: 'Coffee prices are up.',
    paragraphs: ['One', 'Two', 'Three'],
    cta: '',
    hashtags: ['#coffee'],
    details: { website: { value: 'roastery.example' } },
  };

  it('edits a field and keeps keys the form does not show', () => {
    const onChange = vi.fn();
    render(<Harness initial={body} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Hook/), { target: { value: 'Coffee prices are rising.' } });
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.hook).toBe('Coffee prices are rising.');
    expect(last.details).toEqual(body.details);
    expect(screen.getByText('25/300')).toBeInTheDocument();
  });

  it('adds, reorders and removes paragraphs, but not below the minimum', () => {
    const onChange = vi.fn();
    render(<Harness initial={body} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Remove Paragraph 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Add paragraph/ }));
    expect(onChange.mock.calls.at(-1)![0].paragraphs).toEqual(['One', 'Two', 'Three', '']);
    fireEvent.click(screen.getByRole('button', { name: 'Move Paragraph 1 down' }));
    expect(onChange.mock.calls.at(-1)![0].paragraphs).toEqual(['Two', 'One', 'Three', '']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Paragraph 4' }));
    expect(onChange.mock.calls.at(-1)![0].paragraphs).toEqual(['Two', 'One', 'Three']);
  });

  it('shows an error under the field it belongs to', () => {
    render(<Harness initial={body} onChange={() => {}} />);
    expect(screen.getByLabelText('Paragraph 2')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('This can’t be empty.')).toBeInTheDocument();
  });
});
