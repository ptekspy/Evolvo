const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const REDACTED_KEYS = /(token|authorization|api[-_]?key|secret|password)/i;

function normalizeLevel(level) {
  return Object.hasOwn(LEVEL_PRIORITY, level) ? level : "info";
}

function valueToString(value) {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message
    });
  }

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

function sanitizeMetadata(metadata) {
  const entries = Object.entries(metadata ?? {})
    .filter(([, value]) => value !== undefined);

  return entries.map(([key, value]) => {
    if (REDACTED_KEYS.test(key)) {
      return `${key}=[redacted]`;
    }

    return `${key}=${valueToString(value)}`;
  });
}

function pickSinkMethod(sink, level) {
  if (level === "debug") {
    return sink.debug ?? sink.log;
  }

  if (level === "info") {
    return sink.info ?? sink.log;
  }

  if (level === "warn") {
    return sink.warn ?? sink.log;
  }

  return sink.error ?? sink.log;
}

class NoopLogger {
  child() {
    return this;
  }

  debug() {}
  info() {}
  warn() {}
  error() {}
}

export class ConsoleLogger {
  constructor(options = {}) {
    this.level = normalizeLevel(options.level ?? "info");
    this.scope = options.scope ?? "app";
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? console;
    this.clock = options.clock ?? (() => new Date());
  }

  child(scope, bindings = {}) {
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

  debug(message, metadata) {
    this.emit("debug", message, metadata);
  }

  info(message, metadata) {
    this.emit("info", message, metadata);
  }

  warn(message, metadata) {
    this.emit("warn", message, metadata);
  }

  error(message, metadata) {
    this.emit("error", message, metadata);
  }

  emit(level, message, metadata = {}) {
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

export function createNoopLogger() {
  return new NoopLogger();
}
