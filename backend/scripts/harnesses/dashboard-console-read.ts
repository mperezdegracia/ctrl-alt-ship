import {
  listDashboardEscalations,
  listDashboardHandoffs,
  listDirectoryEntries,
} from "../../src/tango/supabase/dashboard-console";
import { listDashboardOperationsPage } from "../../src/tango/supabase/dashboard";

function assertPage(name: string, page: { items: unknown[]; page: number; perPage: number; total: number; totalPages: number }): void {
  if (page.page !== 1 || page.perPage < 1 || page.total < page.items.length || page.totalPages < 1) {
    throw new Error(`${name} paging contract is invalid`);
  }
}

async function main(): Promise<void> {
  const [operations, escalations, handoffs, contacts, providers] = await Promise.all([
    listDashboardOperationsPage({ page: 1, perPage: 10 }),
    listDashboardEscalations({ page: 1, perPage: 10 }),
    listDashboardHandoffs(),
    listDirectoryEntries("contacts", { page: 1, perPage: 10 }),
    listDirectoryEntries("providers", { page: 1, perPage: 10 }),
  ]);
  assertPage("operations", operations);
  assertPage("escalations", escalations);
  assertPage("contacts", contacts);
  assertPage("providers", providers);
  if (handoffs.some((handoff) => handoff.status !== "started" && handoff.status !== "supervisor_joined")) {
    throw new Error("The live handoff queue included a closed escalation");
  }
  console.log(JSON.stringify({
    operations: { total: operations.total, returned: operations.items.length },
    escalations: { total: escalations.total, returned: escalations.items.length },
    handoffCount: handoffs.length,
    contacts: { total: contacts.total, returned: contacts.items.length },
    providers: { total: providers.total, returned: providers.items.length },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
