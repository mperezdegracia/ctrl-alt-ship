import type { Express, Response } from "express";
import { z } from "zod";

import { StructuredLogger } from "../../observability/logger";
import {
  getDashboardOperationDossier,
  getDashboardCallEvidence,
  getDashboardOperationRevision,
  getDashboardRevision,
  listDashboardOperationsPage,
} from "../../tango/supabase/dashboard";
import {
  DashboardConsoleError,
  correctDashboardOperation,
  createDirectoryEntry,
  createHandoffRecipient,
  createSavedView,
  deleteSavedView,
  listDashboardEscalations,
  listDashboardHandoffs,
  listDirectoryEntries,
  listHandoffRecipients,
  listSavedViews,
  resolveDashboardEscalation,
  updateDirectoryEntry,
  updateHandoffRecipient,
} from "../../tango/supabase/dashboard-console";
import {
  requireDashboardAuth,
  type DashboardRequest,
} from "../middleware/require-dashboard-auth";

function sendDashboardError(res: Response, error: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  if (error instanceof DashboardConsoleError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "dashboard_data_unavailable" });
}

const STREAM_POLL_INTERVAL_MS = 2_500;
const STREAM_HEARTBEAT_INTERVAL_MS = 20_000;

function streamEvent(res: Response, type: string, payload: Record<string, string>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const uuidSchema = z.string().uuid();
const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(120).optional(),
});
const operationsQuerySchema = pageQuerySchema.extend({
  status: z.enum([
    "draft", "collecting_details", "sourcing", "quotes_received", "quote_selected", "booking_pending",
    "booking_confirmed", "notifications_sent", "needs_follow_up", "cancelled", "failed",
  ]).optional(),
  attention: z.enum(["true", "false"]).optional(),
});
const escalationsQuerySchema = pageQuerySchema.extend({
  status: z.enum(["active", "started", "supervisor_joined", "resolved", "failed"]).optional(),
});
const directoryQuerySchema = pageQuerySchema.extend({
  active: z.enum(["true", "false"]).optional(),
});
const operationFieldsSchema = z.object({
  containerType: z.string().trim().min(1).max(120).optional(),
  grossWeightKg: z.number().positive().max(999_999_999.999).optional(),
  pickupLocation: z.string().trim().min(1).max(500).optional(),
  deliveryLocation: z.string().trim().min(1).max(500).optional(),
  emptyReturnDepot: z.string().trim().min(1).max(500).optional(),
  operationalConstraints: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  cargoNotes: z.string().trim().min(1).max(5_000).nullable().optional(),
}).refine((fields) => Object.values(fields).some((value) => value !== undefined), {
  message: "At least one operation field is required.",
});
const operationCorrectionSchema = z.object({
  expectedUpdatedAt: z.string().min(1).max(100),
  fields: operationFieldsSchema,
});
const escalationResolutionSchema = z.object({
  resolution: z.enum(["approved", "rejected", "follow_up"]),
  note: z.string().trim().min(1).max(2_000),
});
const counterpartyBaseSchema = z.object({
  name: z.string().trim().min(1).max(240),
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  email: z.string().trim().email().max(320).nullable().optional(),
  authorized: z.boolean().optional(),
  active: z.boolean().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});
const counterpartyUpdateSchema = counterpartyBaseSchema.partial().extend({
  expectedUpdatedAt: z.string().min(1).max(100),
}).refine((body) => Object.entries(body).some(([key, value]) => key !== "expectedUpdatedAt" && value !== undefined), {
  message: "At least one directory field is required.",
});
const handoffRecipientBaseSchema = z.object({
  name: z.string().trim().min(1).max(240),
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  role: z.enum(["supervisor", "operator"]),
  priority: z.number().int().min(1).max(32_767),
});
const handoffRecipientUpdateSchema = handoffRecipientBaseSchema.partial().extend({
  active: z.boolean().optional(),
  expectedUpdatedAt: z.string().min(1).max(100),
}).refine((body) => Object.entries(body).some(([key, value]) => key !== "expectedUpdatedAt" && value !== undefined), {
  message: "At least one handoff recipient field is required.",
});
const savedViewSchema = z.object({
  scope: z.enum(["operations", "escalations"]),
  name: z.string().trim().min(1).max(80),
  configuration: z.record(z.string(), z.unknown()),
});

function invalidRequest(res: Response, issue: string): void {
  res.status(400).json({ error: issue });
}

