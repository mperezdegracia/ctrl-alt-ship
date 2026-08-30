import express from "express";
import OpenAI from "openai";

import { environment } from "./config/environment";
import { supabaseAdmin } from "./config/supabase";
import {
  requireDashboardAuth,
  type DashboardRequest,
} from "./http/middleware/require-dashboard-auth";
import { registerDashboardRoutes } from "./http/routes/dashboard";
import { StructuredLogger } from "./observability/logger";
import { StateTransitionLog } from "./observability/state-transition-log";
import { AgentsCallSession } from "./tango/realtime/agents-call-session";
import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import {
  persistRejectedCall,
  persistRoutedCall,
} from "./tango/supabase/call-routing";
import {
  findCounterpartyByCallerId,
  listActiveOperationsForProvider,
  listOpenOperationsForContact,
} from "./tango/supabase/erp";
import {
  routeIncomingCall,
  type IncomingCallEvent,
} from "./tango/telephony/inbound-routing";
import { SupabaseOperationReadRepository } from "./tango/supabase/operation-read-repository";
import { CallToolFactory } from "./tango/tools/call-tool-factory";
import { SupabaseClientOperationRepository } from "./tango/supabase/client-operation-repository";
import { SupabaseProviderQuoteRepository } from "./tango/supabase/provider-quote-repository";
import { SupabaseProviderBookingRepository } from "./tango/supabase/provider-booking-repository";
import { SupabaseEscalationRepository } from "./tango/supabase/escalation-repository";
import { SupabaseCallTranscriptRepository, SupabaseEscalationHandoffRepository } from "./tango/supabase/call-transcript-repository";
import { OpenAIRealtimeGateway } from "./tango/realtime/openai-realtime-gateway";
import { EscalationHandoffCoordinator } from "./tango/telephony/escalation-handoff-coordinator";
import { EscalationTool, EscalationControlTool } from "./tango/tools/mock-escalation-tool";
import { EscalationService, type CreatedEscalation } from "./domain/escalation-service";
import { ToolError } from "./domain/tool-error";
import { createTwilioOutboundCall, verifyTwilioSignature } from "./tango/telephony/twilio-outbound";
import { extractOutboundCallRecordId, routeOutboundCall } from "./tango/telephony/outbound-routing";
import { PreviewEmailGateway, SmtpEmailGateway } from "./tango/services/email-gateway";
import { EmailOutboxWorker, SupabaseEmailOutboxRepository } from "./tango/workers/email-outbox-worker";
import { PreviewSmsGateway, TwilioSmsGateway } from "./tango/services/sms-gateway";
import { SmsOutboxWorker, SupabaseSmsOutboxRepository } from "./tango/workers/sms-outbox-worker";
import { OutboundSourcingLoop } from "./tango/workers/outbound-sourcing-loop";
import { CallEvidenceRetentionWorker } from "./tango/workers/call-evidence-retention-worker";
import { AgentsSourcingJudge } from "./tango/agents/sourcing-judge";
import { SourcingReviewService } from "./tango/services/sourcing-review-service";
import { isProviderOutboundPurpose } from "./domain/call-flow";
import { resolveCallScope } from "./tango/telephony/call-scope";
import { SupabaseProviderContactRepository } from "./tango/supabase/provider-contact-repository";
import { ProviderContactWorker } from "./tango/workers/provider-contact-worker";
import { ProviderCallStatusHandler, ProviderCallStatusHttpError } from "./tango/telephony/provider-call-status-handler";
import { RecordingStatusHandler, RecordingStatusHttpError } from "./tango/telephony/recording-status-handler";
import { HandoffReferHandler, HandoffReferHttpError } from "./tango/telephony/handoff-refer-handler";
import { HandoffReferRepository } from "./tango/supabase/handoff-refer-repository";

const app = express();

