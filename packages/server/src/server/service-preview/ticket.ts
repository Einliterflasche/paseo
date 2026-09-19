import { randomBytes } from "node:crypto";
import { PreviewAdmissionError } from "./http-admission.js";

const TICKET_BYTES = 32;
const TICKET_LENGTH = Math.ceil((TICKET_BYTES * 8) / 6);
const PREFIX = Buffer.from("ticket=");

export function createPreviewTicket(): string {
  return randomBytes(TICKET_BYTES).toString("base64url");
}

/**
 * Accepts exactly the form generated for an issued ticket: the ASCII prefix and
 * its canonical base64url credential. The operator approved this 50-byte login
 * contract; it does not limit application uploads. Validate as bytes arrive so
 * invalid unfinished forms can be denied without buffering or awaiting EOF.
 */
export function createPreviewTicketReader() {
  let prefixOffset = 0;
  let ticket = "";
  let failed = false;

  function denied(): never {
    failed = true;
    throw new PreviewAdmissionError();
  }

  return {
    write(bytes: Uint8Array): void {
      if (failed) denied();
      for (const byte of bytes) {
        if (prefixOffset < PREFIX.length) {
          if (byte !== PREFIX[prefixOffset]) denied();
          prefixOffset += 1;
          continue;
        }
        const character = String.fromCharCode(byte);
        if (!/^[A-Za-z0-9_-]$/.test(character) || ticket.length === TICKET_LENGTH) denied();
        ticket += character;
      }
    },
    finish(): string {
      if (
        failed ||
        prefixOffset !== PREFIX.length ||
        ticket.length !== TICKET_LENGTH ||
        Buffer.from(ticket, "base64url").toString("base64url") !== ticket
      )
        denied();
      return ticket;
    },
  };
}
