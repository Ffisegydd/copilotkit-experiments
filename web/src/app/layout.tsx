import "@copilotkit/react-core/v2/styles.css";
import "./globals.css";

import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { Providers } from "./providers";

export const metadata: Metadata = { title: "Book Reviews" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* CopilotKit's chat theme keys off a `dark` class on <html>. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{matchMedia('(prefers-color-scheme: dark)').matches&&document.documentElement.classList.add('dark')}catch(e){}",
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
