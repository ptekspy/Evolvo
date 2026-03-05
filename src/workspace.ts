import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, matchesGlob, relative, resolve, sep } from "node:path";
import { createNoopLogger } from "./logger.js";
import type { LoggerLike } from "./types.js";

const DEFAULT_BRANCH = "main";
const DEFAULT_MAX_COMMAND_OUTPUT = 12000;
const SEARCH_RESULT_LIMIT = 200;
const PROTECTED_DIRECTORIES = [".git", "node_modules", ".evolvo"];

function truncate(text: string, limit = DEFAULT_MAX_COMMAND_OUTPUT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n...<truncated>`;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

interface StatusEntry {
  code: string;
  path: string;
}

interface IssueRef {
  number: number;
  title: string;
}

interface RunCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  allowFailure?: boolean;
  authenticated?: boolean;
}

interface WorkspaceOptions {
  githubToken?: string;
  commandTimeoutMs?: number;
  branchBase?: string;
  logger?: LoggerLike;
}

interface ValidationResult {
  passed: boolean;
  summary: string;
}

interface CommitResult {
  changed: boolean;
  pushed: boolean;
  branchName: string;
  commitSha?: string;
  reason?: string;
}

function parseStatusLine(line: string): StatusEntry {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const path = rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath;
  return { code, path: normalizePath(path) };
}

function isProtectedPath(path: string): boolean {
  return path === ".env"
    || path.startsWith(".env.")
    || PROTECTED_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

function isAllowedDirtyPath(entry: StatusEntry): boolean {
  return entry.code === "??" && (
    entry.path === ".env"
    || entry.path.startsWith(".env.")
    || entry.path === ".evolvo"
    || entry.path.startsWith(".evolvo/")
  );
}

function summarizeDirtyEntries(entries: StatusEntry[]): string {
  return entries.map((entry) => `${entry.code} ${entry.path}`).join(", ");
}

export function branchNameForIssue(issueNumber: number, title: string): string {
  return `evolvo/issue-${issueNumber}-${slugify(title)}`;
}

export function buildAuthenticatedGitArgs(token: string, gitArgs: string[] = []): string[] {
  if (!token) {
    return [...gitArgs];
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`, ...gitArgs];
}

export function parseGitStatus(output: string): StatusEntry[] {
  return output.split("\n").map((line) => line.trimEnd()).filter(Boolean).map(parseStatusLine);
}

export class Workspace {
  readonly rootDir: string;
  readonly githubToken: string;
  readonly commandTimeoutMs: number;
  readonly branchBase: string;
  readonly logger: LoggerLike;
  readonly baseRef: string;
  branchName: string | null;
  touchedFiles: Set<string>;

  constructor(rootDir: string, options: WorkspaceOptions = {}) {
    this.rootDir = rootDir;
    this.githubToken = options.githubToken ?? "";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120000;
    this.branchBase = options.branchBase ?? DEFAULT_BRANCH;
    this.logger = options.logger ?? createNoopLogger();
    this.baseRef = `origin/${this.branchBase}`;
    this.branchName = null;
    this.touchedFiles = new Set<string>();
  }

  getBranchName(): string | null {
    return this.branchName;
  }

  getTouchedFiles(): string[] {
    return [...this.touchedFiles];
  }

