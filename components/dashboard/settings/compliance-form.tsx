'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, Plus, RotateCcw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TagInput } from '@/components/ui/tag-input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { SOCIAL_PLATFORMS, type SocialPlatformKey } from '@/lib/platforms';
import {
  CATEGORY_LABEL,
  PACKS,
  type CompliancePolicy,
  type ComplianceReport,
} from '@/lib/compliance-policy';

/**
 * Settings → Compliance: the rules every draft is checked against before
 * approval (lib/compliance-policy.ts), and a tester to try them on copy.
 */

const newId = () =>
  `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PLATFORM_LABEL: Record<SocialPlatformKey, string> = {
  LINKEDIN: 'LinkedIn',
  INSTAGRAM: 'Instagram',
  X: 'X',
  FACEBOOK: 'Facebook',
};
const select =
  'h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: readonly T[];
  value: T[];
  onChange: (next: T[]) => void;
  label: (v: T) => string;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() =>
              onChange(on ? value.filter((x) => x !== o) : [...value, o])
            }
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs transition',
              on
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted/50',
              disabled && 'cursor-not-allowed opacity-70',
            )}
          >
            {label(o)}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn('flex items-start gap-2 text-sm', disabled && 'opacity-70')}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

export function ComplianceForm({
  initial,
  alcohol,
  customised,
  canManage,
}: {
  initial: CompliancePolicy;
  /** The business is an alcohol business (decides the alcohol pack on "auto"). */
  alcohol: boolean;
  customised: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [p, setP] = useState<CompliancePolicy>(initial);
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null);
  const [test, setTest] = useState<{
    type: ContentTypeKey;
    platform: SocialPlatformKey | '';
    text: string;
  }>({
    type: 'IMAGE_POST',
    platform: 'INSTAGRAM',
    text: '',
  });
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const ro = !canManage;
  const set = <K extends keyof CompliancePolicy>(
    k: K,
    v: CompliancePolicy[K],
  ) => setP((prev) => ({ ...prev, [k]: v }));

  async function send(
    method: 'PUT' | 'POST',
    body: unknown,
    kind: 'save' | 'reset' | 'test',
  ) {
    setBusy(kind);
    try {
      const res = await fetch('/api/company/compliance', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        details?: Record<string, string[]>;
        policy?: CompliancePolicy;
        report?: ComplianceReport;
      };
      if (!res.ok) {
        const detail = data.details ? Object.keys(data.details).join(', ') : '';
        toast.error(
          `${data.error ?? 'Could not save.'}${detail ? ` (${detail})` : ''}`,
        );
        return null;
      }
      return data;
    } catch {
      toast.error('Could not reach the server. Try again.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    // Rows left empty are dropped rather than failing the save.
    const data = await send(
      'PUT',
      {
        ...p,
        prohibited: p.prohibited.filter((r) => r.phrase.trim()),
        disclaimers: p.disclaimers.filter((d) => d.text.trim()),
      },
      'save',
    );
    if (data?.policy) {
      setP(data.policy);
      toast.success(
        'Saved. Drafts are checked against these rules before approval.',
      );
      router.refresh();
    }
  }
  async function reset() {
    const data = await send('POST', { action: 'reset' }, 'reset');
    if (data?.policy) {
      setP(data.policy);
      toast.success('Back to the default rules.');
      router.refresh();
    }
  }
  async function runTest() {
    const data = await send(
      'POST',
      {
        action: 'test',
        policy: p,
        type: test.type,
        platform: test.platform || null,
        text: test.text,
      },
      'test',
    );
    if (data?.report) setReport(data.report);
  }

  return (
    <div className="space-y-5">
      {!canManage && (
        <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          Only owners and admins can change these rules.
        </p>
      )}

      {/* Rule packs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Built-in rule packs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Toggle
            checked={p.packs.general}
            disabled={ro}
            onChange={(v) => set('packs', { ...p.packs, general: v })}
          >
            <span className="font-medium">{PACKS.general.label}</span>
            <span className="block text-muted-foreground">
              {PACKS.general.description}
            </span>
          </Toggle>
          <div className="flex flex-wrap items-start gap-3 text-sm">
            <div className="min-w-0 flex-1">
              <span className="font-medium">{PACKS.alcohol.label}</span>
              <span className="block text-muted-foreground">
                {PACKS.alcohol.description}{' '}
                {alcohol
                  ? 'Aura sees an alcohol business.'
                  : 'Aura does not see an alcohol business.'}
              </span>
            </div>
            <select
              aria-label="Alcohol rules"
              className={select}
              disabled={ro}
              value={p.packs.alcohol}
              onChange={(e) =>
                set('packs', {
                  ...p.packs,
                  alcohol: e.target
                    .value as CompliancePolicy['packs']['alcohol'],
                })
              }
            >
              <option value="auto">Automatic</option>
              <option value="on">Always on</option>
              <option value="off">Off</option>
            </select>
          </div>
          <Toggle
            checked={p.packs.health}
            disabled={ro}
            onChange={(v) => set('packs', { ...p.packs, health: v })}
          >
            <span className="font-medium">{PACKS.health.label}</span>
            <span className="block text-muted-foreground">
              {PACKS.health.description}
            </span>
          </Toggle>
          <Toggle
            checked={p.packs.financial}
            disabled={ro}
            onChange={(v) => set('packs', { ...p.packs, financial: v })}
          >
            <span className="font-medium">{PACKS.financial.label}</span>
            <span className="block text-muted-foreground">
              {PACKS.financial.description}
            </span>
          </Toggle>
          <p className="text-xs text-muted-foreground">
            Channel rules always apply: Instagram and Facebook giveaway wording,
            engagement bait, links in Instagram captions, personal attributes in
            ads, shouting in email subjects.
          </p>
        </CardContent>
      </Card>

      {/* Prohibited words */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Words and claims you never use
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {p.prohibited.length === 0 && (
            <p className="text-sm text-muted-foreground">None yet.</p>
          )}
          {p.prohibited.map((r, i) => (
            <div
              key={r.id}
              className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_8rem_1.5fr_auto]"
            >
              <Input
                aria-label="Word or phrase"
                placeholder="e.g. cheapest"
                value={r.phrase}
                disabled={ro}
                onChange={(e) =>
                  set(
                    'prohibited',
                    p.prohibited.map((x, j) =>
                      j === i ? { ...x, phrase: e.target.value } : x,
                    ),
                  )
                }
              />
              <select
                aria-label="If used"
                className={select}
                disabled={ro}
                value={r.severity}
                onChange={(e) =>
                  set(
                    'prohibited',
                    p.prohibited.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            severity: e.target.value as 'block' | 'review',
                          }
                        : x,
                    ),
                  )
                }
              >
                <option value="block">Block</option>
                <option value="review">Needs review</option>
              </select>
              <Input
                aria-label="Why"
                placeholder="Why (shown to the writer and reviewer)"
                value={r.reason}
                disabled={ro}
                onChange={(e) =>
                  set(
                    'prohibited',
                    p.prohibited.map((x, j) =>
                      j === i ? { ...x, reason: e.target.value } : x,
                    ),
                  )
                }
              />
              {!ro && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove"
                  onClick={() =>
                    set(
                      'prohibited',
                      p.prohibited.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {!ro && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                set('prohibited', [
                  ...p.prohibited,
                  { id: newId(), phrase: '', severity: 'block', reason: '' },
                ])
              }
            >
              <Plus className="h-4 w-4" /> Add a word or phrase
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Disclaimers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Required disclaimers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {p.disclaimers.length === 0 && (
            <p className="text-sm text-muted-foreground">None.</p>
          )}
          {p.disclaimers.map((d, i) => {
            const upd = (patch: Partial<typeof d>) =>
              set(
                'disclaimers',
                p.disclaimers.map((x, j) => (j === i ? { ...x, ...patch } : x)),
              );
            return (
              <div key={d.id} className="space-y-2 rounded-md border p-3">
                <div className="flex gap-2">
                  <Input
                    aria-label="Disclaimer text"
                    value={d.text}
                    disabled={ro}
                    onChange={(e) => upd({ text: e.target.value })}
                  />
                  {!ro && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove disclaimer"
                      onClick={() =>
                        set(
                          'disclaimers',
                          p.disclaimers.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Required</span>
                  <select
                    aria-label="When"
                    className={select}
                    disabled={ro}
                    value={d.when}
                    onChange={(e) =>
                      upd({ when: e.target.value as typeof d.when })
                    }
                  >
                    <option value="always">always</option>
                    <option value="promotion">
                      on a promotion or giveaway
                    </option>
                    <option value="terms">when certain words appear</option>
                  </select>
                  <select
                    aria-label="If missing"
                    className={select}
                    disabled={ro}
                    value={d.severity}
                    onChange={(e) =>
                      upd({ severity: e.target.value as 'block' | 'review' })
                    }
                  >
                    <option value="block">missing blocks approval</option>
                    <option value="review">missing needs review</option>
                  </select>
                </div>
                {d.when === 'terms' && (
                  <TagInput
                    value={d.terms}
                    onChange={(terms) => upd({ terms })}
                    placeholder="Words that need it (Enter to add)"
                  />
                )}
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Formats (none = all)
                  </span>
                  <Chips
                    options={CONTENT_TYPES}
                    value={d.formats}
                    onChange={(formats) => upd({ formats })}
                    label={(t) => CONTENT_TYPE_LABELS[t]}
                    disabled={ro}
                  />
                </div>
              </div>
            );
          })}
          {!ro && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                set('disclaimers', [
                  ...p.disclaimers,
                  {
                    id: newId(),
                    text: '',
                    when: 'always',
                    terms: [],
                    formats: [],
                    severity: 'block',
                  },
                ])
              }
            >
              <Plus className="h-4 w-4" /> Add a disclaimer
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Manual review */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Always send to a person</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Toggle
            checked={p.manualReview.competitorMentions}
            disabled={ro}
            onChange={(v) =>
              set('manualReview', { ...p.manualReview, competitorMentions: v })
            }
          >
            When a competitor is named
          </Toggle>
          <Toggle
            checked={p.manualReview.giveaways}
            disabled={ro}
            onChange={(v) =>
              set('manualReview', { ...p.manualReview, giveaways: v })
            }
          >
            Giveaways and contests
          </Toggle>
          <Toggle
            checked={p.manualReview.prices}
            disabled={ro}
            onChange={(v) =>
              set('manualReview', { ...p.manualReview, prices: v })
            }
          >
            When a price is stated
          </Toggle>
          <div className="space-y-1">
            <Label>These formats</Label>
            <Chips
              options={CONTENT_TYPES}
              value={p.manualReview.formats}
              onChange={(formats) =>
                set('manualReview', { ...p.manualReview, formats })
              }
              label={(t) => CONTENT_TYPE_LABELS[t]}
              disabled={ro}
            />
          </div>
          <div className="space-y-1">
            <Label>These channels</Label>
            <Chips
              options={SOCIAL_PLATFORMS}
              value={p.manualReview.channels}
              onChange={(channels) =>
                set('manualReview', { ...p.manualReview, channels })
              }
              label={(c) => PLATFORM_LABEL[c]}
              disabled={ro}
            />
          </div>
          <div className="space-y-1">
            <Label>When these words appear</Label>
            <TagInput
              value={p.manualReview.terms}
              onChange={(terms) =>
                set('manualReview', { ...p.manualReview, terms })
              }
              placeholder="e.g. award, partnership (Enter to add)"
            />
          </div>
        </CardContent>
      </Card>

      {/* CTA */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calls to action and links</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label>Calls to action you never use</Label>
            <TagInput
              value={p.cta.bannedPhrases}
              onChange={(bannedPhrases) =>
                set('cta', { ...p.cta, bannedPhrases })
              }
              placeholder="e.g. DM us (Enter to add)"
            />
          </div>
          <div className="space-y-1">
            <Label>Other domains links may go to</Label>
            <TagInput
              value={p.cta.allowedLinkDomains}
              onChange={(allowedLinkDomains) =>
                set('cta', { ...p.cta, allowedLinkDomains })
              }
              placeholder="e.g. shop.example.com (your website is always allowed)"
            />
          </div>
          <div className="space-y-1">
            <Label>Formats that must have a call to action</Label>
            <Chips
              options={CONTENT_TYPES}
              value={p.cta.requiredFor}
              onChange={(requiredFor) => set('cta', { ...p.cta, requiredFor })}
              label={(t) => CONTENT_TYPE_LABELS[t]}
              disabled={ro}
            />
          </div>
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          {customised && (
            <Button
              variant="outline"
              onClick={reset}
              loading={busy === 'reset'}
              disabled={busy !== null}
            >
              <RotateCcw className="h-4 w-4" /> Reset to defaults
            </Button>
          )}
          <Button
            onClick={save}
            loading={busy === 'save'}
            disabled={busy !== null}
          >
            Save rules
          </Button>
        </div>
      )}

      {/* Tester */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4 text-primary" /> Try the rules
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Format"
              className={select}
              value={test.type}
              onChange={(e) =>
                setTest({ ...test, type: e.target.value as ContentTypeKey })
              }
            >
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CONTENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <select
              aria-label="Channel"
              className={select}
              value={test.platform}
              onChange={(e) =>
                setTest({
                  ...test,
                  platform: e.target.value as SocialPlatformKey | '',
                })
              }
            >
              <option value="">No channel</option>
              {SOCIAL_PLATFORMS.map((c) => (
                <option key={c} value={c}>
                  {PLATFORM_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <Textarea
            aria-label="Copy to check"
            rows={4}
            placeholder="Paste some copy to see what these rules (saved or not) would flag."
            value={test.text}
            onChange={(e) => setTest({ ...test, text: e.target.value })}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={runTest}
            loading={busy === 'test'}
            disabled={busy !== null || !test.text.trim()}
          >
            Check it
          </Button>
          {report && (
            <div
              className="space-y-1.5 text-sm"
              data-testid="compliance-test-result"
            >
              <p className="font-medium">
                {report.status === 'pass'
                  ? 'Passes these rules.'
                  : report.status === 'fail'
                    ? 'Would be blocked.'
                    : 'Would need a person’s review.'}
              </p>
              <ul className="space-y-1">
                {report.findings.map((f) => (
                  <li key={f.ruleId} className="text-xs">
                    <span
                      className={cn(
                        'font-medium',
                        f.outcome === 'fail'
                          ? 'text-destructive'
                          : f.outcome === 'review'
                            ? 'text-amber-600'
                            : 'text-muted-foreground',
                      )}
                    >
                      {f.outcome === 'fail'
                        ? 'Blocks'
                        : f.outcome === 'review'
                          ? 'Review'
                          : 'Advice'}{' '}
                      · {CATEGORY_LABEL[f.category]}
                    </span>{' '}
                    {f.message}
                    {f.fix && (
                      <span className="block text-muted-foreground">
                        {f.fix}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
