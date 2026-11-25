/**
 * HTTP errors a route (or a service behind it) throws. The shape is the one
 * the agent has always answered with: an object given to the constructor is
 * the body as it is (`{ code, message }`, the message rendered in the
 * request's language at the edge); without one the body is
 * `{ statusCode, message }`, and a plain string becomes
 * `{ message, error, statusCode }`.
 */
export const HttpStatus = {
  OK: 200,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export class HttpException extends Error {
  readonly response: unknown;

  constructor(
    response: string | object | undefined,
    private readonly status: number,
  ) {
    super(typeof response === 'string' ? response : (REASONS[status] ?? 'Error'));
    this.response =
      response === undefined
        ? { statusCode: status, message: REASONS[status] ?? 'Error' }
        : typeof response === 'string'
          ? { message: response, error: REASONS[status] ?? 'Error', statusCode: status }
          : response;
  }

  getStatus(): number {
    return this.status;
  }

  getResponse(): unknown {
    return this.response;
  }
}

const of = (status: number) =>
  class extends HttpException {
    constructor(response?: string | object) {
      super(response, status);
    }
  };

export const BadRequestException = of(400);
export const UnauthorizedException = of(401);
export const ForbiddenException = of(403);
export const NotFoundException = of(404);
export const ConflictException = of(409);
export const PayloadTooLargeException = of(413);
export const BadGatewayException = of(502);
