function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Small stale-while-revalidate cache for presentation-only JSON DTOs.
 * Cold/expired callers coalesce on the loader. Stale callers receive the last
 * immutable DTO immediately while one background refresh runs.
 */
export class PresentationDtoCache {
  #value = null;
  #loadedAt = 0;
  #inFlight = null;
  #generation = 0;

  constructor({ ttlMs, staleMs, now = () => Date.now() }) {
    if (!(ttlMs >= 0) || !(staleMs >= ttlMs)) throw new Error("invalid presentation cache window");
    this.ttlMs = ttlMs;
    this.staleMs = staleMs;
    this.now = now;
  }

  clear() {
    this.#value = null;
    this.#loadedAt = 0;
    this.#generation += 1;
    this.#inFlight = null;
  }

  async get(loader) {
    const age = this.#value === null ? Infinity : this.now() - this.#loadedAt;
    if (age <= this.ttlMs) return this.#value;
    if (age <= this.staleMs) {
      this.#refresh(loader).catch(() => {});
      return this.#value;
    }
    return this.#refresh(loader);
  }

  #refresh(loader) {
    if (this.#inFlight) return this.#inFlight;
    const generation = this.#generation;
    let flight;
    flight = Promise.resolve()
      .then(loader)
      .then((dto) => {
        const immutable = deepFreeze(cloneJson(dto));
        if (generation === this.#generation) {
          this.#value = immutable;
          this.#loadedAt = this.now();
        }
        return immutable;
      })
      .finally(() => {
        if (this.#inFlight === flight) this.#inFlight = null;
      });
    this.#inFlight = flight;
    return flight;
  }
}
