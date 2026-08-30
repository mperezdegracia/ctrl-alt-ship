import express from "express";
import OpenAI from "openai";

import { environment } from "./config/environment";
import { supabaseAdmin } from "./config/supabase";
import { publicToolError, ToolError } from "./domain/tool-error";
import {
  requireDashboardAuth,
  type DashboardRequest,
} from "./http/middleware/require-dashboard-auth";
import { registerDashboardRoutes } from "./http/routes/dashboard";
import { StructuredLogger } from "./observability/logger";
import { RealtimeSessionFactory } from "./tango/realtime/realtime-session";
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
import { OpenAIRealtimeGateway } from "./tango/realtime/openai-realtime-gateway";
import { ConfirmationEvidenceTracker } from "./tango/realtime/confirmation-evidence-tracker";
import { TwilioGateway } from "./tango/telephony/twilio-gateway";
import { EscalationHandoffCoordinator } from "./tango/telephony/escalation-handoff-coordinator";
import { MockEscalationTool } from "./tango/tools/mock-escalation-tool";
import { NegotiationStallTracker } from "./tango/telephony/negotiation-stall-tracker";
import { RealtimeSessionDiagnostics } from "./tango/realtime/realtime-session-diagnostics";

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
const realtimeSessionFactory = new RealtimeSessionFactory();
const callToolFactory = new CallToolFactory(
  new SupabaseOperationReadRepository(supabaseAdmin),
  environment.CLIENT_OPERATION_TOOLS_ENABLED
    ? new SupabaseClientOperationRepository(supabaseAdmin) : undefined,
);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const realtimeGateway = new OpenAIRealtimeGateway(openai);
// Temporary trial-by-fire destination. Replace with SUPERVISOR_PHONE when the
// durable escalation service is enabled.
const MOCK_SUPERVISOR_PHONE = "+5491132555829";
const twilioGateway = new TwilioGateway({
  accountSid: environment.TWILIO_ACCOUNT_SID!,
  authToken: environment.TWILIO_AUTH_TOKEN!,
  fromNumber: environment.TWILIO_FROM_NUMBER!,
  publicBaseUrl: environment.PUBLIC_BASE_URL!,
});

