import type { IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import { createProviderAdapter, createSseTransport } from "./agentFactory";

export async function withApprovalGate<T>(
  fn: (provider: IEvmProviderAdapter) => Promise<T>
): Promise<T> {
  const provider = await createProviderAdapter();
  const transport = await createSseTransport(provider);
  try {
    return await fn(provider);
  } finally {
    await transport.disconnect();
  }
}
