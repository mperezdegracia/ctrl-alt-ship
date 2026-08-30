import express from "express";
import OpenAI from "openai";
import WebSocket from "ws";

import { environment } from "./config/environment";
import { supabaseAdmin } from "./config/supabase";
import {
  requireDashboardAuth,
  type DashboardRequest,
} from "./http/middleware/require-dashboard-auth";
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
import { OperationStatusTool } from "./tango/tools/operation-status-tool";
import { RealtimeToolRegistry } from "./tango/tools/realtime-tool";

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
const realtimeTools = new RealtimeToolRegistry([
  new OperationStatusTool(),
]);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function rejectRealtimeCall(callId: string): Promise<void> {
  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/reject`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status_code: 603 }),
    },
  );

  if (!response.ok) {
    throw new Error(`OpenAI call rejection failed with status ${response.status}`);
  }
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

    try {
      await persistRoutedCall(routingDecision);
      callLogger.info("call.routing_persisted");
    } catch (error) {
      callLogger.error("call.routing_persist_failed", { error });
      await rejectRealtimeCall(callId);
      callLogger.warn("call.rejected", { reason: "routing_persist_failed", sip_status: 603 });
      res.sendStatus(200);
      return;
    }

    /*
     * ============================================================
     * 1. ACEPTAR LA LLAMADA
     * ============================================================
     */

    const acceptStartedAt = Date.now();

    const acceptResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },

        body: JSON.stringify(
          realtimeSessionFactory.create(routingDecision, realtimeTools.definitions),
        ),
      }
    );

    const acceptText = await acceptResponse.text();

    callLogger.info("call.accept_completed", {
      status: acceptResponse.status,
      duration_ms: Date.now() - acceptStartedAt,
    });

    if (!acceptResponse.ok) {
      callLogger.error("call.accept_failed", {
        status: acceptResponse.status,
        response_body: acceptText.slice(0, 1_000),
      });
      res.status(502).json({ error: "openai_call_accept_failed" });
      return;
    }

    // The Realtime SIP connector expects the API key in the acknowledgement.
    // This response is sent only after a valid OpenAI signature was verified.
    res.setHeader("Authorization", `Bearer ${OPENAI_API_KEY}`);
    res.sendStatus(200);

    /*
     * ============================================================
     * 2. SIDEBAND WEBSOCKET
     * ============================================================
     */

    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(
        callId
      )}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    ws.on("open", () => {
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

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(
          data.toString()
        );

        callLogger.debug("realtime.event_received", { event_type: message.type });

        switch (message.type) {
          /*
           * --------------------------------------------------------
           * SESSION
           * --------------------------------------------------------
           */

          case "session.created":
            callLogger.info("realtime.session_created", {
              model: message.session?.model,
            });
            break;

          case "session.updated":
            callLogger.info("realtime.session_updated");
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
            });
            callLogger.debug("tool.arguments", {
              tool_name: message.name,
              arguments: message.arguments,
            });

            let args: unknown = {};

            try {
              args = JSON.parse(
                message.arguments || "{}"
              );
            } catch {
              callLogger.error("tool.arguments_invalid", {
                tool_name: message.name,
                tool_call_id: message.call_id,
              });
              return;
            }

            try {
              const result = await realtimeTools.execute(message.name, args);

              callLogger.debug("tool.result", {
                tool_name: message.name,
                result,
              });

              /*
               * ----------------------------------------------------
               * DEVOLVER RESULTADO DE LA TOOL A REALTIME
               * ----------------------------------------------------
               */

              ws.send(
                JSON.stringify({
                  type: "conversation.item.create",

                  item: {
                    type: "function_call_output",

                    call_id: message.call_id,

                    output:
                      JSON.stringify(result),
                  },
                })
              );

              /*
               * Ahora le decimos al modelo:
               *
               * "Ya tenés el resultado de la tool,
               * continuá respondiendo."
               */

              ws.send(
                JSON.stringify({
                  type: "response.create",
                })
              );

              callLogger.info("tool.completed", {
                tool_name: message.name,
                tool_call_id: message.call_id,
              });
            } catch (error) {
              callLogger.error("tool.failed", {
                tool_name: message.name,
                tool_call_id: message.call_id,
                error,
              });

              ws.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: message.call_id,
                  output: JSON.stringify({
                    ok: false,
                    error: "The requested operation could not be completed.",
                  }),
                },
              }));

              ws.send(JSON.stringify({ type: "response.create" }));
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

          /*
           * --------------------------------------------------------
           * ERROR
           * --------------------------------------------------------
           */

          case "error":
            callLogger.error("realtime.error", {
              error_type: message.error?.type,
              error_code: message.error?.code,
              error_message: message.error?.message,
            });
            break;
        }
      } catch (error) {
        callLogger.error("realtime.message_parse_failed", { error });
      }
    });

    ws.on("error", (error) => {
      callLogger.error("realtime.websocket_error", { error });
    });

    ws.on("close", (code, reason) => {
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
  });
});