function routeParameter(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function registerDashboardRoutes(app: Express, logger: StructuredLogger): void {
  app.get("/api/dashboard/operations", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const query = operationsQuerySchema.safeParse(req.query);
    if (!query.success) {
      invalidRequest(res, "invalid_operations_query");
      return;
    }
    try {
      const page = await listDashboardOperationsPage({
        page: query.data.page,
        perPage: query.data.per_page,
        search: query.data.q,
        status: query.data.status,
        attention: query.data.attention === "true",
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ operations: page.items, pagination: {
        page: page.page, perPage: page.perPage, total: page.total, totalPages: page.totalPages,
      } });
    } catch (error) {
      logger.error("dashboard.operations_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.get("/api/dashboard/handoffs", requireDashboardAuth, async (req: DashboardRequest, res) => {
    try {
      const handoffs = await listDashboardHandoffs();
      res.setHeader("Cache-Control", "no-store");
      res.json({ handoffs });
    } catch (error) {
      logger.error("dashboard.handoffs_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.get("/api/dashboard/escalations", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const query = escalationsQuerySchema.safeParse(req.query);
    if (!query.success) {
      invalidRequest(res, "invalid_escalations_query");
      return;
    }
    try {
      const page = await listDashboardEscalations({
        page: query.data.page, perPage: query.data.per_page, search: query.data.q, status: query.data.status,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ escalations: page.items, pagination: {
        page: page.page, perPage: page.perPage, total: page.total, totalPages: page.totalPages,
      } });
    } catch (error) {
      logger.error("dashboard.escalations_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.patch("/api/dashboard/escalations/:id/resolve", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const id = routeParameter(req.params.id);
    const body = escalationResolutionSchema.safeParse(req.body);
    if (!id || !uuidSchema.safeParse(id).success || !body.success) {
      invalidRequest(res, "invalid_escalation_resolution");
      return;
    }
    try {
      await resolveDashboardEscalation({ escalationId: id, ...body.data, actorUserId: req.dashboardUser!.id });
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    } catch (error) {
      logger.error("dashboard.escalation_resolution_failed", { user_id: req.dashboardUser?.id, escalation_id: id, error });
      sendDashboardError(res, error);
    }
  });

  app.get("/api/dashboard/directory/:kind", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const kind = routeParameter(req.params.kind);
    const query = directoryQuerySchema.safeParse(req.query);
    if ((kind !== "contacts" && kind !== "providers") || !query.success) {
      invalidRequest(res, "invalid_directory_query");
      return;
    }
    try {
      const page = await listDirectoryEntries(kind, {
        page: query.data.page, perPage: query.data.per_page, search: query.data.q,
        active: query.data.active === undefined ? undefined : query.data.active === "true",
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ entries: page.items, pagination: {
        page: page.page, perPage: page.perPage, total: page.total, totalPages: page.totalPages,
      } });
    } catch (error) {
      logger.error("dashboard.directory_list_failed", { user_id: req.dashboardUser?.id, kind, error });
      sendDashboardError(res, error);
    }
  });

  app.post("/api/dashboard/directory/:kind", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const kind = routeParameter(req.params.kind);
    const body = counterpartyBaseSchema.safeParse(req.body);
    if ((kind !== "contacts" && kind !== "providers") || !body.success) {
      invalidRequest(res, "invalid_directory_entry");
      return;
    }
    if ((kind === "contacts" && body.data.capabilities !== undefined) || (kind === "providers" && body.data.authorized !== undefined)) {
      invalidRequest(res, "invalid_directory_entry");
      return;
    }
    try {
      const entry = await createDirectoryEntry(kind, body.data, req.dashboardUser!.id);
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ entry });
    } catch (error) {
      logger.error("dashboard.directory_create_failed", { user_id: req.dashboardUser?.id, kind, error });
      sendDashboardError(res, error);
    }
  });

  app.patch("/api/dashboard/directory/:kind/:id", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const kind = routeParameter(req.params.kind);
    const id = routeParameter(req.params.id);
    const body = counterpartyUpdateSchema.safeParse(req.body);
    if ((kind !== "contacts" && kind !== "providers") || !id || !uuidSchema.safeParse(id).success || !body.success) {
      invalidRequest(res, "invalid_directory_update");
      return;
    }
    if ((kind === "contacts" && body.data.capabilities !== undefined) || (kind === "providers" && body.data.authorized !== undefined)) {
      invalidRequest(res, "invalid_directory_update");
      return;
    }
    const { expectedUpdatedAt, ...fields } = body.data;
    try {
      const entry = await updateDirectoryEntry(kind, id, expectedUpdatedAt, fields, req.dashboardUser!.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ entry });
    } catch (error) {
      logger.error("dashboard.directory_update_failed", { user_id: req.dashboardUser?.id, kind, entry_id: id, error });
      sendDashboardError(res, error);
    }
  });

  app.get("/api/dashboard/handoff-recipients", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const query = directoryQuerySchema.safeParse(req.query);
    if (!query.success) {
      invalidRequest(res, "invalid_handoff_recipient_query");
      return;
    }
    try {
      const page = await listHandoffRecipients({
        page: query.data.page, perPage: query.data.per_page, search: query.data.q,
        active: query.data.active === undefined ? undefined : query.data.active === "true",
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ recipients: page.items, pagination: {
        page: page.page, perPage: page.perPage, total: page.total, totalPages: page.totalPages,
      } });
    } catch (error) {
      logger.error("dashboard.handoff_recipients_list_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.post("/api/dashboard/handoff-recipients", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const body = handoffRecipientBaseSchema.safeParse(req.body);
    if (!body.success) {
      invalidRequest(res, "invalid_handoff_recipient");
      return;
    }
    try {
      const recipient = await createHandoffRecipient(body.data, req.dashboardUser!.id);
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ recipient });
    } catch (error) {
      logger.error("dashboard.handoff_recipient_create_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.patch("/api/dashboard/handoff-recipients/:id", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const id = routeParameter(req.params.id);
    const body = handoffRecipientUpdateSchema.safeParse(req.body);
    if (!id || !uuidSchema.safeParse(id).success || !body.success) {
      invalidRequest(res, "invalid_handoff_recipient_update");
      return;
    }
    const { expectedUpdatedAt, ...fields } = body.data;
    try {
      const recipient = await updateHandoffRecipient(id, expectedUpdatedAt, fields, req.dashboardUser!.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ recipient });
    } catch (error) {
      logger.error("dashboard.handoff_recipient_update_failed", { user_id: req.dashboardUser?.id, recipient_id: id, error });
      sendDashboardError(res, error);
    }
  });

  app.get("/api/dashboard/saved-views", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const scope = z.enum(["operations", "escalations"]).safeParse(req.query.scope);
    if (!scope.success) {
      invalidRequest(res, "invalid_saved_view_scope");
      return;
    }
    try {
      const views = await listSavedViews(req.dashboardUser!.id, scope.data);
      res.setHeader("Cache-Control", "no-store");
      res.json({ views });
    } catch (error) {
      logger.error("dashboard.saved_views_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.post("/api/dashboard/saved-views", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const body = savedViewSchema.safeParse(req.body);
    if (!body.success) {
      invalidRequest(res, "invalid_saved_view");
      return;
    }
    try {
      const view = await createSavedView(req.dashboardUser!.id, body.data);
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ view });
    } catch (error) {
      logger.error("dashboard.saved_view_create_failed", { user_id: req.dashboardUser?.id, error });
      sendDashboardError(res, error);
    }
  });

  app.delete("/api/dashboard/saved-views/:id", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const id = routeParameter(req.params.id);
    if (!id || !uuidSchema.safeParse(id).success) {
      invalidRequest(res, "invalid_saved_view");
      return;
    }
    try {
      await deleteSavedView(req.dashboardUser!.id, id);
      res.status(204).end();
    } catch (error) {
      logger.error("dashboard.saved_view_delete_failed", { user_id: req.dashboardUser?.id, view_id: id, error });
      sendDashboardError(res, error);
    }
  });

  app.patch("/api/dashboard/operations/:reference/correction", requireDashboardAuth, async (req: DashboardRequest, res) => {
    const reference = routeParameter(req.params.reference);
    const body = operationCorrectionSchema.safeParse(req.body);
    if (!reference || !/^OP-[0-9]{6,}$/.test(reference) || !body.success) {
      invalidRequest(res, "invalid_operation_correction");
      return;
    }
    try {
      await correctDashboardOperation({ reference, ...body.data, actorUserId: req.dashboardUser!.id });
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    } catch (error) {
      logger.error("dashboard.operation_correction_failed", { user_id: req.dashboardUser?.id, reference, error });
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

  app.get("/api/dashboard/operations/:reference/evidence", requireDashboardAuth, async (req: DashboardRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reference = routeParameter(req.params.reference);
    const call = req.query.call;
    if (!reference || !/^OP-[0-9]{6,}$/.test(reference)
      || (call !== undefined && !uuidSchema.safeParse(call).success)) {
      invalidRequest(res, "invalid_evidence_query");
      return;
    }
    try {
      const evidence = await getDashboardCallEvidence(reference, call as string | undefined);
      if (!evidence) { res.status(404).json({ error: "operation_or_call_not_found" }); return; }
      res.json({ evidence });
    } catch (error) {
      logger.error("dashboard.evidence_failed", { user_id: req.dashboardUser?.id, reference, error });
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
