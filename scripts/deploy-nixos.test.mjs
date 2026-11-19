import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/deploy-nixos.sh");
const realTimeout = spawnSync("bash", ["-c", "command -v timeout"], {
  encoding: "utf8",
}).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-deploy-wrapper-test-"));
  const bin = join(root, "bin");
  const closure = join(root, "closure");
  const wrappers = join(root, "wrappers");
  await mkdir(bin);
  await mkdir(wrappers);
  await mkdir(join(closure, "bin"), { recursive: true });
  await mkdir(join(closure, "sw/bin"), { recursive: true });
  const executable = (name, body) =>
    writeFile(name, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o700 });
  await executable(
    join(closure, "sw/bin/paseo"),
    'printf "%s\\n" "$*" >> "$TEST_ROOT/status-argv"; if [[ -f "$TEST_ROOT/daemon-answers" ]]; then printf \'{\\n  "connectedDaemon": "reachable",\\n  "recoveryState": "running"\\n}\\n\'; else printf \'{\\n  "connectedDaemon": "unreachable"\\n}\\n\'; fi',
  );
  await executable(
    join(closure, "bin/switch-to-configuration"),
    'echo "switch $*" >> "$TEST_ROOT/actions"; exit "${SWITCH_EXIT:-0}"',
  );
  await executable(
    join(bin, "nixos-rebuild"),
    'printf "%s\\n" "$@" > "$TEST_ROOT/build-argv"; exit_code="${BUILD_EXIT:-0}"; if [[ "$exit_code" != 0 ]]; then exit "$exit_code"; fi; ln -s "$TEST_ROOT/closure" result',
  );
  await executable(join(wrappers, "sudo"), 'echo "sudo $*" >> "$TEST_ROOT/sudo-argv"; exec "$@"');
  // Like the non-setuid sudo in the host PATH: the script must never use it.
  await executable(
    join(bin, "sudo"),
    'echo "sudo must be owned by uid 0 and have the setuid bit set" >&2; exit 1',
  );
  await executable(join(bin, "systemd-run"), 'printf "%s\\n" "$@" > "$TEST_ROOT/systemd-argv"');
  await executable(
    join(bin, "nix-env"),
    'printf "profile %s\\n" "$*" >> "$TEST_ROOT/actions"; if [[ -f "$TEST_ROOT/profile-hangs" ]]; then exec sleep 30; fi',
  );
  // Records each requested limit; a hanging profile step is cut off after 1s instead of 300s.
  await executable(
    join(bin, "timeout"),
    [
      'printf "%s %s\\n" "$1" "$2" >> "$TEST_ROOT/timeouts"',
      'limit="$1"; shift',
      'if [[ "$1" == nix-env && -f "$TEST_ROOT/profile-hangs" ]]; then limit=1; fi',
      `exec ${JSON.stringify(realTimeout)} "$limit" "$@"`,
    ].join("\n"),
  );
  await executable(
    join(bin, "systemctl"),
    [
      'printf "%s\\n" "$*" >> "$TEST_ROOT/actions"',
      'if [[ "$1" == stop && -f "$TEST_ROOT/stop-hangs" ]]; then rm "$TEST_ROOT/stop-hangs"; exec sleep 30; fi',
      'if [[ "$1" == start ]]; then touch "$TEST_ROOT/daemon-answers"; exit "${START_EXIT:-0}"; fi',
    ].join("\n"),
  );
  return {
    root,
    closure,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PASEO_DEPLOY_SUDO: join(wrappers, "sudo"),
      PASEO_HOME: join(root, "selected home"),
      PASEO_DEPLOY_READY_TIMEOUT: "4",
      TEST_ROOT: root,
      PASEO_DEPLOY_FLAKE: "",
      PASEO_DEPLOY_STOP_TIMEOUT: "",
      PASEO_PASSWORD: "",
      PASEO_DEPLOY_ENV_FILE: "",
    },
  };
}

function runWorker(f, args = [], env = {}) {
  return spawnSync(script, ["--worker", ...args], {
    env: { ...f.env, ...env },
    encoding: "utf8",
  });
}

async function actions(f) {
  return (await readFile(join(f.root, "actions"), "utf8")).trimEnd().split("\n");
}

test("the host configuration is built before anything stops", async () => {
  const f = await fixture();
  const result = runWorker(f, ["--reason", "update with spaces"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.root, "build-argv"), "utf8"), "build\n");
  assert.match(result.stdout, /Deployment reason: update with spaces/);
  assert.match(result.stdout, new RegExp(`Build result: built ${f.closure}`));
  const [sudo] = (await readFile(join(f.root, "sudo-argv"), "utf8")).trimEnd().split("\n");
  assert.match(sudo, new RegExp(`^sudo .*/activate\\.sh ${f.closure} 300$`));
});

test("a failed build stops nothing", async () => {
  const f = await fixture();
  const result = runWorker(f, [], { BUILD_EXIT: "7" });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /Build result: failed with status 7; nothing was stopped/);
  await assert.rejects(access(join(f.root, "actions")), { code: "ENOENT" });
  await assert.rejects(access(join(f.root, "sudo-argv")), { code: "ENOENT" });
});

test("explicit flake references are passed intact", async () => {
  const f = await fixture();
  const result = runWorker(f, ["--flake", "/configuration#host"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(f.root, "build-argv"), "utf8"),
    "build\n--flake\n/configuration#host\n",
  );
});

