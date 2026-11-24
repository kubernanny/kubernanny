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
