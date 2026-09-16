import type { Metadata } from 'next';
import './globals.css';
import { ExecutionStoreProvider } from '@/lib/execution-store';

export const metadata: Metadata = {
  title: 'Agentic OS',
  description: 'AI-native operating environment',
  manifest: '/manifest.webmanifest',
};

export const viewport = {
  themeColor: '#0d9488',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
      </head>
      <body>
        {/* One execution source of truth for the whole client — survives page
            navigation so background executions keep streaming in (§22/§45). */}
        <ExecutionStoreProvider>{children}</ExecutionStoreProvider>
      </body>
    </html>
  );
}
