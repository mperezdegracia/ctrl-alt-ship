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
import { EscalationTool } from "./tango/tools/mock-escalation-tool";
import { EscalationService, type CreatedEscalation } from "./domain/escalation-service";
import { createTwilioOutboundCall, verifyTwilioSignature } from "./tango/telephony/twilio-outbound";
import { extractOutboundCallRecordId, routeOutboundCall } from "./tango/telephony/outbound-routing";
import { PreviewEmailGateway, SmtpEmailGateway } from "./tango/services/email-gateway";
import { EmailOutboxWorker, SupabaseEmailOutboxRepository } from "./tango/workers/email-outbox-worker";
import { OutboundSourcingLoop } from "./tango/workers/outbound-sourcing-loop";
import { CallEvidenceRetentionWorker } from "./tango/workers/call-evidence-retention-worker";
import { AgentsSourcingJudge } from "./tango/agents/sourcing-judge";
import { SourcingReviewService } from "./tango/services/sourcing-review-service";

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
let outboundWorkerRunning = false;

type ClaimedProviderContact = {
  outbox_id: string;
  operation_id: string;
  quote_request_id: string;
  provider_id: string;
  provider_phone: string;
  purpose: "quote_request" | "renegotiation";
};

function providerPhoneType(capabilities: unknown): "mobile" | "landline" | undefined {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const type = (capabilities as Record<string, unknown>).phone_type;
  return type === "mobile" || type === "landline" ? type : undefined;
}

/**
 * Claim at most one persisted contact per iteration. The loop waits five
 * seconds between iterations, but never waits for a conversation to finish.
 * Each sourcing cycle selects two providers; this is not a global call limit.
 */
