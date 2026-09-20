import { Transform } from "node:stream";

export class DevelopmentPrefixTransform extends Transform {
  #pending = Buffer.alloc(0);
  #rewrites;
  #carryLength;

  constructor(baseUrl) {
    super();
    const prefix = JSON.stringify(baseUrl);
    // Expo's browser sockets use root paths, while Metro registers filesystem
    // entrypoints. Keep public URLs prefixed and strip only registration paths.
    const entryPoints = `pendingEntryPoints.map(value => { const url = new URL(value); if (url.pathname.startsWith(${prefix} + "/")) url.pathname = url.pathname.slice(${prefix}.length); return url.href; })`;
    this.#rewrites = [
      ["if (process.env.NODE_ENV !== 'development') {", "if (true) {"],
      ["${window.location.host}/hot", `\${window.location.host}\${${prefix}}/hot`],
      ["${window.location.host}/message", `\${window.location.host}\${${prefix}}/message`],
      ["entryPoints:pendingEntryPoints", `entryPoints:${entryPoints}`],
      ["entryPoints: pendingEntryPoints", `entryPoints: ${entryPoints}`],
    ].map(([needle, replacement]) => [Buffer.from(needle), Buffer.from(replacement)]);
    // Byte carry preserves split UTF-8 sequences without buffering a bundle.
    this.#carryLength = Math.max(...this.#rewrites.map(([needle]) => needle.length)) - 1;
  }

  _transform(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#pending = Buffer.concat([this.#pending, bytes]);
    this.#drain(false);
    callback();
  }

  _flush(callback) {
    this.#drain(true);
    callback();
  }

  #drain(flush) {
    while (true) {
      let match = -1;
      let selected;
      for (const rewrite of this.#rewrites) {
        const candidate = this.#pending.indexOf(rewrite[0]);
        if (candidate >= 0 && (match < 0 || candidate < match)) {
          match = candidate;
          selected = rewrite;
        }
      }
      if (!selected) break;
      this.push(this.#pending.subarray(0, match));
      this.push(selected[1]);
      this.#pending = this.#pending.subarray(match + selected[0].length);
    }
    const readyLength = flush ? this.#pending.length : this.#pending.length - this.#carryLength;
    if (readyLength > 0) {
      this.push(this.#pending.subarray(0, readyLength));
      this.#pending = this.#pending.subarray(readyLength);
    }
  }
}
