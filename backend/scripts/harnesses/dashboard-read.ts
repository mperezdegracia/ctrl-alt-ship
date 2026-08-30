import { getDashboardOperationDossier, listDashboardOperations } from "../../src/tango/supabase/dashboard";

async function main(): Promise<void> {
  const operations = await listDashboardOperations();
  if (operations.length === 0) {
    throw new Error("Expected at least one active operation in the shared Supabase project");
  }

  const first = operations[0];
  if (!first) throw new Error("Missing the first active operation");
  const dossier = await getDashboardOperationDossier(first.reference);
  if (!dossier) throw new Error(`Dashboard could not reread ${first.reference}`);
  if (dossier.reference !== first.reference) {
    throw new Error(`Dossier reference mismatch: expected ${first.reference}, got ${dossier.reference}`);
  }
  if (dossier.trace.lanes[0]?.id !== "operation") {
    throw new Error("Dashboard trace must begin with the durable operation lane");
  }
  if (dossier.trace.nodes.some((node, index, nodes) => index > 0 && node.occurredAt < (nodes[index - 1]?.occurredAt ?? ""))) {
    throw new Error("Dashboard trace nodes must be ordered by their persisted occurrence time");
  }

  console.log(JSON.stringify({
    operation_count: operations.length,
    reference: dossier.reference,
    status: dossier.status,
    quote_count: dossier.quotes.length,
    commitment_count: dossier.commitments.length,
    trace_lane_count: dossier.trace.lanes.length,
    trace_node_count: dossier.trace.nodes.length,
    has_mandate: Boolean(dossier.mandate),
    has_active_escalation: Boolean(dossier.activeEscalation),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
