import type { Metadata } from 'next';
import { CheckCircle2, MessageCircle, TriangleAlert } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { getWhatsAppDashboard } from '@/server/whatsapp/dashboard.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LocalTime } from '@/components/ui/local-time';
import { MessageMemberButton, UnlinkButton, WhatsAppToggle } from '@/components/whatsapp/assistant-controls';

export const metadata: Metadata = { title: 'WhatsApp assistant' };
export const dynamic = 'force-dynamic';

const STATE_LABEL: Record<string, string> = { active: 'Active', expired: 'Signed out (expired)', revoked: 'Unlinked' };

export default async function WhatsAppAssistantPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const membership = await getMembership(user.id, active.id);
  if (!membership) return null;

  const data = await getWhatsAppDashboard({ companyId: active.id, userId: user.id, role: membership.role });
  const { integration, team } = data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp assistant"
        description="Use Aura from WhatsApp: check drafts, approve, write posts and publish — every action still needs your yes."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="h-4 w-4" /> Status
          </CardTitle>
          <CardDescription>
            One Aura number serves every workspace. Each person signs in from WhatsApp and confirms here on the website.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {integration.configured ? (
            <p className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Connected to the WhatsApp Business Platform
              {integration.displayNumber ? <> — message <span className="font-medium">{integration.displayNumber}</span></> : null}.
            </p>
          ) : (
            <p className="flex items-start gap-2 text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Not set up on this server yet. Missing: {integration.missing.join(', ')}. See docs/WHATSAPP-ASSISTANT.md.
              </span>
            </p>
          )}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div>
              <p className="font-medium">
                WhatsApp for {active.name}{' '}
                <Badge variant={data.enabled ? 'success' : 'muted'}>{data.enabled ? 'On' : 'Off'}</Badge>
              </p>
              <p className="text-muted-foreground">
                {data.enabled
                  ? 'Members can choose this workspace on WhatsApp. What each person can do follows their role here.'
                  : 'This workspace is not offered on WhatsApp.'}
              </p>
            </div>
            {data.canManage ? <WhatsAppToggle enabled={data.enabled} /> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Message text is kept for {integration.retentionDays} days, then deleted.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your linked numbers</CardTitle>
          <CardDescription>
            To link a number, message the Aura number on WhatsApp and follow the sign-in link it sends you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.myLinks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No numbers linked to your account.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {data.myLinks.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="font-medium">
                      •••• {l.last4} {l.profileName ? <span className="text-muted-foreground">({l.profileName})</span> : null}{' '}
                      <Badge variant={l.state === 'active' ? 'success' : 'muted'}>{STATE_LABEL[l.state] ?? l.state}</Badge>
                    </p>
                    <p className="text-muted-foreground">
                      Working in {l.workspace ?? 'no workspace chosen'} · last used <LocalTime iso={l.lastUsedAt} />
                    </p>
                  </div>
                  <UnlinkButton id={l.id} last4={l.last4} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {team ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">This workspace — last 7 days</CardTitle>
              <CardDescription>Only messages handled for {active.name}. Visible to owners and admins.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-2xl font-semibold">{team.week.inbound}</p>
                <p className="text-muted-foreground">messages received</p>
              </div>
              <div>
                <p className="text-2xl font-semibold">{team.week.outbound}</p>
                <p className="text-muted-foreground">replies sent</p>
              </div>
              <div className="space-y-1">
                {Object.entries(team.week.byStatus).map(([status, n]) => (
                  <p key={status} className="text-muted-foreground">
                    {status.toLowerCase()}: <span className="text-foreground">{n}</span>
                  </p>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Members using WhatsApp here</CardTitle>
            </CardHeader>
            <CardContent>
              {team.linked.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody is using this workspace on WhatsApp.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {team.linked.map((m) => (
                    <li key={`${m.email}-${m.last4}`} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{m.name || m.email}</span>{' '}
                        <span className="text-muted-foreground">· {m.role.toLowerCase()} · •••• {m.last4}</span>
                      </span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {STATE_LABEL[m.state] ?? m.state} · <LocalTime iso={m.lastUsedAt} />
                        {m.state === 'active' && integration.configured ? (
                          <MessageMemberButton userId={m.userId} name={m.name || m.email} />
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {team.failures.length || team.deadJobs.length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Problems (last 7 days)</CardTitle>
                <CardDescription>Replies WhatsApp did not deliver, and messages Aura could not handle.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {team.failures.map((f, i) => (
                  <p key={`f${i}`}>
                    <LocalTime iso={f.at} /> — not delivered{f.code ? ` (${f.code})` : ''}: {f.message ?? 'unknown error'}
                  </p>
                ))}
                {team.deadJobs.map((j, i) => (
                  <p key={`d${i}`}>
                    <LocalTime iso={j.at} /> — not handled: {j.error ?? 'unknown error'}
                  </p>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent conversations</CardTitle>
              <CardDescription>The latest messages handled for this workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {team.conversations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No conversations yet.</p>
              ) : (
                team.conversations.map((c, i) => (
                  <details key={i} className="rounded-lg border border-border p-3 text-sm">
                    <summary className="cursor-pointer">
                      <span className="font-medium">{c.who}</span>{' '}
                      <span className="text-muted-foreground">
                        · •••• {c.last4} · <LocalTime iso={c.lastAt} />
                      </span>
                    </summary>
                    <ul className="mt-3 space-y-2">
                      {c.messages.map((m, j) => (
                        <li key={j} className={m.direction === 'INBOUND' ? '' : 'pl-6'}>
                          <p className="text-xs text-muted-foreground">
                            {m.direction === 'INBOUND' ? 'Them' : 'Aura'} · <LocalTime iso={m.at} />
                            {m.direction === 'OUTBOUND' ? ` · ${m.status.toLowerCase()}` : ''}
                          </p>
                          <p className="whitespace-pre-wrap break-words">{m.body || '(no text)'}</p>
                          {m.error ? <p className="text-xs text-destructive">{m.error}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
