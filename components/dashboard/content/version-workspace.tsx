'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, History, Lightbulb, Pencil, Plus, RefreshCw, Sparkles, Undo2, Wand2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import {
  DETAIL_KEYS,
  DETAIL_LABELS,
  detailProblem,
  makeDetail,
  withDetails,
  type BusinessFacts,
  type DetailKey,
  type PostDetails,
} from '@/lib/post-details';
import { applyFields, bodyToFields } from '@/lib/review-item';

/**
 * Recommendations: every version of a post side by side, each with its own
 * copy, call to action and details. Choosing one makes it the post; the
 * others stay as they are. Editing, regenerating or refining a version
 * changes that version only — and nothing is ever published from here.
 */

export interface VersionCardData {
  index: number;
  angle: string;
  isActive: boolean;
  body: Record<string, unknown>;
  /** As it would be posted, details included. */
  preview: string;
  headline: string;
  cta: string | null;
  details: PostDetails;
  approvable: boolean;
  blockers: string[];
  previousCount: number;
  lastChange: string | null;
  platformLabel: string | null;
  /** The facts guard on a variation: true kept, false changed, null not checked (an original). */
  factsKept: boolean | null;
  introduced: string[];
}

interface Props {
  draftId: string;
  updatedAt: string;
  editable: boolean;
  /** The format has a call to action (not threads or blogs). */
  hasCta: boolean;
  /** More versions can be written (not for a blog). */
  allowMore: boolean;
  maxVersions: number;
  facts: BusinessFacts;
  versions: VersionCardData[];
}

async function call<T>(url: string, init: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) {
      toast.error(json.error ?? 'That did not work. Try again.');
      return null;
    }
    return json;
  } catch {
    toast.error('Could not reach Aura. Check your connection and try again.');
    return null;
  }
}

