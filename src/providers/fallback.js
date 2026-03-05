import { createNoopLogger } from "../logger.js";

export class FallbackProvider {
  constructor(primary, fallback, logger = createNoopLogger()) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
  }

  async complete(prompt) {
    const startedAt = Date.now();
    try {
      this.logger.debug("Sending prompt to primary model", {
        promptLength: prompt.length
      });
      const response = await this.primary.complete(prompt);
      this.logger.debug("Primary model completed", {
        durationMs: Date.now() - startedAt,
        outputLength: response.length
      });
      return response;
    } catch (primaryError) {
      if (!this.fallback) {
        this.logger.error("Primary model failed with no fallback configured", {
          durationMs: Date.now() - startedAt,
          error: primaryError
        });
        throw primaryError;
      }

      this.logger.warn("Primary model failed, escalating to fallback model", {
        durationMs: Date.now() - startedAt,
        error: primaryError
      });
      const fallbackStartedAt = Date.now();
      const response = await this.fallback.complete(prompt);
      this.logger.debug("Fallback model completed", {
        durationMs: Date.now() - fallbackStartedAt,
        outputLength: response.length
      });
      return response;
    }
  }
}
