import { composePrompt } from "./masterPrompt.js";
import { createNoopLogger } from "./logger.js";
import type { LoggerLike } from "./types.js";

type ValidationResult = {
  passed: boolean;
  summary: string;
};

type SessionAction =
  | { action: "list_files"; glob?: string }
  | { action: "search_code"; query: string }
  | { action: "read_files"; paths: string[] }
  | { action: "write_file"; path: string; content: string }
  | { action: "delete_file"; path: string }
  | { action: "show_diff" }
  | { action: "run_validation" }
  | { action: "finish"; summary: string; rationale?: string; prTitle?: string; prBody?: string };

type PlannerLike = {
  complete(prompt: string): Promise<string>;
};

type WorkspaceLike = {
  getBranchName(): string | null;
  getTouchedFiles(): string[];
  listFiles(glob?: string): string;
  searchCode(query: string): string;
  readFiles(paths: string[]): string;
  writeFile(path: string, content: string): string;
  deleteFile(path: string): string;
  showDiff(): string;
  runValidation(): ValidationResult;
};

type IssueLike = {
  number: number;
  title: string;
  body?: string;
};

type SessionOptions = {
  maxSteps?: number;
  maxMalformedResponses?: number;
  logger?: LoggerLike;
};

type RunOptions = {
  attempt?: number;
  reviewFeedback?: string;
  previousValidation?: ValidationResult | null;
};

const ACTIONS = new Set<string>([
  "list_files",
  "search_code",
  "read_files",
  "write_file",
  "delete_file",
  "show_diff",
  "run_validation",
  "finish"
]);

function describeHistory(history: Array<{ role: string; text: string }>): string {
  if (history.length === 0) {
    return "No actions taken yet.";
  }

  return history
    .slice(-12)
    .map((entry, index) => {
      const prefix = entry.role === "system" ? "SYSTEM" : `STEP ${index + 1}`;
      return `${prefix}\n${entry.text}`;
    })
    .join("\n\n");
}

function validateAction(parsed: unknown): SessionAction {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Planner must return a JSON object.");
  }

  const actionName = (parsed as { action?: unknown }).action;
  if (typeof actionName !== "string" || !ACTIONS.has(actionName)) {
    throw new Error(`Unsupported action: ${String(actionName)}`);
  }

  if (actionName === "search_code") {
    const query = (parsed as { query?: unknown }).query;
    if (typeof query !== "string") {
      throw new Error("search_code requires string field `query`.");
    }
    return { action: "search_code", query };
  }

  if (actionName === "read_files") {
    const paths = (parsed as { paths?: unknown }).paths;
    if (!Array.isArray(paths) || !paths.every((item) => typeof item === "string")) {
      throw new Error("read_files requires array field `paths`.");
    }
    return { action: "read_files", paths };
  }

  if (actionName === "write_file") {
    const path = (parsed as { path?: unknown }).path;
    const content = (parsed as { content?: unknown }).content;
    if (typeof path !== "string" || typeof content !== "string") {
      throw new Error("write_file requires string fields `path` and `content`.");
    }
    return { action: "write_file", path, content };
  }

  if (actionName === "delete_file") {
    const path = (parsed as { path?: unknown }).path;
    if (typeof path !== "string") {
      throw new Error("delete_file requires string field `path`.");
    }
    return { action: "delete_file", path };
  }

  if (actionName === "finish") {
    const summary = (parsed as { summary?: unknown }).summary;
    const rationale = (parsed as { rationale?: unknown }).rationale;
    const prTitle = (parsed as { prTitle?: unknown }).prTitle;
    const prBody = (parsed as { prBody?: unknown }).prBody;
    if (typeof summary !== "string") {
      throw new Error("finish requires string field `summary`.");
    }

    const result: { action: "finish"; summary: string; rationale?: string; prTitle?: string; prBody?: string } = {
      action: "finish",
      summary
    };
    if (typeof rationale === "string") {
      result.rationale = rationale;
    }
    if (typeof prTitle === "string") {
      result.prTitle = prTitle;
    }
    if (typeof prBody === "string") {
      result.prBody = prBody;
    }
    return result;
  }

  if (actionName === "list_files") {
    const glob = (parsed as { glob?: unknown }).glob;
    if (typeof glob === "string") {
      return { action: "list_files", glob };
    }
    return { action: "list_files" };
  }

  if (actionName === "show_diff") {
    return { action: "show_diff" };
  }

  return { action: "run_validation" };
}

export class ExecutionSession {
  private readonly planner: PlannerLike;
  private readonly workspace: WorkspaceLike;
  private readonly maxSteps: number;
  private readonly maxMalformedResponses: number;
  private readonly logger: LoggerLike;

  constructor(planner: PlannerLike, workspace: WorkspaceLike, options: SessionOptions = {}) {
    this.planner = planner;
    this.workspace = workspace;
    this.maxSteps = options.maxSteps ?? 40;
    this.maxMalformedResponses = options.maxMalformedResponses ?? 15;
    this.logger = options.logger ?? createNoopLogger();
  }

