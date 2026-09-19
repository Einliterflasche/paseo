import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const script = resolve("scripts/deploy-nixos.sh");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-deploy-wrapper-test-"));
  const bin = join(root, "bin");
  const closure = join(root, "closure");
  await mkdir(bin);
  await mkdir(join(closure, "bin"), { recursive: true });
  await mkdir(join(closure, "sw/bin"), { recursive: true });
  const executable = (name, body) =>
    writeFile(name, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o700 });
  await executable(join(closure, "sw/bin/paseo"), 'printf "%s\\n" "$@" > "$TEST_ROOT/deploy-argv"');
  await executable(
    join(closure, "bin/switch-to-configuration"),
    'echo switch >> "$TEST_ROOT/actions"; if [[ "${SWITCH_EXIT:-0}" != 0 ]]; then exit "$SWITCH_EXIT"; fi; if [[ "${SWITCH_REPLACES:-0}" == 1 ]]; then echo replacement > "$TEST_ROOT/invocation"; fi',
  );
  await executable(
    join(bin, "nixos-rebuild"),
    'printf "%s\\n" "$@" > "$TEST_ROOT/build-argv"; exit_code="${BUILD_EXIT:-0}"; if [[ "$exit_code" != 0 ]]; then exit "$exit_code"; fi; ln -s "$TEST_ROOT/closure" result',
  );
  await executable(join(bin, "paseo"), 'printf "%s\\n" "$@" > "$TEST_ROOT/deploy-argv"');
  await executable(join(bin, "sudo"), 'exec "$@"');
  await executable(join(bin, "systemd-run"), 'printf "%s\\n" "$@" > "$TEST_ROOT/systemd-argv"');
  await writeFile(join(root, "invocation"), "original\n");
  await executable(join(bin, "nix-env"), 'printf "profile %s\\n" "$*" >> "$TEST_ROOT/actions"');
  await executable(
    join(bin, "systemctl"),
    'if [[ "$1" == show ]]; then cat "$TEST_ROOT/invocation"; else printf "%s\\n" "$*" >> "$TEST_ROOT/actions"; fi',
  );
  return {
    root,
    closure,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PASEO_CLI: join(bin, "paseo"),
      TEST_ROOT: root,
      PASEO_DEPLOY_FLAKE: "",
      PASEO_PASSWORD: "",
      PASEO_DEPLOY_ENV_FILE: "",
    },
  };
}

test("host configuration is built before exact activation argv is handed to checkpoint CLI", async () => {
  const f = await fixture();
  const result = spawnSync(script, ["--worker", "--reason", "update with spaces"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.root, "build-argv"), "utf8"), "build\n");
  const argv = (await readFile(join(f.root, "deploy-argv"), "utf8")).trimEnd().split("\n");
  assert.deepEqual(argv.slice(0, 8), [
    "daemon",
    "deploy",
    "--target-cli",
    join(f.closure, "sw/bin/paseo"),
    "--reason",
    "update with spaces",
    "--",
    "/run/wrappers/bin/sudo",
  ]);
  assert.equal(argv.length, 10);
  assert.ok(argv[8].endsWith("/activate.sh"));
  assert.equal(argv[9], f.closure);
  await access(argv[8]);
  await assert.rejects(access(join(f.root, "actions")), { code: "ENOENT" });
});

test("a failed build never prepares or activates a restart", async () => {
  const f = await fixture();
  const result = spawnSync(script, ["--worker"], {
    env: { ...f.env, BUILD_EXIT: "7" },
    encoding: "utf8",
  });
  assert.equal(result.status, 7);
  await assert.rejects(access(join(f.root, "deploy-argv")), { code: "ENOENT" });
});

test("explicit flake references are passed intact", async () => {
  const f = await fixture();
  const result = spawnSync(script, ["--worker", "--flake", "/configuration#host"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(f.root, "build-argv"), "utf8"),
    "build\n--flake\n/configuration#host\n",
  );
});

