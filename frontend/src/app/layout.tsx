import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nauta | Operaciones",
  description: "Centro de control operativo de Nauta.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
