import { z } from 'zod';

import { db } from '@/lib/db';
import { countTasks, deriveCampaignState } from '@/lib/campaign-status';
import { CONTENT_STATUS_LABELS, CONTENT_TYPE_LABELS, draftSnippet } from '@/lib/content-ui';
import { OPPORTUNITY_TYPE_INFO } from '@/lib/opportunities';
import { ROLE_LABEL, REPLY_IDS } from '@/lib/whatsapp-link';
import { bold, clip, numbered, openInAura, plain, plural, relativeDay } from '@/lib/whatsapp-format';
import type { ContentTypeKey } from '@/lib/validations/content';
import { tokenHealth } from '@/lib/meta';
import { getAnalytics } from '@/server/analytics/analytics.service';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { listCampaigns } from '@/server/campaigns/campaign.service';
import { listConnections } from '@/server/connectors/connection.service';
import { listDrafts } from '@/server/content/content.service';
import { getAuraHome } from '@/server/home/home.service';
import { listOpportunities } from '@/server/opportunities/opportunity.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';
import { listReviewQueue } from '@/server/review/review-item.service';
import { getLinkedInStatus } from '@/server/services/linkedin.service';
import { text, type Tool } from '@/server/whatsapp/tools/types';

/**
 * Read-only tools: each calls the existing Aura service with the workspace
 * from the session and formats what it returns. Open to every role — the same
 * as the dashboard pages they mirror — because they change nothing.
 */

const none = z.object({}).strict();
const typeLabel = (t: string) => CONTENT_TYPE_LABELS[t as ContentTypeKey] ?? t;

export const homeTool: Tool<typeof none> = {
  id: 'home',
  category: 'dashboard',
  label: 'Dashboard',
  description: 'Overview: what matters now, what is waiting on you, top suggestions and results.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const home = await getAuraHome(ctx.companyId);
    const lines: string[] = [`${bold(ctx.companyName)} — today`];
    if (home.whatMatters?.summary) lines.push('', plain(home.whatMatters.summary));
    if (home.waiting.length) {
      lines.push('', bold('Waiting on you'), numbered(home.waiting.slice(0, 4).map((w) => `${plain(w.title)} — ${plain(w.action)}`)));
    }
    if (home.suggestions.length) {
      lines.push('', bold(`Aura suggests (${home.suggestionCount})`), numbered(home.suggestions.slice(0, 3).map((s) => clip(plain(s.what), 90))));
    }
    if (home.opportunities.length) {
      lines.push('', bold(`Opportunities (${home.opportunityCount})`), numbered(home.opportunities.slice(0, 3).map((o) => clip(plain(o.title), 90))));
    }
    if (home.results?.length) {
      lines.push('', bold('Results'), home.results.slice(0, 3).map((r) => `• ${plain(r.label)}: ${plain(r.value)}${r.change ? ` (${plain(r.change.text)})` : ''}`).join('\n'));
    }
    if (lines.length === 1) lines.push('', 'Nothing needs you right now.');
    lines.push('', openInAura('/dashboard'));
    return { contents: [text(lines.join('\n'))] };
  },
};

export const opportunitiesTool: Tool<typeof none> = {
  id: 'opportunities',
  category: 'opportunities',
  label: 'Opportunities',
  description: 'The latest marketing opportunities Aura has detected, highest priority first.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const rows = await listOpportunities(ctx.companyId, { status: ['DETECTED', 'REVIEWED', 'RECOMMENDED'], limit: 5 });
    if (!rows.length) {
      return { contents: [text(`No open opportunities in ${bold(ctx.companyName)} right now. Aura keeps watching your market and competitors.\n\n${openInAura('/dashboard/opportunities')}`)] };
    }
    const items = rows.map((o) => {
      const label = OPPORTUNITY_TYPE_INFO[o.type]?.label ?? o.type;
      const closes = o.relevantUntil ? ` · closes ${relativeDay(o.relevantUntil)}` : '';
      return `${bold(clip(o.title, 80))}\n   ${label} · ${o.priority.toLowerCase()} priority${closes}\n   ${clip(plain(o.summary), 140)}`;
    });
    return {
      contents: [text(`${bold('Latest opportunities')} — ${plain(ctx.companyName)}\n\n${numbered(items)}\n\n${openInAura('/dashboard/opportunities')}`)],
    };
  },
};

