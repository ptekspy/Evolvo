import type { JsonValue, LogLevel, LoggerLike } from "./types.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const REDACTED_KEYS = /(token|authorization|api[-_]?key|secret|password)/i;

type Metadata = Record<string, JsonValue | undefined>;

type LogSink = {
  log?: (value: string) => void;
  info?: (value: string) => void;
  warn?: (value: string) => void;
  error?: (value: string) => void;
  debug?: (value: string) => void;
};

function normalizeLevel(level: string): LogLevel {
  return Object.hasOwn(LEVEL_PRIORITY, level) ? (level as LogLevel) : "info";
}

function valueToString(value: JsonValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function sanitizeMetadata(metadata: Metadata): string[] {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);

  return entries.map(([key, value]) => {
    if (REDACTED_KEYS.test(key)) {
      return `${key}=[redacted]`;
    }

    return `${key}=${valueToString(value as JsonValue)}`;
  });
}

function pickSinkMethod(sink: LogSink, level: LogLevel): (value: string) => void {
  if (level === "debug") {
    return sink.debug ?? sink.log ?? console.log;
  }

  if (level === "info") {
    return sink.info ?? sink.log ?? console.log;
  }

  if (level === "warn") {
    return sink.warn ?? sink.log ?? console.warn;
  }

  return sink.error ?? sink.log ?? console.error;
}

class NoopLogger implements LoggerLike {
  child(): LoggerLike {
    return this;
  }

  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

export class ConsoleLogger implements LoggerLike {
  private readonly level: LogLevel;
  private readonly scope: string;
  private readonly bindings: Metadata;
  private readonly sink: LogSink;
  private readonly clock: () => Date;

  constructor(options: {
    level?: string;
    scope?: string;
    bindings?: Metadata;
    sink?: LogSink;
    clock?: () => Date;
  } = {}) {
    this.level = normalizeLevel(options.level ?? "info");
    this.scope = options.scope ?? "app";
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? console;
    this.clock = options.clock ?? (() => new Date());
  }

  child(scope?: string, bindings: Metadata = {}): LoggerLike {
    const childScope = scope ? `${this.scope}.${scope}` : this.scope;
    return new ConsoleLogger({
      level: this.level,
      scope: childScope,
      bindings: {
        ...this.bindings,
        ...bindings
      },
      sink: this.sink,
      clock: this.clock
    });
  }

  debug(message: string, metadata: Metadata = {}): void {
    this.emit("debug", message, metadata);
  }

  info(message: string, metadata: Metadata = {}): void {
    this.emit("info", message, metadata);
  }

  warn(message: string, metadata: Metadata = {}): void {
    this.emit("warn", message, metadata);
  }

  error(message: string, metadata: Metadata = {}): void {
    this.emit("error", message, metadata);
  }

  private emit(level: LogLevel, message: string, metadata: Metadata): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = this.clock().toISOString();
    const parts = [`[${timestamp}]`, level.toUpperCase(), this.scope, message];
    const metadataFields = sanitizeMetadata({
      ...this.bindings,
      ...metadata
    });

    if (metadataFields.length > 0) {
      parts.push(metadataFields.join(" "));
    }

    const method = pickSinkMethod(this.sink, level);
    method.call(this.sink, parts.join(" | "));
  }
}

export function createNoopLogger(): LoggerLike {
  return new NoopLogger();
}
