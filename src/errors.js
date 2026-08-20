export class CliError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} message
   */
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliError";
  }
}

export const ZERO_PREV = "0".repeat(64);
export const KINDS = new Set(["start", "tool_call", "tool_result", "end"]);
export const CAPABILITIES = new Set(["fs.read", "fs.write", "exec", "network"]);
export const STOP_REASONS = new Set(["user", "model", "error", "abort"]);
export const ALLOW_DENY = new Set(["allow", "deny"]);