  async run(issue: IssueLike, options: RunOptions = {}): Promise<{ status: "done" | "stuck"; summary: string; rationale?: string; prTitle?: string; prBody?: string; validation: ValidationResult | null }> {
    const history: Array<{ role: string; text: string }> = [];
    let malformedResponses = 0;
    let latestValidation: ValidationResult | null = options.previousValidation ?? null;

    for (let step = 1; step <= this.maxSteps; step += 1) {
      let action: SessionAction;
      try {
        const requestContext: {
          issue: IssueLike;
          attempt: number;
          reviewFeedback?: string;
          latestValidation: ValidationResult | null;
          history: Array<{ role: string; text: string }>;
          malformedResponses: number;
          step: number;
        } = {
          issue,
          attempt: options.attempt ?? 1,
          latestValidation,
          history,
          malformedResponses,
          step
        };
        if (typeof options.reviewFeedback === "string") {
          requestContext.reviewFeedback = options.reviewFeedback;
        }

        const response = await this.requestAction(requestContext);
        action = response.action;
        malformedResponses = response.malformedResponses;
      } catch (error) {
        return {
          status: "stuck",
          summary: `Execution session failed: ${error instanceof Error ? error.message : String(error)}`,
          rationale: "Planner output could not be recovered into a valid action.",
          validation: latestValidation
        };
      }

      const outcome = this.applyAction(action, latestValidation);
      history.push({
        role: "tool",
        text: `Action: ${JSON.stringify(action)}\nResult:\n${outcome.message}`
      });

      if (outcome.validation) {
        latestValidation = outcome.validation;
      }

      if (outcome.finished && action.action === "finish") {
        const result: { status: "done"; summary: string; rationale?: string; prTitle?: string; prBody?: string; validation: ValidationResult | null } = {
          status: "done",
          summary: action.summary,
          validation: latestValidation
        };
        if (typeof action.rationale === "string") {
          result.rationale = action.rationale;
        }
        if (typeof action.prTitle === "string") {
          result.prTitle = action.prTitle;
        }
        if (typeof action.prBody === "string") {
          result.prBody = action.prBody;
        }
        return result;
      }
    }

    return {
      status: "stuck",
      summary: `Execution session exceeded ${this.maxSteps} steps without finishing.`,
      rationale: "Planner did not converge to a valid finish action.",
      validation: latestValidation
    };
  }

  private async requestAction(context: { issue: IssueLike; attempt: number; reviewFeedback?: string; latestValidation: ValidationResult | null; history: Array<{ role: string; text: string }>; malformedResponses: number; step: number }): Promise<{ action: SessionAction; malformedResponses: number }> {
    let malformedResponses = context.malformedResponses;
    const prompt = this.composePrompt(context);
    const initial = await this.planner.complete(prompt);

    try {
      return {
        action: validateAction(JSON.parse(initial) as unknown),
        malformedResponses
      };
    } catch (error) {
      malformedResponses += 1;
      if (malformedResponses >= this.maxMalformedResponses) {
        throw new Error(`Malformed planner response limit reached. Last error: ${error instanceof Error ? error.message : String(error)}`);
      }

      const repairPrompt = `${prompt}\n\nYour previous response was invalid. Return exactly one corrected JSON object and nothing else.\nPrevious response:\n${initial}`;
      const repaired = await this.planner.complete(repairPrompt);
      return {
        action: validateAction(JSON.parse(repaired) as unknown),
        malformedResponses
      };
    }
  }

  private composePrompt(context: { issue: IssueLike; attempt: number; reviewFeedback?: string; latestValidation: ValidationResult | null; history: Array<{ role: string; text: string }>; step: number }): string {
    return composePrompt([
      "You are operating a constrained coding workspace.",
      "Work the issue by choosing exactly one JSON action per response.",
      `Issue #${context.issue.number}: ${context.issue.title}`,
      `Issue body: ${context.issue.body ?? ""}`,
      `Attempt: ${context.attempt}`,
      `Step: ${context.step}/${this.maxSteps}`,
      `Current branch: ${this.workspace.getBranchName() ?? "not prepared"}`,
      `Touched files: ${this.workspace.getTouchedFiles().join(", ") || "none"}`,
      `Latest validation: ${context.latestValidation ? context.latestValidation.summary : "not run yet"}`,
      `Review feedback: ${context.reviewFeedback ?? "none"}`,
      "Recent session history:",
      describeHistory(context.history)
    ].join("\n"));
  }

  private applyAction(action: SessionAction, latestValidation: ValidationResult | null): { message: string; validation?: ValidationResult; finished?: boolean } {
    try {
      switch (action.action) {
        case "list_files":
          return { message: this.workspace.listFiles(action.glob) };
        case "search_code":
          return { message: this.workspace.searchCode(action.query) };
        case "read_files":
          return { message: this.workspace.readFiles(action.paths) };
        case "write_file":
          return { message: this.workspace.writeFile(action.path, action.content) };
        case "delete_file":
          return { message: this.workspace.deleteFile(action.path) };
        case "show_diff":
          return { message: this.workspace.showDiff() };
        case "run_validation": {
          const validation = this.workspace.runValidation();
          return { message: validation.summary, validation };
        }
        case "finish":
          if (!latestValidation?.passed) {
            return { message: "Finish rejected: run_validation must succeed before finish." };
          }
          return { message: "Finish accepted.", finished: true };
      }
    } catch (error) {
      return { message: `Action failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