const dashboardOrigins = new Set(
  environment.DASHBOARD_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.header("origin");

  if (origin && dashboardOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.vary("Origin");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

// OpenAI signs the raw request bytes, so its webhook must bypass the JSON
// parser. All other routes retain normal JSON parsing below.
const jsonBodyParser = express.json();

app.use((req, res, next) => {
  if (req.path === "/openai/webhook") {
    next();
    return;
  }

  jsonBodyParser(req, res, next);
});

// Twilio signs form-encoded callback fields; keep OpenAI's raw webhook untouched.
app.use("/twilio", express.urlencoded({ extended: false }));

const OPENAI_API_KEY = environment.OPENAI_API_KEY;
const logger = new StructuredLogger("tango-backend");
const sourcingDiagnostics = new StateTransitionLog(logger);
const callToolFactory = new CallToolFactory(
  new SupabaseOperationReadRepository(supabaseAdmin),
  environment.CLIENT_OPERATION_TOOLS_ENABLED
    ? new SupabaseClientOperationRepository(supabaseAdmin) : undefined,
  new SupabaseProviderQuoteRepository(supabaseAdmin),
  new SupabaseProviderBookingRepository(supabaseAdmin),
  logger,
);
const escalationRepository = new SupabaseEscalationRepository(supabaseAdmin);
const transcriptRepository = new SupabaseCallTranscriptRepository(supabaseAdmin);
const escalationHandoffRepository = new SupabaseEscalationHandoffRepository(supabaseAdmin);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sourcingReview = new SourcingReviewService(supabaseAdmin, new AgentsSourcingJudge(OPENAI_API_KEY), logger);
const realtimeGateway = new OpenAIRealtimeGateway(openai);
const emailGateway = environment.EMAIL_DELIVERY_MODE === "smtp"
  ? new SmtpEmailGateway({
    host: environment.SMTP_HOST!,
    port: environment.SMTP_PORT,
    secure: environment.SMTP_SECURE,
    username: environment.SMTP_USERNAME!,
    password: environment.SMTP_PASSWORD!,
  }, environment.EMAIL_FROM!)
  : new PreviewEmailGateway();
const emailWorker = new EmailOutboxWorker(
  new SupabaseEmailOutboxRepository(supabaseAdmin),
  emailGateway,
  logger.child({ worker: "email_outbox" }),
);
const smsGateway = environment.SMS_DELIVERY_MODE === "twilio"
  ? new TwilioSmsGateway({
    accountSid: environment.TWILIO_ACCOUNT_SID!,
    authToken: environment.TWILIO_AUTH_TOKEN!,
    from: environment.TWILIO_FROM_NUMBER!,
  })
  : new PreviewSmsGateway();
const smsWorker = new SmsOutboxWorker(
  new SupabaseSmsOutboxRepository(supabaseAdmin),
  smsGateway,
  logger.child({ worker: "sms_outbox" }),
);
function providerPhoneType(capabilities: unknown): "mobile" | "landline" | undefined {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const type = (capabilities as Record<string, unknown>).phone_type;
  return type === "mobile" || type === "landline" ? type : undefined;
}

const providerContactRepository = new SupabaseProviderContactRepository(supabaseAdmin);
const providerContactWorker = new ProviderContactWorker({
  repository: providerContactRepository,
  logger,
  dial: async (job) => {
    const provider = await supabaseAdmin.from("providers").select("capabilities,active")
      .eq("id", job.provider_id).single();
    if (provider.error || !provider.data?.active) throw provider.error ?? new Error("Provider unavailable");
    return createTwilioOutboundCall({
      to: job.provider_phone, phoneType: providerPhoneType(provider.data.capabilities),
      callRecordId: job.call_id, purpose: job.purpose,
    });
  },
});
const providerCallStatusHandler = new ProviderCallStatusHandler({
  repository: providerContactRepository,
  expectedAccountSid: environment.TWILIO_ACCOUNT_SID ?? "",
});
const recordingStatusHandler = new RecordingStatusHandler({
  repository: {
    async recordStatus(params) {
      const { data, error } = await supabaseAdmin.rpc("record_call_recording_status", params);
      if (error) throw error;
      return data;
    },
  },
  expectedAccountSid: environment.TWILIO_ACCOUNT_SID ?? "",
  verifySignature: verifyTwilioSignature,
});

/** The existing loop polls once; all dial/retry ownership and slots are durable in SQL. */
async function runOutboundSourcingWorker(): Promise<void> {
  try { await providerContactWorker.runOnce(); }
  catch (error) { logger.error("sourcing.dispatch_failed", { error }); }
  // Rounds must advance even when no job can be claimed (e.g. all candidates ended).
  const { data: operations, error } = await supabaseAdmin.from("operations")
    .select("id").in("status", ["sourcing", "quotes_received"]);
  if (error) throw error;
  sourcingDiagnostics.retain(["worker", ...(operations ?? []).map(({ id }) => id)]);
  sourcingDiagnostics.observe("worker", "sourcing.worker_heartbeat", { active_operations: operations?.length ?? 0 });
  await Promise.all((operations ?? []).map(async ({ id }) => {
    try {
      const round = await providerContactRepository.advance(id);
      const decision = await sourcingReview.finalize(id);
      sourcingDiagnostics.observe(id, "sourcing.decision", {
        operation_id: id, round_id: round.round_id, round_status: round.status,
        operation_status: round.operation_status, reason: decision.reason ?? round.reason,
        finalized: decision.finalized ?? false, booking_id: decision.booking_id ?? null,
      });
    } catch (error) { logger.error("sourcing.finalize_failed", { error, operation_id: id }); }
  }));
}

async function rejectRealtimeCall(callId: string): Promise<void> {
  logger.info("call.reject_requested", { call_id: callId, sip_status: 603 });
  await realtimeGateway.reject(callId);
  logger.info("call.reject_completed", { call_id: callId });
}

app.get("/", (_req, res) => {
  res.send("Tango backend running");
});

app.get("/health", async (_req, res) => {
  const { error } = await supabaseAdmin
    .from("operations")
    .select("id")
    .limit(1);

  if (error) {
    logger.error("health.supabase_failed", { error });
    res.status(503).json({ status: "degraded" });
    return;
  }

  res.json({ status: "ok" });
});

app.post("/calls/outbound", async (req, res) => {
  if (!environment.OUTBOUND_CALLS_TOKEN || req.header("authorization") !== `Bearer ${environment.OUTBOUND_CALLS_TOKEN}`) {
    return res.sendStatus(401);
  }
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.sendStatus(400);
  const input = body as Record<string, unknown>;
  const keys = ["operation_id", "provider_id", "quote_request_id", "round_id", "purpose"];
  if (Object.keys(input).some((key) => !keys.includes(key))
    || keys.some((key) => typeof input[key] !== "string" || !input[key])
    || keys.filter((key) => key !== "purpose").some((key) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input[key])))
    || !isProviderOutboundPurpose(input.purpose)) return res.status(400).json({ error: "durable_outbound_context_required" });
  try {
    const { data: request, error } = await supabaseAdmin.from("quote_requests")
      .select("id,operation_id,provider_id,round_id,status")
      .eq("id", input.quote_request_id).eq("operation_id", input.operation_id)
      .eq("provider_id", input.provider_id).eq("round_id", input.round_id).maybeSingle();
    if (error) throw error;
    if (!request || !["queued", "contacted", "pending", "responded"].includes(request.status)) {
      return res.status(409).json({ error: "outbound_request_not_available" });
    }
    const [round, job] = await Promise.all([
      supabaseAdmin.from("sourcing_rounds").select("id,kind,status")
        .eq("id", request.round_id).eq("operation_id", request.operation_id).maybeSingle(),
      supabaseAdmin.from("outbox").select("id,status")
        .eq("quote_request_id", request.id).eq("job_type", "contact_provider")
        .in("status", ["pending", "processing"]).limit(1).maybeSingle(),
    ]);
    if (round.error || job.error) throw round.error ?? job.error;
    const expectedKind = input.purpose === "booking_replacement" ? "replacement"
      : input.purpose === "renegotiation" ? "renegotiation" : "initial";
    if (round.data?.status !== "active" || round.data.kind !== expectedKind || !job.data) {
      return res.status(409).json({ error: "durable_outbound_job_not_available" });
    }
    // Informational acceptance only. The existing worker owns claim, attempts, and POST.
    return res.status(202).json({ outbox_id: job.data.id, quote_request_id: request.id, status: "queued" });
  } catch (error) {
    logger.error("outbound_call.queue_lookup_failed", { error });
    return res.status(503).json({ error: "outbound_queue_unavailable" });
  }
});

