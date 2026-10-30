'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { DRAFT_FIELDS, parseTags, type DraftField } from '@/lib/draft-fields';
import type { ContentTypeKey } from '@/lib/validations/content';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * A draft's body as a form: one labelled box per field, with character counts
 * and add / remove / reorder for paragraphs, tweets, slides and sections.
 * `value` is the body object; keys not in the form are passed through.
 * `errors` is keyed by schema path ('slides.2.headline').
 */

type Body = Record<string, unknown>;

export function DraftFieldsEditor({
  type,
  value,
  onChange,
  errors,
  idPrefix = 'draft',
}: {
  type: ContentTypeKey;
  value: Body;
  onChange: (next: Body) => void;
  errors: Record<string, string>;
  idPrefix?: string;
}) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <div className="space-y-4">
      {DRAFT_FIELDS[type].map((field) => (
        <FieldBlock
          key={field.key}
          field={field}
          value={value[field.key]}
          onChange={(v) => set(field.key, v)}
          errors={errors}
          id={`${idPrefix}-${field.key}`}
        />
      ))}
    </div>
  );
}

function Counter({ length, max }: { length: number; max: number }) {
  return (
    <span className={cn('text-xs tabular-nums', length > max ? 'text-destructive' : 'text-muted-foreground')}>
      {length}/{max}
    </span>
  );
}

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

/** Errors for a key and anything under it, e.g. 'paragraphs' and 'paragraphs.1'. */
function own(errors: Record<string, string>, key: string) {
  return errors[key];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function RowControls({
  index,
  count,
  min,
  label,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  min: number;
  label: string;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5">
      <Button type="button" size="sm" variant="ghost" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>
        <ArrowUp />
      </Button>
      <Button type="button" size="sm" variant="ghost" aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
        <ArrowDown />
      </Button>
      <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${label}`} disabled={count <= min} onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}

function FieldBlock({
  field,
  value,
  onChange,
  errors,
  id,
}: {
  field: DraftField;
  value: unknown;
  onChange: (v: unknown) => void;
  errors: Record<string, string>;
  id: string;
}) {
  if (field.kind === 'text' || field.kind === 'textarea') {
    const v = str(value);
    const Box = field.kind === 'text' ? Input : Textarea;
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={id}>
            {field.label}
            {field.required && <span className="text-destructive"> *</span>}
          </Label>
          <Counter length={v.length} max={field.max} />
        </div>
        <Box
          id={id}
          value={v}
          onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => onChange(e.target.value)}
          {...(field.kind === 'textarea' ? { rows: Math.min(8, Math.max(2, Math.ceil(v.length / 90))) } : {})}
          aria-invalid={Boolean(own(errors, field.key))}
        />
        {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
        <ErrorText message={own(errors, field.key)} />
      </div>
    );
  }

  if (field.kind === 'tags') {
    const list = arr(value).map(String);
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={id}>{field.label}</Label>
          <span className={cn('text-xs tabular-nums', list.length > field.maxItems ? 'text-destructive' : 'text-muted-foreground')}>
            {list.length}/{field.maxItems}
          </span>
        </div>
        <Input
          id={id}
          defaultValue={list.join(', ')}
          onBlur={(e) => onChange(parseTags(e.target.value))}
          placeholder="Separate with commas"
        />
        {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
        <ErrorText message={Object.entries(errors).find(([k]) => k === field.key || k.startsWith(`${field.key}.`))?.[1]} />
      </div>
    );
  }

  if (field.kind === 'list') {
    const list = arr(value).map(str);
    const Box = field.long ? Textarea : Input;
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{field.label}</legend>
        {list.map((item, i) => {
          const label = `${field.itemLabel} ${i + 1}`;
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`${id}-${i}`} className="text-xs text-muted-foreground">
                  {label}
                </Label>
                <div className="flex items-center gap-1">
                  <Counter length={item.length} max={field.max} />
                  <RowControls
                    index={i}
                    count={list.length}
                    min={field.min}
                    label={label}
                    onMove={(to) => onChange(move(list, i, to))}
                    onRemove={() => onChange(list.filter((_, j) => j !== i))}
                  />
                </div>
              </div>
              <Box
                id={`${id}-${i}`}
                value={item}
                onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
                  onChange(list.map((x, j) => (j === i ? e.target.value : x)))
                }
                {...(field.long ? { rows: Math.min(8, Math.max(2, Math.ceil(item.length / 90))) } : {})}
                aria-invalid={Boolean(errors[`${field.key}.${i}`])}
              />
              <ErrorText message={errors[`${field.key}.${i}`]} />
            </div>
          );
        })}
        {list.length < field.maxItems && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...list, ''])}>
            <Plus /> Add {field.itemLabel.toLowerCase()}
          </Button>
        )}
        <ErrorText message={own(errors, field.key)} />
      </fieldset>
    );
  }

  if (field.kind !== 'group') return null;
  const list = arr(value).map((x) => (x && typeof x === 'object' ? (x as Body) : {}));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{field.label}</legend>
      {list.map((item, i) => {
        const label = `${field.itemLabel} ${i + 1}`;
        return (
          <div key={i} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">{label}</span>
              <RowControls
                index={i}
                count={list.length}
                min={field.min}
                label={label}
                onMove={(to) => onChange(move(list, i, to))}
                onRemove={() => onChange(list.filter((_, j) => j !== i))}
              />
            </div>
            {field.fields.map((sub) => {
              const v = str(item[sub.key]);
              const Box = sub.long ? Textarea : Input;
              const path = `${field.key}.${i}.${sub.key}`;
              return (
                <div key={sub.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={`${id}-${i}-${sub.key}`} className="text-xs">
                      {sub.label}
                      {sub.required && <span className="text-destructive"> *</span>}
                    </Label>
                    <Counter length={v.length} max={sub.max} />
                  </div>
                  <Box
                    id={`${id}-${i}-${sub.key}`}
                    value={v}
                    onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
                      onChange(list.map((x, j) => (j === i ? { ...x, [sub.key]: e.target.value } : x)))
                    }
                    {...(sub.long ? { rows: Math.min(10, Math.max(2, Math.ceil(v.length / 90))) } : {})}
                    aria-invalid={Boolean(errors[path])}
                  />
                  <ErrorText message={errors[path]} />
                </div>
              );
            })}
          </div>
        );
      })}
      {list.length < field.maxItems && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...list, Object.fromEntries(field.fields.map((f) => [f.key, '']))])}
        >
          <Plus /> Add {field.itemLabel.toLowerCase()}
        </Button>
      )}
      <ErrorText message={own(errors, field.key)} />
    </fieldset>
  );
}
