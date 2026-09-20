import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DevelopmentPrefixTransform } from "./prefix-expo-transform.mjs";

async function rewrite(chunks, baseUrl) {
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(new DevelopmentPrefixTransform(baseUrl))) {
    output.push(chunk);
  }
  return Buffer.concat(output);
}

const websocketSource = [
  'const serverScheme = "wss"; const protocol = "wss";',
  "globalThis.hot = `${serverScheme}://${window.location.host}/hot`;",
  "globalThis.message = `${protocol}://${window.location.host}/message`;",
].join("\n");

function websocketUrls(source) {
  const context = { window: { location: { host: "control.example:9443" } } };
  runInNewContext(source, context);
  return { hot: context.hot, message: context.message };
}

test("Expo development websocket endpoints stay inside the configured prefix at every byte split", async () => {
  const prefix = "/__paseo_services/apps/expo";
  const source = Buffer.from(`// café 😃\n${websocketSource}\n// 日本語`);
  const expected = {
    hot: `wss://control.example:9443${prefix}/hot`,
    message: `wss://control.example:9443${prefix}/message`,
  };
  for (let split = 0; split <= source.length; split += 1) {
    const output = await rewrite([source.subarray(0, split), source.subarray(split)], prefix);
    assert.deepEqual(websocketUrls(output.toString("utf8")), expected);
    assert.ok(output.toString("utf8").startsWith("// café 😃\n"));
    assert.ok(output.toString("utf8").endsWith("// 日本語"));
  }
  const bytes = Array.from(source, (byte) => Buffer.from([byte]));
  assert.deepEqual(websocketUrls((await rewrite(bytes, prefix)).toString("utf8")), expected);
});

test("configured paths are JavaScript values and do not rewrite unrelated endpoint literals", async () => {
  const prefix = '/preview/quote"/backtick`/dollar${globalThis.injected = true}/é';
  const source = `${websocketSource}\nglobalThis.literal = "/hot"; globalThis.other = "/message";`;
  const output = (await rewrite([Buffer.from(source)], prefix)).toString("utf8");
  const context = { window: { location: { host: "control.example:9443" } } };
  runInNewContext(output, context);
  assert.equal(context.hot, `wss://control.example:9443${prefix}/hot`);
  assert.equal(context.message, `wss://control.example:9443${prefix}/message`);
  assert.equal(context.literal, "/hot");
  assert.equal(context.other, "/message");
  assert.equal(context.injected, undefined);
});

test("development base guard is enabled and unmatched bytes and incomplete needles flush unchanged", async () => {
  const guard = "if (process.env.NODE_ENV !== 'development') {";
  const prefix = Buffer.from([0, 255, 195, 169]);
  const suffix = Buffer.from("\n${window.location.host}/ho");
  const input = Buffer.concat([prefix, Buffer.from(guard), suffix]);
  const output = await rewrite(
    Array.from(input, (byte) => Buffer.from([byte])),
    "/preview",
  );
  assert.deepEqual(output, Buffer.concat([prefix, Buffer.from("if (true) {"), suffix]));
});

test("Expo HMR registration removes only its public mount and preserves bundle query options", async () => {
  const prefix = "/__paseo_services/apps/expo";
  const bundle = `https://control.example:9443${prefix}/index.bundle?platform=web&dev=true&transform.baseUrl=${encodeURIComponent(prefix)}`;
  const unrelated = "https://control.example:9443/other/index.bundle?platform=web";
  const expected = new URL(bundle);
  expected.pathname = "/index.bundle";
  for (const syntax of ["entryPoints:pendingEntryPoints", "entryPoints: pendingEntryPoints"]) {
    const source = Buffer.from(`const pendingEntryPoints = ${JSON.stringify([bundle, unrelated])};
      globalThis.payload = { type: 'register-entrypoints', ${syntax} };
      globalThis.publicBundles = pendingEntryPoints;`);
    for (let split = 0; split <= source.length; split += 1) {
      const output = await rewrite([source.subarray(0, split), source.subarray(split)], prefix);
      const context = { URL };
      runInNewContext(output.toString("utf8"), context);
      assert.equal(context.payload.type, "register-entrypoints");
      assert.deepEqual(Array.from(context.payload.entryPoints), [expected.href, unrelated]);
      assert.deepEqual(Array.from(context.publicBundles), [bundle, unrelated]);
    }
  }
});
