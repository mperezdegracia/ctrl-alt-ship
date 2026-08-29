import "dotenv/config";
import express from "express";
import WebSocket from "ws";

const app = express();

// Para arrancar rápido.
// Después podemos agregar validación con OPENAI_WEBHOOK_SECRET.
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Falta OPENAI_API_KEY");
}

app.get("/", (_req, res) => {
  res.send("Volta backend running");
});

app.post("/openai/webhook", async (req, res) => {
  const event = req.body;

  console.log("Webhook received:", JSON.stringify(event, null, 2));

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

  console.log("Incoming call:", callId);

  try {
    /*
     * 1. ACEPTAR LA LLAMADA
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

          instructions: `
Sos Volta, un agente telefónico de prueba.

Reglas:
- Hablá siempre en español.
- Sé breve.
- Soná natural.
- No inventes información.
- Si no entendés algo, pedí que lo repitan.
- Permití interrupciones naturalmente.
          `.trim(),
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
     * 2. CONECTAR EL BACKEND A LA SESIÓN REALTIME
     *
     * Esto es el sideband WebSocket.
     * El audio sigue siendo SIP <-> OpenAI.
     *
     * Nosotros usamos este WebSocket para:
     * - mandar eventos
     * - tools
     * - cambiar instructions
     * - response.create
     * - escuchar eventos
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
      console.log("Realtime sideband connected:", callId);

      /*
       * 3. HACER QUE VOLTA SALUDE INMEDIATAMENTE
       */

      ws.send(
        JSON.stringify({
          type: "response.create",

          response: {
            instructions: `
Saludá inmediatamente diciendo algo similar a:

"Hola, soy Volta. ¿En qué te puedo ayudar?"

Después esperá la respuesta de la persona.
            `.trim(),
          },
        })
      );

      console.log("Initial response.create sent");
    });

    /*
     * 4. LOGS DE LA SESIÓN
     */

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());

        console.log("Realtime event:", message.type);

        switch (message.type) {
          case "session.created":
            console.log("Session created");
            break;

          case "session.updated":
            console.log("Session updated");
            break;

          case "input_audio_buffer.speech_started":
            console.log("👤 User started speaking");
            break;

          case "input_audio_buffer.speech_stopped":
            console.log("👤 User stopped speaking");
            break;

          case "conversation.item.input_audio_transcription.completed":
            console.log(
              "👤 Transcript:",
              message.transcript
            );
            break;

          case "response.output_audio_transcript.delta":
            process.stdout.write(message.delta ?? "");
            break;

          case "response.output_audio_transcript.done":
            console.log(
              "\n🤖 Volta:",
              message.transcript
            );
            break;

          case "response.done":
            console.log("Response completed");
            break;

          case "error":
            console.error(
              "Realtime error:",
              JSON.stringify(message, null, 2)
            );
            break;
        }
      } catch (error) {
        console.error("Could not parse WS message:", error);
      }
    });

    ws.on("error", (error) => {
      console.error("Realtime WebSocket error:", error);
    });

    ws.on("close", (code, reason) => {
      console.log(
        `Realtime WebSocket closed. code=${code}, reason=${reason.toString()}`
      );
    });
  } catch (error) {
    console.error("Incoming-call handling error:", error);
  }
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(
    `Webhook: http://localhost:${PORT}/openai/webhook`
  );
});
