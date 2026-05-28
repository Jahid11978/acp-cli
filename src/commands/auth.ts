import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { getClient } from "../lib/api/client";
import { setCurrentOwnerWallet, setTokens } from "../lib/config";

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description(
      "Agent-friendly authentication. `acp auth url` returns a URL and exits; `acp auth complete` is a single non-blocking probe — call repeatedly until done."
    );

  // URL — emits {url, requestId} and exits immediately. Designed for agent
  // harnesses that can't (or won't) sit on a blocking browser flow: the
  // agent runs this, relays the URL to its human, then polls `complete`.
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
          console.log(
            `Then poll:\n  acp auth complete --request-id ${requestId}\n`
          );
        }
      } catch (err) {
        outputError(
          json,
          `Failed to get auth URL: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

  // COMPLETE — single non-blocking probe. The caller (typically an agent)
  // is expected to poll this every few seconds until `done: true`. We
  // don't block here so harnesses that timeout long calls don't kill the
  // flow.
  auth
    .command("complete")
    .description(
      "Probe once whether the human has finished signing in. Returns {done, walletAddress?} and saves tokens when done. Non-blocking — call repeatedly."
    )
    .requiredOption("--request-id <id>", "Request ID returned by `acp auth url`")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const requestId: string = opts.requestId;
      try {
        const { authApi } = await getClient(true);
        const result = await authApi.pollCliToken(requestId);
        if (!result) {
          if (json) {
            outputResult(json, { done: false });
          } else {
            console.log("Not signed in yet — try again in a few seconds.");
          }
          return;
        }
        setCurrentOwnerWallet(result.walletAddress);
        await setTokens(result.token, result.refreshToken, result.walletAddress);
        if (json) {
          outputResult(json, {
            done: true,
            walletAddress: result.walletAddress,
          });
        } else {
          console.log(
            `Successfully authenticated to ACP CLI as ${result.walletAddress}`
          );
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
