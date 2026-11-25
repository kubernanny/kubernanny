/**
 * One line per message on stdout (errors and warnings on stderr):
 * `2026-11-25T09:00:00.000Z   LOG [context] message`. Tests silence it with
 * `Logger.silent = true`.
 */
type Level = 'LOG' | 'WARN' | 'ERROR' | 'DEBUG';

export class Logger {
  static silent = Boolean(process.env.VITEST);

  constructor(private readonly context = 'kubernanny') {}

  log(message: string): void {
    Logger.write('LOG', this.context, message);
  }

  warn(message: string): void {
    Logger.write('WARN', this.context, message);
  }

  error(message: string): void {
    Logger.write('ERROR', this.context, message);
  }

  debug(message: string): void {
    if (process.env.LOG_DEBUG) {
      Logger.write('DEBUG', this.context, message);
    }
  }

  private static write(level: Level, context: string, message: string): void {
    if (Logger.silent) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.padStart(5)} [${context}] ${message}\n`;
    (level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout).write(line);
  }
}
