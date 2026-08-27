'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, Mail, X, Copy, AlertTriangle, Check } from 'lucide-react';
import { toast } from '@/components/ui/toaster';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials } from '@/lib/utils';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface TeamMemberView {
  userId: string;
  role: Role;
  name: string | null;
  email: string;
  image: string | null;
}
export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  /** Real outcome of the invitation email - never assume it was delivered. */
  emailStatus: 'PENDING' | 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
  emailTransport: string | null;
  emailError: string | null;
  emailSentAt: string | null;
}

interface InviteResponse {
  email: string;
  acceptUrl: string;
  emailStatus: 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
  emailTransport: string;
  emailError?: string;
}

const DELIVERY_LABEL: Record<InvitationView['emailStatus'], string> = {
  PENDING: 'Email queued',
  SENT: 'Email delivered',
  FAILED: 'Email failed',
  NOT_CONFIGURED: 'Email not sent',
};

function deliveryVariant(
  status: InvitationView['emailStatus'],
): 'success' | 'destructive' | 'warning' | 'muted' {
  if (status === 'SENT') return 'success';
  if (status === 'FAILED') return 'destructive';
  if (status === 'NOT_CONFIGURED') return 'warning';
  return 'muted';
}

/** Copy-to-clipboard button with a confirmation tick. */
function CopyLinkButton({
  url,
  label = 'Copy invite link',
}: {
  url: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          toast.success('Invite link copied.');
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error('Could not copy - select the link and copy it manually.');
        }
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {label}
    </Button>
  );
}

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};
const ROLE_HELP =
  'Owner: full control + billing · Admin: manage team, settings & approvals · Member: create & draft · Viewer: read-only';
const ROLE_TOOLTIP: Record<Role, string> = {
  OWNER: 'Full control, including billing and deleting the workspace.',
  ADMIN: 'Manage team, settings, and approve content/outreach. No billing.',
  MEMBER: 'Create and draft content, leads, and outreach. Cannot approve or manage team.',
  VIEWER: 'Read-only access. Cannot create, approve, or change anything.',
};

