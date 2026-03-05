import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, matchesGlob, relative, resolve, sep } from "node:path";
import { createNoopLogger } from "./logger.js";

const DEFAULT_BRANCH = "main";
const DEFAULT_MAX_COMMAND_OUTPUT = 12000;
const SEARCH_RESULT_LIMIT = 200;
const PROTECTED_DIRECTORIES = [".git", "node_modules", ".evolvo"];

function truncate(text, limit = DEFAULT_MAX_COMMAND_OUTPUT) {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n...<truncated>`;
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function parseStatusLine(line) {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
  return {
    code,
    path: normalizePath(path)
  };
}

function isProtectedPath(path) {
  return path === ".env"
    || path.startsWith(".env.")
    || PROTECTED_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

function isAllowedDirtyPath(entry) {
  return entry.code === "??" && (
    entry.path === ".env"
    || entry.path.startsWith(".env.")
    || entry.path === ".evolvo"
    || entry.path.startsWith(".evolvo/")
  );
}

function summarizeDirtyEntries(entries) {
  return entries.map((entry) => `${entry.code} ${entry.path}`).join(", ");
}

function summarizeOutput(output) {
  return truncate(output.trim() || "<no output>", 400);
}

export function branchNameForIssue(issueNumber, title) {
  return `evolvo/issue-${issueNumber}-${slugify(title)}`;
}

export function buildAuthenticatedGitArgs(token, gitArgs = []) {
  if (!token) {
    return [...gitArgs];
  }

  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`, ...gitArgs];
}

export function parseGitStatus(output) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseStatusLine);
}

