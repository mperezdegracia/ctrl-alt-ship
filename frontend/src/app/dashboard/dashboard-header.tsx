"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type DashboardView = "operations" | "attention";

export function DashboardHeader({
  email,
  activeView = "operations",
}: {
  email: string;
  activeView?: DashboardView;
}) {
  const router = useRouter();
  async function signOut() { await createClient().auth.signOut(); router.replace("/login"); router.refresh(); }
  return (
    <header className="dashboard-header">
      <Link href="/dashboard" className="wordmark" aria-label="Tango dashboard">
        <Image className="wordmark-mark" src="/tango.png" alt="" width={30} height={30} priority />
        <span>Tango</span>
      </Link>
      <nav className="dashboard-nav" aria-label="Operations navigation">
        <Link href="/dashboard" aria-current={activeView === "operations" ? "page" : undefined}>Operations</Link>
        <Link href="/dashboard?filter=attention" aria-current={activeView === "attention" ? "page" : undefined}>Attention</Link>
      </nav>
      <div className="dashboard-user"><span>{email}</span><button onClick={signOut}>Sign out</button></div>
    </header>
  );
}
