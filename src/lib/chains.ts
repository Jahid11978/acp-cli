import {
  ERC20_SPONSORED_CHAINS,
  getEvmChainByChainId,
} from "@virtuals-protocol/acp-node-v2";
import { CliError } from "./errors";

export const SPONSORED_CHAIN_IDS = ERC20_SPONSORED_CHAINS.map(
  (chain) => chain.id
);

export function formatChainId(id: number): string {
  const chain = getEvmChainByChainId(id);
  return chain ? `${id} (${chain.name})` : String(id);
}

export function formatChainIds(ids: number[]): string {
  return ids.map(formatChainId).join(", ");
}

export function assertSponsoredChainId(chainId: number): void {
  if (!SPONSORED_CHAIN_IDS.includes(chainId)) {
    throw new CliError(
      `Unsupported chain ID: ${formatChainId(chainId)}`,
      "VALIDATION_ERROR",
      `Supported chains: ${formatChainIds(SPONSORED_CHAIN_IDS)}`
    );
  }
}