export function VersionWorkspace(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [refining, setRefining] = useState<number | null>(null);
  const [instruction, setInstruction] = useState('');
  const [editing, setEditing] = useState<VersionCardData | null>(null);
  const [moreCount, setMoreCount] = useState(2);
  const base = `/api/content/drafts/${props.draftId}`;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      const ok = await fn();
      if (ok) router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const use = (v: VersionCardData) =>
    run(`use-${v.index}`, async () => {
      const r = await call(`${base}/variation`, { method: 'POST', body: JSON.stringify({ index: v.index }) });
      if (r) toast.success(`Version ${v.index + 1} is now the post. The others are kept.`);
      return r;
    });

  const rewrite = (v: VersionCardData, text?: string) =>
    run(`rewrite-${v.index}`, async () => {
      const r = await call<{ factsKept: boolean }>(`${base}/variations/${v.index}/rewrite`, {
        method: 'POST',
        body: JSON.stringify(text ? { instruction: text } : {}),
      });
      if (r) {
        toast.success(text ? 'Version refined.' : 'Version regenerated.', {
          description: r.factsKept ? 'Only this version changed — its previous text can be restored.' : 'It added facts that need checking — see the issues on the card.',
        });
        setRefining(null);
        setInstruction('');
      }
      return r;
    });

  const revert = (v: VersionCardData) =>
    run(`revert-${v.index}`, async () => {
      const r = await call(`${base}/variations/${v.index}/revert`, {
        method: 'POST',
        body: JSON.stringify({ baseUpdatedAt: props.updatedAt }),
      });
      if (r) toast.success('Previous text restored for this version.');
      return r;
    });

  const more = () =>
    run('more', async () => {
      const r = await call<{ added: number[] }>(`${base}/variations/more`, { method: 'POST', body: JSON.stringify({ count: moreCount }) });
      if (r) toast.success(`${r.added.length} new recommendation${r.added.length === 1 ? '' : 's'} added.`);
      return r;
    });

  const full = props.versions.length >= props.maxVersions;

  return (
    <Card id="recommendations" className="scroll-mt-6">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 text-primary" aria-hidden />
            Recommendations
            <Badge variant="muted">{props.versions.length}</Badge>
          </CardTitle>
          <CardDescription>
            Compare the versions, choose one for the post, and adjust each on its own — its call to action, link and contact
            details stay with that version.
          </CardDescription>
        </div>
        {props.editable && props.allowMore && (
          <div className="flex shrink-0 items-center gap-2">
            <label className="sr-only" htmlFor="more-count">
              How many more
            </label>
            <select
              id="more-count"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={moreCount}
              onChange={(e) => setMoreCount(Number(e.target.value))}
              disabled={busy !== null}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} more
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={more} loading={busy === 'more'} disabled={busy !== null && busy !== 'more'}>
              <Plus aria-hidden /> More recommendations
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {full && props.editable && props.allowMore && (
          <p className="text-xs text-muted-foreground">
            A post keeps up to {props.maxVersions} versions — adding more replaces the oldest unused one (never the one in use).
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {props.versions.map((v) => (
            <article
              key={v.index}
              aria-label={`Version ${v.index + 1}${v.isActive ? ' (in use)' : ''}`}
              className={`flex min-w-0 flex-col gap-3 rounded-lg border p-3 ${v.isActive ? 'border-primary/60 bg-primary/5' : 'border-border'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">Version {v.index + 1}</span>
                {v.angle && <span className="truncate text-xs text-muted-foreground">· {v.angle}</span>}
                {v.isActive && (
                  <Badge variant="default">
                    <Check className="mr-1 h-3 w-3" aria-hidden /> In use
                  </Badge>
                )}
                {v.platformLabel && <Badge variant="outline">{v.platformLabel}</Badge>}
                {v.factsKept === true && <Badge variant="secondary">Facts kept</Badge>}
                {v.approvable ? (
                  <Badge variant="success">Ready</Badge>
                ) : (
                  <Badge variant="warning">{v.blockers.length} to fix</Badge>
                )}
              </div>

              {v.headline && <p className="break-words font-medium leading-snug">{v.headline}</p>}
              <p className="line-clamp-4 whitespace-pre-line break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {/* The headline is shown above; the snippet continues from it. */}
                {v.headline && v.preview.startsWith(v.headline) ? v.preview.slice(v.headline.length).trim() : v.preview}
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Read this version</summary>
                <p className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-sm text-foreground [overflow-wrap:anywhere]">
                  {v.preview}
                </p>
              </details>
              {v.factsKept === false && (
                <p className="break-words text-xs text-destructive">Changes facts from the original: {v.introduced.join(', ')}</p>
              )}
              {props.hasCta && (
                <p className="break-words text-sm">
                  <span className="text-muted-foreground">Call to action: </span>
                  {v.cta ? <span className="font-medium">{v.cta}</span> : <span className="italic text-muted-foreground">none</span>}
                </p>
              )}
              <DetailChips details={v.details} />
              {!v.approvable && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-[hsl(38_92%_35%)] dark:text-warning">
                  {v.blockers.slice(0, 3).map((b) => (
                    <li key={b} className="break-words">
                      {b}
                    </li>
                  ))}
                </ul>
              )}
              {v.lastChange && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <History className="h-3 w-3" aria-hidden /> Last change: {v.lastChange}
                </p>
              )}

              {props.editable && (
                <div className="mt-auto flex flex-wrap gap-2">
                  {!v.isActive && (
                    <Button size="sm" onClick={() => use(v)} loading={busy === `use-${v.index}`} disabled={busy !== null}>
                      Use this version
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setEditing(v)} disabled={busy !== null}>
                    <Pencil aria-hidden /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRefining(refining === v.index ? null : v.index);
                      setInstruction('');
                    }}
                    disabled={busy !== null}
                    aria-expanded={refining === v.index}
                  >
                    <Wand2 aria-hidden /> Refine
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => rewrite(v)} loading={busy === `rewrite-${v.index}` && refining !== v.index} disabled={busy !== null}>
                    <RefreshCw aria-hidden /> Regenerate
                  </Button>
                  {v.previousCount > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => revert(v)} loading={busy === `revert-${v.index}`} disabled={busy !== null}>
                      <Undo2 aria-hidden /> Revert
                    </Button>
                  )}
                </div>
              )}

              {refining === v.index && (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (instruction.trim().length >= 3) rewrite(v, instruction.trim());
                  }}
                >
                  <Label htmlFor={`refine-${v.index}`}>What should change in version {v.index + 1}?</Label>
                  <Textarea
                    id={`refine-${v.index}`}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder="e.g. Make the hook warmer and mention the tasting night"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" type="submit" loading={busy === `rewrite-${v.index}`} disabled={instruction.trim().length < 3 || busy !== null}>
                      <Sparkles aria-hidden /> Refine this version
                    </Button>
                    <Button size="sm" type="button" variant="ghost" onClick={() => setRefining(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </article>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Nothing here is published. The version in use goes through review and approval as usual; changing it after approval
          means approving it again.
        </p>
      </CardContent>

      {editing && (
        <VersionEditor
          key={`${editing.index}-${props.updatedAt}`}
          draftId={props.draftId}
          updatedAt={props.updatedAt}
          version={editing}
          hasCta={props.hasCta}
          facts={props.facts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function DetailChips({ details }: { details: PostDetails }) {
  const present = DETAIL_KEYS.filter((k) => details[k]);
  if (!present.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Post details">
      {present.map((k) => {
        const d = details[k]!;
        const ok = d.source === 'profile' || d.confirmed;
        return (
          <li key={k}>
            <Badge variant={ok ? 'outline' : 'warning'} className="max-w-[16rem] truncate" title={d.value}>
              {DETAIL_LABELS[k]}: {d.value}
              {!ok && ' · confirm'}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Editing one version
// ---------------------------------------------------------------------------

interface DetailDraft {
  value: string;
  confirmed: boolean;
}

function VersionEditor(props: {
  draftId: string;
  updatedAt: string;
  version: VersionCardData;
  hasCta: boolean;
  facts: BusinessFacts;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { version, facts } = props;
  const fields = useMemo(() => bodyToFields(version.body).filter((f) => f.key !== 'cta'), [version.body]);
  const [edits, setEdits] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [cta, setCta] = useState(version.cta ?? '');
  const [ctaOptions, setCtaOptions] = useState<string[] | null>(null);
  const [details, setDetails] = useState<Record<DetailKey, DetailDraft>>(
    () =>
      Object.fromEntries(
        DETAIL_KEYS.map((k) => [k, { value: version.details[k]?.value ?? '', confirmed: Boolean(version.details[k]?.confirmed) }]),
      ) as Record<DetailKey, DetailDraft>,
  );
  const [busy, setBusy] = useState<'save' | 'cta' | null>(null);

  const problems = DETAIL_KEYS.map((k) => (details[k].value.trim() ? detailProblem(k, details[k].value) : null));
  const unconfirmed = DETAIL_KEYS.filter((k) => {
    const v = details[k].value.trim();
    return v && facts[k]?.trim() !== v && !details[k].confirmed;
  });

  const suggestCtas = async () => {
    setBusy('cta');
    const r = await call<{ options: string[] }>(`/api/content/drafts/${props.draftId}/variations/${version.index}/cta-options`, {
      method: 'POST',
    });
    setBusy(null);
    if (r) {
      setCtaOptions(r.options);
      if (!r.options.length) toast.message('No new suggestions that keep to the known facts — write your own, or try again.');
    }
  };

  const save = async () => {
    if (problems.some(Boolean)) {
      toast.error(problems.find(Boolean)!);
      return;
    }
    setBusy('save');
    const copy = applyFields(version.body, edits, fields) as Record<string, unknown>;
    if (props.hasCta) copy.cta = cta.trim();
    const nextDetails: PostDetails = {};
    for (const k of DETAIL_KEYS) {
      const v = details[k].value.trim();
      if (v) nextDetails[k] = makeDetail(k, v, facts, details[k].confirmed);
    }
    const r = await call(`/api/content/drafts/${props.draftId}/variations/${version.index}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: withDetails(copy, nextDetails), baseUpdatedAt: props.updatedAt }),
    });
    setBusy(null);
    if (r) {
      toast.success(`Version ${version.index + 1} saved.`, {
        description: version.isActive ? 'This is the post — if it was approved, it needs approving again.' : 'Only this version changed.',
      });
      props.onSaved();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit version {version.index + 1}</DialogTitle>
          <DialogDescription>
            Changes apply to this version only{version.isActive ? ' — it is the one in use, so this edits the post' : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
              {f.multiline ? (
                <Textarea
                  id={`f-${f.key}`}
                  value={edits[f.key] ?? ''}
                  onChange={(e) => setEdits((s) => ({ ...s, [f.key]: e.target.value }))}
                  rows={Math.min(8, Math.max(2, Math.ceil((edits[f.key] ?? '').length / 70)))}
                />
              ) : (
                <Input id={`f-${f.key}`} value={edits[f.key] ?? ''} onChange={(e) => setEdits((s) => ({ ...s, [f.key]: e.target.value }))} />
              )}
              {f.list && <p className="text-xs text-muted-foreground">Separate with spaces; the # is optional.</p>}
            </div>
          ))}

          {props.hasCta && (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Call to action</legend>
              <Input aria-label="Call to action" value={cta} onChange={(e) => setCta(e.target.value)} maxLength={300} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" type="button" onClick={suggestCtas} loading={busy === 'cta'} disabled={busy !== null}>
                  <Sparkles aria-hidden /> {ctaOptions ? 'More suggestions' : 'Suggest calls to action'}
                </Button>
                <span className="text-xs text-muted-foreground">Suggestions never add links, numbers or offers that are not already known.</span>
              </div>
              {ctaOptions && ctaOptions.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Suggested calls to action">
                  {ctaOptions.map((o) => (
                    <li key={o}>
                      <button
                        type="button"
                        onClick={() => setCta(o)}
                        className={`rounded-full border px-3 py-1 text-left text-sm hover:bg-muted ${cta === o ? 'border-primary bg-primary/10' : ''}`}
                      >
                        {o}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}

          <fieldset className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Link and contact details</legend>
            <p className="text-xs text-muted-foreground">
              Optional. Aura never makes these up — use your saved business details, or type them and confirm they are correct.
            </p>
            {DETAIL_KEYS.map((k, i) => {
              const d = details[k];
              const fact = facts[k];
              const typed = d.value.trim() && fact?.trim() !== d.value.trim();
              return (
                <div key={k} className="space-y-1.5">
                  <Label htmlFor={`d-${k}`}>{DETAIL_LABELS[k]}</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id={`d-${k}`}
                      value={d.value}
                      inputMode={k === 'phone' ? 'tel' : k === 'email' ? 'email' : k === 'website' ? 'url' : 'text'}
                      placeholder={k === 'website' ? 'https://…' : ''}
                      onChange={(e) => setDetails((s) => ({ ...s, [k]: { value: e.target.value, confirmed: false } }))}
                      aria-invalid={Boolean(problems[i])}
                    />
                    <div className="flex shrink-0 gap-2">
                      {fact && d.value.trim() !== fact.trim() && (
                        <Button size="sm" variant="outline" type="button" onClick={() => setDetails((s) => ({ ...s, [k]: { value: fact, confirmed: true } }))}>
                          Use saved
                        </Button>
                      )}
                      {d.value && (
                        <Button size="sm" variant="ghost" type="button" onClick={() => setDetails((s) => ({ ...s, [k]: { value: '', confirmed: false } }))}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                  {problems[i] && <p className="text-xs text-destructive">{problems[i]}</p>}
                  {fact && !d.value && <p className="text-xs text-muted-foreground">Saved: {fact}</p>}
                  {typed && !problems[i] && (
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={d.confirmed}
                        onChange={(e) => setDetails((s) => ({ ...s, [k]: { ...s[k], confirmed: e.target.checked } }))}
                      />
                      <span>I confirm this {DETAIL_LABELS[k].toLowerCase()} is correct for this post.</span>
                    </label>
                  )}
                </div>
              );
            })}
            {!facts.address && !facts.phone && !facts.email && (
              <p className="text-xs text-muted-foreground">
                Save your address, phone and email once in Settings → Business details to reuse them on any post.
              </p>
            )}
          </fieldset>
        </div>

        <DialogFooter className="gap-2">
          {unconfirmed.length > 0 && (
            <p className="mr-auto text-xs text-[hsl(38_92%_35%)] dark:text-warning">
              Unconfirmed details can be saved, but the post cannot be approved until they are confirmed.
            </p>
          )}
          <Button variant="ghost" onClick={props.onClose} disabled={busy === 'save'}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy === 'save'} disabled={busy !== null}>
            Save version {version.index + 1}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