app.post("/twilio/recording-status", async (req, res) => {
  const baseUrl = environment.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl || !environment.TWILIO_ACCOUNT_SID) {
    return res.sendStatus(503);
  }
  try {
    await recordingStatusHandler.handle({
      url: `${baseUrl}${req.originalUrl}`,
      signature: req.header("x-twilio-signature") ?? undefined,
      body: req.body,
    });
    return res.sendStatus(204);
  } catch (error) {
    const status = error instanceof RecordingStatusHttpError ? error.statusCode : 500;
    logger.warn("twilio.recording_status_rejected", { status });
    return res.sendStatus(status);
  }
});

app.post("/twilio/call-status", async (req, res) => {
  const baseUrl = environment.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return res.sendStatus(503);
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.values(body).some((value) => typeof value !== "string")) return res.sendStatus(400);
  const fields = body as Record<string, string>;
  try {
    const result = await providerCallStatusHandler.handle({
      url: `${baseUrl}${req.originalUrl}`,
      signature: req.header("x-twilio-signature") ?? undefined,
      accountSid: fields.AccountSid,
      callRecordId: typeof req.query.call_record_id === "string" ? req.query.call_record_id : undefined,
      body: fields,
    });
    logger.info("twilio.call_status_persisted", {
      call_record_id: req.query.call_record_id, status: fields.CallStatus,
      accepted: result.accepted, retry_scheduled: result.retry_scheduled, next_attempt: result.next_attempt,
    });
    return res.sendStatus(204);
  } catch (error) {
    const status = error instanceof ProviderCallStatusHttpError ? error.statusCode : 500;
    logger.warn("twilio.call_status_rejected", { status });
    return res.sendStatus(status);
  }
});

