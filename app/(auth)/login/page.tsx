import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { LoginForm } from '@/components/auth/login-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { AuthDivider } from '@/components/auth/auth-divider';
import { safeRedirectPath } from '@/lib/safe-url';
import { enabledSocialProviders } from '@/lib/social-signin';
import { authErrorMessage } from '@/lib/auth-errors';

export const metadata: Metadata = { title: 'Log in' };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string; error?: string };
}) {
  // Social sign-in returns to the same place as the password form does (an
  // invite, a WhatsApp link) — same-site paths only.
  const callbackUrl = safeRedirectPath(searchParams.callbackUrl, '/dashboard');
  const social = enabledSocialProviders();
  const signInError = authErrorMessage(searchParams.error);

  return (
    <Card className="shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Welcome back</CardTitle>
        <CardDescription>Log in to your Botella Aura workspace</CardDescription>
      </CardHeader>
      <CardContent>
        {signInError && (
          <p
            role="alert"
            className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {signInError}
          </p>
        )}
        {social.length > 0 && (
          <>
            <SocialButtons providers={social} callbackUrl={callbackUrl} />
            <AuthDivider />
          </>
        )}
        <LoginForm />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
