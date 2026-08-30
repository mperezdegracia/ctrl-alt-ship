import type { Express, Response } from "express";

import { StructuredLogger } from "../../observability/logger";
import {
  getDashboardOperationDossier,
  listDashboardOperations,
} from "../../tango/supabase/dashboard";
import {
  requireDashboardAuth,
  type DashboardRequest,
} from "../middleware/require-dashboard-auth";

function sendDashboardError(res: Response, error: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(500).json({ error: "dashboard_data_unavailable" });
}

export function registerDashboardRoutes(app: Express, logger: StructuredLogger): void {
  app.get("/api/dashboard/operations", requireDashboardAuth, async (req: DashboardRequest, res) => {
    try {
      const operations = await listDashboardOperations();
      res.setHeader("Cache-Control", "no-store");
      res.json({ operations });
    } catch (error) {
      logger.error("dashboard.operations_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.get("/api/dashboard/operations/:reference", requireDashboardAuth, async (req: DashboardRequest, res) => {
    try {
      const reference = Array.isArray(req.params.reference) ? req.params.reference[0] : req.params.reference;
      if (!reference) {
        res.status(400).json({ error: "invalid_operation_reference" });
        return;
      }
      const dossier = await getDashboardOperationDossier(reference);
      res.setHeader("Cache-Control", "no-store");
      if (!dossier) {
        res.status(404).json({ error: "operation_not_found" });
        return;
      }
      res.json({ operation: dossier });
    } catch (error) {
      logger.error("dashboard.operation_failed", {
        user_id: req.dashboardUser?.id,
        reference: Array.isArray(req.params.reference) ? req.params.reference[0] : req.params.reference,
        error,
      });
      sendDashboardError(res, error);
    }
  });
}