// Temporary protected endpoint. It proves the dashboard auth boundary before
// the dashboard routes exist. Voice webhooks deliberately do not use it.
app.get("/api/me", requireDashboardAuth, (req: DashboardRequest, res) => {
  res.json({ user: req.dashboardUser });
});

const handoffReferRepository = new HandoffReferRepository(supabaseAdmin);
const handoffReferHandler = new HandoffReferHandler({
  accountSid: environment.TWILIO_ACCOUNT_SID ?? "",
  fromNumber: environment.TWILIO_FROM_NUMBER ?? "",
  baseUrl: environment.PUBLIC_BASE_URL ?? "",
  verifySignature: verifyTwilioSignature,
  find: (callId) => handoffReferRepository.find(callId),
  markFailed: (context, detail) => escalationHandoffRepository.mark({
    escalationId: context.escalationId, sourceCallId: context.sourceCallId,
    status: "transfer_failed", detail,
  }),
  log: (event, fields) => logger.info(event, fields),
});
app.post(["/twilio/handoff-refer", "/twilio/handoff-finished"], async (req, res) => {
  const baseUrl = environment.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return res.sendStatus(503);
  try {
    const twiml = await handoffReferHandler.handle({
      url: `${baseUrl}${req.originalUrl}`, body: req.body,
      signature: req.header("x-twilio-signature") ?? undefined,
      finished: req.path === "/twilio/handoff-finished",
    });
    return res.type("text/xml").send(twiml);
  } catch (error) {
    logger.error("escalation.twilio_callback_failed", { error });
    return res.sendStatus(error instanceof HandoffReferHttpError ? error.statusCode : 500);
  }
});

registerDashboardRoutes(app, logger);