  assertCleanWorktree(): void {
    const status = this.runGit(["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
    const entries = parseGitStatus(status);
    const disallowed = entries.filter((entry) => !isAllowedDirtyPath(entry));
    if (disallowed.length > 0) {
      throw new Error(`Workspace must be clean before execution. Disallowed changes: ${summarizeDirtyEntries(disallowed)}`);
    }
  }

  hasUncommittedChanges(): boolean {
    const entries = parseGitStatus(this.runGit(["status", "--porcelain=v1", "--untracked-files=all"]).stdout);
    return entries.some((entry) => !isAllowedDirtyPath(entry));
  }

  prepareBranch(issue: IssueRef): string {
    this.assertCleanWorktree();
    this.branchName = branchNameForIssue(issue.number, issue.title);
    this.runGit(["fetch", "origin", this.branchBase], { authenticated: true });
    this.runGit(["checkout", "-B", this.branchName, this.baseRef]);
    this.touchedFiles.clear();
    return this.branchName;
  }

  listFiles(glob = ""): string {
    const files = this.walkFiles("");
    const filtered = glob ? files.filter((file) => matchesGlob(file, glob)) : files;
    return filtered.length > 0 ? filtered.join("\n") : "No files matched.";
  }

  searchCode(query: string): string {
    if (!query) return "Query is required.";
    const matches: string[] = [];
    for (const file of this.walkFiles("")) {
      const content = readFileSync(resolve(this.rootDir, file), "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]?.includes(query)) {
          matches.push(`${file}:${index + 1}:${lines[index]}`);
          if (matches.length >= SEARCH_RESULT_LIMIT) {
            return `${matches.join("\n")}\n...<truncated>`;
          }
        }
      }
    }
    return matches.length > 0 ? matches.join("\n") : `No matches for "${query}".`;
  }

  readFiles(paths: string[]): string {
    if (!Array.isArray(paths) || paths.length === 0) return "At least one path is required.";
    const sections: string[] = [];
    for (const path of paths) {
      const absolutePath = resolve(this.rootDir, path);
      if (!existsSync(absolutePath)) {
        sections.push(`--- ${path} ---\n<missing>`);
      } else {
        sections.push(`--- ${path} ---\n${truncate(readFileSync(absolutePath, "utf8"))}`);
      }
    }
    return sections.join("\n\n");
  }

  writeFile(path: string, content: string): string {
    const absolutePath = resolve(this.rootDir, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
    this.touchedFiles.add(normalizePath(path));
    return `Wrote ${path} (${Buffer.byteLength(content, "utf8")} bytes).`;
  }

  deleteFile(path: string): string {
    const absolutePath = resolve(this.rootDir, path);
    if (!existsSync(absolutePath)) return `File ${path} did not exist.`;
    if (statSync(absolutePath).isDirectory()) {
      throw new Error(`delete_file only supports files, received directory: ${path}`);
    }
    rmSync(absolutePath);
    this.touchedFiles.add(normalizePath(path));
    return `Deleted ${path}.`;
  }

  showDiff(): string {
    if (this.touchedFiles.size === 0) return "No tracked file edits yet.";
    const result = this.runGit(["diff", "--no-ext-diff", "--", ...this.getTouchedFiles()], { allowFailure: true });
    return result.stdout ? truncate(result.stdout) : "No diff output.";
  }

  diffAgainstBase(): string {
    const result = this.runGit(["diff", "--no-ext-diff", `${this.baseRef}...HEAD`], { allowFailure: true });
    return result.stdout ? truncate(result.stdout) : "No diff against base.";
  }

  runValidation(): ValidationResult {
    return { passed: true, summary: "Validation delegated to pipeline." };
  }

  commitAndPush(issue: IssueRef, prTitle: string): CommitResult {
    const files = this.getTouchedFiles();
    if (files.length === 0 || !this.branchName) {
      return { changed: false, pushed: false, branchName: this.branchName ?? "", reason: "No touched files were recorded." };
    }
    this.runGit(["add", "-A", "--", ...files]);
    const diffStatus = this.runGit(["diff", "--cached", "--quiet"], { allowFailure: true }).status;
    if (diffStatus === 0) {
      return { changed: false, pushed: false, branchName: this.branchName, reason: "Touched files produced no staged diff." };
    }
    const commitMessage = `feat(issue #${issue.number}): ${prTitle || issue.title}`;
    this.runGit(["commit", "-m", commitMessage]);
    this.runGit(["push", "-u", "origin", `HEAD:refs/heads/${this.branchName}`], { authenticated: true });
    const commitSha = this.runGit(["rev-parse", "HEAD"]).stdout.trim();
    this.touchedFiles.clear();
    return { changed: true, pushed: true, branchName: this.branchName, commitSha };
  }

  cleanup(): void {
    if (!this.branchName) return;
    this.runGit(["checkout", this.branchBase]);
    this.runGit(["pull", "--rebase", "origin", this.branchBase], { authenticated: true });
    this.branchName = null;
    this.touchedFiles.clear();
  }

  private walkFiles(relativeDir: string): string[] {
    const directory = resolve(this.rootDir, relativeDir);
    const items = readdirSync(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const item of items) {
      const relativePath = normalizePath(relative(resolve(this.rootDir), resolve(directory, item.name)));
      if (isProtectedPath(relativePath)) continue;
      if (item.isDirectory()) files.push(...this.walkFiles(relativePath));
      else files.push(relativePath);
    }
    return files.sort((a, b) => a.localeCompare(b));
  }

  private runGit(args: string[], options: RunCommandOptions = {}): RunCommandResult {
    return this.runCommand("git", options.authenticated ? buildAuthenticatedGitArgs(this.githubToken, args) : args, options);
  }

  private runCommand(command: string, args: string[], options: RunCommandOptions = {}): RunCommandResult {
    const result = spawnSync(command, args, {
      cwd: this.rootDir,
      encoding: "utf8",
      timeout: this.commandTimeoutMs,
      maxBuffer: 10 * 1024 * 1024
    });
    const status = result.status ?? 1;
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (!options.allowFailure && status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed (${status}): ${(stderr || stdout).trim()}`);
    }
    return { status, stdout, stderr };
  }
}