export const suggestionsTool: Tool<typeof none> = {
  id: 'suggestions',
  category: 'suggestions',
  label: 'Aura suggests',
  description: 'Recommendations Aura has generated: what to do next and why.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const { suggestions } = await getSuggestions(ctx.companyId, { limit: 5 });
    if (!suggestions.length) {
      return { contents: [text(`No suggestions waiting in ${bold(ctx.companyName)} right now.\n\n${openInAura('/dashboard/suggestions')}`)] };
    }
    const items = suggestions.map(
      (s) => `${bold(clip(s.what, 90))}${s.timing ? ` — ${plain(s.timing)}` : ''}\n   ${clip(plain(s.why), 150)}`,
    );
    return {
      contents: [
        text(`${bold('Aura suggests')} — ${plain(ctx.companyName)}\n\n${numbered(items)}\n\nTo act on one, open it in Aura: ${openInAura('/dashboard/suggestions').replace('Open in Aura: ', '')}`),
      ],
    };
  },
};

export const campaignsTool: Tool<typeof none> = {
  id: 'campaigns',
  category: 'campaigns',
  label: 'Campaigns',
  description: 'Active campaigns and what each one needs.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const campaigns = await listCampaigns(ctx.companyId);
    if (!campaigns.length) {
      return { contents: [text(`No campaigns in ${bold(ctx.companyName)} yet.\n\n${openInAura('/dashboard/campaigns')}`)] };
    }
    const items = campaigns.slice(0, 6).map((c) => {
      const state = deriveCampaignState(c.status, countTasks(c.tasks));
      return `${bold(clip(c.name, 70))} — ${state.label}\n   ${clip(plain(state.summary), 140)}`;
    });
    return {
      contents: [text(`${bold('Campaigns')} — ${plain(ctx.companyName)} (${campaigns.length})\n\n${numbered(items)}\n\n${openInAura('/dashboard/campaigns')}`)],
    };
  },
};

export const approvalsTool: Tool<typeof none> = {
  id: 'approvals',
  category: 'approvals',
  label: 'Pending approvals',
  description: 'Content and outreach waiting for review or approval.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const rows = (await listReviewQueue(ctx.companyId)).filter((r) => r.state === 'in_review' || r.state === 'draft');
    if (!rows.length) {
      return { contents: [text(`Nothing is waiting for review in ${bold(ctx.companyName)}. 🎉`)] };
    }
    const content = rows.filter((r) => r.kind === 'content');
    const waiting = rows.filter((r) => r.state === 'in_review').length;
    const lead = `${plural(waiting, 'item')} waiting for approval, ${plural(rows.length - waiting, 'draft')} in progress.`;
    if (!content.length) {
      return { contents: [text(`${lead}\n\nThey are outreach messages — review them in Aura: ${openInAura('/dashboard/review').replace('Open in Aura: ', '')}`)] };
    }
    return {
      contents: [
        {
          kind: 'list',
          body: `${bold('Review & approve')} — ${plain(ctx.companyName)}\n\n${lead} Pick one to read it.`,
          button: 'Choose an item',
          sections: [
            {
              rows: content.slice(0, 10).map((r) => ({
                id: `draft:${r.id}`,
                title: clip(r.title || r.typeLabel, 24),
                description: `${r.typeLabel} · ${r.state === 'in_review' ? 'awaiting approval' : 'draft'}${r.verdict && r.verdict !== 'pass' ? ' · needs a look' : ''}`,
              })),
            },
          ],
        },
      ],
    };
  },
};

