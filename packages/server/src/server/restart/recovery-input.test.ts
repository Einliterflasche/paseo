import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  RecoveryInputSchema,
  continuationPrompt,
  recoveryInput,
  verifyRecoveryInputFiles,
} from "./recovery-input.js";

test("recovery retains rich attachment metadata and image bytes, including identical separate inputs", () => {
  const prompt = [
    {
      type: "text" as const,
      mimeType: "text/plain" as const,
      contextKind: "chat_history",
      title: "original",
      text: "remember this",
    },
    { type: "image" as const, data: "AAECAw==", mimeType: "image/png" },
  ];
  const inputs = ["first", "second"].map((clientMessageId) =>
    RecoveryInputSchema.parse(recoveryInput(prompt, { clientMessageId }, "steer")),
  );
  expect(inputs.map((input) => input.id)).toEqual(["first", "second"]);
  expect(inputs.map((input) => input.prompt)).toEqual([prompt, prompt]);
  const continuation = continuationPrompt(inputs);
  expect(Array.isArray(continuation)).toBe(true);
  if (!Array.isArray(continuation)) throw new Error("Expected image continuation");
  expect(continuation.filter((block) => block.type === "image")).toEqual([prompt[1], prompt[1]]);
  const text = continuation[0];
  if (text?.type !== "text") throw new Error("Expected recovery context");
  expect(text.text.indexOf('"id":"first"')).toBeLessThan(text.text.indexOf('"id":"second"'));
});

test("a missing or truncated upload blocks checkpoint readiness", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-upload-recovery-"));
  const file = join(home, "data.bin");
  const input = recoveryInput(
    [
      {
        type: "uploaded_file",
        id: "upload",
        fileName: "data.bin",
        path: file,
        mimeType: "application/octet-stream",
        size: 4,
      },
    ],
    undefined,
    "run",
  );
  await expect(verifyRecoveryInputFiles([input])).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(file, Buffer.from([0, 1]));
  await expect(verifyRecoveryInputFiles([input])).rejects.toThrow("incomplete");
  await writeFile(file, Buffer.from([0, 1, 2, 3]));
  await expect(verifyRecoveryInputFiles([input])).resolves.toBeUndefined();
});
