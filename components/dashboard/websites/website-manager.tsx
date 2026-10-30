'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ExternalLink, Globe, Plug, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { ConnectionBadge } from '@/components/dashboard/websites/status-badges';
import { SEO_FIELD_LABELS, type SeoField, type WebsiteConnectionState, type WebsitePlatform } from '@/lib/website-platforms';
import { describeSlots, WEEKDAY_SHORT } from '@/lib/website-schedule';

interface Website {
  id: string;
  platform: string;
  platformName: string;
  name: string;
  siteUrl: string;
  state: WebsiteConnectionState;
  accountLabel: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  capabilities: Record<string, unknown>;
}

type Platform = WebsitePlatform & { connectable: boolean; oauthConfigured?: boolean };

interface Data {
  websites: Website[];
  platforms: Platform[];
  canManage: boolean;
  canPublish: boolean;
}

const SUPPORT_LABEL = { native: 'Yes', plugin: 'With SEO plugin', fallback: 'Closest option', none: 'No' } as const;

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  return { ok: res.ok, data };
}

/**
 * Settings → Website publishing: connect sites, see their state, test,
 * reconnect, disconnect, and set each one's auto-publish schedule.
 */
export function WebsiteManager() {
  const [data, setData] = useState<Data | null>(null);
  const [connecting, setConnecting] = useState<{ platform: Platform; siteUrl?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/websites');
    if (r.ok) setData((await r.json()) as Data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <p className="text-sm text-muted-foreground">Loading websites…</p>;

  async function test(w: Website) {
    setBusy(w.id);
    const r = await send(`/api/websites/${w.id}/test`, 'POST');
    setBusy(null);
    if (r.data.ok) toast.success(`${w.name} is connected and working.`);
    else toast.error(String(r.data.error ?? 'The site could not be reached.'));
    await load();
  }

  async function disconnect(w: Website) {
    if (!window.confirm(`Disconnect ${w.name}? Aura’s access is withdrawn and scheduled blogs for it are cancelled. Publishing history is kept.`)) return;
    setBusy(w.id);
    const r = await send(`/api/websites/${w.id}`, 'DELETE');
    setBusy(null);
    if (!r.ok) return toast.error(String(r.data.error ?? 'Could not disconnect.'));
    const revoked = r.data.revokedAtPlatform
      ? 'Access was revoked on the site too.'
      : w.platform === 'wordpress'
        ? 'Also revoke the Application Password in WordPress (Users → Profile) if it is still listed.'
        : '';
    toast.success(`${w.name} disconnected. ${revoked}`);
    await load();
  }

  const byId = (id: string) => data.platforms.find((p) => p.id === id);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" /> Connected websites
          </CardTitle>
          <CardDescription>
            Approved blogs publish straight to these sites — as a live post, a draft, or on a schedule. Connect as many as you run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.websites.length === 0 && (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              No websites connected yet. Choose your platform below to connect one.
            </p>
          )}
          {data.websites.map((w) => (
            <div key={w.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: byId(w.platform)?.color }} aria-hidden />
                    {w.name}
                    <span className="text-xs font-normal text-muted-foreground">{w.platformName}</span>
                    <ConnectionBadge state={w.state} />
                  </p>
                  <a href={w.siteUrl} target="_blank" rel="noreferrer noopener" className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    {w.siteUrl.replace(/^https?:\/\//, '')} <ExternalLink className="h-3 w-3" />
                  </a>
                  {w.accountLabel && <p className="text-xs text-muted-foreground">As {w.accountLabel}</p>}
                  {w.lastError && w.state !== 'connected' && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-foreground">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" /> {w.lastError}
                    </p>
                  )}
                </div>
                {data.canManage && (
                  <div className="flex flex-wrap gap-1.5">
                    {w.state === 'reauth' || w.state === 'error' ? (
                      <Button size="sm" onClick={() => byId(w.platform) && setConnecting({ platform: byId(w.platform)!, siteUrl: w.siteUrl })}>
                        <Plug className="h-3.5 w-3.5" /> Reconnect
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" loading={busy === w.id} onClick={() => test(w)}>
                      <RefreshCw className="h-3.5 w-3.5" /> Test
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setScheduleFor(scheduleFor === w.id ? null : w.id)}>
                      <CalendarClock className="h-3.5 w-3.5" /> Auto-publish
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === w.id} onClick={() => disconnect(w)} aria-label={`Disconnect ${w.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
              {scheduleFor === w.id && <ScheduleEditor website={w} canEdit={data.canPublish} />}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect a website</CardTitle>
          <CardDescription>Aura uses each platform’s official API. Passwords and keys are encrypted and never shown again.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {data.platforms.map((p) => (
            <div key={p.id} className="flex flex-col rounded-md border border-border p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.color }} aria-hidden />
                {p.name}
                {p.status === 'planned' && <Badge variant="muted">Planned</Badge>}
                {p.status === 'no_api' && <Badge variant="muted">No publishing API</Badge>}
              </p>
              <p className="mt-1 flex-1 text-xs text-muted-foreground">{p.status === 'no_api' ? p.limitations[0] : p.description}</p>
              {p.status === 'no_api' && <p className="mt-1 text-xs text-foreground">{p.limitations[1]}</p>}
              {p.connectable && data.canManage && (
                <Button size="sm" variant="outline" className="mt-2 self-start" onClick={() => setConnecting({ platform: p })}>
                  <Plug className="h-3.5 w-3.5" /> Connect {p.name}
                </Button>
              )}
            </div>
          ))}
          {!data.canManage && <p className="text-xs text-muted-foreground sm:col-span-2">Only owners and admins can connect websites.</p>}
        </CardContent>
      </Card>

      {connecting && (
        <ConnectDialog
          platform={connecting.platform}
          initialSiteUrl={connecting.siteUrl}
          onClose={() => setConnecting(null)}
          onConnected={async () => {
            setConnecting(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function ConnectDialog({
  platform,
  initialSiteUrl,
  onClose,
  onConnected,
}: {
  platform: Platform;
  initialSiteUrl?: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const siteKey = platform.id === 'shopify' ? 'shop' : 'siteUrl';
  const [values, setValues] = useState<Record<string, string>>(
    initialSiteUrl ? { [siteKey]: platform.id === 'shopify' ? initialSiteUrl.replace(/^https?:\/\//, '') : initialSiteUrl } : {},
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauth = platform.id === 'shopify' && platform.oauthConfigured && !values.accessToken?.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (oauth) {
        const r = await send('/api/websites/shopify/connect', 'POST', { shop: values.shop ?? '' });
        if (!r.ok) return setError(String(r.data.error ?? 'Could not start connecting to Shopify.'));
        window.location.href = String(r.data.authorizeUrl);
        return;
      }
      const r = await send('/api/websites', 'POST', { platform: platform.id, name: name || undefined, fields: values });
      if (!r.ok) return setError(String(r.data.error ?? 'Could not connect.'));
      toast.success(`${platform.name} connected.`);
      onConnected();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connect {platform.name}</DialogTitle>
            <DialogDescription>{platform.authSummary}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            {platform.fields.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`wf-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`wf-${f.key}`}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    placeholder={f.placeholder}
                    required={!f.optional && !(platform.id === 'shopify' && f.key === 'accessToken')}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                  {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
                </div>
              ))}
            {platform.id === 'shopify' && !platform.oauthConfigured && (
              <p className="text-xs text-muted-foreground">Shopify OAuth isn’t set up on this deployment yet, so paste an Admin API access token.</p>
            )}
            {!oauth && (
              <div className="space-y-1">
                <Label htmlFor="wf-name">Name in Aura (optional)</Label>
                <Input id="wf-name" placeholder="Brand A blog" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <details className="rounded-md border border-border p-2 text-xs">
              <summary className="cursor-pointer font-medium text-foreground">What {platform.name} can receive</summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {(Object.keys(platform.seo) as SeoField[]).map((k) => (
                  <li key={k}>
                    <span className="text-foreground">{SEO_FIELD_LABELS[k]}:</span> {SUPPORT_LABEL[platform.seo[k].support]}
                    {platform.seo[k].note ? ` — ${platform.seo[k].note}` : ''}
                  </li>
                ))}
                {platform.limitations.map((l) => (
                  <li key={l}>• {l}</li>
                ))}
              </ul>
            </details>
            {error && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
              </p>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {oauth ? 'Continue to Shopify' : 'Verify and connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ScheduleData {
  schedule: { enabled: boolean; weekdays: number[]; timeOfDay: string; mode: string; postsPerSlot: number; nextRunAt: string | null };
  queue: { id: string; title: string }[];
  timeZone: string;
}

function ScheduleEditor({ website, canEdit }: { website: Website; canEdit: boolean }) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [form, setForm] = useState<ScheduleData['schedule'] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/websites/${website.id}/schedule`);
      if (r.ok) {
        const d = (await r.json()) as ScheduleData;
        setData(d);
        setForm(d.schedule);
      }
    })();
  }, [website.id]);

  if (!data || !form) return <p className="mt-3 text-xs text-muted-foreground">Loading schedule…</p>;

  async function save() {
    setBusy(true);
    const r = await send(`/api/websites/${website.id}/schedule`, 'PUT', {
      enabled: form!.enabled,
      weekdays: form!.weekdays,
      timeOfDay: form!.timeOfDay,
      mode: form!.mode,
      postsPerSlot: form!.postsPerSlot,
    });
    setBusy(false);
    if (!r.ok) return toast.error(String(r.data.error ?? 'Could not save the schedule.'));
    const d = r.data as unknown as ScheduleData;
    setData(d);
    setForm(d.schedule);
    toast.success(d.schedule.enabled ? 'Auto-publish is on.' : 'Auto-publish is off.');
  }

  const toggleDay = (d: number) =>
    setForm((f) => f && { ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort() });

  return (
    <div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3">
      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
        <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Auto-publish approved blogs to {website.name}
      </label>
      <p className="text-xs text-muted-foreground">
        Only blogs a person has approved are published, oldest approval first — each blog once per site. Times are in {data.timeZone}.
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
        {WEEKDAY_SHORT.map((label, i) => (
          <button
            key={label}
            type="button"
            disabled={!canEdit}
            aria-pressed={form.weekdays.includes(i + 1)}
            onClick={() => toggleDay(i + 1)}
            className={`rounded-md border px-2.5 py-1 text-xs ${form.weekdays.includes(i + 1) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`time-${website.id}`}>Time</Label>
          <Input id={`time-${website.id}`} type="time" className="w-32" disabled={!canEdit} value={form.timeOfDay} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`mode-${website.id}`}>As</Label>
          <select
            id={`mode-${website.id}`}
            className="h-10 rounded-md border border-input bg-background px-2 text-sm"
            disabled={!canEdit}
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value })}
          >
            <option value="publish">Published post</option>
            <option value="draft">Draft on the site</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`count-${website.id}`}>Blogs per slot</Label>
          <Input
            id={`count-${website.id}`}
            type="number"
            min={1}
            max={5}
            className="w-24"
            disabled={!canEdit}
            value={form.postsPerSlot}
            onChange={(e) => setForm({ ...form, postsPerSlot: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
          />
        </div>
        {canEdit && (
          <Button size="sm" loading={busy} onClick={save}>
            Save schedule
          </Button>
        )}
      </div>
      <p className="text-xs text-foreground">
        {form.enabled ? describeSlots(form.weekdays, form.timeOfDay) : 'Off'}
        {data.schedule.enabled && data.schedule.nextRunAt ? ` · next run ${new Date(data.schedule.nextRunAt).toLocaleString()}` : ''}
      </p>
      <div className="text-xs">
        <p className="font-medium text-foreground">Next up ({data.queue.length === 0 ? 'nothing approved and waiting' : `${data.queue.length} shown`})</p>
        <ul className="mt-1 list-inside list-disc text-muted-foreground">
          {data.queue.map((q) => (
            <li key={q.id}>
              <a href={`/dashboard/content/${q.id}`} className="hover:text-foreground hover:underline">
                {q.title}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
