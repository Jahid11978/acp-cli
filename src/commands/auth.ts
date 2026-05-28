import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { CliError } from "../lib/errors";
import { AuthApi } from "../lib/api/auth";
import { getClient } from "../lib/api/client";
import { setCurrentOwnerWallet, setTokens } from "../lib/config";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function waitForToken(
  authApi: AuthApi,
  requestId: string
): Promise<{
  token: string;
  refreshToken: string;
  walletAddress: string;
} | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await authApi.pollCliToken(requestId);
    if (result) return result;
  }
  return null;
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description(
      "Agent-friendly authentication. `acp auth url` returns a URL and exits; `acp auth complete` finalizes after the human signs in."
    );

  // URL — emits {url, requestId} and exits immediately. Designed for agent
  // harnesses that can't (or won't) sit on a blocking browser flow: the
  // agent runs this, relays the URL to its human, then calls `complete`.
  auth
    .command("url")
    .description(
      "Print a sign-in URL and requestId, then exit. Does not open a browser or poll."
    )
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { authApi } = await getClient(true);
        const { url, requestId } = await authApi.getCliUrl();
        if (json) {
          outputResult(json, { url, requestId });
        } else {
          console.log(`\nSign in here:\n\n  ${url}\n`);
          console.log(`Then run:\n  acp auth complete --request-id ${requestId}\n`);
        }
      } catch (err) {
        outputError(
          json,
          `Failed to get auth URL: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

  // COMPLETE — blocks polling for a previously-issued requestId. Run this
  // *after* the human has clicked through the URL from `acp auth url`.
  auth
    .command("complete")
    .description(
      "Poll until the human finishes the sign-in for a requestId from `acp auth url`, then save tokens."
    )
    .requiredOption("--request-id <id>", "Request ID returned by `acp auth url`")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const requestId: string = opts.requestId;
      try {
        const { authApi } = await getClient(true);
        const result = await waitForToken(authApi, requestId);
        if (!result) {
          outputError(
            json,
            new CliError(
              "Authentication timed out.",
              "TIMEOUT",
              "Run `acp auth url` again and complete the browser sign-in."
            )
          );
          return;
        }
        setCurrentOwnerWallet(result.walletAddress);
        await setTokens(result.token, result.refreshToken, result.walletAddress);
        if (json) {
          outputResult(json, {
            message: "Successfully authenticated to ACP CLI",
            walletAddress: result.walletAddress,
          });
        } else {
          console.log("Successfully authenticated to ACP CLI");
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