async function rejectRealtimeCall(callId: string): Promise<void> {
  await realtimeGateway.reject(callId);
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
    try {
      routingDecision = await routeIncomingCall(event as IncomingCallEvent, {
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
      persona: routingDecision.identity.persona,
      counterparty_name: routingDecision.identity.name,
      caller_phone_suffix: routingDecision.callerPhone.slice(-4),
      candidate_operations: routingDecision.operations.map((operation) => operation.reference),
    });

    let persistedCallId: string;
    try {
      persistedCallId = await persistRoutedCall(routingDecision);
      callLogger.info("call.routing_persisted");
    } catch (error) {
      callLogger.error("call.routing_persist_failed", { error });
      await rejectRealtimeCall(callId);
      callLogger.warn("call.rejected", { reason: "routing_persist_failed", sip_status: 603 });
      res.sendStatus(200);
      return;
    }

    const handoffCoordinator = twilioGateway && routingDecision.identity.persona === "provider"
      ? new EscalationHandoffCoordinator(twilioGateway) : undefined;
    const stallTracker = handoffCoordinator
      ? new NegotiationStallTracker(environment.ESCALATION_STALLED_TURNS) : undefined;
    let stalledEscalationPending = false;
    const prepareMockHandoff = async (request: { operationReference?: string; trigger: string; reason: string }) => {
      if (!handoffCoordinator || handoffCoordinator.prepared) return;
      const operationReference = request.operationReference
        ?? routingDecision.operations[0]?.reference
        ?? "current-operation";
      const publicBaseUrl = environment.PUBLIC_BASE_URL!;
      const dashboardUrl = new URL(`/dashboard/operations/${encodeURIComponent(operationReference)}`, publicBaseUrl).toString();
      await handoffCoordinator.prepare({
        callSid: routingDecision.twilioCallSid,
        conferenceName: `tango-escalation-${persistedCallId}`,
        supervisorPhone: MOCK_SUPERVISOR_PHONE,
        summary: `Tango escalation\nOperation: ${operationReference}\nTrigger: ${request.trigger}\nReason: ${request.reason}\nReview: ${dashboardUrl}`,
        conferenceStatusCallbackUrl: new URL(`/twilio/conference-events?call_id=${encodeURIComponent(persistedCallId)}`, publicBaseUrl).toString(),
        participantStatusCallbackUrl: new URL(`/twilio/participant-events?call_id=${encodeURIComponent(persistedCallId)}`, publicBaseUrl).toString(),
        recordingStatusCallbackUrl: new URL(`/twilio/recording-events?call_id=${encodeURIComponent(persistedCallId)}`, publicBaseUrl).toString(),
      });
    };
    const escalationTool = handoffCoordinator
      ? new MockEscalationTool(prepareMockHandoff) : undefined;
    const realtimeTools = callToolFactory.create({
      callId: persistedCallId,
      realtimeCallId: callId,
      persona: routingDecision.identity.persona,
      counterpartyId: routingDecision.identity.persona === "client"
        ? routingDecision.identity.contactId
        : routingDecision.identity.providerId,
    }, escalationTool);
    try {
      await realtimeTools.refresh();
      callLogger.info("call.tools_configured", {
        profile: realtimeTools.flowState?.profile ?? "read_only",
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
    const initialConfiguration = realtimeSessionFactory.create(routingDecision, realtimeTools.definitions, realtimeTools.flowState);

    try {
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

    const realtime = realtimeGateway.connectSideband(callId);
    const confirmationEvidence = new ConfirmationEvidenceTracker();
    const sessionDiagnostics = new RealtimeSessionDiagnostics(
      callLogger, initialConfiguration, realtimeTools.flowState?.profile ?? "read_only",
    );

    realtime.socket.on("open", () => {
      callLogger.info("realtime.sideband_connected");

      // Let VAD trigger the first reply after the caller speaks, so the
      // greeting can use their language instead of a forced default.
      callLogger.info("realtime.awaiting_caller_speech", {
        language: "auto",
        persona: routingDecision.identity.persona,
      });
    });

    /*
     * ============================================================
     * 4. EVENTOS REALTIME
     * ============================================================
     */

    realtime.on("event", async (message) => {
      try {
        confirmationEvidence.observe(message);
        callLogger.debug("realtime.event_received", { event_type: message.type });

        switch (message.type) {
          /*
           * --------------------------------------------------------
           * SESSION
           * --------------------------------------------------------
           */

          case "session.created":
          case "session.updated":
            sessionDiagnostics.observe(message);
            break;

          /*
           * --------------------------------------------------------
           * USUARIO HABLANDO
           * --------------------------------------------------------
           */

          case "input_audio_buffer.speech_started":
            callLogger.debug("audio.speech_started");
            break;

          case "input_audio_buffer.speech_stopped":
            callLogger.debug("audio.speech_stopped");
            break;

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DEL USUARIO
           * --------------------------------------------------------
           */

          case "conversation.item.input_audio_transcription.completed":
            if (stallTracker?.recordCallerTurn()) stalledEscalationPending = true;
            callLogger.debug("transcript.caller", {
              transcript: message.transcript,
            });
            break;

          /*
           * --------------------------------------------------------
           * TOOL CALL
           * --------------------------------------------------------
           */

          case "response.function_call_arguments.done": {
            callLogger.info("tool.requested", {
              tool_name: message.name,
              tool_call_id: message.call_id,
              response_id: message.response_id,
              profile: realtimeTools.flowState?.profile ?? "read_only",
              advertised_tools: realtimeTools.definitions.map((tool) => tool.name),
              server_tools: sessionDiagnostics.serverTools,
            });
            callLogger.debug("tool.arguments", {
              tool_name: message.name,
              arguments: message.arguments,
            });

            try {
              let args: unknown;
              try {
                args = JSON.parse(message.arguments);
              } catch {
                throw new ToolError("invalid_arguments", "Tool arguments must be valid JSON matching the tool schema.");
              }
              const evidence = message.name === "confirm_mandate"
                ? confirmationEvidence.capture(message.response_id) : undefined;
              if (message.name === "confirm_mandate") {
                callLogger.info("confirmation.evidence_checked", {
                  tool_call_id: message.call_id,
                  ...confirmationEvidence.diagnostics(message.response_id),
                });
              }
              if (["create_operation", "update_operation"].includes(message.name)) confirmationEvidence.invalidate();
              const result = await realtimeTools.execute(message.name, args, {
                toolCallId: message.call_id, confirmationEvidence: evidence,
              });
              if (message.name === "confirm_mandate") confirmationEvidence.invalidate();
              if (message.name !== "escalate") stallTracker?.recordProgress();

              try {
                await realtimeTools.refresh();
              } catch (error) {
                // The mutation may already be committed. Preserve its success
                // result, but remove tools until state can be refreshed safely.
                callLogger.error("tool.profile_refresh_failed", { error });
              }
              const liveEscalation = message.name === "escalate" && handoffCoordinator;
              realtime.send(sessionDiagnostics.prepareUpdate(realtimeSessionFactory.createFlowUpdate(
                routingDecision, liveEscalation ? [] : realtimeTools.definitions, realtimeTools.flowState,
              ), realtimeTools.flowState, message.call_id));

              callLogger.debug("tool.result", {
                tool_name: message.name,
                result,
              });

              /*
               * ----------------------------------------------------
               * DEVOLVER RESULTADO DE LA TOOL A REALTIME
               * ----------------------------------------------------
               */

              realtime.send({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: message.call_id,
                  output: JSON.stringify(result),
                },
              });

              /*
               * Ahora le decimos al modelo:
               *
               * "Ya tenés el resultado de la tool,
               * continuá respondiendo."
               */

              if (liveEscalation) {
                handoffCoordinator.beginFarewell();
                realtime.send({
                  type: "response.create",
                  response: {
                    instructions: "In the caller's active language, say exactly: I will connect you with my supervisor now. I have shared the relevant context. Do not add any other sentence.",
                  },
                });
              } else {
                realtime.send({ type: "response.create" });
              }

              callLogger.info("tool.completed", {
                tool_name: message.name,
                tool_call_id: message.call_id,
              });
            } catch (error) {
              if (message.name === "confirm_mandate") confirmationEvidence.invalidate();
              callLogger.error("tool.failed", {
                tool_name: message.name,
                tool_call_id: message.call_id,
                error,
              });

              try { await realtimeTools.refresh(); } catch (refreshError) {
                callLogger.error("tool.profile_refresh_failed", { error: refreshError });
              }
              realtime.send(sessionDiagnostics.prepareUpdate(realtimeSessionFactory.createFlowUpdate(
                routingDecision, realtimeTools.definitions, realtimeTools.flowState,
              ), realtimeTools.flowState, message.call_id));

              realtime.send({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: message.call_id,
                  output: JSON.stringify(publicToolError(error)),
                },
              });

              realtime.send({ type: "response.create" });
            }

            break;
          }

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DE TANGO
           * --------------------------------------------------------
           */

          case "response.output_audio_transcript.delta":
            break;

          case "response.created":
            if (message.response.id && handoffCoordinator?.observeResponseCreated(message.response.id)) {
              callLogger.info("escalation.farewell_started", { response_id: message.response.id });
            }
            break;

          case "output_audio_buffer.stopped":
            if (stalledEscalationPending && handoffCoordinator && !handoffCoordinator.prepared) {
              stalledEscalationPending = false;
              await prepareMockHandoff({
                trigger: "negotiation_stalled",
                reason: `No progress after ${environment.ESCALATION_STALLED_TURNS} consecutive caller turns.`,
              });
              handoffCoordinator.beginFarewell();
              realtime.send({ type: "response.create", response: { instructions: "In the caller's active language, say exactly: I will connect you with my supervisor now. I have shared the relevant context. Do not add any other sentence." } });
              break;
            }
            if (await handoffCoordinator?.onAudioStopped(message.response_id)) {
              callLogger.info("escalation.conference_started", { response_id: message.response_id });
            }
            break;

          case "response.output_audio_transcript.done":
            callLogger.debug("transcript.tango", {
              transcript: message.transcript,
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
            });
            break;

        }
      } catch (error) {
        callLogger.error("realtime.event_handler_failed", { error });
      }
    });

    realtime.on("error", (error) => {
      // SDK normalizes API errors, malformed frames and transport errors here.
      callLogger.error("realtime.error", {
        error_type: error.error?.type,
        error_code: error.error?.code,
        event_id: error.event_id,
        error_message: error.message,
      });
    });

    realtime.socket.on("close", (code, reason) => {
      callLogger.info("realtime.sideband_closed", {
        code,
        reason: reason.toString(),
      });
    });
  } catch (error) {
    callLogger.error("call.handling_failed", { error });
    if (!res.headersSent) res.status(500).json({ error: "incoming_call_failed" });
  }
});

const PORT = environment.PORT;

app.listen(PORT, () => {
  logger.info("server.started", {
    port: PORT,
    webhook_path: "/openai/webhook",
    log_level: environment.LOG_LEVEL,
    client_operation_tools_enabled: environment.CLIENT_OPERATION_TOOLS_ENABLED,
    deploy_commit: process.env.RENDER_GIT_COMMIT ?? "local",
  });
});
