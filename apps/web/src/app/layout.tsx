import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'InsiderScope',
  description: 'Solana memecoin insider tracker',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <nav className="border-b border-line bg-surface/60">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2.5 text-xs">
            <Link href="/" className="text-sm tracking-tight text-ink">
              insider<span className="text-accent">scope</span>
            </Link>
            <Link href="/" className="text-ink-2 hover:text-ink">
              overview
            </Link>
            <Link href="/insiders" className="text-ink-2 hover:text-ink">
              insiders
            </Link>
            <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-3">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-buy" />
              live
            </span>
          </div>
        </nav>
        <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
