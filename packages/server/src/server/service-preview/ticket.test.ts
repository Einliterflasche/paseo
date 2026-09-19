import { describe, expect, it } from "vitest";
import { PreviewAdmissionError } from "./http-admission.js";
import { createPreviewTicket, createPreviewTicketReader } from "./ticket.js";

const ticket = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 7)).toString(
  "base64url",
);
const zeroTicket = Buffer.alloc(32).toString("base64url");

function percentEncode(value: string): string {
  return Array.from(Buffer.from(value), (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(
    "",
  );
}

/** Only the exact generated form may carry the independently checked issuer credential. */
function formTicket(body: Uint8Array): string | null {
  const entries = [...new URLSearchParams(Buffer.from(body).toString("utf8"))];
  if (entries.length !== 1 || entries[0]?.[0] !== "ticket") return null;
  const value = entries[0][1];
  const decoded = Buffer.from(value, "base64url");
  const generated = Buffer.from(new URLSearchParams({ ticket: value }).toString());
  return decoded.length === 32 &&
    decoded.toString("base64url") === value &&
    generated.equals(Buffer.from(body))
    ? value
    : null;
}

function streamingTicket(chunks: readonly Uint8Array[]): string | null {
  const reader = createPreviewTicketReader();
  try {
    for (const chunk of chunks) reader.write(chunk);
    return reader.finish();
  } catch (error) {
    if (!(error instanceof PreviewAdmissionError)) throw error;
    return null;
  }
}

function expectEverySplit(body: Uint8Array, expected: string | null): void {
  expect(formTicket(body)).toBe(expected);
  for (let split = 0; split <= body.length; split += 1) {
    expect(streamingTicket([body.slice(0, split), body.slice(split)]), `split ${split}`).toBe(
      expected,
    );
  }
  expect(streamingTicket(Array.from(body, (byte) => Uint8Array.of(byte)))).toBe(expected);
}

describe("preview ticket form reader", () => {
  it("rejects a percent-encoded equivalent of the generated exact form", () => {
    const body = `%74icket=${ticket}`;
    expect(new URLSearchParams(body).get("ticket")).toBe(ticket);
    expect(streamingTicket([Buffer.from(body)])).toBeNull();
  });

  it("accepts a freshly issued canonical 32-byte credential", () => {
    const issued = createPreviewTicket();
    expect(Buffer.from(issued, "base64url")).toHaveLength(32);
    const body = Buffer.from(new URLSearchParams({ ticket: issued }).toString());
    expect(body).toHaveLength(50);
    expectEverySplit(body, issued);
  });

  it.each([
    ["ordinary form", `ticket=${ticket}`],
    ["URL-safe alphabet", `ticket=${Buffer.alloc(32, 255).toString("base64url")}`],
  ])("accepts exact %s at every byte boundary", (_name, body) => {
    const bytes = Buffer.from(body);
    const expected = new URLSearchParams(body).get("ticket");
    expect(bytes).toHaveLength(50);
    expectEverySplit(bytes, expected);
  });

  it.each([
    ["question-mark prefix", `?ticket=${ticket}`],
    ["empty segments", `&&ticket=${ticket}&&&`],
    ["question mark before empty segments", `?&&ticket=${ticket}&&`],
    ["lowercase percent encoding", `${percentEncode("ticket")}=${percentEncode(ticket)}`],
    [
      "uppercase percent encoding",
      `${percentEncode("ticket").toUpperCase()}=${percentEncode(ticket).toUpperCase()}`,
    ],
    [
      "mixed name and value encoding",
      `t%69ck%65t=${ticket.slice(0, 4)}${percentEncode(ticket.slice(4))}`,
    ],
    ["leading empty field", `&ticket=${ticket}`],
    ["trailing empty field", `ticket=${ticket}&`],
  ])("rejects noncanonical %s at every byte boundary", (_name, body) => {
    expect(new URLSearchParams(body).get("ticket")).toBe(ticket);
    expectEverySplit(Buffer.from(body), null);
  });

  it("rejects a long encoded form with empty fields", () => {
    const body = Buffer.from(
      `?${"&".repeat(4096)}${percentEncode("ticket")}=${percentEncode(ticket)}${"&".repeat(4096)}`,
    );
    expect(body.length).toBeGreaterThan(50);
    expect(new URLSearchParams(body.toString()).get("ticket")).toBe(ticket);
    expect(formTicket(body)).toBeNull();
    expect(streamingTicket(Array.from(body, (byte) => Uint8Array.of(byte)))).toBeNull();
  });

  it.each([
    ["empty body", ""],
    ["empty fields only", "?&&&"],
    ["missing value", "ticket"],
    ["empty value", "ticket="],
    ["empty name", `=${ticket}`],
    ["different field", `token=${ticket}`],
    ["long field name", `tickets=${ticket}`],
    ["encoded field suffix", `ticket%00=${ticket}`],
    ["duplicate field", `ticket=${ticket}&ticket=${ticket}`],
    ["encoded duplicate field", `ticket=${ticket}&%74icket=${ticket}`],
    ["extra field before", `other=x&ticket=${ticket}`],
    ["extra field after", `ticket=${ticket}&other=x`],
    ["nonempty empty-name field", `ticket=${ticket}&=`],
    ["short token", `ticket=${ticket.slice(0, -1)}`],
    ["long token", `ticket=${ticket}A`],
    ["noncanonical final bits", `ticket=${zeroTicket.slice(0, -1)}B`],
    ["padding", `ticket=${ticket}=`],
    ["encoded padding", `ticket=${ticket}%3D`],
    ["plus decoding", `ticket=+${ticket.slice(1)}`],
    ["encoded space", `ticket=%20${ticket.slice(1)}`],
    ["encoded plus", `ticket=%2b${ticket.slice(1)}`],
    ["encoded slash", `ticket=%2F${ticket.slice(1)}`],
    ["encoded separator", `ticket=${ticket}%26`],
    ["incomplete percent escape", `ticket=${ticket}%`],
    ["incomplete half escape", `ticket=${ticket}%4`],
    ["non-hex escape", `ticket=${ticket}%4G`],
    ["escape interrupted by field delimiter", `%7&ticket=${ticket}`],
    ["escape in name interrupted by equals", `%7=${ticket}`],
    ["encoded equals is part of name", `ticket%3d${ticket}`],
    ["second question mark", `??ticket=${ticket}`],
    ["question mark after separator", `&?ticket=${ticket}`],
    ["encoded question mark", `%3fticket=${ticket}`],
    ["non-ASCII token", `ticket=${ticket.slice(0, -1)}é`],
    ["malformed UTF-8", `ticket=${ticket.slice(0, -1)}%ff`],
    ["double encoding", `ticket=%2541${ticket.slice(1)}`],
  ])("rejects malformed %s at every byte boundary", (_name, body) => {
    expectEverySplit(Buffer.from(body), null);
  });

  it("matches the reference decoder for byte mutations in names, separators and tokens", () => {
    const base = Buffer.from(`ticket=${ticket}`);
    for (const offset of [0, 5, 6, 7, base.length - 1]) {
      for (let byte = 0; byte <= 255; byte += 1) {
        const body = Buffer.from(base);
        body[offset] = byte;
        expect(streamingTicket([body]), `offset ${offset}, byte ${byte}`).toBe(formTicket(body));
      }
    }
  });

  it.each([
    ["impossible field", "other"],
    ["invalid token character", "ticket=%20"],
    ["overlong decoded token", `ticket=${ticket}A`],
    ["trailing empty field", `ticket=${ticket}&`],
    ["second field", `ticket=${ticket}&t`],
  ])("rejects %s while the sender still has more bytes", (_name, prefix) => {
    const reader = createPreviewTicketReader();
    expect(() => reader.write(Buffer.from(prefix))).toThrow(PreviewAdmissionError);
  });

  it("keeps a valid incomplete prefix pending until EOF or impossible bytes", () => {
    const reader = createPreviewTicketReader();
    reader.write(Buffer.from("tic"));
    reader.write(Buffer.from(`ket=${ticket.slice(0, -1)}`));
    expect(() => reader.finish()).toThrow(PreviewAdmissionError);
  });

  it("denies the first excess byte without waiting for the sender to finish", () => {
    const reader = createPreviewTicketReader();
    reader.write(Buffer.from(`ticket=${ticket}`));
    expect(() => reader.write(Buffer.from("&"))).toThrow(PreviewAdmissionError);
    expect(() => reader.finish()).toThrow(PreviewAdmissionError);
    expect(() => reader.write(new Uint8Array())).toThrow(PreviewAdmissionError);
  });
});
