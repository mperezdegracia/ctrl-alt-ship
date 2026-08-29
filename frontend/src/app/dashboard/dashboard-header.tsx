"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function DashboardHeader({ email }: { email: string }) {
  const router = useRouter();
  async function signOut() { await createClient().auth.signOut(); router.replace("/login"); router.refresh(); }
  return <header className="dashboard-header"><div className="wordmark"><span className="wordmark-mark" aria-hidden="true">N</span><span>Nauta</span></div><div className="dashboard-user"><span>{email}</span><button onClick={signOut}>Sign out</button></div></header>;
}
