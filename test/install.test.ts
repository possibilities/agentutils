import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDirs } from "./helpers.ts";

afterAll(removeTempDirs);

const root = realpathSync(join(import.meta.dir, ".."));
const script = join(root, "scripts", "install.sh");
const source = join(root, "src", "cli.ts");
const expectedSha = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();

setDefaultTimeout(15_000);

type InstallLayout = {
  root: string;
  binDir: string;
  stateDir: string;
  target: string;
  receipt: string;
};

function layout(): InstallLayout {
  const temporaryRoot = makeTempDir("agentutils-install-");
  const binDir = join(temporaryRoot, "bin");
  const stateDir = join(temporaryRoot, "state");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  return {
    root: temporaryRoot,
    binDir,
    stateDir,
    target: join(binDir, "agentutils"),
    receipt: join(stateDir, "deployed-sha"),
  };
}

async function runInstallScript(
  installScript: string,
  installLayout: Pick<InstallLayout, "binDir" | "stateDir">,
  env: Record<string, string>,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", installScript, ...args], {
    cwd: "/tmp",
    env: {
      ...process.env,
      ...env,
      AGENTUTILS_INSTALL_BIN_DIR: installLayout.binDir,
      AGENTUTILS_INSTALL_STATE_DIR: installLayout.stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runInstall(
  installLayout: Pick<InstallLayout, "binDir" | "stateDir">,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runInstallScript(script, installLayout, {}, ...args);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function previousCheckout(origin = "https://github.com/possibilities/agentutils.git") {
  const checkout = makeTempDir("agentutils-previous-");
  mkdirSync(join(checkout, "src"));
  const cli = join(checkout, "src", "cli.ts");
  writeFileSync(cli, "#!/usr/bin/env bun\n");
  chmodSync(cli, 0o755);
  git("-C", checkout, "init", "-q");
  git("-C", checkout, "config", "user.name", "AgentUtils Test");
  git("-C", checkout, "config", "user.email", "agentutils@example.invalid");
  git("-C", checkout, "remote", "add", "origin", origin);
  git("-C", checkout, "add", "src/cli.ts");
  git("-C", checkout, "commit", "-qm", "previous checkout");
  return { checkout, cli, sha: git("-C", checkout, "rev-parse", "HEAD") };
}

test("zero arguments installs an exact source link and private receipt", async () => {
  const installLayout = layout();
  const result = await runInstall(installLayout);

  expect(result.exitCode).toBe(0);
  expect(lstatSync(installLayout.target).isSymbolicLink()).toBe(true);
  expect(readlinkSync(installLayout.target)).toBe(source);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
  expect(lstatSync(installLayout.receipt).mode & 0o777).toBe(0o600);
});

test("--install replaces the receipt inode even at the same SHA", async () => {
  const installLayout = layout();
  expect((await runInstall(installLayout, "--install")).exitCode).toBe(0);
  const firstInode = lstatSync(installLayout.receipt).ino;

  expect((await runInstall(installLayout, "--install")).exitCode).toBe(0);
  expect(lstatSync(installLayout.receipt).ino).not.toBe(firstInode);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("installer recovers a current source link with an old valid receipt", async () => {
  const installLayout = layout();
  const previous = previousCheckout();
  symlinkSync(source, installLayout.target);
  writeFileSync(installLayout.receipt, `${previous.sha}\n`, { mode: 0o600 });
  const oldReceiptInode = lstatSync(installLayout.receipt).ino;

  const result = await runInstall(installLayout, "--install");

  expect(result.exitCode).toBe(0);
  expect(readlinkSync(installLayout.target)).toBe(source);
  expect(lstatSync(installLayout.receipt).ino).not.toBe(oldReceiptInode);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("installer migrates an exact previous-checkout source symlink", async () => {
  const installLayout = layout();
  const previous = previousCheckout("git@github.com:possibilities/agentutils.git");
  symlinkSync(previous.cli, installLayout.target);
  writeFileSync(installLayout.receipt, `${previous.sha}\n`, { mode: 0o600 });

  const result = await runInstall(installLayout, "--install");
  expect(result.exitCode).toBe(0);
  expect(readlinkSync(installLayout.target)).toBe(source);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("installer refuses a mismatched receipt for a previous-checkout source link", async () => {
  const installLayout = layout();
  const previous = previousCheckout();
  symlinkSync(previous.cli, installLayout.target);
  writeFileSync(installLayout.receipt, `${expectedSha}\n`, { mode: 0o600 });

  const result = await runInstall(installLayout, "--install");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("does not match the managed command");
  expect(readlinkSync(installLayout.target)).toBe(previous.cli);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("installer refuses foreign command files and symlinks", async () => {
  const foreignFile = layout();
  writeFileSync(foreignFile.target, "foreign\n");
  const fileResult = await runInstall(foreignFile, "--install");
  expect(fileResult.exitCode).toBe(1);
  expect(fileResult.stderr).toContain("Refusing");

  const foreignLink = layout();
  symlinkSync("/tmp/not-agentutils", foreignLink.target);
  const linkResult = await runInstall(foreignLink, "--install");
  expect(linkResult.exitCode).toBe(1);
  expect(linkResult.stderr).toContain("Refusing foreign command symlink");

  const forged = layout();
  writeFileSync(
    forged.target,
    "#!/usr/bin/env bash\n# agentutils-managed-wrapper\n# agentutils-source-root: /tmp/forged\nexec true\n",
    { mode: 0o755 },
  );
  const forgedResult = await runInstall(forged, "--install");
  expect(forgedResult.exitCode).toBe(1);
});

test("installer refuses a previous checkout with a foreign origin", async () => {
  const installLayout = layout();
  const previous = previousCheckout("https://example.com/possibilities/agentutils.git");
  symlinkSync(previous.cli, installLayout.target);

  const result = await runInstall(installLayout, "--install");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("foreign origin");
});

const FORK_ORIGIN = "https://github.com/someone-else/agentutils.git";

// A working checkout of a fork: its own installer copy plus the manifest and
// lockfile the installer's frozen `bun install` needs.
function forkCheckout() {
  const checkout = makeTempDir("agentutils-fork-");
  mkdirSync(join(checkout, "src"));
  mkdirSync(join(checkout, "scripts"));
  const cli = join(checkout, "src", "cli.ts");
  writeFileSync(cli, "#!/usr/bin/env bun\n");
  chmodSync(cli, 0o755);
  const installScript = join(checkout, "scripts", "install.sh");
  copyFileSync(script, installScript);
  copyFileSync(join(root, "package.json"), join(checkout, "package.json"));
  copyFileSync(join(root, "bun.lock"), join(checkout, "bun.lock"));
  git("-C", checkout, "init", "-q");
  git("-C", checkout, "config", "user.name", "AgentUtils Test");
  git("-C", checkout, "config", "user.email", "agentutils@example.invalid");
  git("-C", checkout, "remote", "add", "origin", FORK_ORIGIN);
  git("-C", checkout, "add", "-A");
  git("-C", checkout, "commit", "-qm", "fork checkout");
  return { checkout, cli, installScript };
}

test("a fork installs from its own checkout with the expected-origin override", async () => {
  const installLayout = layout();
  const fork = forkCheckout();

  const refused = await runInstallScript(fork.installScript, installLayout, {}, "--install");
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("foreign origin");
  expect(existsSync(installLayout.target)).toBe(false);
  expect(existsSync(installLayout.receipt)).toBe(false);

  const result = await runInstallScript(
    fork.installScript,
    installLayout,
    { AGENTUTILS_INSTALL_EXPECTED_ORIGIN: FORK_ORIGIN },
    "--install",
  );
  expect(result.exitCode).toBe(0);
  expect(readlinkSync(installLayout.target)).toBe(realpathSync(fork.cli));
});

test("a foreign checkout cannot replace a managed installation", async () => {
  const installLayout = layout();
  expect((await runInstall(installLayout, "--install")).exitCode).toBe(0);
  const fork = forkCheckout();

  const refused = await runInstallScript(fork.installScript, installLayout, {}, "--install");

  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("foreign origin");
  expect(readlinkSync(installLayout.target)).toBe(source);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("the override cannot make an upstream checkout pass as a fork", async () => {
  const installLayout = layout();
  const result = await runInstallScript(
    script,
    installLayout,
    { AGENTUTILS_INSTALL_EXPECTED_ORIGIN: FORK_ORIGIN },
    "--install",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("foreign origin");
});

test("installer refuses symlinked and unsafe writable directories", async () => {
  const symlinked = layout();
  const linkedBin = join(symlinked.root, "linked-bin");
  symlinkSync(symlinked.binDir, linkedBin);
  const symlinkResult = await runInstall({ ...symlinked, binDir: linkedBin }, "--install");
  expect(symlinkResult.exitCode).toBe(1);
  expect(symlinkResult.stderr).toContain("symlinked bin path");

  for (const destination of ["bin", "state"] as const) {
    const nested = layout();
    const realParent = join(nested.root, `real-${destination}-parent`);
    const linkedParent = join(nested.root, `linked-${destination}-parent`);
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const result = await runInstall(
      {
        binDir: destination === "bin" ? join(linkedParent, "bin") : nested.binDir,
        stateDir: destination === "state" ? join(linkedParent, "state") : nested.stateDir,
      },
      "--install",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`symlinked ${destination} path component`);
  }

  const writable = layout();
  chmodSync(writable.stateDir, 0o777);
  const writableResult = await runInstall(writable, "--install");
  expect(writableResult.exitCode).toBe(1);
  expect(writableResult.stderr).toContain("unsafe writable state directory");
});

test("installer refuses malformed, permissive, symlinked, and hardlinked receipts", async () => {
  const malformed = layout();
  writeFileSync(malformed.receipt, "not-a-sha\n", { mode: 0o600 });
  symlinkSync(source, malformed.target);
  expect((await runInstall(malformed, "--install")).exitCode).toBe(1);

  const permissive = layout();
  symlinkSync(source, permissive.target);
  writeFileSync(permissive.receipt, `${expectedSha}\n`, { mode: 0o644 });
  const permissiveResult = await runInstall(permissive, "--install");
  expect(permissiveResult.exitCode).toBe(1);
  expect(permissiveResult.stderr).toContain("unsafe permissions");

  const linked = layout();
  symlinkSync(source, linked.target);
  symlinkSync(join(linked.root, "elsewhere"), linked.receipt);
  const linkedResult = await runInstall(linked, "--install");
  expect(linkedResult.exitCode).toBe(1);
  expect(linkedResult.stderr).toContain("unsafe deployed receipt");

  const hardlinked = layout();
  symlinkSync(source, hardlinked.target);
  writeFileSync(hardlinked.receipt, `${expectedSha}\n`, { mode: 0o600 });
  linkSync(hardlinked.receipt, join(hardlinked.root, "receipt-hardlink"));
  const hardlinkResult = await runInstall(hardlinked, "--install");
  expect(hardlinkResult.exitCode).toBe(1);
  expect(hardlinkResult.stderr).toContain("hardlinked deployed receipt");
});

test("uninstall removes only owned artifacts and is idempotent", async () => {
  const installLayout = layout();
  expect((await runInstall(installLayout)).exitCode).toBe(0);
  const unrelated = join(installLayout.stateDir, "keep-me");
  writeFileSync(unrelated, "keep\n");

  expect((await runInstall(installLayout, "--uninstall")).exitCode).toBe(0);
  expect(existsSync(installLayout.target)).toBe(false);
  expect(existsSync(installLayout.receipt)).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("keep\n");

  expect((await runInstall(installLayout, "--uninstall")).exitCode).toBe(0);
  expect(readFileSync(unrelated, "utf8")).toBe("keep\n");
});

test("uninstall refuses foreign artifacts without deleting owned state", async () => {
  const installLayout = layout();
  expect((await runInstall(installLayout)).exitCode).toBe(0);
  unlinkSync(installLayout.target);
  writeFileSync(installLayout.target, "foreign\n");

  const result = await runInstall(installLayout, "--uninstall");
  expect(result.exitCode).toBe(1);
  expect(existsSync(installLayout.target)).toBe(true);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
});

test("help works and unknown or extra arguments are rejected", async () => {
  const installLayout = layout();
  const help = await runInstall(installLayout, "--help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("Usage:");

  const unknown = await runInstall(installLayout, "--wat");
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr).toContain("Unknown installer option");

  const extra = await runInstall(installLayout, "--install", "extra");
  expect(extra.exitCode).toBe(2);
  expect(extra.stderr).toContain("Expected at most one installer option");
  expect(existsSync(installLayout.target)).toBe(false);
});