export function TeamManager({
  members,
  invitations,
  currentUserId,
  currentUserRole,
  canManage,
}: {
  members: TeamMemberView[];
  invitations: InvitationView[];
  currentUserId: string;
  currentUserRole: Role;
  canManage: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Accept links from invites sent in this session, keyed by email. */
  const [links, setLinks] = useState<Record<string, string>>({});

  const isOwner = currentUserRole === 'OWNER';

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    try {
      const res = await fetch('/api/team/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const body = (await res.json().catch(() => ({}))) as InviteResponse & {
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not send the invite.');
        return;
      }
      reportDelivery(body);
      setEmail('');
      setRole('MEMBER');
      router.refresh();
    } finally {
      setInviting(false);
    }
  }

  async function resend(inv: InvitationView) {
    setBusyId(inv.id);
    try {
      const res = await fetch('/api/team/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inv.email, role: inv.role }),
      });
      const body = (await res.json().catch(() => ({}))) as InviteResponse & {
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not resend the invite.');
        return;
      }
      reportDelivery(body);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Tell the admin what really happened. A fresh accept link is always kept so
   * a mail-provider problem never blocks getting a teammate into the workspace.
   */
  function reportDelivery(body: InviteResponse) {
    if (body.acceptUrl) {
      setLinks((prev) => ({ ...prev, [body.email]: body.acceptUrl }));
    }
    if (body.emailStatus === 'SENT') {
      toast.success(
        `Invitation emailed to ${body.email} via ${body.emailTransport}.`,
      );
      return;
    }
    if (body.emailStatus === 'NOT_CONFIGURED') {
      toast.error(
        `No email provider is configured, so nothing was emailed. Copy the invite link for ${body.email} below.`,
      );
      return;
    }
    toast.error(
      `The email provider rejected the message${
        body.emailError ? `: ${body.emailError}` : ''
      }. Copy the invite link below instead.`,
    );
  }

  async function revoke(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/team/invitations/${id}`, { method: 'DELETE' });
      if (!res.ok) return toast.error('Could not revoke the invite.');
      toast.success('Invitation revoked.');
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(userId: string, newRole: Role) {
    setBusyId(userId);
    try {
      const res = await fetch(`/api/team/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return toast.error(body.error ?? 'Could not change role.');
      toast.success('Role updated.');
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(userId: string) {
    setBusyId(userId);
    try {
      const res = await fetch(`/api/team/members/${userId}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return toast.error(body.error ?? 'Could not remove member.');
      toast.success('Member removed.');
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team members</CardTitle>
        <CardDescription>
          Invite teammates and control what they can do. {ROLE_HELP}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {canManage && (
          <form onSubmit={invite} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="VIEWER">Viewer</option>
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
                {isOwner && <option value="OWNER">Owner</option>}
              </select>
            </div>
            <Button type="submit" loading={inviting}>
              <UserPlus className="h-4 w-4" /> Invite
            </Button>
          </form>
        )}

        {/* Pending invitations */}
        {invitations.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Pending invitations
            </p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {invitations.map((inv) => {
                const expired = new Date(inv.expiresAt).getTime() < Date.now();
                const link = links[inv.email];
                const undelivered =
                  inv.emailStatus === 'FAILED' ||
                  inv.emailStatus === 'NOT_CONFIGURED';
                return (
                  <li key={inv.id} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-foreground">{inv.email}</span>
                        <Badge variant="secondary">{ROLE_LABEL[inv.role]}</Badge>
                        <Badge variant={expired ? 'warning' : 'muted'}>
                          {expired ? 'Expired' : 'Pending'}
                        </Badge>
                        {/* The delivery truth - separate from the invite's own status. */}
                        <Badge
                          variant={deliveryVariant(inv.emailStatus)}
                          title={
                            inv.emailError ??
                            (inv.emailSentAt
                              ? `Accepted by ${inv.emailTransport ?? 'the provider'} at ${new Date(
                                  inv.emailSentAt,
                                ).toLocaleString()}`
                              : undefined)
                          }
                        >
                          {DELIVERY_LABEL[inv.emailStatus]}
                        </Badge>
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 flex-wrap gap-1">
                          {link && <CopyLinkButton url={link} />}
                          {/* When mail did not go out, sharing the link IS the
                              way in — so it leads, and says what it does.
                              Invite tokens are stored hashed, so the link can
                              only be produced by issuing a fresh one; the
                              button name reflects that rather than implying we
                              are re-sending something we still hold. */}
                          <Button
                            variant={undelivered && !link ? 'default' : 'outline'}
                            size="sm"
                            loading={busyId === inv.id}
                            onClick={() => resend(inv)}
                          >
                            {undelivered
                              ? link
                                ? 'New link'
                                : 'Get invite link'
                              : 'Resend'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busyId === inv.id}
                            onClick={() => revoke(inv.id)}
                          >
                            <X className="h-4 w-4" /> Revoke
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Why it did not arrive + the manual way in. */}
                    {undelivered && (
                      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          {inv.emailStatus === 'NOT_CONFIGURED'
                            ? 'No email provider is configured, so this invite was never emailed.'
                            : `The email provider rejected it${
                                inv.emailError ? `: ${inv.emailError}` : ''
                              }.`}{' '}
                          {link
                            ? 'Use \u201CCopy invite link\u201D and send it yourself.'
                            : 'Press \u201CResend\u201D to generate a shareable invite link.'}
                        </span>
                      </p>
                    )}

                    {link && (
                      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                        {link}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Members */}
        <ul className="divide-y divide-border">
          {members.map((m) => {
            const display = m.name || m.email;
            const isSelf = m.userId === currentUserId;
            // Owners can manage anyone; admins can manage non-owners; nobody edits themselves here.
            const canEditThis =
              canManage &&
              !isSelf &&
              (currentUserRole === 'OWNER' || m.role !== 'OWNER');
            return (
              <li key={m.userId} className="flex items-center justify-between gap-3 py-3 first:pt-0">
                <div className="flex items-center gap-3">
                  <Avatar>
                    {m.image && <AvatarImage src={m.image} alt="" />}
                    <AvatarFallback>{getInitials(display)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {display}
                      {isSelf && (
                        <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </div>
                </div>

                {canEditThis ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={m.role}
                      disabled={busyId === m.userId}
                      onChange={(e) => changeRole(m.userId, e.target.value as Role)}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="VIEWER">Viewer</option>
                      <option value="MEMBER">Member</option>
                      <option value="ADMIN">Admin</option>
                      {currentUserRole === 'OWNER' && <option value="OWNER">Owner</option>}
                    </select>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyId === m.userId}
                      onClick={() => remove(m.userId)}
                      className="text-destructive hover:text-destructive"
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Badge
                    variant={m.role === 'OWNER' ? 'default' : 'secondary'}
                    title={ROLE_TOOLTIP[m.role]}
                  >
                    {ROLE_LABEL[m.role]}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
