import "dotenv/config";
import express from "express";
import WebSocket from "ws";

import { supabaseAdmin } from "./backend/src/config/supabase";
import {
  requireDashboardAuth,
  type DashboardRequest,
} from "./backend/src/http/middleware/require-dashboard-auth";

const app = express();

app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Falta OPENAI_API_KEY");
}

/*
 * ============================================================
 * TOOL DE EJEMPLO
 * ============================================================
 */

async function getOperationStatus(operationId: string) {
  console.log("🔧 TOOL get_operation_status:", operationId);

  // Mock por ahora.
  // Después esto puede consultar Postgres.
  return {
    operation_id: operationId,
    container: "MSKU1234567",
    status: "NEGOTIATING",
    origin: "Puerto de Manzanillo",
    destination: "Guadalajara",
    pickup_date: "2026-09-03",
    max_price_mxn: 9000,
    best_quote_mxn: 8500,
  };
}

app.get("/", (_req, res) => {
  res.send("Volta backend running");
});

app.get("/health", async (_req, res) => {
  const { error } = await supabaseAdmin
    .from("operations")
    .select("id")
    .limit(1);

  if (error) {
    console.error("Supabase health check failed:", error.message);
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

app.post("/openai/webhook", async (req, res) => {
  const event = req.body;

  console.log(
    "Webhook received:",
    JSON.stringify(event, null, 2)
  );

  // Respondemos rápido al webhook.
  res.sendStatus(200);

  if (event.type !== "realtime.call.incoming") {
    return;
  }

  const callId = event.data?.call_id;

  if (!callId) {
    console.error("No call_id received");
    return;
  }

  console.log("☎️ Incoming call:", callId);

  try {
    /*
     * ============================================================
     * 1. ACEPTAR LA LLAMADA
     * ============================================================
     */

    console.time("accept-call");

    const acceptResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          type: "realtime",

          model: "gpt-realtime",

          output_modalities: ["audio"],

          /*
           * Habilitamos transcripción de lo que dice el usuario.
           */
          audio: {
            input: {
              transcription: {
                model: "gpt-transcribe",
              },
            },
          },

          instructions: `
Sos Volta, un agente telefónico de logística.

Idioma:
- Empezá la conversación en español.
- Detectá el idioma que usa la persona y respondé en ese mismo idioma.
- Si la persona cambia de idioma durante la conversación o te pide usar otro idioma, cambiá inmediatamente y mantené ese idioma hasta que vuelva a cambiarlo.
- Si el idioma no está claro, preguntá brevemente qué idioma prefiere.
- No traduzcas nombres propios, códigos de operación, números de contenedor ni otros identificadores.
- Usá español como idioma de respaldo cuando no puedas determinar el idioma.

Reglas:
- Sé breve.
- Soná natural.
- No inventes información.
- Si no entendés algo, pedí que lo repitan en el idioma actual.
- Permití interrupciones naturalmente.

Tenés acceso a una herramienta llamada get_operation_status.

Si el usuario pregunta por el estado,
precio, contenedor, ruta o información de una operación,
usá get_operation_status antes de responder.
          `.trim(),

          /*
           * DEFINICIÓN DE LA TOOL
           */
          tools: [
            {
              type: "function",

              name: "get_operation_status",

              description:
                "Obtiene el estado actual y los datos de una operación logística.",

              parameters: {
                type: "object",

                properties: {
                  operation_id: {
                    type: "string",
                    description:
                      "Identificador de la operación, por ejemplo OP-182",
                  },
                },

                required: ["operation_id"],
                additionalProperties: false,
              },
            },
          ],

          tool_choice: "auto",
        }),
      }
    );

    console.timeEnd("accept-call");

    const acceptText = await acceptResponse.text();

    console.log(
      "Accept response:",
      acceptResponse.status,
      acceptText
    );

    if (!acceptResponse.ok) {
      console.error("Could not accept call");
      return;
    }

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
      console.log(
        "✅ Realtime sideband connected:",
        callId
      );

      /*
       * ============================================================
       * 3. SALUDO INICIAL
       * ============================================================
       */

      ws.send(
        JSON.stringify({
          type: "response.create",

          response: {
            instructions: `
Saludá inmediatamente diciendo:

"Hola, soy Volta. ¿En qué te puedo ayudar?"

Después esperá la respuesta de la persona.
            `.trim(),
          },
        })
      );

      console.log("Initial response.create sent");
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

        console.log(
          "Realtime event:",
          message.type
        );

        switch (message.type) {
          /*
           * --------------------------------------------------------
           * SESSION
           * --------------------------------------------------------
           */

          case "session.created":
            console.log("✅ Session created");
            break;

          case "session.updated":
            console.log("✅ Session updated");
            break;

          /*
           * --------------------------------------------------------
           * USUARIO HABLANDO
           * --------------------------------------------------------
           */

          case "input_audio_buffer.speech_started":
            console.log(
              "🎤 Usuario empezó a hablar"
            );
            break;

          case "input_audio_buffer.speech_stopped":
            console.log(
              "🛑 Usuario terminó de hablar"
            );
            break;

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DEL USUARIO
           * --------------------------------------------------------
           */

          case "conversation.item.input_audio_transcription.completed":
            console.log(
              "\n👤 Usuario dijo:",
              message.transcript
            );
            break;

          /*
           * --------------------------------------------------------
           * TOOL CALL
           * --------------------------------------------------------
           */

          case "response.function_call_arguments.done": {
            console.log(
              "\n🔧 TOOL CALL RECIBIDA"
            );

            console.log(
              "Tool:",
              message.name
            );

            console.log(
              "Arguments:",
              message.arguments
            );

            let args: any = {};

            try {
              args = JSON.parse(
                message.arguments || "{}"
              );
            } catch {
              console.error(
                "No pude parsear tool arguments"
              );
              return;
            }

            /*
             * Ejecutamos nuestra tool.
             */

            if (
              message.name ===
              "get_operation_status"
            ) {
              const result =
                await getOperationStatus(
                  args.operation_id
                );

              console.log(
                "🔧 Tool result:",
                result
              );

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

              console.log(
                "✅ Tool result enviado a Realtime"
              );
            }

            break;
          }

          /*
           * --------------------------------------------------------
           * TRANSCRIPCIÓN DE VOLTA
           * --------------------------------------------------------
           */

          case "response.output_audio_transcript.delta":
            process.stdout.write(
              message.delta ?? ""
            );
            break;

          case "response.output_audio_transcript.done":
            console.log(
              "\n🤖 Volta dijo:",
              message.transcript
            );
            break;

          /*
           * --------------------------------------------------------
           * RESPONSE TERMINADA
           * --------------------------------------------------------
           */

          case "response.done":
            console.log(
              "✅ Response completed"
            );
            break;

          /*
           * --------------------------------------------------------
           * ERROR
           * --------------------------------------------------------
           */

          case "error":
            console.error(
              "❌ Realtime error:",
              JSON.stringify(
                message,
                null,
                2
              )
            );
            break;
        }
      } catch (error) {
        console.error(
          "Could not parse WS message:",
          error
        );
      }
    });

    ws.on("error", (error) => {
      console.error(
        "Realtime WebSocket error:",
        error
      );
    });

    ws.on("close", (code, reason) => {
      console.log(
        `Realtime WebSocket closed. code=${code}, reason=${reason.toString()}`
      );
    });
  } catch (error) {
    console.error(
      "Incoming-call handling error:",
      error
    );
  }
});

const PORT = Number(
  process.env.PORT || 3000
);

app.listen(PORT, () => {
  console.log(
    `Server listening on http://localhost:${PORT}`
  );

  console.log(
    `Webhook: http://localhost:${PORT}/openai/webhook`
  );
});
