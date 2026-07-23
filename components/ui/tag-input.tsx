'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Tag/chip input for lists of short strings (keywords, subreddits, competitors).
 * Enter or comma commits a tag; Backspace on an empty field removes the last.
 * Fully keyboard-navigable and labelable via the `id` prop.
 */
export function TagInput({
  id,
  value,
  onChange,
  placeholder,
  transform,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional normalizer applied to each committed tag (e.g. strip "r/"). */
  transform?: (raw: string) => string;
}) {
  const [draft, setDraft] = React.useState('');

  function commit(raw: string) {
    const cleaned = (transform ? transform(raw) : raw).trim();
    if (!cleaned) return;
    if (!value.includes(cleaned)) onChange([...value, cleaned]);
    setDraft('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 shadow-xs',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="rounded-full hover:bg-primary/20"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
