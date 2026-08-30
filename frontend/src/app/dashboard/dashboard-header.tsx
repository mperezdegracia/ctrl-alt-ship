"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type DashboardView = "control-room" | "operations" | "escalations" | "directory";

export function DashboardHeader({
  email,
  activeView = "control-room",
}: {
  email: string;
  activeView?: DashboardView;
}) {
  const router = useRouter();
  async function signOut() { await createClient().auth.signOut(); router.replace("/login"); router.refresh(); }
  return (
    <header className="dashboard-header">
      <Link href="/dashboard" className="wordmark" aria-label="Tango Control Room">
        <Image className="wordmark-mark" src="/tango.png" alt="" width={30} height={30} priority />
        <span>Tango</span>
      </Link>
      <nav className="dashboard-nav" aria-label="Operations navigation">
        <Link href="/dashboard" aria-current={activeView === "control-room" ? "page" : undefined}>Control room</Link>
        <Link href="/dashboard/operations" aria-current={activeView === "operations" ? "page" : undefined}>Operations</Link>
        <Link href="/dashboard/escalations" aria-current={activeView === "escalations" ? "page" : undefined}>Escalations</Link>
        <Link href="/dashboard/directory" aria-current={activeView === "directory" ? "page" : undefined}>Directory</Link>
      </nav>
      <div className="dashboard-user"><span>{email}</span><button onClick={signOut}>Sign out</button></div>
    </header>
  );
}
