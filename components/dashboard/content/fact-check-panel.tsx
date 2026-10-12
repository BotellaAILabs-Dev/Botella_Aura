import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  ShieldAlert,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type {
  CheckedClaim,
  ClaimStatus,
  FactCheckReport,
} from '@/lib/fact-check';

/**
 * The fact check on a draft (lib/fact-check.ts): every claim it makes, checked
 * against the business's trusted details and evidence — and what needs a
 * person's review before it is approved.
 */
const STATUS: Record<
  FactCheckReport['status'],
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'muted' }
> = {
  verified: { label: 'Fact-checked', variant: 'success' },
  needs_review: { label: 'Needs review', variant: 'warning' },
  contradicted: { label: 'Contradiction', variant: 'destructive' },
  nothing_to_check: { label: 'No claims to check', variant: 'muted' },
};

const CLAIM: Record<
  ClaimStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  contradicted: {
    label: 'Contradicts',
    icon: XCircle,
    className: 'text-destructive',
  },
  unsupported: {
    label: 'Unsupported',
    icon: ShieldAlert,
    className: 'text-destructive',
  },
  unverified: {
    label: 'Unconfirmed',
    icon: HelpCircle,
    className: 'text-amber-600',
  },
  outdated: {
    label: 'Possibly outdated',
    icon: Clock,
    className: 'text-amber-600',
  },
  supported: {
    label: 'Supported',
    icon: CheckCircle2,
    className: 'text-primary',
  },
};

const ORDER: ClaimStatus[] = [
  'contradicted',
  'unsupported',
  'unverified',
  'outdated',
  'supported',
];

const KIND_LABEL: Record<string, string> = {
  business_profile: 'business profile',
  evidence: 'evidence',
  knowledge: 'your documents',
  brief: 'your brief',
  assumption: 'unconfirmed details',
};

function ClaimRow({ c }: { c: CheckedClaim }) {
  const s = CLAIM[c.status];
  const Icon = s.icon;
  return (
    <li className="flex gap-2 text-xs">
      <Icon
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${s.className}`}
        aria-label={s.label}
      />
      <span className="min-w-0">
        <span className="text-foreground">“{c.text}”</span>{' '}
        <span className={`font-medium ${s.className}`}>
          {s.label}
          {c.mustFix && c.status !== 'contradicted' ? ' — must fix' : ''}.
        </span>{' '}
        <span className="text-muted-foreground">{c.reason}</span>
      </span>
    </li>
  );
}

export function FactCheckPanel({ report: r }: { report: FactCheckReport }) {
  const status = STATUS[r.status];
  const sorted = [...r.claims].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const flagged = sorted.filter((c) => c.status !== 'supported');
  const supported = sorted.filter((c) => c.status === 'supported');
  const against = r.checkedAgainst
    .map((k) => `${k.count} ${KIND_LABEL[k.kind] ?? k.kind}`)
    .join(' · ');

  return (
    <Card
      className={
        r.status === 'contradicted'
          ? 'border-destructive/40'
          : r.status === 'needs_review'
            ? 'border-amber-300/60'
            : ''
      }
    >
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-primary" aria-hidden />
          <span className="font-medium text-foreground">Fact check</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {r.claims.length} claim{r.claims.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {r.status === 'verified'
            ? 'Every claim matches your business details or evidence.'
            : r.status === 'nothing_to_check'
              ? 'No factual claims — nothing to verify.'
              : r.status === 'contradicted'
                ? 'A claim says something different from what Aura knows. Fix it before approving.'
                : 'Some claims could not be verified. Check them before this is approved — they are not presented as verified.'}
          {against
            ? ` Checked against: ${against}.`
            : ' There were no trusted details to check against.'}
        </p>
        {flagged.length > 0 && (
          <ul className="space-y-1.5">
            {flagged.map((c) => (
              <ClaimRow key={c.text} c={c} />
            ))}
          </ul>
        )}
        {supported.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {supported.length} supported claim
              {supported.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-1.5 space-y-1.5">
              {supported.map((c) => (
                <ClaimRow key={c.text} c={c} />
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
