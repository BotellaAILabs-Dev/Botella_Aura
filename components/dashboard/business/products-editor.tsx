'use client';

import { useState } from 'react';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';

import { PRODUCT_LIMITS, type Product } from '@/lib/products';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';

/**
 * The product catalogue on About My Business.
 *
 * One product at a time, in the business's own words. Every save sends the
 * whole list through PATCH /api/business-context, so the same rules apply as
 * for every other business fact (real names, no duplicates, valid links).
 */

type SaveResult = { ok: true } | { ok: false; message: string };

/** What the form edits: a product without an id yet, or an existing one. */
type Draft = Omit<Product, 'id'> & { id?: string };

const EMPTY: Draft = {
  name: '',
  description: null,
  audience: null,
  benefit: null,
  price: null,
  url: null,
  featured: false,
};

export function ProductsEditor({
  products,
  canEdit,
  onSave,
}: {
  products: Product[];
  canEdit: boolean;
  onSave: (products: Draft[]) => Promise<SaveResult>;
}) {
  /** Index being edited, 'new' for the add form, or null. */
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: Draft[], message: string) {
    setBusy(true);
    const result = await onSave(next);
    setBusy(false);
    if (result.ok) {
      toast.success(message);
      setEditing(null);
    } else {
      toast.error(result.message);
    }
    return result;
  }

  return (
    <div id="field-identity.products" className="scroll-mt-24 space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="text-sm font-medium">Products</span>
          <p className="text-xs text-muted-foreground">
            Aura picks the product each post is about, and writes to the people it is for. Mark
            your lead products with a star.
          </p>
        </div>
        {canEdit && editing === null && products.length < PRODUCT_LIMITS.max && (
          <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
            <Plus /> Add product
          </Button>
        )}
      </div>

      {products.length === 0 && editing !== 'new' && (
        <p className="text-sm italic text-muted-foreground">
          No products yet. Add the things customers buy, e.g. “Monthly bean subscription — for
          people who grind at home”.
        </p>
      )}

      <ul className="space-y-2">
        {products.map((p, i) =>
          editing === i ? (
            <li key={p.id}>
              <ProductForm
                initial={p}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={(draft) =>
                  save(
                    products.map((x, j) => (j === i ? { ...draft, id: x.id } : x)),
                    `${draft.name} saved.`,
                  )
                }
              />
            </li>
          ) : (
            <li key={p.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.featured && <Badge variant="secondary">Lead product</Badge>}
                    {p.price && <span className="text-xs text-muted-foreground">{p.price}</span>}
                  </div>
                  {p.description && <p className="text-sm">{p.description}</p>}
                  {(p.audience || p.benefit) && (
                    <p className="text-xs text-muted-foreground">
                      {p.audience && <>For {p.audience}. </>}
                      {p.benefit && <>Why they choose it: {p.benefit}</>}
                    </p>
                  )}
                  {p.url && <p className="break-all text-xs text-muted-foreground">{p.url}</p>}
                </div>
                {canEdit && editing === null && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={p.featured ? `Unmark ${p.name} as lead` : `Mark ${p.name} as lead`}
                      onClick={() =>
                        save(
                          products.map((x, j) => (j === i ? { ...x, featured: !x.featured } : x)),
                          p.featured ? `${p.name} is no longer a lead product.` : `${p.name} is a lead product.`,
                        )
                      }
                    >
                      <Star className={p.featured ? 'fill-current' : undefined} />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setEditing(i)}>
                      <Pencil /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Remove ${p.name}`}
                      onClick={() => save(products.filter((_, j) => j !== i), `${p.name} removed.`)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ),
        )}
        {editing === 'new' && (
          <li>
            <ProductForm
              initial={EMPTY}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={(draft) => save([...products, draft], `${draft.name} added.`)}
            />
          </li>
        )}
      </ul>
    </div>
  );
}

function ProductForm({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  busy: boolean;
  onSubmit: (draft: Draft) => Promise<SaveResult>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setD({ ...d, [key]: e.target.value || null });
  const prefix = initial.id ?? 'new';

  return (
    <form
      className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!d.name?.trim()) {
          setError('Give the product a name.');
          return;
        }
        setError(null);
        const result = await onSubmit({ ...d, name: d.name.trim() });
        if (!result.ok) setError(result.message);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-name`}>Name</Label>
          <Input
            id={`${prefix}-name`}
            value={d.name}
            maxLength={PRODUCT_LIMITS.name}
            onChange={(e) => setD({ ...d, name: e.target.value })}
            placeholder="Monthly bean subscription"
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-price`}>Price (optional)</Label>
          <Input
            id={`${prefix}-price`}
            value={d.price ?? ''}
            maxLength={PRODUCT_LIMITS.price}
            onChange={set('price')}
            placeholder="₹899 / month"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-description`}>What it is</Label>
        <Textarea
          id={`${prefix}-description`}
          value={d.description ?? ''}
          maxLength={PRODUCT_LIMITS.description}
          onChange={set('description')}
          rows={2}
          placeholder="Two 250 g bags of single-origin beans, roasted the week they ship."
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-audience`}>Who it is for</Label>
          <Input
            id={`${prefix}-audience`}
            value={d.audience ?? ''}
            maxLength={PRODUCT_LIMITS.audience}
            onChange={set('audience')}
            placeholder="Home brewers who own a grinder"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-benefit`}>Why people choose it</Label>
          <Input
            id={`${prefix}-benefit`}
            value={d.benefit ?? ''}
            maxLength={PRODUCT_LIMITS.benefit}
            onChange={set('benefit')}
            placeholder="Fresher than supermarket beans, never runs out"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-url`}>Link (optional)</Label>
        <Input
          id={`${prefix}-url`}
          value={d.url ?? ''}
          maxLength={PRODUCT_LIMITS.url}
          onChange={set('url')}
          placeholder="yourshop.com/subscription"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={d.featured}
          onChange={(e) => setD({ ...d, featured: e.target.checked })}
        />
        Lead product — used when a post isn’t about anything specific
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save product'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
