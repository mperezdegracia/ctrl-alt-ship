import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tango | Operations",
  description: "Tango freight operations control center.",
  icons: { icon: "/tango.png", shortcut: "/tango.png", apple: "/tango.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
