import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardApiError, getDashboardCallEvidence } from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { CallEvidenceView } from "@/features/operation/call-evidence-view";
import { DashboardHeader } from "../../../dashboard-header";

export const dynamic = "force-dynamic";

export default async function EvidencePage({ params, searchParams }: {
  params: Promise<{ reference: string }>; searchParams: Promise<{ call?: string | string[] }>;
}) {
  const { accessToken, email } = await requireDashboardSession();
  const { reference } = await params;
  const { call } = await searchParams;
  if (!/^OP-[0-9]{6,}$/.test(reference) || Array.isArray(call)
    || (call !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(call))) notFound();
  let evidence;
  try { evidence = await getDashboardCallEvidence(reference, accessToken, call); }
  catch (error) {
    if (error instanceof DashboardApiError && error.status === 404) notFound();
    throw error;
  }
  return <main className="dashboard-shell">
    <DashboardHeader email={email} activeView="operations" />
    <article className="operation-detail">
      <Link className="back-to-operations" href={`/dashboard/operations/${reference}`}>← Volver a la operación</Link>
      <header className="operation-detail-header">
        <div><p className="operation-reference">{reference} / EVIDENCIA</p><h1>Evidencia de la llamada</h1>
          <p className="operation-route">Qué se dijo y qué pasó, en una misma línea de tiempo.</p></div>
      </header>
      <CallEvidenceView evidence={evidence} />
    </article>
  </main>;
}
