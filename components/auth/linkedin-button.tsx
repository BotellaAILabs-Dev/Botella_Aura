'use client';

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';

/**
 * LinkedIn OAuth sign-in button. Rendered only when LinkedIn is configured.
 *
 * Identity only — this is "Sign In with LinkedIn", not the publishing
 * connection. Someone logging in is not agreeing to let Aura post as them.
 */
export function LinkedInButton({
  callbackUrl = '/dashboard',
  label = 'Continue with LinkedIn',
}: {
  callbackUrl?: string;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={() => signIn('linkedin', { callbackUrl })}
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="#0A66C2"
          d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"
        />
      </svg>
      {label}
    </Button>
  );
}
