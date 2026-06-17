import type {
  Middleware,
  RequestContext,
  TypedRequestContext,
} from "@aws-lambda-powertools/event-handler/types";

type RequestContextWithValidatedResponseBody = RequestContext & {
  valid: {
    res: {
      body: unknown;
    };
  };
};

export const ResponseValidationMiddleware = (): Middleware => {
  return async ({ reqCtx, next }) => {
    // We only care about the resposne
    await next();

    if (hasValidatedResponseBody(reqCtx)) {
      reqCtx.res = new Response(JSON.stringify(reqCtx.valid.res.body), {
        status: reqCtx.res.status,
        statusText: reqCtx.res.statusText,
        headers: reqCtx.res.headers,
      });
    }
  };
};

const hasValidatedResponseBody = (
  ctx: RequestContext | TypedRequestContext,
): ctx is RequestContextWithValidatedResponseBody => {
  if (!("valid" in ctx)) {
    return false;
  }

  const valid = ctx.valid;
  if (typeof valid !== "object" || valid === null || !("res" in valid)) {
    return false;
  }

  const response = valid.res;
  return typeof response === "object" && response !== null && "body" in response;
};