export const draftsTool: Tool<typeof none> = {
  id: 'drafts',
  category: 'content',
  label: 'Recent drafts',
  description: 'Your latest content drafts in Content Studio.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const drafts = (await listDrafts(ctx.companyId)).slice(0, 10);
    if (!drafts.length) {
      return { contents: [text(`No drafts in ${bold(ctx.companyName)} yet. Say “write a LinkedIn post about …” to create one.`)] };
    }
    return {
      contents: [
        {
          kind: 'list',
          body: `${bold('Recent drafts')} — ${plain(ctx.companyName)}. Pick one to read it.`,
          button: 'Choose a draft',
          sections: [
            {
              rows: drafts.map((d) => ({
                id: `draft:${d.id}`,
                title: clip(d.title || draftSnippet(d.type as ContentTypeKey, d.body) || typeLabel(d.type), 24),
                description: `${typeLabel(d.type)} · ${CONTENT_STATUS_LABELS[d.status]}`,
              })),
            },
          ],
        },
      ],
    };
  },
};

export const calendarTool: Tool<typeof none> = {
  id: 'calendar',
  category: 'calendar',
  label: 'Content calendar',
  description: 'What is scheduled to publish in the next two weeks.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const now = new Date();
    const until = new Date(now.getTime() + 14 * 86_400_000);
    // The same query the calendar page makes, for the next fortnight.
    const scheduled = await db.contentDraft.findMany({
      where: { companyId: ctx.companyId, scheduledFor: { gte: now, lte: until }, publishedAt: null },
      orderBy: { scheduledFor: 'asc' },
      take: 10,
      select: { id: true, type: true, title: true, body: true, status: true, scheduledFor: true },
    });
    if (!scheduled.length) {
      return { contents: [text(`Nothing is scheduled in the next two weeks for ${bold(ctx.companyName)}.\n\n${openInAura('/dashboard/content/calendar')}`)] };
    }
    const items = scheduled.map(
      (d) =>
        `${bold(relativeDay(d.scheduledFor!))} — ${clip(d.title || draftSnippet(d.type as ContentTypeKey, d.body), 70)}\n   ${typeLabel(d.type)} · ${CONTENT_STATUS_LABELS[d.status]}`,
    );
    return { contents: [text(`${bold('Next two weeks')} — ${plain(ctx.companyName)}\n\n${numbered(items)}\n\n${openInAura('/dashboard/content/calendar')}`)] };
  },
};

export const analyticsTool: Tool<typeof none> = {
  id: 'analytics',
  category: 'analytics',
  label: 'Results',
  description: 'Marketing results for the last 30 days: posts, engagement, outreach, leads.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const a = await getAnalytics(ctx.companyId, 30);
    if (!a.hasData) {
      return { contents: [text(`No results to show for ${bold(ctx.companyName)} in the last 30 days yet.\n\n${openInAura('/dashboard/analytics')}`)] };
    }
    const t = a.topline;
    return {
      contents: [
        text(
          [
            `${bold('Last 30 days')} — ${plain(ctx.companyName)}`,
            '',
            `• Posts published: ${t.postsPublished}`,
            `• Engagement: ${t.totalEngagement}`,
            `• Outreach sent: ${t.outreachSent} (${t.repliesReceived} replies)`,
            `• New connections: ${t.connectionsMade}`,
            `• Leads found: ${t.leadsDiscovered}`,
            `• Campaigns run: ${t.campaignsRun}`,
            '',
            openInAura('/dashboard/analytics'),
          ].join('\n'),
        ),
      ],
    };
  },
};

