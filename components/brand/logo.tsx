import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Botella Aura wordmark. `iconOnly` renders just the mark (for the collapsed
 * sidebar); otherwise the full lockup. Keeps brand usage consistent everywhere.
 */
export function Logo({
  className,
  iconOnly = false,
}: {
  className?: string;
  iconOnly?: boolean;
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Sparkles className="h-4 w-4" aria-hidden />
      </span>
      {!iconOnly && (
        <span className="text-base font-semibold tracking-tight text-foreground">
          Botella{' '}
          <span className="text-primary">Aura</span>
        </span>
      )}
    </span>
  );
}