async function runOutboundSourcingWorker(): Promise<void> {
  if (outboundWorkerRunning) return;
  outboundWorkerRunning = true;
  try {
    const { data, error } = await supabaseAdmin.rpc("claim_next_provider_contact");
    if (error) throw error;
    const job = (data?.[0] ?? null) as ClaimedProviderContact | null;
    if (job) {
      const jobStarted = Date.now();
      const jobLogger = logger.child({ outbox_id: job.outbox_id, operation_id: job.operation_id,
        quote_request_id: job.quote_request_id, provider_id: job.provider_id });
      jobLogger.info("sourcing.contact_claimed", { purpose: job.purpose, destination_phone_suffix: job.provider_phone.slice(-4) });
      const inserted = await supabaseAdmin.from("calls").insert({
        operation_id: job.operation_id, provider_id: job.provider_id,
        provider_intent: "quote", persona: "provider", direction: "outbound", outcome: "active",
      }).select("id").single();
      if (inserted.error || !inserted.data) throw inserted.error ?? new Error("Could not persist provider call");
      jobLogger.info("sourcing.call_record_created", { call_record_id: inserted.data.id });
      try {
        const provider = await supabaseAdmin.from("providers").select("capabilities").eq("id", job.provider_id).single();
        if (provider.error || !provider.data) throw provider.error ?? new Error("Provider phone type unavailable");
        jobLogger.info("sourcing.dial_requested", { call_record_id: inserted.data.id,
          phone_type: providerPhoneType(provider.data.capabilities) ?? "unspecified" });
        const twilio = await createTwilioOutboundCall({
          to: job.provider_phone, phoneType: providerPhoneType(provider.data.capabilities),
          callRecordId: inserted.data.id, purpose: job.purpose,
        });
        jobLogger.info("sourcing.dial_accepted", { call_record_id: inserted.data.id, twilio_call_sid: twilio.sid,
          duration_ms: Date.now() - jobStarted, human_answer_confirmed: false });
        const { error: updateError } = await supabaseAdmin.from("calls")
          .update({ twilio_call_sid: twilio.sid }).eq("id", inserted.data.id);
        if (updateError) throw updateError;
        const { error: finishedError } = await supabaseAdmin.rpc("finish_provider_contact", {
          p_outbox_id: job.outbox_id, p_call_id: inserted.data.id, p_twilio_call_sid: twilio.sid,
        });
        if (finishedError) throw finishedError;
        logger.info("sourcing.provider_call_started", { operation_id: job.operation_id, quote_request_id: job.quote_request_id, call_id: inserted.data.id });
      } catch (error) {
        const { error: persistError } = await supabaseAdmin.from("calls").update({ outcome: "failed", ended_at: new Date().toISOString() }).eq("id", inserted.data.id);
        if (persistError) jobLogger.error("sourcing.call_failure_persist_failed", { error: persistError, call_record_id: inserted.data.id });
        const { error: finishError } = await supabaseAdmin.rpc("finish_provider_contact", {
          p_outbox_id: job.outbox_id, p_call_id: inserted.data.id, p_twilio_call_sid: null,
          p_error: error instanceof Error ? error.message.slice(0, 500) : "outbound_call_failed",
        });
        if (finishError) logger.error("sourcing.provider_call_retry_failed", { error: finishError, outbox_id: job.outbox_id });
        else jobLogger.info("sourcing.contact_failure_recorded", { call_record_id: inserted.data.id, duration_ms: Date.now() - jobStarted });
        logger.error("sourcing.provider_call_failed", { error, operation_id: job.operation_id, quote_request_id: job.quote_request_id });
      }
    }
    const { data: sourcing, error: sourcingError } = await supabaseAdmin.from("operations").select("id").in("status", ["sourcing", "quotes_received"]);
    if (sourcingError) throw sourcingError;
    sourcingDiagnostics.retain(["worker", ...(sourcing ?? []).map(({ id }) => id)]);
    sourcingDiagnostics.observe("worker", "sourcing.worker_heartbeat", { active_operations: sourcing?.length ?? 0 });
    await Promise.all((sourcing ?? []).map(async ({ id }) => {
      try {
        const decision = await sourcingReview.finalize(id);
        sourcingDiagnostics.observe(id, "sourcing.decision", { operation_id: id,
          finalized: decision?.finalized ?? false, reason: decision?.reason ?? null,
          booking_id: decision?.booking_id ?? null, review_id: decision?.review_id ?? null });
      } catch (error) {
        logger.error("sourcing.finalize_failed", { error, operation_id: id });
      }
    }));
  } catch (error) {
    logger.error("sourcing.worker_failed", { error });
  } finally {
    outboundWorkerRunning = false;
  }
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
    logger.warn("outbound_call.unauthorized");
    return res.sendStatus(401);
  }
  const body = req.body as { operation_id?: string; provider_id?: string; purpose?: "quote_request" | "renegotiation" };
  if (!body.operation_id || !body.provider_id || !body.purpose) return res.status(400).json({ error: "invalid_outbound_call" });
  logger.info("outbound_call.requested", { operation_id: body.operation_id, provider_id: body.provider_id, purpose: body.purpose });
  const provider = await supabaseAdmin.from("providers").select("phone,active,capabilities").eq("id", body.provider_id).single();
  if (provider.error || !provider.data?.active) return res.status(404).json({ error: "active_provider_not_found" });
  const call = await supabaseAdmin.from("calls").insert({ operation_id: body.operation_id, provider_id: body.provider_id, provider_intent: "quote", persona: "provider", direction: "outbound", outcome: "active" }).select("id").single();
  if (call.error || !call.data) return res.status(502).json({ error: "outbound_call_persist_failed" });
  try {
    const twilio = await createTwilioOutboundCall({
      to: provider.data.phone, phoneType: providerPhoneType(provider.data.capabilities),
      callRecordId: call.data.id, purpose: body.purpose,
    });
    await supabaseAdmin.from("calls").update({ twilio_call_sid: twilio.sid }).eq("id", call.data.id);
    return res.status(202).json({ call_id: call.data.id, twilio_call_sid: twilio.sid });
  } catch (error) {
    await supabaseAdmin.from("calls").update({ outcome: "failed", ended_at: new Date().toISOString() }).eq("id", call.data.id);
    logger.error("outbound_call.failed", { error });
    return res.status(502).json({
      error: "twilio_outbound_call_failed",
      detail: error instanceof Error ? error.message : "unknown_twilio_error",
    });
  }
});

app.post("/twilio/recording-status", (req, res) => {
  const baseUrl = environment.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl || !verifyTwilioSignature(`${baseUrl}${req.originalUrl}`, req.body as Record<string, string>, req.header("x-twilio-signature") ?? undefined)) {
    logger.warn("twilio.callback_rejected", { route: "recording-status", base_url_configured: Boolean(baseUrl) });
    return res.sendStatus(403);
  }
  const body = req.body as { CallSid?: string; RecordingSid?: string; RecordingStatus?: string };
  const status = body.RecordingStatus === "completed" ? "completed" : body.RecordingStatus === "absent" ? "absent" : "failed";
  logger.info("twilio.recording_status_received", { twilio_call_sid: body.CallSid, recording_sid: body.RecordingSid, status });
  if (body.CallSid) void supabaseAdmin.from("calls").update({
    recording_sid: body.RecordingSid ?? null, recording_status: status,
    recording_completed_at: status === "completed" ? new Date().toISOString() : null,
  }).eq("twilio_call_sid", body.CallSid);
  return res.sendStatus(204);
});

