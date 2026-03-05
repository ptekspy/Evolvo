import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, branchNameForIssue, buildAuthenticatedGitArgs } from "../workspace.js";

function run(cwd, command, args) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8"
  }).trim();
}

function createRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "evolvo-workspace-"));
  const remoteDir = mkdtempSync(join(tmpdir(), "evolvo-remote-"));

  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({
    name: "workspace-fixture",
    type: "module",
    scripts: {
      test: "node --eval \"console.log('test ok')\"",
      check: "node --check src/a.js"
    }
  }, null, 2));
  writeFileSync(join(repoDir, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repoDir, "src", "b.js"), "export const b = 1;\n");

  run(repoDir, "git", ["init", "-b", "main"]);
  run(repoDir, "git", ["config", "user.name", "Workspace Test"]);
  run(repoDir, "git", ["config", "user.email", "workspace@example.com"]);
  run(repoDir, "git", ["add", "."]);
  run(repoDir, "git", ["commit", "-m", "init"]);

  run(remoteDir, "git", ["init", "--bare"]);
  run(repoDir, "git", ["remote", "add", "origin", remoteDir]);
  run(repoDir, "git", ["push", "-u", "origin", "main"]);

  return { repoDir, remoteDir };
}

test("branchNameForIssue creates a deterministic branch slug", () => {
  assert.equal(branchNameForIssue(7, "Start evolving!"), "evolvo/issue-7-start-evolving");
});

test("buildAuthenticatedGitArgs injects a per-command auth header", () => {
  const args = buildAuthenticatedGitArgs("secret-token", ["push", "origin", "HEAD"]);
  assert.equal(args[0], "-c");
  assert.match(args[1], /http\.extraheader=AUTHORIZATION: basic /);
  assert.deepEqual(args.slice(2), ["push", "origin", "HEAD"]);
});

test("Workspace prepareBranch allows .env and .evolvo but blocks other dirty files", () => {
  const { repoDir, remoteDir } = createRepo();
  const workspace = new Workspace(repoDir, { commandTimeoutMs: 10000 });

  try {
    mkdirSync(join(repoDir, ".evolvo"), { recursive: true });
    writeFileSync(join(repoDir, ".evolvo", "state.json"), "{}\n");
    writeFileSync(join(repoDir, ".env"), "TOKEN=value\n");
    workspace.assertCleanWorktree();

    writeFileSync(join(repoDir, "notes.txt"), "dirty\n");
    assert.throws(() => workspace.assertCleanWorktree(), /Workspace must be clean/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("Workspace prepareBranch checks out a deterministic issue branch", () => {
  const { repoDir, remoteDir } = createRepo();
  const workspace = new Workspace(repoDir, {
    githubToken: "unused-for-file-remote",
    commandTimeoutMs: 10000
  });

  try {
    const branch = workspace.prepareBranch({ number: 3, title: "Implement worker", body: "" });
    assert.equal(branch, "evolvo/issue-3-implement-worker");
    assert.equal(run(repoDir, "git", ["branch", "--show-current"]), branch);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("Workspace stages only touched files", () => {
  const { repoDir, remoteDir } = createRepo();
  const workspace = new Workspace(repoDir, { commandTimeoutMs: 10000 });

  try {
    writeFileSync(join(repoDir, "src", "a.js"), "export const a = 2;\n");
    writeFileSync(join(repoDir, "src", "b.js"), "export const b = 2;\n");
    workspace.touchedFiles.add("src/a.js");
    workspace.stageTouchedFiles();

    const staged = run(repoDir, "git", ["diff", "--cached", "--name-only"]);
    const unstaged = run(repoDir, "git", ["diff", "--name-only"]);
    assert.equal(staged, "src/a.js");
    assert.equal(unstaged, "src/b.js");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});
