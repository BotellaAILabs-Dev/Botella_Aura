import type { OutreachType } from '@prisma/client';

import { db } from '@/lib/db';
import { CATEGORY_LABEL, checkCompliance } from '@/lib/compliance-policy';
import type { ReviewFlag } from '@/lib/review-item';
import { getPolicyContext } from '@/server/content/compliance.service';

/**
 * Quality and compliance checks for an outreach message — the same workspace
 * rules as Content Studio (lib/compliance-policy.ts), plus LinkedIn's limits.
 * Shown in the unified review and enforced when a message is approved.
 */

export const CONNECTION_NOTE_LIMIT = 300;
const PLACEHOLDER =
  /\[(?:name|first name|company|insert|your)[^\]]*\]|\{\{[^}]+\}\}/i;

export async function checkOutreachMessage(msg: {
  companyId: string;
  type: OutreachType;
  draftText: string;
}): Promise<ReviewFlag[]> {
  const flags: ReviewFlag[] = [];
  const text = msg.draftText.trim();
  if (!text) {
    flags.push({
      severity: 'block',
      label: 'Completeness',
      message: 'The message is empty.',
      source: 'rules',
    });
  }
  if (msg.type === 'CONNECTION_NOTE' && text.length > CONNECTION_NOTE_LIMIT) {
    flags.push({
      severity: 'block',
      label: 'Channel',
      message: `LinkedIn connection notes are limited to ${CONNECTION_NOTE_LIMIT} characters — this one is ${text.length}.`,
      source: 'rules',
    });
  }
  const ph = text.match(PLACEHOLDER);
  if (ph) {
    flags.push({
      severity: 'block',
      label: 'Completeness',
      message: `Replace the placeholder “${ph[0]}” before it is sent.`,
      quote: ph[0],
      source: 'rules',
    });
  }

  const [policy, competitors] = await Promise.all([
    getPolicyContext(msg.companyId),
    db.competitorProfile.findMany({
      where: { companyId: msg.companyId },
      select: { name: true },
    }),
  ]);
  const report = checkCompliance({
    type: 'LINKEDIN_POST',
    // A direct message: the networks' post rules (engagement bait, giveaway
    // wording) do not apply.
    platform: null,
    text,
    cta: '',
    policy: policy.policy,
    alcohol: policy.alcohol,
    website: policy.website,
    competitors: competitors.map((c) => c.name),
    rules: [],
    claims: null,
  });
  for (const f of report.findings) {
    // Post-format rules are not about messages.
    if (
      f.ruleId === 'workspace.cta.required' ||
      f.ruleId.startsWith('workspace.review.format.')
    )
      continue;
    flags.push({
      severity:
        f.outcome === 'fail'
          ? 'block'
          : f.outcome === 'review'
            ? 'review'
            : 'info',
      label: CATEGORY_LABEL[f.category],
      message: f.message,
      quote: f.quote,
      source: f.source === 'workspace' ? 'your rules' : 'built-in rules',
    });
  }
  const order = { block: 0, review: 1, info: 2 } as const;
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}
