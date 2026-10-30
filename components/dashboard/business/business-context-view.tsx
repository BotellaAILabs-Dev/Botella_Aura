'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Megaphone,
  Palette,
  Pencil,
  Radar,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';

import type { BusinessContext } from '@/lib/business-context';
import {
  attentionItems,
  CHANNEL_OPTIONS,
  confirmTarget,
  displayValue,
  EDITABLE_FIELDS,
  freshnessIndicator,
  MARKET_MODE_LABEL,
  sourceIndicator,
  type AttentionItem,
  type EditableField,
  type Indicator,
} from '@/lib/business-context-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ProductsEditor } from '@/components/dashboard/business/products-editor';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';

/**
 * About My Business — the Business Context, as the user sees it.
 *
 * Every value here is read from the context service, so the page shows what
 * Aura actually uses rather than a copy of a form. Each fact says where it came
 * from and how current it is; anything missing, out of date or unconfirmed is
 * listed at the top; and every edit goes through PATCH /api/business-context,
 * so it is validated by the same rules as everywhere else and updates the
 * context every workflow reads.
 */

interface Props {
  context: BusinessContext;
  canEdit: boolean;
  logoSrc: string | null;
}

type SaveResult = { ok: true } | { ok: false; message: string };

export function BusinessContextView({ context: ctx, canEdit, logoSrc }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  /**
   * The newest revision this page knows about.
   *
   * Taken from the save response as well as from props: router.refresh()
   * delivers the new props a moment after a save, and a second save in that
   * window would otherwise send the old revision and be refused as if someone
   * else had changed the business. Revisions are ISO timestamps, so the later
   * one is simply the larger string.
   */
  const revisionRef = useRef(ctx.meta.revision);
  if ((ctx.meta.revision ?? '') > (revisionRef.current ?? '')) {
    revisionRef.current = ctx.meta.revision;
  }

  /** One write path for edits and confirmations. */
  async function send(body: Record<string, unknown>): Promise<SaveResult> {
    const res = await fetch('/api/business-context', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        expectedRevision: revisionRef.current ?? undefined,
      }),
    }).catch(() => null);
    if (!res)
      return { ok: false, message: 'Could not reach the server. Try again.' };
    if (res.ok) {
      const saved = (await res.json().catch(() => ({}))) as {
        context?: { meta?: { revision?: string | null } };
      };
      const next = saved.context?.meta?.revision;
      if (next && next > (revisionRef.current ?? ''))
        revisionRef.current = next;
      router.refresh();
      return { ok: true };
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: Record<string, string[] | undefined>;
    };
    if (res.status === 409) setStale(true);
    const detail = Object.values(data.details ?? {})
      .flat()
      .filter(Boolean)[0];
    return { ok: false, message: detail ?? data.error ?? 'Could not save.' };
  }

  async function confirm(path: string, label: string) {
    const result = await send({ patch: {}, confirm: [path] });
    if (result.ok) toast.success(`${label} confirmed.`);
    else toast.error(result.message);
  }

  const attention = attentionItems(ctx);
  const { completeness } = ctx.meta;

  const row = (key: string) => {
    const field = EDITABLE_FIELDS[key]!;
    return (
      <FactRow
        key={key}
        field={field}
        ctx={ctx}
        canEdit={canEdit}
        editing={editing === key}
        onEdit={() => setEditing(key)}
        onCancel={() => setEditing(null)}
        onSave={async (value) => {
          const result = await send({ patch: field.toPatch(value) });
          if (result.ok) {
            toast.success(`${field.label} saved.`);
            setEditing(null);
          }
          return result;
        }}
        onConfirm={confirm}
      />
    );
  };

  const voiceFact = ctx.meta.facts['voice.summary'];
  const voiceConfirm = confirmTarget(null, voiceFact);
  const visual = ctx.identity.visual;

  return (
    <div className="space-y-6">
      {stale && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            Someone else changed this page while you had it open. Reload to see
            the latest before editing.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setStale(false);
              setEditing(null);
              router.refresh();
            }}
          >
            Reload
          </Button>
        </div>
      )}

      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          You have view-only access. Ask an owner or admin to change your
          business details.
        </p>
      )}

      {/* --- How complete, and what needs attention -------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                {completeness.complete
                  ? 'Aura has what it needs'
                  : 'Aura is missing key information'}
              </CardTitle>
              <CardDescription>
                {completeness.complete
                  ? 'Everything required is filled in. The items below would make Aura’s work sharper.'
                  : 'Fill in the required items below — until then, Aura has to write about a business it does not know.'}
              </CardDescription>
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold tabular-nums">
                {completeness.score}%
              </div>
              <div className="text-xs text-muted-foreground">complete</div>
            </div>
          </div>
          <div
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={completeness.score}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Business profile completeness"
          >
            <div
              className={cn(
                'h-full rounded-full',
                completeness.complete ? 'bg-primary' : 'bg-warning',
              )}
              style={{ width: `${completeness.score}%` }}
            />
          </div>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" /> Nothing needs
              your attention.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map((item) => (
                <AttentionRow
                  key={item.key}
                  item={item}
                  canEdit={canEdit}
                  onOpen={(key) => {
                    setEditing(key);
                    document
                      .getElementById(`field-${key}`)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- The business --------------------------------------------------- */}
      <Section
        icon={Building2}
        title="Your business"
        description="What you do and sell. Everything Aura writes starts here."
      >
        {row('identity.name')}
        {row('identity.description')}
        {row('identity.offerings')}
        <ProductsEditor
          products={ctx.identity.products}
          canEdit={canEdit}
          onSave={(products) =>
            send({ patch: { identity: { products } } })
          }
        />
        {row('identity.industry')}
        {row('identity.website')}
      </Section>

      {/* --- Audience ----------------------------------------------------------- */}
      <Section
        icon={Users}
        title="Who you sell to"
        description="Aura writes to this reader, and recommends what this reader cares about."
      >
        {row('audience.marketMode')}
        {row('audience.stated')}
        <ReadOnlyRow
          label="Buyer roles and industries"
          value={
            [...ctx.audience.roleTitles, ...ctx.audience.industries].join(
              ', ',
            ) || null
          }
          empty="None set"
          note="From your outreach targeting and lead searches."
          href="/dashboard/settings/outreach"
          linkLabel="Edit targeting"
        />
      </Section>

      {/* --- Goals ---------------------------------------------------------------- */}
      <Section
        icon={Target}
        title="Goals"
        description="What the business is working towards right now."
      >
        {row('objectives.goals')}
        <ReadOnlyRow
          label="Running campaigns"
          value={
            ctx.objectives.campaigns.length
              ? ctx.objectives.campaigns
                  .map((c) => `${c.name}${c.goal ? ` — ${c.goal}` : ''}`)
                  .join('\n')
              : null
          }
          empty="No campaign running"
          href="/dashboard/campaigns"
          linkLabel="View campaigns"
        />
      </Section>

      {/* --- Channels --------------------------------------------------------------- */}
      <Section
        icon={Megaphone}
        title="Channels"
        description="Where you publish, and where Aura can act for you."
      >
        {row('channels.preferred')}
        <ReadOnlyRow
          label="Connected to Aura"
          value={ctx.channels.connected.join(', ') || null}
          empty="Nothing connected"
          note={(() => {
            const missing = ctx.channels.preferred.filter(
              (c) => !ctx.channels.connected.includes(c),
            );
            return missing.length
              ? `Not connected: ${missing.join(', ')}. Aura can plan for these but not publish or measure there.`
              : undefined;
          })()}
          href="/dashboard/settings/connections"
          linkLabel="Manage connections"
        />
      </Section>

      {/* --- Brand -------------------------------------------------------------------- */}
      <Section
        icon={Palette}
        title="Brand"
        description="How you sound and look."
      >
        <div className="space-y-2 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Brand voice</span>
            <Indicators fact={voiceFact} />
          </div>
          {ctx.voice.summary ? (
            <p className="text-sm text-foreground">{ctx.voice.summary}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No voice yet — describe it below.
            </p>
          )}
          {ctx.voice.profile &&
            ctx.voice.profile.toneDescriptors.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Tone: {ctx.voice.profile.toneDescriptors.join(', ')}
              </p>
            )}
          <div className="flex flex-wrap gap-2 pt-1">
            {canEdit && voiceConfirm && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => confirm(voiceConfirm, 'Brand voice')}
              >
                <CheckCircle2 /> This is right
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <Link href="/dashboard/settings/knowledge-base">
                Edit the full voice profile <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
        {row('voice.notes')}
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="space-y-2">
            <span className="text-sm font-medium">Logo and colours</span>
            <div className="flex items-center gap-3">
              {logoSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoSrc}
                  alt="Your logo"
                  className="h-10 w-10 rounded border border-border object-contain"
                />
              ) : (
                <span className="text-sm italic text-muted-foreground">
                  No logo
                </span>
              )}
              {(['primaryColor', 'secondaryColor', 'accentColor'] as const).map(
                (k) =>
                  visual?.[k] ? (
                    <span
                      key={k}
                      title={`${k.replace('Color', '')} ${visual[k]}`}
                      className="h-6 w-6 rounded-full border border-border"
                      style={{ backgroundColor: visual[k] }}
                    />
                  ) : null,
              )}
            </div>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/dashboard/settings/brand">
              Edit logo and colours <ArrowRight />
            </Link>
          </Button>
        </div>
      </Section>

      {/* --- Market and learning (read-only, owned elsewhere) ------------------------ */}
      <Section
        icon={Radar}
        title="Your market"
        description="Who you compete with and what you follow."
      >
        <div className="space-y-2 py-4">
          <span className="text-sm font-medium">Competitors</span>
          {ctx.market.competitors.length ? (
            <ul className="flex flex-wrap gap-2">
              {ctx.market.competitors.map((c) => (
                <li key={c.name}>
                  <Badge
                    variant={
                      c.confidence === 'unverified' ? 'warning' : 'outline'
                    }
                    title={
                      c.confidence === 'unverified'
                        ? 'Suggested by AI and not confirmed — track or remove it.'
                        : (c.notes ?? undefined)
                    }
                  >
                    {c.name}
                    {c.confidence === 'unverified' && ' · AI-suggested'}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm italic text-muted-foreground">None tracked</p>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link href="/dashboard/competitors">
              Manage competitors <ArrowRight />
            </Link>
          </Button>
        </div>
      </Section>

      <Section
        icon={Sparkles}
        title="What Aura has learned"
        description="From your own results and published work."
      >
        <ReadOnlyRow
          label="Patterns that work for you"
          value={
            ctx.memory.insights
              .slice(0, 5)
              .map((m) => m.insight)
              .join('\n') || null
          }
          empty="Not enough results yet"
          href="/dashboard/memory"
          linkLabel="See what works"
        />
        <ReadOnlyRow
          label="Recently published"
          value={
            ctx.history.recentContent
              .slice(0, 5)
              .map((c) => c.title)
              .join('\n') || null
          }
          empty="Nothing published in the last 90 days"
          href="/dashboard/content"
          linkLabel="Open Content Studio"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-0">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">{children}</CardContent>
    </Card>
  );
}

function Pill({ indicator }: { indicator: Indicator }) {
  const variant =
    indicator.tone === 'warning'
      ? 'warning'
      : indicator.tone === 'muted'
        ? 'muted'
        : 'default';
  return (
    <Badge variant={variant} title={indicator.title}>
      {indicator.tone === 'warning' && <AlertTriangle className="h-3 w-3" />}
      {indicator.label}
    </Badge>
  );
}

function Indicators({
  fact,
}: {
  fact: BusinessContext['meta']['facts'][string] | undefined;
}) {
  const source = sourceIndicator(fact);
  const fresh = freshnessIndicator(fact);
  return (
    <>
      {source && <Pill indicator={source} />}
      {fresh && <Pill indicator={fresh} />}
    </>
  );
}

function FactRow({
  field,
  ctx,
  canEdit,
  editing,
  onEdit,
  onCancel,
  onSave,
  onConfirm,
}: {
  field: EditableField;
  ctx: BusinessContext;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (value: string | string[]) => Promise<SaveResult>;
  onConfirm: (path: string, label: string) => void;
}) {
  // The voice notes row describes the notes themselves, not the resolved voice.
  const fact =
    field.key === 'voice.notes' ? undefined : ctx.meta.facts[field.factPath];
  const value = displayValue(field, ctx);
  const confirmPath = confirmTarget(field, fact);
  const missing = ctx.meta.completeness.missingRequired.includes(
    field.factPath,
  );

  return (
    <div id={`field-${field.key}`} className="scroll-mt-24 space-y-2 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{field.label}</span>
          {missing && <Badge variant="destructive">Required</Badge>}
          <Indicators fact={fact} />
        </div>
        {canEdit && !editing && (
          <div className="flex gap-1">
            {confirmPath && value && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onConfirm(confirmPath, field.label)}
              >
                <CheckCircle2 /> Still right
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={onEdit}
              aria-label={`Edit ${field.label}`}
            >
              <Pencil /> {value ? 'Edit' : 'Add'}
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <FieldEditor
          field={field}
          initial={field.read(ctx)}
          onSave={onSave}
          onCancel={onCancel}
        />
      ) : value ? (
        <p className="whitespace-pre-line text-sm text-foreground">{value}</p>
      ) : (
        <p className="text-sm italic text-muted-foreground">
          {field.placeholder
            ? `Not set — e.g. “${field.placeholder}”`
            : 'Not set'}
        </p>
      )}
      {!editing && fact?.note && fact.inferred && (
        <p className="text-xs text-muted-foreground">{fact.note}</p>
      )}
      {!editing && field.hint && !value && (
        <p className="text-xs text-muted-foreground">{field.hint}</p>
      )}
    </div>
  );
}

function FieldEditor({
  field,
  initial,
  onSave,
  onCancel,
}: {
  field: EditableField;
  initial: string | string[] | null;
  onSave: (value: string | string[]) => Promise<SaveResult>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<string | string[]>(
    initial ?? (field.kind === 'channels' ? [] : ''),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = `edit-${field.key}`;

  async function save() {
    setSaving(true);
    setError(null);
    const result = await onSave(value);
    setSaving(false);
    if (!result.ok) setError(result.message);
  }

  const str = typeof value === 'string' ? value : '';
  const list = Array.isArray(value) ? value : [];
  const over = field.max !== undefined && str.length > field.max;
  // Nothing to save until the value actually differs — otherwise Save sends a
  // no-op and the "saved" toast claims a change that never happened.
  const normalise = (v: string | string[] | null) =>
    Array.isArray(v)
      ? [...v].sort().join('|')
      : (v ?? '').replace(/\s+/g, ' ').trim();
  const dirty = normalise(value) !== normalise(initial);

  return (
    <div className="space-y-2">
      {field.kind === 'text' && (
        <Input
          id={id}
          aria-label={field.label}
          value={str}
          maxLength={field.max}
          placeholder={field.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {field.kind === 'textarea' && (
        <>
          <Textarea
            id={id}
            aria-label={field.label}
            rows={3}
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={over}
          />
          {field.max !== undefined && (
            <p
              className={cn(
                'text-right text-xs',
                over ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {str.length} / {field.max}
            </p>
          )}
        </>
      )}
      {field.kind === 'marketMode' && (
        <div className="flex gap-2" role="radiogroup" aria-label={field.label}>
          {(['B2B', 'B2C'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              role="radio"
              aria-checked={value === mode}
              variant={value === mode ? 'default' : 'outline'}
              onClick={() => setValue(mode)}
            >
              {MARKET_MODE_LABEL[mode]}
            </Button>
          ))}
        </div>
      )}
      {field.kind === 'channels' && (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={field.label}
        >
          {CHANNEL_OPTIONS.map((ch) => {
            const on = list.includes(ch);
            return (
              <Button
                key={ch}
                type="button"
                size="sm"
                aria-pressed={on}
                variant={on ? 'default' : 'outline'}
                onClick={() =>
                  setValue(on ? list.filter((c) => c !== ch) : [...list, ch])
                }
              >
                {ch}
              </Button>
            );
          })}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving || over || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ReadOnlyRow({
  label,
  value,
  empty,
  note,
  href,
  linkLabel,
}: {
  label: string;
  value: string | null;
  empty: string;
  note?: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="space-y-2 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button asChild size="sm" variant="ghost">
          <Link href={href}>
            {linkLabel} <ArrowRight />
          </Link>
        </Button>
      </div>
      {value ? (
        <p className="whitespace-pre-line text-sm text-foreground">{value}</p>
      ) : (
        <p className="text-sm italic text-muted-foreground">{empty}</p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function AttentionRow({
  item,
  canEdit,
  onOpen,
}: {
  item: AttentionItem;
  canEdit: boolean;
  onOpen: (key: string) => void;
}) {
  const tone =
    item.severity === 'required'
      ? 'text-destructive'
      : item.severity === 'warning'
        ? '[color:hsl(38_92%_35%)]'
        : 'text-muted-foreground';
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-2">
        <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
        <div>
          <p className="text-sm font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground">{item.detail}</p>
        </div>
      </div>
      {item.editKey && canEdit ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onOpen(item.editKey!)}
        >
          Fix it
        </Button>
      ) : item.href ? (
        <Button asChild size="sm" variant="outline">
          <Link href={item.href}>Go there</Link>
        </Button>
      ) : null}
    </li>
  );
}
