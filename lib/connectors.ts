/**
 * Connectors registry — the single source of truth for the Connectors module.
 * Each entry is an integration users can (eventually) connect. `available`
 * connectors have a working OAuth flow today; `coming_soon` ones are listed so
 * the roadmap is visible in-product, and light up as their OAuth is added +
 * approved. Adding a real integration later = flip status + set connectHref.
 */
export type ConnectorCategory =
  | 'Analytics'
  | 'Advertising'
  | 'Social & Publishing'
  | 'CRM & Email'
  | 'Commerce'
  | 'Storage';

export type ConnectorStatus = 'available' | 'coming_soon';

export interface Connector {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  status: ConnectorStatus;
  /** Badge accent colour (brand-ish). */
  color: string;
  /** Where "Connect" routes for `available` connectors. */
  connectHref?: string;
}

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = [
  'Analytics',
  'Advertising',
  'Social & Publishing',
  'CRM & Email',
  'Commerce',
  'Storage',
];

export const CONNECTORS: Connector[] = [
  // --- Analytics ---
  {
    id: 'ga4',
    name: 'Google Analytics (GA4)',
    category: 'Analytics',
    description: 'Pull traffic, conversions, and audience data to inform content.',
    status: 'coming_soon',
    color: '#E8710A',
  },
  {
    id: 'search-console',
    name: 'Google Search Console',
    category: 'Analytics',
    description: 'Understand search queries and rankings driving your site.',
    status: 'coming_soon',
    color: '#458CF5',
  },
  // --- Advertising ---
  {
    id: 'google-ads',
    name: 'Google Ads',
    category: 'Advertising',
    description: 'Campaign performance to align content with paid spend.',
    status: 'coming_soon',
    color: '#4285F4',
  },
  // --- Social & Publishing ---
  {
    id: 'linkedin',
    name: 'LinkedIn',
    category: 'Social & Publishing',
    description: 'Personalize content from your profile; publish approved posts.',
    status: 'available',
    color: '#0A66C2',
    connectHref: '/dashboard/settings/connections',
  },
  {
    id: 'meta',
    name: 'Meta (Facebook & Instagram)',
    category: 'Social & Publishing',
    description: 'Page insights and scheduled publishing to FB & IG.',
    status: 'coming_soon',
    color: '#1877F2',
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    category: 'Social & Publishing',
    description: 'Publish threads and read engagement signals.',
    status: 'coming_soon',
    color: '#111111',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'Social & Publishing',
    description: 'Channel analytics and video-topic ideas.',
    status: 'coming_soon',
    color: '#FF0000',
  },
  // --- CRM & Email ---
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'CRM & Email',
    description: 'Sync contacts, deals, and marketing activity.',
    status: 'coming_soon',
    color: '#FF7A59',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'CRM & Email',
    description: 'Bring CRM context into outreach and content.',
    status: 'coming_soon',
    color: '#00A1E0',
  },
  {
    id: 'mailchimp',
    name: 'Mailchimp',
    category: 'CRM & Email',
    description: 'Audiences and campaign performance for email.',
    status: 'coming_soon',
    color: '#FFE01B',
  },
  // --- Commerce ---
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'Commerce',
    description: 'Products and sales data to ground product content.',
    status: 'coming_soon',
    color: '#95BF47',
  },
  // --- Storage ---
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'Storage',
    description: 'Import brand docs and assets into your knowledge base.',
    status: 'coming_soon',
    color: '#1FA463',
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    category: 'Storage',
    description: 'Import documents and assets from Microsoft 365.',
    status: 'coming_soon',
    color: '#0364B8',
  },
];

export function connectorInitials(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase();
}
