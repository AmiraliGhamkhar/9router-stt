const STATUS_TO_CODE = {
  400: ["invalid_request", "invalid_request_error"],
  401: ["authentication_failed", "authentication_error"],
  403: ["authentication_failed", "authentication_error"],
  413: ["audio_too_large", "invalid_request_error"],
  429: ["rate_limited", "rate_limit_error"],
  502: ["upstream_error", "provider_error"],
  503: ["provider_unavailable", "provider_error"],
  504: ["upstream_timeout", "provider_error"],
};

export class SttError extends Error {
  constructor(message, { status = 502, code, type, provider } = {}) {
    super(message);
    this.name = "SttError";
    this.status = status;
    const fallback = STATUS_TO_CODE[status] || STATUS_TO_CODE[502];
    this.code = code || fallback[0];
    this.type = type || fallback[1];
    this.provider = provider || null;
  }
}

export function publicError(error, requestId) {
  const safe = error instanceof SttError
    ? error
    : new SttError("STT provider request failed", { status: 502 });
  return {
    status: safe.status,
    body: {
      error: {
        message: safe.message,
        type: safe.type,
        code: safe.code,
        request_id: requestId,
      },
    },
  };
}

export function upstreamError(provider, status) {
  const normalizedStatus = status === 401 || status === 403 ? 502 : (status >= 400 && status < 600 ? status : 502);
  if (status === 401 || status === 403) {
    return new SttError(`${provider} upstream authentication failed`, {
      status: normalizedStatus,
      code: "upstream_authentication_failed",
      type: "provider_error",
      provider,
    });
  }
  if (status === 429) {
    return new SttError(`${provider} is rate limited`, {
      status: 429,
      code: "upstream_rate_limited",
      type: "provider_error",
      provider,
    });
  }
  return new SttError(`${provider} upstream request failed`, {
    status: normalizedStatus >= 500 ? normalizedStatus : 502,
    code: "upstream_request_failed",
    type: "provider_error",
    provider,
  });
}
