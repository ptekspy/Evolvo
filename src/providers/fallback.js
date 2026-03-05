export class FallbackProvider {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async complete(prompt) {
    try {
      return await this.primary.complete(prompt);
    } catch (primaryError) {
      if (!this.fallback) {
        throw primaryError;
      }

      console.warn(`Primary model failed, escalating to fallback model: ${primaryError}`);
      return this.fallback.complete(prompt);
    }
  }
}
