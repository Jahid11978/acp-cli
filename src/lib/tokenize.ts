import {
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from "viem";
import { createAgentFromConfig } from "./agentFactory";
import {
  EvmAcpClient,
  getSplTokenBalance,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import type {
  AgentApi,
  OccupyLaunchOptions,
  OccupyPrepareLaunchResponse,
  PrepareLaunchResponse,
  SolanaPrepareLaunchResponse,
  VirtualsPrepareLaunchResponse,
} from "./api/agent";
import { isOccupyLaunch } from "./api/agent";
import { toSolanaInstructionLike, type SolAddr } from "./solana";
import { isSolanaChainId } from "./chains";
import { withApprovalGate } from "./walletGate";
import { CliError } from "./errors";

export interface TokenizeParams {
  agentId: string;
  chainId: number;
  symbol: string;
  antiSniperTaxType?: number;
  needAcf?: boolean;
  isProject60days?: boolean;
  airdropPercent?: number;
  isRobotics?: boolean;
  prebuyVirtualBaseUnit: bigint;
  onProgress?: (message: string) => void;
}

export interface EvmTokenizeParams extends TokenizeParams {
  walletAddress: string;
  launchOptions?: OccupyLaunchOptions;
}

export interface TokenizeResult {
  virtualId: number;
  txHash: string;
  launchFee: string;
}

export function convertPrebuyVirtual(
  raw: string,
  chainId: number
): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  try {
    const decimals = isSolanaChainId(chainId) ? 9 : 18;
    const base = parseUnits(trimmed as `${number}`, decimals);
    return base < 0n ? null : base;
  } catch {
    return null;
  }
}

function getEvmProvider(chainId: number) {
  return createAgentFromConfig().then((agent) => {
    const client = agent.getClient(chainId);
    if (!(client instanceof EvmAcpClient)) {
      throw new Error("Only EVM chains are supported for tokenization.");
    }
    return client.getProvider();
  });
}

/**
 * Where the Occupy allow-list is published. `AssetConfig` has a point lookup
 * and no enumeration, so the set of allow-listed assets can only be recovered
 * by scanning contract logs — an archive workload public RPCs refuse. The list
 * is eleven curated assets that change rarely, so it is documented instead of
 * derived, and `--quote-token` takes the address from it.
 */
export const QUOTE_TOKEN_DOCS_URL =
  "https://os.virtuals.io/agent-identity/token/overview#occupy-quote-assets";

/**
 * Validate `--quote-token`. Pure: the address is passed straight through, and
 * whether the asset may be launched against is decided on-chain by
 * `assetConfigs(address)` when the launch is prepared.
 */
export function parseQuoteTokenAddress(quoteToken: string): `0x${string}` {
  const wanted = quoteToken.trim();
  if (!isAddress(wanted)) {
    throw new CliError(
      `--quote-token must be a contract address, got "${quoteToken}".`,
      "MISSING_QUOTE_TOKEN",
      `A ticker cannot be resolved to an address without enumerating the allow-list, which is not something the chain supports cheaply. Look the asset up at ${QUOTE_TOKEN_DOCS_URL} and pass its address.`
    );
  }
  return getAddress(wanted);
}

/**
 * The quote asset's decimals, read off the token.
 *
 * Only called when there is a pre-buy, because that is the only thing that
 * needs them: `--prebuy 5` is converted with `parseUnits(amount, decimals)`,
 * and the allow-list is not uniform — the tokenized equities are 8-decimal
 * while wtFGI is 18, so an assumed 18 against an 8-decimal asset overspends by
 * a factor of 10^10.
 *
 * Read rather than taken from the published list on purpose. The list is a
 * hand-maintained doc and this is a funds-moving conversion, so the token
 * itself is the authority. Unlike the enumeration this replaced, it is a single
 * `eth_call` — no log range, no archive depth, no RPC that refuses it.
 */
export async function readQuoteTokenDecimals(
  chainId: number,
  address: `0x${string}`
): Promise<number> {
  const provider = await getEvmProvider(chainId);
  try {
    const decimals = (await provider.readContract(chainId, {
      abi: erc20Abi,
      address,
      functionName: "decimals",
    })) as number;
    return Number(decimals);
  } catch (err) {
    throw new CliError(
      `Could not read decimals for ${address} on chain ${chainId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MISSING_QUOTE_TOKEN",
      `A pre-buy is denominated in the quote asset, so its decimals have to be known before spending. Check the address is an ERC-20 on this chain — the allow-listed assets are published at ${QUOTE_TOKEN_DOCS_URL}.`
    );
  }
}

/**
 * Occupy quotes its curve in an arbitrary asset, so a pre-buy is denominated in
 * that token's units rather than VIRTUAL's 18. Read the decimals rather than
 * assuming — an 8-decimal quote asset would otherwise overspend by 10^10.
 */
export function convertPrebuyWithDecimals(
  raw: string,
  decimals: number
): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  try {
    const base = parseUnits(trimmed as `${number}`, decimals);
    return base < 0n ? null : base;
  } catch {
    return null;
  }
}

export async function checkTokenBalance(
  chainId: number,
  tokenAddress: string,
  wallet: string,
  requiredWei: string,
  label: string
): Promise<number> {
  const provider = await getEvmProvider(chainId);
  const [balance, decimals] = await Promise.all([
    provider.readContract(chainId, {
      abi: erc20Abi,
      address: tokenAddress as `0x${string}`,
      functionName: "balanceOf",
      args: [wallet as `0x${string}`],
    }) as Promise<bigint>,
    provider.readContract(chainId, {
      abi: erc20Abi,
      address: tokenAddress as `0x${string}`,
      functionName: "decimals",
    }) as Promise<number>,
  ]);
  const required = BigInt(requiredWei);
  if (balance < required) {
    throw new Error(
      `Insufficient ${label} balance. Need ${formatUnits(
        required,
        Number(decimals)
      )}, have ${formatUnits(balance, Number(decimals))}.`
    );
  }
  return Number(decimals);
}

export async function checkVirtualBalance(
  chainId: number,
  virtualToken: string,
  wallet: string,
  requiredWei: string
): Promise<void> {
  const provider = await getEvmProvider(chainId);
  const balance = (await provider.readContract(chainId, {
    abi: erc20Abi,
    address: virtualToken as `0x${string}`,
    functionName: "balanceOf",
    args: [wallet as `0x${string}`],
  })) as bigint;
  const required = BigInt(requiredWei);
  if (balance < required) {
    throw new Error(
      `Insufficient VIRTUAL balance. Need ${formatEther(
        required
      )}, have ${formatEther(balance)}.`
    );
  }
}

async function waitForReceipt(
  provider: Awaited<ReturnType<typeof getEvmProvider>>,
  chainId: number,
  txHash: `0x${string}`,
  { intervalMs = 2_000, timeoutMs = 120_000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(chainId, txHash);
      if (receipt.status === "reverted") {
        throw new Error(`Transaction ${txHash} reverted on-chain.`);
      }
      return;
    } catch (err) {
      if (err instanceof Error && err.message.includes("reverted")) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Timed out waiting for receipt of ${txHash}`);
}

export async function sendApprove(
  chainId: number,
  tokenAddress: string,
  approveCalldata: string
): Promise<string> {
  const provider = await getEvmProvider(chainId);
  const txHash = await provider.sendTransaction(chainId, {
    to: tokenAddress as `0x${string}`,
    data: approveCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function sendLaunch(
  chainId: number,
  bondingAddress: string,
  launchCalldata: string
): Promise<string> {
  const provider = await getEvmProvider(chainId);
  const txHash = await provider.sendTransaction(chainId, {
    to: bondingAddress as `0x${string}`,
    data: launchCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function sendPreLaunch(
  chainId: number,
  bondingV5Address: string,
  preLaunchCalldata: string
): Promise<string> {
  const provider = await getEvmProvider(chainId);
  const txHash = await provider.sendTransaction(chainId, {
    to: bondingV5Address as `0x${string}`,
    data: preLaunchCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function tokenizeOnSolana(
  agentApi: AgentApi,
  params: TokenizeParams,
  json?: boolean
): Promise<TokenizeResult> {
  const {
    agentId,
    chainId,
    symbol,
    antiSniperTaxType,
    needAcf,
    isProject60days,
    airdropPercent,
    isRobotics,
    prebuyVirtualBaseUnit,
    onProgress,
  } = params;

  let solanaLaunch: SolanaPrepareLaunchResponse;
  try {
    onProgress?.("\nPreparing token launch...");
    solanaLaunch = await agentApi.prepareSolanaLaunch(
      agentId,
      chainId,
      symbol,
      antiSniperTaxType,
      needAcf,
      isProject60days,
      airdropPercent,
      isRobotics,
      prebuyVirtualBaseUnit > 0n ? prebuyVirtualBaseUnit.toString() : undefined
    );
  } catch (err) {
    throw new Error(
      `Failed to prepare launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  let signature: string;
  try {
    onProgress?.("Launching token onchain...");

    if (!json && needAcf) {
      console.log(
        `Launch fee (with ACF): ${BigInt(solanaLaunch.launchFee) / BigInt(1e9)} VIRTUAL`
      );
    }
    if (!json && isRobotics) {
      console.log(`Robotics Launch: enabled (Eastworld eligibility).`);
    }

    const ixs = solanaLaunch.instructions.map(toSolanaInstructionLike);
    const result = await withApprovalGate(
      async (provider: ISolanaProviderAdapter) => {
        // Preflight parity with the EVM path's checkVirtualBalance: the
        // wallet must cover launch fee + prebuy in the quote token (VIRTUAL,
        // 9 decimals on Solana) BEFORE broadcasting, so an underfunded
        // launch fails with a clear verdict instead of an on-chain error.
        // A missing token account reads as zero.
        const required =
          BigInt(solanaLaunch.launchFee) + prebuyVirtualBaseUnit;
        const owner = (await provider.getAddress()) as SolAddr;
        const { amount, decimals } = await getSplTokenBalance(
          provider.getRpc(chainId),
          owner,
          solanaLaunch.quoteMint as SolAddr
        );
        if (amount < required) {
          throw new CliError(
            `Insufficient VIRTUAL balance. Need ${formatUnits(
              required,
              decimals
            )}, have ${formatUnits(amount, decimals)}.`,
            "VALIDATION_ERROR"
          );
        }
        return provider.sendInstructions(chainId, ixs);
      },
      { chainId, sponsored: false }
    );

    // last instruction for token launch result
    signature = Array.isArray(result) ? result[result.length - 1] : result;
  } catch (err) {
    // Preflight verdicts are already user-facing; don't wrap them.
    if (err instanceof CliError) throw err;
    throw new Error(`Failed to launch token: ${err}`);
  }

  return {
    virtualId: solanaLaunch.virtualId,
    txHash: signature,
    launchFee: solanaLaunch.launchFee,
  };
}

/**
 * Occupy is single-phase and charges no launch fee: one `launch` call mints the
 * token, opens the pool and settles the pre-buy. So there is nothing to approve
 * unless the backend returned `approveCalldata` for a pre-buy, and the balance
 * to check is the quote token, not VIRTUAL.
 */
async function launchOnOccupy(
  launch: OccupyPrepareLaunchResponse,
  params: {
    chainId: number;
    symbol: string;
    prebuyBaseUnit: bigint;
    walletAddress: string;
    json?: boolean;
    onProgress?: (message: string) => void;
  }
): Promise<TokenizeResult> {
  const {
    chainId,
    symbol,
    prebuyBaseUnit,
    walletAddress,
    json,
    onProgress,
  } = params;
  const { virtualId, contracts, approveCalldata, launchCalldata } = launch;

  try {
    if (!json) {
      // The venue and the quote asset are the two things a human most needs to
      // see before an irreversible launch: the curve is priced against a stock.
      console.log(
        `Launchpad: Occupy — no launch fee, one transaction, curve priced against ${contracts.quoteToken}`
      );
    }

    if (prebuyBaseUnit > 0n) {
      // Same shape as the VIRTUAL check on the Virtuals launchpad: the agent
      // spends the venue's own currency out of its own wallet.
      const decimals = await checkTokenBalance(
        chainId,
        contracts.quoteToken,
        walletAddress,
        prebuyBaseUnit.toString(),
        "quote token"
      );
      if (!json) {
        console.log(
          `Pre-buying $${symbol} with ${formatUnits(prebuyBaseUnit, decimals)} ${
            contracts.quoteToken
          }`
        );
      }
      if (!approveCalldata) {
        throw new Error(
          "Backend returned no approveCalldata for a non-zero pre-buy"
        );
      }
      onProgress?.("Approving quote token...");
      await sendApprove(chainId, contracts.quoteToken, approveCalldata);
    }

    onProgress?.("Calling launch contract...");
    const txHash = await sendLaunch(chainId, contracts.bonding, launchCalldata);

    return { virtualId, txHash, launchFee: "0" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch token on Occupy: ${msg}`);
  }
}

export async function tokenizeOnEvm(
  agentApi: AgentApi,
  params: EvmTokenizeParams,
  json?: boolean
): Promise<TokenizeResult> {
  const {
    agentId,
    chainId,
    symbol,
    antiSniperTaxType,
    needAcf,
    isProject60days,
    airdropPercent = 0,
    isRobotics,
    prebuyVirtualBaseUnit,
    walletAddress,
    launchOptions,
    onProgress,
  } = params;

  let launch: PrepareLaunchResponse;
  try {
    onProgress?.("\nPreparing token launch...");
    launch = await agentApi.prepareLaunch(
      agentId,
      chainId,
      symbol,
      antiSniperTaxType,
      needAcf,
      isProject60days,
      airdropPercent,
      isRobotics,
      prebuyVirtualBaseUnit > 0n ? prebuyVirtualBaseUnit.toString() : undefined,
      launchOptions
    );
  } catch (err) {
    throw new Error(
      `Failed to prepare launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (isOccupyLaunch(launch)) {
    return launchOnOccupy(launch, {
      chainId,
      symbol,
      prebuyBaseUnit: prebuyVirtualBaseUnit,
      walletAddress,
      json,
      onProgress,
    });
  }

  const {
    virtualId,
    contracts,
    launchFee,
    approveCalldata,
    preLaunchCalldata,
  } = launch as VirtualsPrepareLaunchResponse;

  const launchFeeWei = BigInt(launchFee);
  const totalApprovalWei = launchFeeWei + prebuyVirtualBaseUnit;

  let preLaunchTxHash: string;
  try {
    await checkVirtualBalance(
      chainId,
      contracts.virtualToken,
      walletAddress,
      totalApprovalWei.toString()
    );
    if (!json && needAcf) {
      console.log(
        `Launch fee (with ACF): ${formatEther(launchFeeWei)} VIRTUAL`
      );
    }
    if (!json && isProject60days) {
      console.log(
        `60 Days Experiment enabled — pre-buy tokens will follow a 60-day cliff.`
      );
    }
    if (!json && airdropPercent > 0) {
      console.log(
        `Airdrop: allocating ${airdropPercent}% of supply to veVIRTUAL holders.`
      );
    }
    if (!json && isRobotics) {
      console.log(`Robotics Launch: enabled (Eastworld eligibility).`);
    }
    if (!json && prebuyVirtualBaseUnit > 0n) {
      console.log(
        `Pre-buying ${formatEther(prebuyVirtualBaseUnit)} VIRTUAL of $${symbol}`
      );
    }
    onProgress?.("Approving VIRTUAL token...");

    await sendApprove(chainId, contracts.virtualToken, approveCalldata);

    onProgress?.("Calling preLaunch contract...");
    preLaunchTxHash = await sendPreLaunch(
      chainId,
      contracts.bondingV5,
      preLaunchCalldata
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hints: string[] = [];
    if (needAcf && prebuyVirtualBaseUnit > 0n) {
      hints.push("with ACF enabled, pre-buy must be ≤50% of LP");
    }
    if (airdropPercent > 0 && prebuyVirtualBaseUnit > 0n) {
      hints.push(
        `airdrop reserves ${airdropPercent}% of supply before LP, reducing pre-buy headroom`
      );
    }
    const hint = hints.length
      ? ` Hint: ${hints.join("; ")}; reduce --prebuy and retry.`
      : "";
    throw new Error(`Failed to launch token: ${msg}${hint}`);
  }

  return {
    virtualId,
    txHash: preLaunchTxHash,
    launchFee: launchFeeWei.toString(),
  };
}
