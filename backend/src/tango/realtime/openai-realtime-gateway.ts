import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import type { CallAcceptParams } from "openai/resources/realtime/calls";

type SidebandFactory = (callId: string, client: OpenAI) => OpenAIRealtimeWS;

export class OpenAIRealtimeGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly sidebandFactory: SidebandFactory = (callID, client) => new OpenAIRealtimeWS({ callID }, client),
  ) {}

  async accept(callId: string, configuration: CallAcceptParams): Promise<{ status: number; requestId: string | null }> {
    const { response, request_id } = await this.client.realtime.calls.accept(
      callId, configuration, { maxRetries: 0, timeout: 10_000 },
    ).withResponse();
    return { status: response.status, requestId: request_id };
  }

  async reject(callId: string): Promise<void> {
    await this.client.realtime.calls.reject(callId, { status_code: 603 }, { maxRetries: 0, timeout: 10_000 });
  }

  connectSideband(callId: string): OpenAIRealtimeWS {
    return this.sidebandFactory(callId, this.client);
  }
}
