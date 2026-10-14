/**
 * Deterministic intent matching for the WhatsApp agent — the common requests,
 * recognised without a model. It runs first: it is instant, free, works when
 * the AI provider is down, and cannot be talked into anything. The AI router
 * handles only what this does not recognise. Pure; unit-tested.
 */

export interface Intent {
  tool: string;
  args: Record<string, unknown>;
}

const has = (t: string, re: RegExp) => re.test(t);

/** "write a linkedin post about X" → { type, platform, topic: X } */
function postRequest(raw: string, t: string): Intent | null {
  if (!has(t, /^(please\s+)?(can you\s+)?(write|create|generate|draft|make|compose|prepare)\b/)) return null;
  if (!has(t, /\b(post|thread|tweet|carousel|email|newsletter|ad|advert|article|blog|caption|promo|promotion|copy)\b/)) return null;
  const type = has(t, /\bcarousel\b/)
    ? 'CAROUSEL'
    : has(t, /\b(thread|tweet)\b|\bon x\b|\bfor x\b/)
      ? 'TWEET_THREAD'
      : has(t, /\b(email|newsletter)\b/)
        ? 'EMAIL'
        : has(t, /\b(ad|advert)\b/)
          ? 'AD'
          : has(t, /\b(blog|article)\b/)
            ? 'BLOG'
            : has(t, /\b(promo|promotion)\b/)
              ? 'PROMO'
              : has(t, /\b(instagram|facebook|caption)\b/)
                ? 'IMAGE_POST'
                : 'LINKEDIN_POST';
  const platform = has(t, /\binstagram\b/) ? 'INSTAGRAM' : has(t, /\bfacebook\b/) ? 'FACEBOOK' : has(t, /\blinkedin\b/) ? 'LINKEDIN' : undefined;
  // The topic: what follows "about/on/for/announcing", else the whole request.
  const m = raw.match(/\b(?:about|on the topic of|regarding|announcing|promoting|for)\s+(.{3,})$/i);
  const topic = (m?.[1] ?? raw).trim().replace(/[.!?]+$/, '');
  return { tool: 'generate_post', args: { topic: topic.slice(0, 500), type, ...(platform ? { platform } : {}) } };
}

/** The networks Aura publishes to in one action, in a fixed order. */
export const SOCIAL_NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'] as const;

/**
 * Which networks a message names: "Facebook, Instagram and LinkedIn",
 * "fb + insta", "all three", "all of them". Null when it names none.
 */
export function parsePlatforms(text: string | null): string[] | null {
  const t = ` ${(text ?? '').toLowerCase()} `;
  if (/\b(all three|all 3|all of them|all networks|all platforms|everywhere|every network)\b/.test(t)) return [...SOCIAL_NETWORKS];
  const found = SOCIAL_NETWORKS.filter((p) =>
    p === 'FACEBOOK' ? /\b(facebook|fb)\b/.test(t) : p === 'INSTAGRAM' ? /\b(instagram|insta|ig)\b/.test(t) : /\b(linkedin|linked in)\b/.test(t),
  );
  return found.length ? [...found] : null;
}

/**
 * "Create a marketing post for all my social media accounts", "a post for
 * Facebook and Instagram": a post meant for several networks. The topic is
 * what follows "about …", when given.
 */
function socialPostRequest(raw: string, t: string): Intent | null {
  if (!/^(please\s+)?(can you\s+)?(write|create|generate|draft|make|compose|prepare)\b/.test(t)) return null;
  if (!/\b(post|content|update|announcement|campaign post)\b/.test(t)) return null;
  const named = parsePlatforms(raw);
  const forSocials = /\b(social media|social accounts|socials|all my (social )?(media )?(accounts|channels|networks|platforms)|all (my )?networks|all platforms)\b/.test(t);
  if (!forSocials && (!named || named.length < 2)) return null;
  const about = raw.match(/\b(?:about|on the topic of|regarding|announcing|promoting)\s+(.{3,})$/i)?.[1]?.trim().replace(/[.!?]+$/, '');
  // Networks named are used; "all my social media accounts" names none, so
  // Aura asks which.
  return {
    tool: 'plan_social_post',
    args: { ...(about ? { topic: about.slice(0, 500) } : {}), ...(named ? { platforms: named } : {}) },
  };
}

