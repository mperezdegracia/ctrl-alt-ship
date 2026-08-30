import type { Express, Response } from "express";

import { StructuredLogger } from "../../observability/logger";
import {
  getDashboardOperationDossier,
  getDashboardOperationRevision,
  getDashboardRevision,
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

const STREAM_POLL_INTERVAL_MS = 2_500;
const STREAM_HEARTBEAT_INTERVAL_MS = 20_000;

function streamEvent(res: Response, type: string, payload: Record<string, string>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
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

  app.get("/api/dashboard/stream", requireDashboardAuth, async (req: DashboardRequest, res) => {
    try {
      let revision = await getDashboardRevision();
      res.status(200);
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      streamEvent(res, "ready", { scope: "dashboard" });

      let checking = false;
      const poll = async () => {
        if (checking) return;
        checking = true;
        try {
          const nextRevision = await getDashboardRevision();
          if (nextRevision !== revision) {
            revision = nextRevision;
            streamEvent(res, "dashboard.changed", { scope: "dashboard" });
          }
        } catch (error) {
          logger.error("dashboard.stream_failed", { user_id: req.dashboardUser?.id, error });
          streamEvent(res, "stream.error", { scope: "dashboard" });
        } finally {
          checking = false;
        }
      };
      const pollTimer = setInterval(() => { void poll(); }, STREAM_POLL_INTERVAL_MS);
      const heartbeatTimer = setInterval(() => { res.write(": keep-alive\n\n"); }, STREAM_HEARTBEAT_INTERVAL_MS);
      const close = () => {
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
      };
      req.on("close", close);
      res.on("close", close);
    } catch (error) {
      logger.error("dashboard.stream_setup_failed", { user_id: req.dashboardUser?.id, error });
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

  app.get("/api/dashboard/operations/:reference/stream", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const reference = Array.isArray(req.params.reference) ? req.params.reference[0] : req.params.reference;
    if (!reference) {
      res.status(400).json({ error: "invalid_operation_reference" });
      return;
    }

    try {
      let revision = await getDashboardOperationRevision(reference);
      if (!revision) {
        res.status(404).json({ error: "operation_not_found" });
        return;
      }

      res.status(200);
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      streamEvent(res, "ready", { reference });

      let checking = false;
      const poll = async () => {
        if (checking) return;
        checking = true;
        try {
          const nextRevision = await getDashboardOperationRevision(reference);
          if (!nextRevision) {
            streamEvent(res, "operation.removed", { reference });
            return;
          }
          if (nextRevision !== revision) {
            revision = nextRevision;
            streamEvent(res, "operation.changed", { reference });
          }
        } catch (error) {
          logger.error("dashboard.operation_stream_failed", {
            user_id: req.dashboardUser?.id,
            reference,
            error,
          });
          streamEvent(res, "stream.error", { reference });
        } finally {
          checking = false;
        }
      };
      const pollTimer = setInterval(() => { void poll(); }, STREAM_POLL_INTERVAL_MS);
      const heartbeatTimer = setInterval(() => { res.write(": keep-alive\n\n"); }, STREAM_HEARTBEAT_INTERVAL_MS);
      const close = () => {
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
      };
      req.on("close", close);
      res.on("close", close);
    } catch (error) {
      logger.error("dashboard.operation_stream_setup_failed", {
        user_id: req.dashboardUser?.id,
        reference,
        error,
      });
      sendDashboardError(res, error);
    }
  });
}