app.post("/twilio/call-status", (req, res) => {
  const baseUrl = environment.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl || !verifyTwilioSignature(`${baseUrl}${req.originalUrl}`, req.body as Record<string, string>, req.header("x-twilio-signature") ?? undefined)) {
    logger.warn("twilio.callback_rejected", { route: "call-status", base_url_configured: Boolean(baseUrl) });
    return res.sendStatus(403);
  }
  const body = req.body as { CallSid?: string; CallStatus?: string };
  logger.info("twilio.call_status_received", { twilio_call_sid: body.CallSid, status: body.CallStatus });
  if (body.CallSid && body.CallStatus) {
    const outcome = body.CallStatus === "completed" ? "completed" : "failed";
    void supabaseAdmin.from("calls").update({ outcome, ended_at: new Date().toISOString() }).eq("twilio_call_sid", body.CallSid);
  }
  return res.sendStatus(204);
});

// Temporary protected endpoint. It proves the dashboard auth boundary before
// the dashboard routes exist. Voice webhooks deliberately do not use it.
app.get("/api/me", requireDashboardAuth, (req: DashboardRequest, res) => {
  res.json({ user: req.dashboardUser });
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
    const outboundId = extractOutboundCallRecordId((event as IncomingCallEvent).data.sip_headers);
    const routingStarted = Date.now();
    callLogger.info("call.routing_started", { direction: outboundId ? "outbound" : "inbound", call_record_id: outboundId });
    try {
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

    const toolScope = {
      callId: persistedCallId,
      realtimeCallId: callId,
      persona: routingDecision.identity.persona,
      counterpartyId: routingDecision.identity.persona === "client"
        ? routingDecision.identity.contactId
        : routingDecision.identity.providerId,
    } as const;
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
    const escalationTool = new EscalationTool(
      new EscalationService(toolScope, escalationRepository),
      prepareHandoff,
    );
    const realtimeTools = callToolFactory.create(toolScope, escalationTool);
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
            callLogger.info("audio.speech_started", { escalation_prepared: handoffCoordinator.prepared,
              refer_accepted: handoffCoordinator.referAccepted });
            break;

          case "input_audio_buffer.speech_stopped":
            callLogger.info("audio.speech_stopped");
            break;

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DEL USUARIO
           * --------------------------------------------------------
           */

          case "conversation.item.input_audio_transcription.completed":
            callLogger.info("transcript.caller_completed", {
              item_id: message.item_id, character_count: message.transcript.length,
            });
            await transcriptRepository.record({
              callId: persistedCallId,
              realtimeCallId: callId,
              speaker: "caller",
              content: message.transcript,
              realtimeItemId: message.item_id,
            });
            break;

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

          case "response.output_audio_transcript.done":
            callLogger.info("transcript.tango_completed", {
              response_id: message.response_id, character_count: message.transcript.length,
            });
            await transcriptRepository.record({
              callId: persistedCallId,
              realtimeCallId: callId,
              speaker: "tango",
              content: message.transcript,
              realtimeResponseId: message.response_id,
            });
            break;

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
        callLogger.error("realtime.event_handler_failed", { error });
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
    provider_quote_tools_enabled: true,
    deploy_commit: process.env.RENDER_GIT_COMMIT ?? "local",
    escalation_routing: "database-managed",
    outbound_configuration_complete: Boolean(environment.TWILIO_ACCOUNT_SID && environment.TWILIO_AUTH_TOKEN
      && environment.TWILIO_FROM_NUMBER && environment.PUBLIC_BASE_URL && environment.OPENAI_PROJECT_ID),
  });
  if (environment.EMAIL_WORKER_ENABLED) {
    emailWorker.start(environment.EMAIL_WORKER_POLL_INTERVAL_MS);
  }
  void outboundSourcingLoop.start();
  evidenceRetentionWorker.start();
});
