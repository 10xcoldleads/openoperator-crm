import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const assetRecoveryScript = `
(() => {
  /* openoperator_asset_recovery */
  const recover = (reason) => {
    const message = String(reason?.message || reason || "");
    if (!/failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(message)) return;
    const next = new URL(window.location.href);
    if (next.searchParams.has("__asset_retry")) return;
    next.searchParams.set("__asset_retry", String(Date.now()));
    window.location.replace(next.toString());
  };
  window.addEventListener("error", (event) => recover(event.error || event.message), true);
  window.addEventListener("unhandledrejection", (event) => recover(event.reason));
})();
`;

export const metadata: Metadata = {
  title: "OpenOperator CRM",
  description: "Private revenue operations command center for OpenOperator.",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
    noimageindex: true,
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head><script dangerouslySetInnerHTML={{ __html: assetRecoveryScript }} /></head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
