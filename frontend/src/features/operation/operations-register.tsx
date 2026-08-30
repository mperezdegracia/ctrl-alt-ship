import Link from "next/link";

import { formatDateTime, formatStatus } from "@/lib/dashboard-api";
import type { DashboardOperation } from "@/lib/dashboard-api";

export function OperationsRegister({ operations }: { operations: DashboardOperation[] }) {
  if (operations.length === 0) {
    return <p className="section-empty-copy">No operations match this view.</p>;
  }
  return (
    <div className="operations-table-wrap">
      <table className="operations-table">
        <thead>
          <tr><th>Operation</th><th>Route</th><th>State</th><th>Next action</th><th>Updated</th></tr>
        </thead>
        <tbody>
          {operations.map((operation) => (
            <tr key={operation.reference} className={operation.escalation ? "operation-row-escalated" : undefined}>
              <td><Link href={`/dashboard/operations/${operation.reference}`}><strong>{operation.reference}</strong><span>{operation.clientName}</span></Link></td>
              <td><span>{operation.pickupLocation ?? "Not recorded"}</span><strong>{operation.deliveryLocation ?? "Not recorded"}</strong></td>
              <td><span className={`status-mark status-${operation.status.replaceAll("_", "-")}`}>{formatStatus(operation.status)}</span></td>
              <td>{operation.nextStep}</td>
              <td className="updated-time">{formatDateTime(operation.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
