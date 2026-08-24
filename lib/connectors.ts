/**
 * Connectors registry — the single source of truth for the Connectors module.
 * Each entry is an integration users can (eventually) connect. `available`
 * connectors have a working OAuth flow today; `coming_soon` ones are listed so
 * the roadmap is visible in-product, and light up as their OAuth is added +
 * approved. Adding a real integration later = flip status + set connectHref.
 */
export type ConnectorCategory =
  | 'Analytics'
  | 'SEO & Content'
  | 'Advertising'
  | 'Social & Publishing'
  | 'CRM & Email'
  | 'Commerce'
  | 'Design'
  | 'Productivity'
  | 'Automation'
  | 'Storage';

/**
 * `available`   - has a working integration in this codebase.
 * `coming_soon` - listed for roadmap visibility; no integration yet.
 *
 * An `available` connector may still need one-time app credentials on the
 * deployment before it can be connected; the Connectors page asks the server
 * (server/connectors/providers.ts) and says exactly what is missing, instead of
 * showing an indefinite "Coming soon".
 */
export type ConnectorStatus = 'available' | 'coming_soon';

export interface Connector {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  status: ConnectorStatus;
  /** Badge accent colour (brand-ish). */
  color: string;
  /** Where "Connect" routes for connectors with a bespoke flow (LinkedIn). */
  connectHref?: string;
}

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = [
  'Analytics',
  'SEO & Content',
  'Advertising',
  'Social & Publishing',
  'CRM & Email',
  'Commerce',
  'Design',
  'Productivity',
  'Automation',
  'Storage',
];

export const CONNECTORS: Connector[] = [
  // --- Analytics ---
  {
    id: 'ga4',
    name: 'Google Analytics (GA4)',
    category: 'Analytics',
    description: 'Pull traffic, conversions, and audience data to inform content.',
    status: 'available',
    color: '#E8710A',
  },
  {
    id: 'search-console',
    name: 'Google Search Console',
    category: 'Analytics',
    description: 'Understand search queries and rankings driving your site.',
    status: 'available',
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
    status: 'available',
    color: '#FF7A59',
  },
  {
    id: 'klaviyo',
    name: 'Klaviyo',
    category: 'CRM & Email',
    description: 'Email/SMS audiences and campaign performance.',
    status: 'coming_soon',
    color: '#232426',
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
    status: 'available',
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
  {
    id: 'google-cse',
    name: 'Google Custom Search',
    category: 'Analytics',
    description:
      'Official web search for lead discovery — role-title lookups across the open web.',
    status: 'available',
    color: '#34A853',
  },
  // --- SEO & Content ---
  {
    id: 'semrush',
    name: 'Semrush',
    category: 'SEO & Content',
    description: 'Keyword, ranking, and competitive SEO data.',
    status: 'coming_soon',
    color: '#FF642D',
  },
  {
    id: 'ahrefs',
    name: 'Ahrefs',
    category: 'SEO & Content',
    description: 'Backlinks, keywords, and content-gap insights.',
    status: 'coming_soon',
    color: '#054ADA',
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'Social & Publishing',
    description: 'Publish approved blog drafts to your site.',
    status: 'coming_soon',
    color: '#21759B',
  },
  // --- Design ---
  {
    id: 'canva',
    name: 'Canva',
    category: 'Design',
    description: 'Turn content into on-brand graphics.',
    status: 'coming_soon',
    color: '#00C4CC',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Design',
    description: 'Pull brand assets and design tokens.',
    status: 'coming_soon',
    color: '#F24E1E',
  },
  // --- Productivity ---
  {
    id: 'notion',
    name: 'Notion',
    category: 'Productivity',
    description: 'Sync briefs, plans, and content into Notion.',
    status: 'coming_soon',
    color: '#111111',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Productivity',
    description: 'Approvals and alerts where your team works.',
    status: 'available',
    color: '#4A154B',
  },
  {
    id: 'crunchbase',
    name: 'Crunchbase',
    category: 'CRM & Email',
    description:
      'Funding, stage, and investor data for lead discovery and outreach signals.',
    status: 'available',
    color: '#146AFF',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Productivity',
    description:
      'Higher API limits for competitor product-movement tracking and lead discovery.',
    status: 'available',
    color: '#181717',
  },
  // --- Automation ---
  {
    id: 'zapier',
    name: 'Zapier',
    category: 'Automation',
    description: 'Connect Aura to 6,000+ apps via Zaps.',
    status: 'coming_soon',
    color: '#FF4A00',
  },
  {
    id: 'make',
    name: 'Make (Integromat)',
    category: 'Automation',
    description: 'Build custom automations and scenarios.',
    status: 'coming_soon',
    color: '#6D00CC',
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