export function matchIntent(text: string | null, opts: { hasDraft: boolean }): Intent | null {
  const raw = (text ?? '').trim();
  const t = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  if (!t) return null;

  // Connect accounts — before the generic "connections".
  if (has(t, /\b(connect|link|add)\b.*\blinkedin\b/)) return { tool: 'connect_account', args: { provider: 'linkedin' } };
  if (has(t, /\b(connect|link|add)\b.*\b(facebook|instagram|meta)\b/)) return { tool: 'connect_account', args: { provider: 'meta' } };

  // An image request before a post request: "generate an image for this post"
  // mentions a post but asks for a picture.
  if (has(t, /\b(create|generate|make|add|design|produce)\b.*\b(image|picture|photo|visual|graphic|poster)\b/)) {
    return { tool: 'generate_image', args: {} };
  }

  // A post for several networks, before a post for one.
  const social = socialPostRequest(raw, t);
  if (social) return social;

  const post = postRequest(raw, t);
  if (post) return post;

  // Follow-ups on the draft being worked on.
  if (opts.hasDraft) {
    // "Approve and publish" — before plain "approve".
    if (has(t, /^(approve (and|&) publish|publish|publish (it|this|now|the post|this post)|post (it|this) now|post it|go live)\b/)) {
      const platforms = parsePlatforms(raw);
      return { tool: 'publish_draft', args: platforms ? { platforms } : {} };
    }
    if (has(t, /^(preview|show (me )?the previews?|how will it look)\b/)) return { tool: 'publish_preview', args: {} };
    if (has(t, /^(approve|approve (it|this|the post|this post))$/)) return { tool: 'approve_draft', args: {} };
    if (has(t, /^(reject|reject (it|this|the post|this post))$/)) return { tool: 'reject_draft', args: {} };
    if (has(t, /^(submit|submit (it|this)|send (it )?for approval|submit for approval)$/)) return { tool: 'submit_draft', args: {} };
    if (has(t, /^use (this|that|the) (image|picture|photo)$|^use it$/)) return { tool: 'use_image', args: {} };
    if (has(t, /^(make it|make this|shorten|shorter|longer|lengthen|rewrite|rephrase|add |remove |change |more |less |use a |mention )/)) {
      return { tool: 'edit_draft', args: { instructions: raw.slice(0, 1000) } };
    }
  }

  if (has(t, /\bopportunit(y|ies)\b/)) return { tool: 'opportunities', args: {} };
  if (has(t, /\b(recommendations?|suggestions?|suggests?|what should i do)\b/)) return { tool: 'suggestions', args: {} };
  // Before campaigns: "campaign performance" asks for results, not the list.
  if (has(t, /\b(analytics|results?|performance|metrics|stats|statistics|engagement|how (am i|are we) doing)\b/)) return { tool: 'analytics', args: {} };
  if (has(t, /\bcampaigns?\b/)) return { tool: 'campaigns', args: {} };
  if (has(t, /\b(approvals?|pending|awaiting|waiting for (approval|review)|to review|review queue)\b/)) return { tool: 'approvals', args: {} };
  if (has(t, /\b(calendar|scheduled|upcoming|this week'?s posts|next week)\b/)) return { tool: 'calendar', args: {} };
  if (has(t, /\bdrafts?\b|\bmy (posts|content)\b/)) return { tool: 'drafts', args: {} };
  if (has(t, /\b(business (context|profile|info|information|details)|about (my|our) (business|company)|brand voice)\b/)) return { tool: 'business', args: {} };
  if (has(t, /\b(connections|connected accounts|social accounts|connected)\b/)) return { tool: 'connections', args: {} };
  if (has(t, /\b(dashboard|overview|summary|summari[sz]e|what'?s (new|happening|up)|today)\b/)) return { tool: 'home', args: {} };
  if (has(t, /^(account|my account|settings|account settings|who am i)$/)) return { tool: 'account', args: {} };
  return null;
}

/** A typed answer to a confirmation question. */
export function typedConfirmation(text: string | null): 'yes' | 'no' | null {
  const t = (text ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (['yes', 'y', 'confirm', 'yes approve', 'yes, approve', 'yes reject', 'yes, reject', 'ok', 'okay'].includes(t)) return 'yes';
  if (['no', 'n', 'cancel', 'stop it', 'never mind', 'nevermind'].includes(t)) return 'no';
  return null;
}
