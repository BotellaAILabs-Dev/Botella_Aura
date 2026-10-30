import { Badge, type BadgeProps } from '@/components/ui/badge';
import {
  BLOG_PUBLISH_STATE_LABEL,
  CONNECTION_STATE_LABEL,
  type BlogPublishState,
  type WebsiteConnectionState,
} from '@/lib/website-platforms';

const CONNECTION_VARIANT: Record<WebsiteConnectionState, BadgeProps['variant']> = {
  connected: 'success',
  error: 'warning',
  reauth: 'destructive',
  not_connected: 'muted',
};

const PUBLISH_VARIANT: Record<BlogPublishState, BadgeProps['variant']> = {
  not_connected: 'muted',
  awaiting_approval: 'warning',
  ready: 'outline',
  scheduled: 'default',
  publishing: 'secondary',
  published: 'success',
  drafted: 'secondary',
  failed: 'destructive',
  cancelled: 'muted',
};

export function ConnectionBadge({ state }: { state: WebsiteConnectionState }) {
  return <Badge variant={CONNECTION_VARIANT[state]}>{CONNECTION_STATE_LABEL[state]}</Badge>;
}

export function PublishStateBadge({ state }: { state: BlogPublishState }) {
  return <Badge variant={PUBLISH_VARIANT[state]}>{BLOG_PUBLISH_STATE_LABEL[state]}</Badge>;
}