test("build and deployment run outside Paseo as the operator with the selected state directory", async () => {
  const f = await fixture();
  const paseoHome = join(f.root, "selected home");
  const result = spawnSync(script, ["--reason", "quick update"], {
    env: { ...f.env, PASEO_HOME: paseoHome },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(join(f.root, "systemd-argv"), "utf8")).trimEnd().split("\n");
  assert.ok(args.includes(`--uid=${process.getuid()}`));
  assert.ok(!args.includes("--wait"));
  const handoff = args
    .find((arg) => arg.startsWith("--setenv=PASEO_DEPLOY_HANDOFF="))
    .split("=")
    .slice(2)
    .join("=");
  await access(join(handoff, "ready"));
  assert.ok(args.includes(`--setenv=PASEO_HOME=${paseoHome}`));
  assert.deepEqual(args.slice(-5), ["--", script, "--worker", "--reason", "quick update"]);
  await assert.rejects(access(join(f.root, "build-argv")), { code: "ENOENT" });
});

test("credentials reach the detached unit by file reference without appearing in argv", async () => {
  const f = await fixture();
  const credentialFile = join(f.root, "credentials.env");
  await writeFile(credentialFile, "PASEO_PASSWORD=example-secret\n", { mode: 0o600 });
  const result = spawnSync(script, [], {
    env: { ...f.env, PASEO_DEPLOY_ENV_FILE: credentialFile },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = await readFile(join(f.root, "systemd-argv"), "utf8");
  assert.ok(args.includes(`--property=EnvironmentFile=${credentialFile}\n`));
  assert.ok(!args.includes("example-secret"));
  assert.ok(!result.stdout.includes("example-secret"));
  await assert.rejects(access(join(f.root, "actions")), { code: "ENOENT" });
});

test("a password that would be lost across detachment fails before launching the job", async () => {
  const f = await fixture();
  const result = spawnSync(script, [], {
    env: { ...f.env, PASEO_PASSWORD: "example-secret" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("PASEO_DEPLOY_ENV_FILE"));
  assert.ok(!result.stderr.includes("example-secret"));
  await assert.rejects(access(join(f.root, "systemd-argv")), { code: "ENOENT" });
});

test("a missing credential file never launches a deployment job", async () => {
  const f = await fixture();
  const result = spawnSync(script, [], {
    env: { ...f.env, PASEO_DEPLOY_ENV_FILE: join(f.root, "missing.env") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  await assert.rejects(access(join(f.root, "systemd-argv")), { code: "ENOENT" });
});

for (const replaces of [false, true]) {
  test(`activation records the system generation and ${replaces ? "never restarts the replacement again" : "replaces an unchanged paused service"}`, async () => {
    const f = await fixture();
    const prepare = spawnSync(script, ["--worker"], { env: f.env, encoding: "utf8" });
    assert.equal(prepare.status, 0, prepare.stderr);
    const args = (await readFile(join(f.root, "deploy-argv"), "utf8")).trimEnd().split("\n");
    const activation = spawnSync(args[8], [args[9]], {
      env: { ...f.env, SWITCH_REPLACES: replaces ? "1" : "0" },
      encoding: "utf8",
    });
    assert.equal(activation.status, 0, activation.stderr);
    assert.deepEqual((await readFile(join(f.root, "actions"), "utf8")).trimEnd().split("\n"), [
      `profile --profile /nix/var/nix/profiles/system --set ${f.closure}`,
      "switch",
      `${replaces ? "start" : "restart"} paseo.service`,
    ]);
  });
}

test("a failed activation never attempts an additional restart", async () => {
  const f = await fixture();
  const prepare = spawnSync(script, ["--worker"], { env: f.env, encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);
  const args = (await readFile(join(f.root, "deploy-argv"), "utf8")).trimEnd().split("\n");
  const activation = spawnSync(args[8], [args[9]], {
    env: { ...f.env, SWITCH_EXIT: "8" },
    encoding: "utf8",
  });
  assert.equal(activation.status, 8);
  const actions = await readFile(join(f.root, "actions"), "utf8");
  assert.ok(!actions.includes("restart"));
  assert.ok(!actions.includes("start paseo.service"));
});

test("worker cannot build or checkpoint while the privileged launcher is still present", async () => {
  const f = await fixture();
  const handoff = join(f.root, "handoff");
  await mkdir(handoff);
  await writeFile(join(handoff, "launcher-pid"), String(process.pid));
  const child = spawn(script, ["--worker"], {
    env: { ...f.env, PASEO_DEPLOY_HANDOFF: handoff },
    stdio: "ignore",
  });
  const exited = new Promise((done) => child.on("exit", done));
  try {
    await new Promise((done) => setTimeout(done, 250));
    await assert.rejects(access(join(f.root, "build-argv")), { code: "ENOENT" });
    await assert.rejects(access(join(f.root, "deploy-argv")), { code: "ENOENT" });
    await writeFile(join(handoff, "ready"), "");
    assert.equal(await exited, 0);
    await access(join(f.root, "build-argv"));
    await access(join(f.root, "deploy-argv"));
  } finally {
    child.kill();
  }
});

test("an abandoned launcher fails closed before checkpointing", async () => {
  const f = await fixture();
  const handoff = join(f.root, "handoff");
  await mkdir(handoff);
  const dead = spawnSync("true");
  await writeFile(join(handoff, "launcher-pid"), String(dead.pid));
  const result = spawnSync(script, ["--worker"], {
    env: { ...f.env, PASEO_DEPLOY_HANDOFF: handoff },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /launcher exited/);
  await assert.rejects(access(join(f.root, "build-argv")), { code: "ENOENT" });
});
