'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, Mail, X } from 'lucide-react';
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

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

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
}

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};
const ROLE_HELP =
  'Owner: full control + billing · Admin: manage team, settings & approvals · Member: create & draft';

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
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not send the invite.');
        return;
      }
      toast.success(`Invitation sent to ${email}.`);
      setEmail('');
      setRole('MEMBER');
      router.refresh();
    } finally {
      setInviting(false);
    }
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
              {invitations.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium text-foreground">{inv.email}</span>
                    <Badge variant="secondary">{ROLE_LABEL[inv.role]}</Badge>
                  </div>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyId === inv.id}
                      onClick={() => revoke(inv.id)}
                    >
                      <X className="h-4 w-4" /> Revoke
                    </Button>
                  )}
                </li>
              ))}
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
                  <Badge variant={m.role === 'OWNER' ? 'default' : 'secondary'}>
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