app.post("/openai/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const webhookSecret = environment.OPENAI_WEBHOOK_SECRET;

  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "expected_raw_webhook_body" });
    return;
  }

  let event: { id?: string; type?: string; data?: { call_id?: string } };

  try {
    event = (await openai.webhooks.unwrap(
      req.body.toString("utf8"),
      req.headers,
      webhookSecret
    )) as typeof event;
  } catch (error) {
    logger.warn("webhook.signature_invalid", { error });
    res.status(400).json({ error: "invalid_webhook_signature" });
    return;
  }

  logger.info("webhook.verified", { event_id: event.id, event_type: event.type });

  if (event.type !== "realtime.call.incoming") {
    res.sendStatus(200);
    return;
  }

  const callId = event.data?.call_id;

  if (!callId) {
    logger.warn("webhook.missing_call_id", { event_id: event?.id });
    res.status(400).json({ error: "missing_call_id" });
    return;
  }

  const callLogger = logger.child({ call_id: callId });
  callLogger.info("call.incoming");

  try {
    let routingDecision;
    let outboundId: string | null = null;
    const routingStarted = Date.now();
    try {
      outboundId = extractOutboundCallRecordId((event as IncomingCallEvent).data.sip_headers);
      callLogger.info("call.routing_started", { direction: outboundId ? "outbound" : "inbound", call_record_id: outboundId });
      routingDecision = outboundId
        ? await routeOutboundCall(outboundId, callId, (event as IncomingCallEvent).data.sip_headers?.find((header) => header.name.toLowerCase() === "x-twilio-callsid")?.value ?? "unknown")
        : await routeIncomingCall(event as IncomingCallEvent, {
        findIdentity: findCounterpartyByCallerId,
        listClientOperations: listOpenOperationsForContact,
        listProviderOperations: listActiveOperationsForProvider,
      });
    } catch (error) {
      callLogger.error("call.routing_failed", { error });
      await rejectRealtimeCall(callId);
      callLogger.warn("call.rejected", { reason: "routing_failure", sip_status: 603 });
      res.sendStatus(200);
      return;
    }

    if (routingDecision.action === "reject") {
      try {
        await persistRejectedCall(routingDecision);
      } catch (error) {
        callLogger.error("call.rejection_persist_failed", { error });
      }
      await rejectRealtimeCall(callId);
      callLogger.warn("call.rejected", {
        reason: routingDecision.reason,
        sip_status: 603,
        caller_phone_suffix: routingDecision.callerPhone.slice(-4),
      });
      res.sendStatus(200);
      return;
    }

    callLogger.info("call.routed", {
      duration_ms: Date.now() - routingStarted,
      direction: outboundId ? "outbound" : "inbound",
      purpose: routingDecision.purpose,
      round_id: routingDecision.outbound ? routingDecision.roundId : undefined,
      attempt: routingDecision.outbound ? routingDecision.attempt : undefined,
      persona: routingDecision.identity.persona,
      counterparty_name: routingDecision.identity.name,
      caller_phone_suffix: routingDecision.callerPhone.slice(-4),
      candidate_operations: routingDecision.operations.map((operation) => operation.reference),
    });

    let persistedCallId: string;
    try {
      persistedCallId = await persistRoutedCall(routingDecision);
      callLogger.info("call.routing_persisted", { call_record_id: persistedCallId });
    } catch (error) {
      callLogger.error("call.routing_persist_failed", { error });
      await rejectRealtimeCall(callId);
      callLogger.warn("call.rejected", { reason: "routing_persist_failed", sip_status: 603 });
      res.sendStatus(200);
      return;
    }

    const toolScope = resolveCallScope(routingDecision, persistedCallId);
    const handoffCoordinator = new EscalationHandoffCoordinator(realtimeGateway, callLogger);
    let activeEscalation: CreatedEscalation | undefined;
    const prepareHandoff = async (escalation: CreatedEscalation): Promise<boolean> => {
      activeEscalation = escalation;
      if (!escalation.recipient) {
        callLogger.warn("escalation.handoff_not_configured", {
          escalation_id: escalation.escalationId,
          operation_reference: escalation.operationReference,
        });
        return false;
      }
      if (handoffCoordinator.prepared) return handoffCoordinator.referAccepted === false;
      callLogger.info("escalation.prepare_started", {
        escalation_id: escalation.escalationId,
        operation_reference: escalation.operationReference,
        recipient_role: escalation.recipient.role,
        target_phone_suffix: escalation.recipient.phone.slice(-4),
        context_delivered: true,
      });
      await handoffCoordinator.prepare({
        realtimeCallId: callId,
        supervisorTargetUri: `tel:${escalation.recipient.phone}`,
      });
      callLogger.info("escalation.prepared", {
        escalation_id: escalation.escalationId,
        awaiting: "farewell_audio",
        target_phone_suffix: escalation.recipient.phone.slice(-4),
      });
      return true;
    };
    const escalationService = new EscalationService(toolScope, escalationRepository);
    const escalationTool = new EscalationTool(
      escalationService,
      prepareHandoff,
    );
    const escalationControls = [
      new EscalationControlTool("confirm_escalation", async () => {
        if (!activeEscalation?.recipient || !handoffCoordinator.prepared || !handoffCoordinator.canReturn) {
          throw new ToolError("invalid_transition", "The live transfer is unavailable or has already started. Do not claim a new transfer.");
        }
        return { status: "confirmed", handoff_ready: true };
      }),
      new EscalationControlTool("cancel_escalation", async () => {
        if (!activeEscalation || !handoffCoordinator.canReturn) {
          throw new ToolError("invalid_transition", "The transfer has already started or no handoff is pending. It cannot be cancelled here.");
        }
        const escalation = activeEscalation;
        await handoffCoordinator.cancel(() => escalationService.cancel(escalation.escalationId));
        activeEscalation = undefined;
        callLogger.info("escalation.returned_to_flow", { escalation_id: escalation.escalationId });
        return { status: "cancelled", handoff_ready: false, resumed_previous_flow: true };
      }),
    ];
    const realtimeTools = callToolFactory.create(toolScope, escalationTool, escalationControls);
    try {
      await realtimeTools.refresh();
      callLogger.info("call.tools_configured", {
        profile: realtimeTools.profile,
        tools: realtimeTools.definitions.map((tool) => tool.name),
      });
    } catch (error) {
      callLogger.error("call.tool_state_failed", { error });
      await rejectRealtimeCall(callId);
      res.sendStatus(200);
      return;
    }

    /*
     * ============================================================
     * 1. ACEPTAR LA LLAMADA
     * ============================================================
     */

    const acceptStartedAt = Date.now();
    const agentsCall = new AgentsCallSession(routingDecision, realtimeTools, callLogger, {
      onEscalationReady: () => {
        handoffCoordinator.beginFarewell();
        agentsCall.transport.requestResponse({
          instructions: "In the caller's active language, say in one short sentence that you will connect them with an operator now and that the relevant context has been shared. Do not add anything else.",
        });
      },
    });
    const initialConfiguration = await agentsCall.initialConfiguration();

    try {
      callLogger.info("call.accept_requested", { profile: realtimeTools.profile });
      const accepted = await realtimeGateway.accept(callId,
        initialConfiguration,
      );
      callLogger.info("call.accept_completed", {
        status: accepted.status,
        request_id: accepted.requestId,
        duration_ms: Date.now() - acceptStartedAt,
      });
    } catch (error) {
      callLogger.error("call.accept_failed", {
        status: error instanceof OpenAI.APIError ? error.status : undefined,
        request_id: error instanceof OpenAI.APIError ? error.requestID : undefined,
        duration_ms: Date.now() - acceptStartedAt,
      });
      res.status(502).json({ error: "openai_call_accept_failed" });
      return;
    }

    // Acknowledge the verified webhook without returning server credentials.
    res.sendStatus(200);

    /*
     * ============================================================
     * 2. SIDEBAND WEBSOCKET
     * ============================================================
     */

    const realtime = agentsCall.session;
    realtime.on("transport_event", async (event) => {
      const message = event as RealtimeServerEvent;
      try {
        callLogger.debug("realtime.event_received", { event_type: message.type });

        switch (message.type) {
          /*
           * --------------------------------------------------------
           * SESSION
           * --------------------------------------------------------
           */

          case "session.created":
          case "session.updated":
            // AgentsCallSession records SDK/server configuration diagnostics.
            break;

          /*
           * --------------------------------------------------------
           * USUARIO HABLANDO
           * --------------------------------------------------------
           */

          case "input_audio_buffer.speech_started":
            handoffCoordinator.onCallerSpeechStarted();
            callLogger.info("audio.speech_started", { escalation_prepared: handoffCoordinator.prepared,
              refer_accepted: handoffCoordinator.referAccepted });
            break;

          case "input_audio_buffer.speech_stopped":
            handoffCoordinator.onCallerSpeechStopped();
            callLogger.info("audio.speech_stopped");
            break;

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DEL USUARIO
           * --------------------------------------------------------
           */

          case "conversation.item.input_audio_transcription.completed": {
            const transcript = message.transcript.trim();
            const itemId = message.item_id?.trim();
            if (!transcript || !itemId) {
              callLogger.debug("transcript.skipped", {
                speaker: "caller", reason: transcript ? "missing_item_id" : "empty", item_id: message.item_id,
              });
              break;
            }
            callLogger.info("transcript.caller_completed", {
              item_id: itemId, character_count: transcript.length,
            });
            const transcriptSegmentId = await transcriptRepository.record({
              callId: persistedCallId,
              realtimeCallId: callId,
              speaker: "caller",
              content: transcript,
              realtimeItemId: itemId,
            });
            agentsCall.recordCallerTranscriptSegment(transcriptSegmentId);
            break;
          }

          /*
           * --------------------------------------------------------
           * TOOL CALL
           * --------------------------------------------------------
           */

          // Function calls are executed and returned exclusively by RealtimeSession.

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DE TANGO
           * --------------------------------------------------------
           */

          case "response.output_audio_transcript.delta":
            break;

          case "response.created":
            callLogger.info("realtime.response_started", { response_id: message.response.id,
              refer_accepted: handoffCoordinator.referAccepted });
            if (handoffCoordinator.referAccepted) callLogger.warn("escalation.response_after_refer", {
              response_id: message.response.id, human_answer_confirmed: false });
            if (message.response.id && handoffCoordinator.observeResponseCreated(message.response.id)) {
              callLogger.info("escalation.farewell_started", { response_id: message.response.id });
            }
            break;

          case "output_audio_buffer.stopped": {
            let escalationRefer;
            try {
              escalationRefer = await handoffCoordinator.onAudioStopped(message.response_id);
            } catch (error) {
              if (activeEscalation) {
                try {
                  await escalationHandoffRepository.mark({
                    escalationId: activeEscalation.escalationId,
                    sourceCallId: persistedCallId,
                    status: "transfer_failed",
                    detail: "The voice transfer request failed. The escalation remains open for manual review.",
                  });
                } catch (persistenceError) {
                  callLogger.error("escalation.handoff_failure_persist_failed", { escalation_id: activeEscalation.escalationId, error: persistenceError });
                }
              }
              callLogger.error("escalation.refer_failed", {
                realtime_call_id: callId,
                target_uri_scheme: "tel",
                escalation_id: activeEscalation?.escalationId,
                target_phone_suffix: activeEscalation?.recipient?.phone.slice(-4),
                status: error instanceof OpenAI.APIError ? error.status : undefined,
                request_id: error instanceof OpenAI.APIError ? error.requestID : undefined,
              });
              throw error;
            }
            if (escalationRefer) {
              if (!activeEscalation?.recipient) {
                callLogger.error("escalation.handoff_recipient_missing_after_refer", { realtime_call_id: callId });
                break;
              }
              try {
                await escalationHandoffRepository.mark({
                  escalationId: activeEscalation.escalationId,
                  sourceCallId: persistedCallId,
                  status: "transfer_requested",
                });
              } catch (error) {
                callLogger.error("escalation.handoff_success_persist_failed", { escalation_id: activeEscalation.escalationId, error });
              }
              callLogger.info("escalation.refer_succeeded", {
                response_id: message.response_id,
                realtime_call_id: callId,
                target_uri_scheme: "tel",
                escalation_id: activeEscalation.escalationId,
                target_phone_suffix: activeEscalation.recipient.phone.slice(-4),
                status: escalationRefer.status,
                request_id: escalationRefer.requestId,
                human_answer_confirmed: false,
              });
            }
            break;
          }

          case "response.output_audio_transcript.done": {
            const transcript = message.transcript.trim();
            const responseId = message.response_id?.trim();
            if (!transcript || !responseId) {
              callLogger.debug("transcript.skipped", {
                speaker: "tango", reason: transcript ? "missing_response_id" : "empty", response_id: message.response_id,
              });
              break;
            }
            callLogger.info("transcript.tango_completed", {
              response_id: responseId, character_count: transcript.length,
            });
            await transcriptRepository.record({
              callId: persistedCallId,
              realtimeCallId: callId,
              speaker: "tango",
              content: transcript,
              realtimeResponseId: responseId,
            });
            break;
          }

          /*
           * --------------------------------------------------------
           * RESPONSE TERMINADA
           * --------------------------------------------------------
           */

          case "response.done":
            callLogger.info("realtime.response_completed", {
              response_id: message.response?.id,
              status: message.response?.status,
              refer_accepted: handoffCoordinator.referAccepted,
            });
            break;

        }
      } catch (error) {
        callLogger.error("realtime.event_handler_failed", { event_type: message.type, error });
      }
    });

    callLogger.info("realtime.sideband_connect_requested");
    await agentsCall.connect(callId, OPENAI_API_KEY);
    callLogger.info("realtime.greeting_requested", {
      language: "en", subsequent_language: "caller", persona: routingDecision.identity.persona, runtime: "agents_sdk",
    });
  } catch (error) {
    callLogger.error("call.handling_failed", { error });
    if (!res.headersSent) res.status(500).json({ error: "incoming_call_failed" });
  }
});

