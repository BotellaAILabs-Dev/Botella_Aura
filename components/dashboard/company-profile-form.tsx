'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { toast } from '@/components/ui/toaster';

import {
  updateCompanySchema,
  type UpdateCompanyInput,
} from '@/lib/validations/company';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  companyId: string;
  canEdit: boolean;
  initial: {
    name: string;
    website: string | null;
    industry: string | null;
    brandVoiceNotes: string | null;
  };
}

export function CompanyProfileForm({ companyId, canEdit, initial }: Props) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdateCompanyInput>({
    resolver: zodResolver(updateCompanySchema),
    defaultValues: {
      name: initial.name,
      website: initial.website ?? '',
      industry: initial.industry ?? '',
      brandVoiceNotes: initial.brandVoiceNotes ?? '',
    },
  });

  async function onSubmit(values: UpdateCompanyInput) {
    setServerError(null);
    const res = await fetch(`/api/companies/${companyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setServerError(body.error ?? 'Could not save changes.');
      return;
    }
    toast.success('Company profile saved.');
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardHeader>
          <CardTitle>Company profile</CardTitle>
          <CardDescription>
            Aura uses this to tailor trends, content, and outreach. This is the
            data future sprints feed into AI prompts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!canEdit && (
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              You have view-only access. Ask an owner or admin to make changes.
            </p>
          )}
          {serverError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {serverError}
            </p>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Company name</Label>
              <Input
                id="name"
                disabled={!canEdit}
                aria-invalid={!!errors.name}
                {...register('name')}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                disabled={!canEdit}
                placeholder="acme.com"
                aria-invalid={!!errors.website}
                {...register('website')}
              />
              {errors.website && (
                <p className="text-xs text-destructive">
                  {errors.website.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="industry">Industry</Label>
            <Input
              id="industry"
              disabled={!canEdit}
              placeholder="B2B SaaS"
              {...register('industry')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="brandVoiceNotes">Brand voice notes</Label>
            <Textarea
              id="brandVoiceNotes"
              rows={6}
              disabled={!canEdit}
              placeholder="How should Aura sound when writing for you?"
              {...register('brandVoiceNotes')}
            />
            {errors.brandVoiceNotes && (
              <p className="text-xs text-destructive">
                {errors.brandVoiceNotes.message}
              </p>
            )}
          </div>
        </CardContent>
        {canEdit && (
          <CardFooter className="justify-end gap-2">
            <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
