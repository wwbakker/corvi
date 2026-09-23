// --- Routes get the real prize of typed errors: the host maps them to status codes --------

export {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  NotFoundError,
} from "@corvi/contracts/errors";

export type { RequestMethod, RouteError, RouteHandler } from "@corvi/contracts/integration";
