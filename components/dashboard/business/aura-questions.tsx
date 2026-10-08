'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MessageCircleQuestion } from 'lucide-react';

import type { Question } from '@/lib/business-context-questions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';

/**
 * Aura's questions about the business.
 *
 * Shown instead of guesses: when Aura is missing something it needs, or holds
 * a value it cannot vouch for, it asks here. Answers go to
 * POST /api/business-context/questions, which updates the Business Context
 * through the same validated path as every other edit.
 */

interface Props {
  questions: Question[];
  openCount: number;
  canAnswer: boolean;
}

export function AuraQuestions({ questions, openCount, canAnswer }: Props) {
  if (questions.length === 0) return null;
  const more = openCount - questions.length;
  return (
    <Card id="aura-questions" className="scroll-mt-20 border-primary/30">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">
            {questions.length === 1
              ? 'Aura has a question'
              : 'Aura has a few questions'}
          </CardTitle>
        </div>
        <CardDescription>
          Aura won’t guess these. Answer what you can — each answer updates what
          Aura knows about your business straight away.
          {more > 0 && ` (${more} more after these.)`}
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {questions.map((q) => (
          <QuestionItem key={q.key} question={q} canAnswer={canAnswer} />
        ))}
      </CardContent>
    </Card>
  );
}

function QuestionItem({
  question: q,
  canAnswer,
}: {
  question: Question;
  canAnswer: boolean;
}) {
  const router = useRouter();
  const initial = q.answer.current ?? (q.answer.type === 'multi' ? [] : '');
  const [value, setValue] = useState<string | string[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    const res = await fetch('/api/business-context/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: q.key, ...body }),
    }).catch(() => null);
    setBusy(null);
    if (!res) return setError('Could not reach the server. Try again.');
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: Record<string, string[] | undefined>;
    };
    if (!res.ok) {
      const detail = Object.values(data.details ?? {})
        .flat()
        .filter(Boolean)[0];
      return setError(detail ?? data.error ?? 'Could not save.');
    }
    toast.success(
      body.action === 'answer'
        ? 'Thanks — Aura has updated your business details.'
        : 'Okay, Aura won’t ask about this for now.',
    );
    router.refresh();
  }

  const str = typeof value === 'string' ? value : '';
  const list = Array.isArray(value) ? value : [];
  const empty = Array.isArray(value) ? list.length === 0 : !str.trim();
  const unchanged =
    JSON.stringify(Array.isArray(value) ? [...value].sort() : str.trim()) ===
    JSON.stringify(
      Array.isArray(initial) ? [...initial].sort() : String(initial).trim(),
    );
  const inputId = `q-${q.key}`;

  return (
    <div className="space-y-3 py-4">
      <div className="flex flex-wrap items-start gap-2">
        <label htmlFor={inputId} className="flex-1 text-sm font-medium">
          {q.text}
        </label>
        {q.priority === 'critical' && (
          <Badge variant="destructive">Needed</Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{q.why}</p>

      {canAnswer && (
        <>
          {q.answer.type === 'link' && q.answer.href && (
            <Button asChild size="sm">
              <Link href={q.answer.href}>{q.answer.cta ?? 'Go there'}</Link>
            </Button>
          )}
          {(q.answer.type === 'text' || q.answer.type === 'textarea') &&
            (q.answer.type === 'text' ? (
              <Input
                id={inputId}
                value={str}
                maxLength={q.answer.max}
                placeholder={q.answer.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
            ) : (
              <Textarea
                id={inputId}
                rows={2}
                value={str}
                placeholder={q.answer.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
            ))}
          {q.answer.type === 'choice' && (
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-labelledby={inputId}
            >
              {q.answer.choices?.map((c) => (
                <Button
                  key={c.value}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={value === c.value}
                  variant={value === c.value ? 'default' : 'outline'}
                  onClick={() => setValue(c.value)}
                >
                  {c.label}
                </Button>
              ))}
            </div>
          )}
          {q.answer.type === 'multi' && (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={q.text}
            >
              {q.answer.choices?.map((c) => {
                const on = list.includes(c.value);
                return (
                  <Button
                    key={c.value}
                    type="button"
                    size="sm"
                    aria-pressed={on}
                    variant={on ? 'default' : 'outline'}
                    onClick={() =>
                      setValue(
                        on
                          ? list.filter((v) => v !== c.value)
                          : [...list, c.value],
                      )
                    }
                  >
                    {c.label}
                  </Button>
                );
              })}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {q.answer.confirmable && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  post(
                    { action: 'answer', answer: { confirm: true } },
                    'confirm',
                  )
                }
              >
                {busy === 'confirm' ? 'Saving…' : 'Yes, that’s right'}
              </Button>
            )}
            {q.answer.type !== 'link' && (
              <Button
                size="sm"
                disabled={
                  busy !== null || empty || (q.answer.confirmable && unchanged)
                }
                onClick={() =>
                  post({ action: 'answer', answer: { value } }, 'answer')
                }
              >
                {busy === 'answer'
                  ? 'Saving…'
                  : q.answer.confirmable
                    ? 'Update'
                    : 'Answer'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => post({ action: 'snooze' }, 'snooze')}
            >
              Not now
            </Button>
            {q.priority !== 'critical' && (
              <Button
                size="sm"
                variant="ghost"
                className={cn('text-muted-foreground')}
                disabled={busy !== null}
                onClick={() => post({ action: 'dismiss' }, 'dismiss')}
              >
                Doesn’t apply to us
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
