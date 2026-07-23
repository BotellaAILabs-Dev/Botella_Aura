'use client';

import { Toaster as SonnerToaster } from 'sonner';

/**
 * App-wide toast/notification surface (built on sonner). Mounted once in the
 * root providers; call `toast(...)` from anywhere. Themed to match our tokens.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group rounded-lg border border-border bg-card text-card-foreground shadow-md',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground',
          error: 'border-destructive/30',
          success: 'border-success/30',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
