import OpenAI from "openai";
import type { CallAcceptParams } from "openai/resources/realtime/calls";

export class OpenAIRealtimeGateway {
  constructor(private readonly client: OpenAI) {}

  async accept(callId: string, configuration: CallAcceptParams): Promise<{ status: number; requestId: string | null }> {
    const { response, request_id } = await this.client.realtime.calls.accept(
      callId, configuration, { maxRetries: 0, timeout: 10_000 },
    ).withResponse();
    return { status: response.status, requestId: request_id };
  }

  async reject(callId: string): Promise<void> {
    await this.client.realtime.calls.reject(callId, { status_code: 603 }, { maxRetries: 0, timeout: 10_000 });
  }

}
