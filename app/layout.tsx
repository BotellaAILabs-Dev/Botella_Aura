import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/app/providers';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Botella Aura — AI Marketing Co-Pilot',
    template: '%s · Botella Aura',
  },
  description:
    'Botella Aura researches trends, analyzes companies, generates on-brand ' +
    'content, and drafts outreach — with a human approval step before anything ' +
    'goes live.',
  applicationName: 'Botella Aura',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