export class Workspace {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.githubToken = options.githubToken ?? "";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120000;
    this.branchBase = options.branchBase ?? DEFAULT_BRANCH;
    this.logger = options.logger ?? createNoopLogger();
    this.baseRef = `origin/${this.branchBase}`;
    this.branchName = null;
    this.touchedFiles = new Set();
  }

  getBranchName() {
    return this.branchName;
  }

  getTouchedFiles() {
    return [...this.touchedFiles];
  }

  assertCleanWorktree() {
    const status = this.runGit(["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
    const entries = parseGitStatus(status);
    const disallowed = entries.filter((entry) => !isAllowedDirtyPath(entry));

    if (disallowed.length > 0) {
      this.logger.warn("Workspace is dirty before execution", {
        disallowed: summarizeDirtyEntries(disallowed)
      });
      throw new Error(`Workspace must be clean before execution. Disallowed changes: ${summarizeDirtyEntries(disallowed)}`);
    }

    this.logger.debug("Workspace cleanliness check passed");
  }

  hasUncommittedChanges() {
    const result = this.runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
    const entries = parseGitStatus(result.stdout);
    return entries.some((entry) => !isAllowedDirtyPath(entry));
  }

  prepareBranch(issue) {
    this.assertCleanWorktree();
    this.branchName = branchNameForIssue(issue.number, issue.title);
    this.logger.info("Preparing execution branch", {
      issueNumber: issue.number,
      branchName: this.branchName,
      baseRef: this.baseRef
    });
    this.runGit(["fetch", "origin", this.branchBase], { authenticated: true });
    this.runGit(["checkout", "-B", this.branchName, this.baseRef]);
    this.touchedFiles.clear();
    return this.branchName;
  }

  listFiles(glob) {
    const files = this.walkFiles("");
    const filtered = glob ? files.filter((file) => matchesGlob(file, glob)) : files;
    this.logger.debug("Listed workspace files", {
      glob: glob ?? null,
      count: filtered.length
    });
    return filtered.length > 0 ? filtered.join("\n") : "No files matched.";
  }

  searchCode(query) {
    if (!query) {
      return "Query is required.";
    }

    this.logger.debug("Searching code", {
      query
    });
    const matches = [];
    for (const file of this.walkFiles("")) {
      const content = readFileSync(resolve(this.rootDir, file), "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(query)) {
          matches.push(`${file}:${index + 1}:${lines[index]}`);
          if (matches.length >= SEARCH_RESULT_LIMIT) {
            return `${matches.join("\n")}\n...<truncated>`;
          }
        }
      }
    }

    return matches.length > 0 ? matches.join("\n") : `No matches for "${query}".`;
  }

  readFiles(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return "At least one path is required.";
    }

    this.logger.debug("Reading files", {
      paths
    });
    const sections = [];
    for (const path of paths) {
      const { relativePath, absolutePath } = this.resolveWritablePath(path);
      if (!existsSync(absolutePath)) {
        sections.push(`--- ${relativePath} ---\n<missing>`);
        continue;
      }

      sections.push(`--- ${relativePath} ---\n${truncate(readFileSync(absolutePath, "utf8"))}`);
    }

    return sections.join("\n\n");
  }

  writeFile(path, content) {
    const { relativePath, absolutePath } = this.resolveWritablePath(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
    this.touchedFiles.add(relativePath);
    this.logger.info("Wrote file", {
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
      touchedCount: this.touchedFiles.size
    });
    return `Wrote ${relativePath} (${Buffer.byteLength(content, "utf8")} bytes).`;
  }

  deleteFile(path) {
    const { relativePath, absolutePath } = this.resolveWritablePath(path);
    if (!existsSync(absolutePath)) {
      this.logger.warn("delete_file targeted missing file", {
        path: relativePath
      });
      return `File ${relativePath} did not exist.`;
    }

    if (statSync(absolutePath).isDirectory()) {
      throw new Error(`delete_file only supports files, received directory: ${relativePath}`);
    }

    rmSync(absolutePath);
    this.touchedFiles.add(relativePath);
    this.logger.info("Deleted file", {
      path: relativePath,
      touchedCount: this.touchedFiles.size
    });
    return `Deleted ${relativePath}.`;
  }

  showDiff() {
    if (this.touchedFiles.size === 0) {
      return "No tracked file edits yet.";
    }

    this.logger.debug("Showing diff for touched files", {
      files: this.getTouchedFiles()
    });
    const args = ["diff", "--no-ext-diff", "--", ...this.getTouchedFiles()];
    const result = this.runGit(args, { allowFailure: true });
    return result.stdout ? truncate(result.stdout) : "No diff output.";
  }

  diffAgainstBase() {
    this.logger.debug("Showing diff against base", {
      baseRef: this.baseRef
    });
    const result = this.runGit(["diff", "--no-ext-diff", `${this.baseRef}...HEAD`], { allowFailure: true });
    return result.stdout ? truncate(result.stdout) : "No diff against base.";
  }

  runValidation() {
    const scripts = this.readPackageScripts();
    const steps = [
      ["test", scripts.test ? ["pnpm", ["test"]] : null],
      ["check", scripts.check ? ["pnpm", ["check"]] : null],
      ["build", scripts.build ? ["pnpm", ["build"]] : null]
    ].filter(([, command]) => Boolean(command));

    if (steps.length === 0) {
      this.logger.info("Validation skipped because no scripts were configured");
      return {
        passed: true,
        summary: "No validation scripts configured."
      };
    }

    const report = [];
    for (const [name, command] of steps) {
      const [bin, args] = command;
      this.logger.info("Running validation step", {
        step: name,
        command: `${bin} ${args.join(" ")}`
      });
      const result = this.runCommand(bin, args, { allowFailure: true });
      const combined = truncate(`${result.stdout}${result.stderr}`.trim() || "<no output>");
      report.push(`$ ${bin} ${args.join(" ")}\n${combined}`);

      if (result.status !== 0) {
        this.logger.warn("Validation step failed", {
          step: name,
          status: result.status,
          output: summarizeOutput(`${result.stdout}${result.stderr}`)
        });
        return {
          passed: false,
          summary: `Validation failed during ${name}.\n\n${report.join("\n\n")}`
        };
      }
    }

    this.logger.info("Validation passed", {
      steps: steps.map(([name]) => name)
    });
    return {
      passed: true,
      summary: report.join("\n\n")
    };
  }

  stageTouchedFiles() {
    const files = this.getTouchedFiles();
    if (files.length === 0) {
      this.logger.warn("No touched files available to stage");
      return [];
    }

    this.runGit(["add", "-A", "--", ...files]);
    this.logger.info("Staged touched files", {
      files
    });
    return files;
  }

  commitAndPush(issue, prTitle) {
    const files = this.stageTouchedFiles();
    if (files.length === 0) {
      return {
        changed: false,
        pushed: false,
        branchName: this.branchName,
        reason: "No touched files were recorded."
      };
    }

    const diffStatus = this.runGit(["diff", "--cached", "--quiet"], { allowFailure: true }).status;
    if (diffStatus === 0) {
      return {
        changed: false,
        pushed: false,
        branchName: this.branchName,
        reason: "Touched files produced no staged diff."
      };
    }

    const commitMessage = `feat(issue #${issue.number}): ${prTitle || issue.title}`;
    this.logger.info("Creating commit for issue branch", {
      issueNumber: issue.number,
      commitMessage,
      files
    });
    this.runGit(["commit", "-m", commitMessage]);
    this.logger.info("Pushing issue branch", {
      branchName: this.branchName
    });
    this.runGit(["push", "-u", "origin", `HEAD:refs/heads/${this.branchName}`], { authenticated: true });

    const commitSha = this.runGit(["rev-parse", "HEAD"]).stdout.trim();
    this.logger.info("Push completed", {
      branchName: this.branchName,
      commitSha
    });
    return {
      changed: true,
      pushed: true,
      branchName: this.branchName,
      commitSha
    };
  }

  cleanup() {
    if (!this.branchName) {
      return;
    }

    this.logger.info("Cleaning up workspace", {
      branchName: this.branchName,
      branchBase: this.branchBase
    });
    this.runGit(["checkout", this.branchBase]);
    this.runGit(["pull", "--rebase", "origin", this.branchBase], { authenticated: true });
    this.branchName = null;
    this.touchedFiles.clear();
  }

  walkFiles(relativeDir) {
    const directory = resolve(this.rootDir, relativeDir);
    const items = readdirSync(directory, { withFileTypes: true });
    const files = [];

    for (const item of items) {
      const relativePath = normalizePath(relative(resolve(this.rootDir), resolve(directory, item.name)));
      if (isProtectedPath(relativePath)) {
        continue;
      }

      if (item.isDirectory()) {
        files.push(...this.walkFiles(relativePath));
        continue;
      }

      files.push(relativePath);
    }

    return files.sort((left, right) => left.localeCompare(right));
  }

  readPackageScripts() {
    const packageJsonPath = resolve(this.rootDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      return {};
    }

    return JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts ?? {};
  }

  resolveWritablePath(path) {
    const absolutePath = resolve(this.rootDir, path);
    const relativePath = normalizePath(relative(this.rootDir, absolutePath));
    const prefix = `${this.rootDir}${sep}`;

    if (absolutePath !== this.rootDir && !absolutePath.startsWith(prefix)) {
      throw new Error(`Path escapes workspace root: ${path}`);
    }

    if (!relativePath || relativePath.startsWith("..")) {
      throw new Error(`Invalid workspace path: ${path}`);
    }

    if (isProtectedPath(relativePath)) {
      throw new Error(`Path is protected from model access: ${relativePath}`);
    }

    return {
      absolutePath,
      relativePath
    };
  }

  runGit(args, options = {}) {
    return this.runCommand("git", buildAuthenticatedGitArgs(options.authenticated ? this.githubToken : "", args), {
      ...options,
      displayArgs: args
    });
  }

  runCommand(command, args, options = {}) {
    const displayArgs = options.displayArgs ?? args;
    const startedAt = Date.now();
    this.logger.debug("Running command", {
      command,
      args: displayArgs
    });
    const result = spawnSync(command, args, {
      cwd: this.rootDir,
      encoding: "utf8",
      timeout: options.timeout ?? this.commandTimeoutMs,
      env: process.env
    });

    if (result.error) {
      this.logger.error("Command execution threw", {
        command,
        args: displayArgs,
        error: result.error
      });
      throw result.error;
    }

    if (!options.allowFailure && result.status !== 0) {
      this.logger.error("Command failed", {
        command,
        args: displayArgs,
        status: result.status,
        durationMs: Date.now() - startedAt,
        output: summarizeOutput(`${result.stdout}${result.stderr}`)
      });
      throw new Error(
        `${command} ${displayArgs.join(" ")} failed with code ${result.status}: ${truncate(`${result.stdout}${result.stderr}`.trim())}`
      );
    }

    this.logger.debug("Command completed", {
      command,
      args: displayArgs,
      status: result.status ?? 0,
      durationMs: Date.now() - startedAt
    });

    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  }
}
