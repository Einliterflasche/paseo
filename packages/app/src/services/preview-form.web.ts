import type { PreparedPreview } from "./preview-coordinator";

/** A ticket is submitted once, in the body, without entering history or app storage. */
export function submitPreviewForm({
  document,
  prepared,
  target,
  openerAlreadyCleared = false,
}: {
  document: Document;
  prepared: PreparedPreview;
  target: string;
  openerAlreadyCleared?: boolean;
}) {
  if (!/^[a-zA-Z0-9-]+$/.test(prepared.bootstrapId)) throw new Error("Invalid preview bootstrap");
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `/__paseo_services/bootstrap/${prepared.bootstrapId}`;
  form.target = target;
  // noreferrer also suppresses the POST's Origin in Chromium. The gateway
  // requires that exact Origin; the ticket is only in the body, never the URL.
  if (prepared.mode === "tab" && !openerAlreadyCleared) form.rel = "noopener";
  form.hidden = true;
  const ticket = document.createElement("input");
  ticket.type = "hidden";
  ticket.name = "ticket";
  ticket.value = prepared.ticket;
  form.appendChild(ticket);
  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    ticket.value = "";
    form.remove();
  }
}
