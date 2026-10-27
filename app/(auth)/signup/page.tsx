import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SignupForm } from '@/components/auth/signup-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { AuthDivider } from '@/components/auth/auth-divider';
import { enabledSocialProviders } from '@/lib/social-signin';

export const metadata: Metadata = { title: 'Sign up' };

export default function SignupPage() {
  const social = enabledSocialProviders();

  return (
    <Card className="shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Create your account</CardTitle>
        <CardDescription>
          Start building your AI marketing co-pilot
        </CardDescription>
      </CardHeader>
      <CardContent>
        {social.length > 0 && (
          <>
            <SocialButtons
              providers={social}
              callbackUrl="/onboarding"
              mode="signup"
            />
            <AuthDivider />
          </>
        )}
        <SignupForm />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </p>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          By continuing you agree that Aura only acts with your approval —
          nothing is posted or sent on your behalf without review.
        </p>
      </CardContent>
    </Card>
  );
}
