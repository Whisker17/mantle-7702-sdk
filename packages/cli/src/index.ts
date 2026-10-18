export const PACKAGE_NAME = "@mantle-aa/cli";

export { type CliIO, COMMANDS, HOME_ENV, RPC_URL_ENV, run, SPONSOR_URL_ENV } from "./cli.js";
export {
  describeError,
  type ErrorCode,
  EXIT_CODES,
  NotAvailableError,
  UsageError,
} from "./errors.js";
