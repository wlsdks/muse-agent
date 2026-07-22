import type { JsonValue } from "./json-utils.js";

export interface StrictJsonOptions {
  readonly maxArrayItems?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxObjectMembers?: number;
}

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonError";
  }
}

const DEFAULTS: Required<StrictJsonOptions> = {
  maxArrayItems: 4_096,
  maxDepth: 32,
  maxNodes: 16_384,
  maxObjectMembers: 4_096
};

class JsonDuplicateScanner {
  readonly #text: string;
  readonly #options: Required<StrictJsonOptions>;
  #index = 0;
  #nodes = 0;

  constructor(text: string, options: StrictJsonOptions) {
    this.#text = text;
    this.#options = { ...DEFAULTS, ...options };
  }

  scan(): void {
    this.#skipWhitespace();
    this.#scanValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) throw new StrictJsonError("trailing JSON content");
  }

  #scanValue(depth: number): void {
    this.#nodes += 1;
    if (this.#nodes > this.#options.maxNodes) throw new StrictJsonError("JSON node limit exceeded");
    if (depth > this.#options.maxDepth) throw new StrictJsonError("JSON depth limit exceeded");
    const current = this.#text[this.#index];
    if (current === "{") return this.#scanObject(depth + 1);
    if (current === "[") return this.#scanArray(depth + 1);
    if (current === "\"") { this.#scanString(); return; }
    this.#scanPrimitive();
  }

  #scanObject(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#consume("}")) return;
    const keys = new Set<string>();
    let members = 0;
    while (true) {
      if (members >= this.#options.maxObjectMembers) throw new StrictJsonError("JSON object member limit exceeded");
      if (this.#text[this.#index] !== "\"") throw new StrictJsonError("expected JSON object key");
      const key = this.#scanString();
      if (keys.has(key)) throw new StrictJsonError(`duplicate JSON key: ${key}`);
      keys.add(key);
      this.#skipWhitespace();
      if (!this.#consume(":")) throw new StrictJsonError("expected colon after JSON object key");
      this.#skipWhitespace();
      this.#scanValue(depth);
      members += 1;
      this.#skipWhitespace();
      if (this.#consume("}")) return;
      if (!this.#consume(",")) throw new StrictJsonError("expected comma in JSON object");
      this.#skipWhitespace();
    }
  }

  #scanArray(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#consume("]")) return;
    let items = 0;
    while (true) {
      if (items >= this.#options.maxArrayItems) throw new StrictJsonError("JSON array item limit exceeded");
      this.#scanValue(depth);
      items += 1;
      this.#skipWhitespace();
      if (this.#consume("]")) return;
      if (!this.#consume(",")) throw new StrictJsonError("expected comma in JSON array");
      this.#skipWhitespace();
    }
  }

  #scanString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const current = this.#text[this.#index]!;
      if (current === "\"") {
        this.#index += 1;
        try {
          return JSON.parse(this.#text.slice(start, this.#index)) as string;
        } catch {
          throw new StrictJsonError("invalid JSON string");
        }
      }
      if (current === "\\") {
        this.#index += 2;
      } else {
        this.#index += 1;
      }
    }
    throw new StrictJsonError("unterminated JSON string");
  }

  #scanPrimitive(): void {
    const start = this.#index;
    while (this.#index < this.#text.length && !/[\s,}\]]/u.test(this.#text[this.#index]!)) this.#index += 1;
    if (this.#index === start) throw new StrictJsonError("invalid JSON value");
  }

  #skipWhitespace(): void {
    while (this.#index < this.#text.length && /\s/u.test(this.#text[this.#index]!)) this.#index += 1;
  }

  #consume(expected: string): boolean {
    if (this.#text[this.#index] !== expected) return false;
    this.#index += 1;
    return true;
  }
}

export function parseStrictJson(text: string, options: StrictJsonOptions = {}): JsonValue {
  try {
    new JsonDuplicateScanner(text, options).scan();
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    if (cause instanceof StrictJsonError) throw cause;
    throw new StrictJsonError("invalid JSON");
  }
}