const PORT = environment.PORT;
const outboundSourcingLoop = new OutboundSourcingLoop(runOutboundSourcingWorker, logger);
const evidenceRetentionWorker = new CallEvidenceRetentionWorker(supabaseAdmin, { accountSid: environment.TWILIO_ACCOUNT_SID, authToken: environment.TWILIO_AUTH_TOKEN }, logger);

app.listen(PORT, () => {
  logger.info("server.started", {
    port: PORT,
    webhook_path: "/openai/webhook",
    log_level: environment.LOG_LEVEL,
    client_operation_tools_enabled: environment.CLIENT_OPERATION_TOOLS_ENABLED,
    email_delivery_mode: environment.EMAIL_DELIVERY_MODE,
    email_worker_enabled: environment.EMAIL_WORKER_ENABLED,
    sms_delivery_mode: environment.SMS_DELIVERY_MODE,
    sms_worker_enabled: environment.SMS_WORKER_ENABLED,
    provider_quote_tools_enabled: true,
    deploy_commit: process.env.RENDER_GIT_COMMIT ?? "local",
    escalation_routing: "database-managed",
    outbound_configuration_complete: Boolean(environment.TWILIO_ACCOUNT_SID && environment.TWILIO_AUTH_TOKEN
      && environment.TWILIO_FROM_NUMBER && environment.PUBLIC_BASE_URL && environment.OPENAI_PROJECT_ID),
  });
  if (environment.EMAIL_WORKER_ENABLED) {
    emailWorker.start(environment.EMAIL_WORKER_POLL_INTERVAL_MS);
  }
  if (environment.SMS_WORKER_ENABLED) {
    smsWorker.start(environment.SMS_WORKER_POLL_INTERVAL_MS);
  }
  void outboundSourcingLoop.start();
  evidenceRetentionWorker.start();
});
