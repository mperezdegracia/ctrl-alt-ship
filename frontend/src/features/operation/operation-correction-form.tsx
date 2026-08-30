"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest } from "@/lib/dashboard-api";
import type { DashboardOperationDossier } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

export function OperationCorrectionForm({ operation }: { operation: DashboardOperationDossier }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const values = new FormData(event.currentTarget);
    const weightValue = String(values.get("grossWeightKg") ?? "").trim();
    const constraints = String(values.get("operationalConstraints") ?? "")
      .split("\n").map((item) => item.trim()).filter(Boolean);
    const fields: Record<string, string | number | string[] | null> = {};
    const textFields = ["containerType", "pickupLocation", "deliveryLocation", "emptyReturnDepot"] as const;
    for (const field of textFields) {
      const value = String(values.get(field) ?? "").trim();
      if (value) fields[field] = value;
    }
    if (weightValue) fields.grossWeightKg = Number(weightValue);
    if (constraints.length > 0) fields.operationalConstraints = constraints;
    const cargoNotes = String(values.get("cargoNotes") ?? "").trim();
    fields.cargoNotes = cargoNotes || null;

    try {
      const { data } = await createClient().auth.getSession();
      if (!data.session?.access_token) throw new Error("Your session has expired. Sign in again before saving.");
      await dashboardRequest(`/api/dashboard/operations/${encodeURIComponent(operation.reference)}/correction`, data.session.access_token, {
        method: "PATCH",
        body: { expectedUpdatedAt: operation.updatedAt, fields },
      });
      startTransition(() => router.refresh());
      setMessage("Correction recorded in the operation audit trail.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The correction could not be saved.");
    }
  }

  return (
    <section className="detail-section operation-correction" aria-labelledby="correction-heading">
      <div className="section-heading-row">
        <div>
          <h2 id="correction-heading">Correct operation details</h2>
          <p>Available before mandate authorization. Saving records the exact before-and-after values.</p>
        </div>
      </div>
      <form onSubmit={(event) => void submit(event)} className="ledger-form ledger-form-grid">
        <label>Container<input name="containerType" defaultValue={operation.containerType ?? ""} /></label>
        <label>Gross weight (kg)<input name="grossWeightKg" type="number" min="0.001" step="0.001" defaultValue={operation.grossWeightKg ?? ""} /></label>
        <label>Pickup<input name="pickupLocation" defaultValue={operation.pickupLocation ?? ""} /></label>
        <label>Delivery<input name="deliveryLocation" defaultValue={operation.deliveryLocation ?? ""} /></label>
        <label>Empty return<input name="emptyReturnDepot" defaultValue={operation.emptyReturnDepot ?? ""} /></label>
        <label>Operating constraints<textarea name="operationalConstraints" defaultValue={operation.operationalConstraints.join("\n")} placeholder="One condition per line" rows={3} /></label>
        <label className="ledger-form-wide">Cargo notes<textarea name="cargoNotes" defaultValue={operation.cargoNotes ?? ""} rows={3} placeholder="No note recorded" /></label>
        <div className="ledger-form-actions ledger-form-wide">
          <button type="submit" disabled={isPending}>{isPending ? "Recording correction" : "Record correction"}</button>
          {message && <p className={message.startsWith("Correction") ? "inline-form-success" : "inline-form-error"} role="status">{message}</p>}
        </div>
      </form>
    </section>
  );
}
