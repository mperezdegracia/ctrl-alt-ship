"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { formatDateTime, formatStatus } from "@/lib/dashboard-api";
import type { DashboardOperation } from "@/lib/dashboard-api";

export function OperationsRegister({ operations }: { operations: DashboardOperation[] }) {
  const knownReferences = useRef(new Set(operations.map((operation) => operation.reference)));
  const [arrivedReferences, setArrivedReferences] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const additions = operations.filter((operation) => !knownReferences.current.has(operation.reference)).map((operation) => operation.reference);
    knownReferences.current = new Set(operations.map((operation) => operation.reference));
    if (additions.length === 0) return;
    setArrivedReferences(new Set(additions));
    const timer = window.setTimeout(() => setArrivedReferences(new Set()), 900);
    return () => window.clearTimeout(timer);
  }, [operations]);

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
            <tr key={operation.reference} className={`${operation.escalation ? "operation-row-escalated" : ""}${arrivedReferences.has(operation.reference) ? " operation-row-arrived" : ""}`.trim()}>
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