export const businessTool: Tool<typeof none> = {
  id: 'business',
  category: 'business',
  label: 'Business context',
  description: 'What Aura knows about your business: what you do, who you serve, your voice.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const c = await getBusinessContext(ctx.companyId, { sections: [] });
    if (!c) return { contents: [text(`Aura doesn’t have a business profile for ${bold(ctx.companyName)} yet.\n\n${openInAura('/dashboard/business')}`)] };
    const lines = [`${bold(c.identity.name ?? ctx.companyName)}`];
    if (c.identity.industry) lines.push(`Industry: ${plain(c.identity.industry)}`);
    if (c.identity.description) lines.push('', clip(plain(c.identity.description), 400));
    if (c.identity.offerings) lines.push('', `${bold('What you offer')}\n${clip(plain(c.identity.offerings), 300)}`);
    if (c.audience.stated) lines.push('', `${bold('Who you serve')}\n${clip(plain(c.audience.stated), 250)}`);
    const tone = c.voice.profile?.toneDescriptors ?? [];
    if (tone.length) lines.push('', `${bold('Brand voice')}: ${plain(tone.slice(0, 5).join(', '))}`);
    if (c.identity.website) lines.push('', `Website: ${c.identity.website}`);
    lines.push('', `To change any of this: ${openInAura('/dashboard/business').replace('Open in Aura: ', '')}`);
    return { contents: [text(lines.join('\n'))] };
  },
};

export const connectionsTool: Tool<typeof none> = {
  id: 'connections',
  category: 'connections',
  label: 'Connected accounts',
  description: 'Which social accounts and tools are connected (LinkedIn, Facebook, Instagram, …).',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const [linkedin, connections] = await Promise.all([getLinkedInStatus(ctx.companyId), listConnections(ctx.companyId)]);
    const meta = connections.find((c) => c.connectorId === 'meta');
    const others = connections.filter((c) => c.connectorId !== 'meta');
    const line = (name: string, ok: boolean, detail: string | null) => `${ok ? '✅' : '⚪'} ${name}${detail ? ` — ${plain(detail)}` : ok ? '' : ' — not connected'}`;
    const lines = [
      `${bold('Connected accounts')} — ${plain(ctx.companyName)}`,
      '',
      line('LinkedIn', linkedin.connected, linkedin.connected ? linkedin.displayName : linkedin.status === 'EXPIRED' ? 'expired, reconnect' : null),
      line(
        'Facebook & Instagram',
        meta?.status === 'CONNECTED' && tokenHealth(meta.expiresAt ? new Date(meta.expiresAt) : null) !== 'expired',
        meta
          ? meta.status === 'CONNECTED'
            ? {
                ok: meta.accountLabel,
                expiring: `${meta.accountLabel ?? 'connected'} — expires soon, reconnect`,
                expired: 'expired, reconnect',
              }[tokenHealth(meta.expiresAt ? new Date(meta.expiresAt) : null)]
            : `${meta.status.toLowerCase()}, reconnect`
          : null,
      ),
      ...others.map((c) => line(c.connectorId, c.status === 'CONNECTED', c.accountLabel)),
      '',
      'Say “connect LinkedIn” or “connect Facebook” to connect one.',
    ];
    return { contents: [text(lines.join('\n'))] };
  },
};

export const accountTool: Tool<typeof none> = {
  id: 'account',
  category: 'account',
  label: 'Account',
  description: 'Who you are signed in as, your workspace and role; switch workspace or log out.',
  permission: null,
  inMenu: true,
  args: none,
  async run(ctx) {
    const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    return {
      contents: [
        {
          kind: 'buttons',
          body: `Signed in as ${plain(user?.email ?? 'your Aura account')}.\nWorkspace: ${bold(ctx.companyName)} (${ROLE_LABEL[ctx.role] ?? ctx.role}).\n\nAccount settings are changed in Aura: ${openInAura('/dashboard/settings').replace('Open in Aura: ', '')}`,
          buttons: [
            { id: REPLY_IDS.switchWorkspace, title: 'Switch workspace' },
            { id: REPLY_IDS.logout, title: 'Log out' },
          ],
        },
      ],
    };
  },
};

export const READ_TOOLS = [
  homeTool,
  draftsTool,
  campaignsTool,
  opportunitiesTool,
  suggestionsTool,
  businessTool,
  calendarTool,
  approvalsTool,
  analyticsTool,
  connectionsTool,
  accountTool,
];