test("activation stops, sets the profile, switches, and starts in that order", async () => {
  const f = await fixture();
  const result = runWorker(f, [], { PASEO_DEPLOY_STOP_TIMEOUT: "45" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await actions(f), [
    "stop paseo.service",
    "reset-failed paseo.service",
    `profile --profile /nix/var/nix/profiles/system --set ${f.closure}`,
    "switch switch",
    "start paseo.service",
  ]);
  assert.match(result.stdout, /Stop result: clean stop\./);
  assert.match(result.stdout, /Switch result: switched to /);
  assert.match(result.stdout, /Start result: paseo\.service started\./);
  const [sudo] = (await readFile(join(f.root, "sudo-argv"), "utf8")).trimEnd().split("\n");
  assert.ok(sudo.endsWith(" 45"));
});

test("a stop that exceeds its limit is killed before the switch continues", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "stop-hangs"), "");
  const result = runWorker(f, [], { PASEO_DEPLOY_STOP_TIMEOUT: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await actions(f), [
    "stop paseo.service",
    "kill --signal=SIGKILL paseo.service",
    "stop paseo.service",
    "reset-failed paseo.service",
    `profile --profile /nix/var/nix/profiles/system --set ${f.closure}`,
    "switch switch",
    "start paseo.service",
  ]);
  assert.match(result.stdout, /Stop result: forced kill\./);
});

test("a failed switch starts the service, then the system units, and fails the job", async () => {
  const f = await fixture();
  const result = runWorker(f, [], { SWITCH_EXIT: "8" });
  assert.equal(result.status, 8);
  assert.deepEqual((await actions(f)).slice(-3), [
    "switch switch",
    "start paseo.service",
    "start multi-user.target",
  ]);
  assert.match(result.stdout, /Switch result: failed with status 8\./);
  assert.match(result.stdout, /System units result: multi-user\.target started\./);
  assert.match(result.stdout, /Activation result: exited with status 8\./);
  assert.match(result.stdout, /"connectedDaemon": "reachable"/);
});

test("a profile step that hangs is cut off, and the service and system units start", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "profile-hangs"), "");
  const result = runWorker(f);
  assert.equal(result.status, 124, result.stderr);
  assert.deepEqual((await actions(f)).slice(-3), [
    `profile --profile /nix/var/nix/profiles/system --set ${f.closure}`,
    "start paseo.service",
    "start multi-user.target",
  ]);
  const timeouts = await readFile(join(f.root, "timeouts"), "utf8");
  assert.match(timeouts, /^300 nix-env$/m);
  assert.match(
    result.stdout,
    /Profile result: failed or exceeded 300s with status 124; the switch/,
  );
  assert.match(result.stdout, /Activation result: exited with status 124\./);
});

test("a successful switch leaves the system units to the switch", async () => {
  const f = await fixture();
  const result = runWorker(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(await actions(f)).includes("start multi-user.target"));
  assert.doesNotMatch(result.stdout, /System units result/);
});

test("a failed start fails the job after the daemon check", async () => {
  const f = await fixture();
  const result = runWorker(f, [], { START_EXIT: "5" });
  assert.equal(result.status, 5);
  assert.match(result.stdout, /Start result: failed with status 5\./);
});

test("a daemon that never answers fails the job after the ready limit", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "bin/systemctl"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TEST_ROOT/actions"\n',
    { mode: 0o700 },
  );
  const result = runWorker(f, [], { PASEO_DEPLOY_READY_TIMEOUT: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Daemon status: the daemon did not answer within 1s\./);
  assert.ok((await actions(f)).includes("start paseo.service"));
  const polls = (await readFile(join(f.root, "status-argv"), "utf8")).trimEnd().split("\n");
  assert.ok(polls.length >= 2);
});

test("an answering daemon ends the job with its status", async () => {
  const f = await fixture();
  const result = runWorker(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Daemon status:\n\{\n {2}"connectedDaemon": "reachable"/);
  const statusArgv = await readFile(join(f.root, "status-argv"), "utf8");
  assert.equal(statusArgv, `daemon status --json --home ${f.env.PASEO_HOME}\n`);
});

test("build and deployment run outside Paseo as the operator with the selected state directory", async () => {
  const f = await fixture();
  const result = spawnSync(script, ["--reason", "quick update"], {
    env: { ...f.env, PASEO_DEPLOY_STOP_TIMEOUT: "200" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(join(f.root, "systemd-argv"), "utf8")).trimEnd().split("\n");
  assert.ok(args.includes(`--uid=${process.getuid()}`));
  assert.ok(!args.includes("--wait"));
  assert.ok(args.includes(`--setenv=PASEO_HOME=${f.env.PASEO_HOME}`));
  assert.ok(args.includes("--setenv=PASEO_DEPLOY_STOP_TIMEOUT=200"));
  assert.ok(args.includes("--setenv=PASEO_DEPLOY_READY_TIMEOUT=4"));
  assert.deepEqual(args.slice(-5), ["--", script, "--worker", "--reason", "quick update"]);
  assert.ok(!args.some((arg) => arg.startsWith("--setenv=PASEO_DEPLOY_SUDO")));
  const sudo = await readFile(join(f.root, "sudo-argv"), "utf8");
  assert.match(sudo, /^sudo systemd-run /);
  await assert.rejects(access(join(f.root, "build-argv")), { code: "ENOENT" });
});

test("a missing setuid wrapper fails before launching the job", async () => {
  const f = await fixture();
  const missing = join(f.root, "no-wrappers/sudo");
  const result = spawnSync(script, [], {
    env: { ...f.env, PASEO_DEPLOY_SUDO: "", PASEO_DEPLOY_SUDO_WRAPPER: missing },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, `Setuid sudo wrapper not found: ${missing}\n`);
  await assert.rejects(access(join(f.root, "sudo-argv")), { code: "ENOENT" });
  await assert.rejects(access(join(f.root, "systemd-argv")), { code: "ENOENT" });
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
