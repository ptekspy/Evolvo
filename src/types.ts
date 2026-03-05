export type LogLevel = "debug" | "info" | "warn" | "error";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export interface LoggerLike {
  child(scope?: string, bindings?: Record<string, JsonValue>): LoggerLike;
  debug(message: string, metadata?: Record<string, JsonValue>): void;
  info(message: string, metadata?: Record<string, JsonValue>): void;
  warn(message: string, metadata?: Record<string, JsonValue>): void;
  error(message: string, metadata?: Record<string, JsonValue>): void;
}
