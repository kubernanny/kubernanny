/** The agent answered, authenticated, with an error (or the built-in demo did). */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string | undefined,
  ) {
    // No text of our own: describeError() words an empty message in the UI language.
    super(message ?? '');
    this.name = 'AgentError';
  }
}

/** Fetching the agent's key without a pinned one is only safe where TLS or the local machine vouches for it. */
export class InsecureTransportError extends Error {
  constructor(readonly url: string) {
    super(`refusing to fetch an agent key over plain http from ${url}`);
    this.name = 'InsecureTransportError';
  }
}
