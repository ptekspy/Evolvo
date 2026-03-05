import { composePrompt } from "./masterPrompt.js";
import { createNoopLogger } from "./logger.js";

const ACTIONS = new Set([
  "list_files",
  "search_code",
  "read_files",
  "write_file",
  "delete_file",
  "show_diff",
  "run_validation",
  "finish"
]);

function describeHistory(history) {
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

function validateAction(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Planner must return a JSON object.");
  }

  if (!ACTIONS.has(parsed.action)) {
    throw new Error(`Unsupported action: ${parsed.action}`);
  }

  if (parsed.action === "search_code" && typeof parsed.query !== "string") {
    throw new Error("search_code requires string field `query`.");
  }

  if (parsed.action === "read_files" && !Array.isArray(parsed.paths)) {
    throw new Error("read_files requires array field `paths`.");
  }

  if (parsed.action === "write_file" && (typeof parsed.path !== "string" || typeof parsed.content !== "string")) {
    throw new Error("write_file requires string fields `path` and `content`.");
  }

  if (parsed.action === "delete_file" && typeof parsed.path !== "string") {
    throw new Error("delete_file requires string field `path`.");
  }

  if (parsed.action === "finish" && typeof parsed.summary !== "string") {
    throw new Error("finish requires string field `summary`.");
  }

  return parsed;
}

function summarizeAction(action) {
  switch (action.action) {
    case "list_files":
      return {
        action: action.action,
        glob: action.glob ?? null
      };
    case "search_code":
      return {
        action: action.action,
        query: action.query
      };
    case "read_files":
      return {
        action: action.action,
        pathCount: action.paths.length,
        paths: action.paths
      };
    case "write_file":
      return {
        action: action.action,
        path: action.path,
        contentBytes: Buffer.byteLength(action.content, "utf8")
      };
    case "delete_file":
      return {
        action: action.action,
        path: action.path
      };
    case "finish":
      return {
        action: action.action,
        summary: action.summary,
        prTitle: action.prTitle ?? null
      };
    default:
      return {
        action: action.action
      };
  }
}

export class ExecutionSession {
  constructor(planner, workspace, options = {}) {
    this.planner = planner;
    this.workspace = workspace;
    this.maxSteps = options.maxSteps ?? 40;
    this.maxMalformedResponses = options.maxMalformedResponses ?? 3;
    this.logger = options.logger ?? createNoopLogger();
  }

  async run(issue, options = {}) {
    const history = [];
    let malformedResponses = 0;
    let latestValidation = options.previousValidation ?? null;

    for (let step = 1; step <= this.maxSteps; step += 1) {
      let action;
      try {
        const response = await this.requestAction({
          issue,
          attempt: options.attempt ?? 1,
          reviewFeedback: options.reviewFeedback,
          latestValidation,
          history,
          malformedResponses,
          step
        });
        action = response.action;
        malformedResponses = response.malformedResponses;
        this.logger.info("Planner selected action", {
          step,
          malformedResponses,
          ...summarizeAction(action)
        });
      } catch (error) {
        if (error.retryable) {
          malformedResponses = error.malformedResponses;
          this.logger.warn("Planner output invalid; retrying next step", {
            malformedResponses,
            error: error.message
          });
          history.push({
            role: "system",
            text: `Planner output was invalid and will be retried.\n${error.message}`
          });
          continue;
        }

        return {
          status: "stuck",
          summary: `Execution session failed: ${error.message}`,
          rationale: "Planner output could not be recovered into a valid action.",
          validation: latestValidation,
          malformedResponses
        };
      }

      const outcome = this.applyAction(action, latestValidation);
      this.logger.debug("Action result", {
        step,
        action: action.action,
        message: outcome.message
      });
      history.push({
        role: "tool",
        text: `Action: ${JSON.stringify(action)}\nResult:\n${outcome.message}`
      });

      if (outcome.validation) {
        latestValidation = outcome.validation;
      }

      if (outcome.finished) {
        this.logger.info("Execution session finished", {
          step,
          summary: action.summary
        });
        return {
          status: "done",
          summary: action.summary,
          rationale: action.rationale ?? "",
          prTitle: action.prTitle,
          prBody: action.prBody,
          validation: latestValidation,
          stepCount: step,
          malformedResponses
        };
      }
    }

    return {
      status: "stuck",
      summary: `Execution session exceeded ${this.maxSteps} steps without finishing.`,
      rationale: "Planner did not converge to a valid finish action.",
      validation: latestValidation,
      malformedResponses
    };
  }

  async requestAction(context) {
    let malformedResponses = context.malformedResponses ?? 0;
    const prompt = this.composePrompt(context);
    this.logger.debug("Requesting planner action", {
      step: context.step,
      promptLength: prompt.length,
      malformedResponses
    });
    const initial = await this.planner.complete(prompt);

    try {
      return {
        action: validateAction(JSON.parse(initial)),
        malformedResponses
      };
    } catch (error) {
      malformedResponses += 1;
      this.logger.warn("Planner returned malformed JSON", {
        step: context.step,
        malformedResponses,
        error: error.message
      });
      if (malformedResponses >= this.maxMalformedResponses) {
        throw new Error(`Malformed planner response limit reached. Last error: ${error.message}`);
      }

      const repairPrompt = `${prompt}\n\nYour previous response was invalid. Return exactly one corrected JSON object and nothing else.\nPrevious response:\n${initial}`;
      const repaired = await this.planner.complete(repairPrompt);

      try {
        return {
          action: validateAction(JSON.parse(repaired)),
          malformedResponses
        };
      } catch (repairError) {
        malformedResponses += 1;
        this.logger.warn("Planner repair response was malformed", {
          step: context.step,
          malformedResponses,
          error: repairError.message
        });
        if (malformedResponses >= this.maxMalformedResponses) {
          throw new Error(`Malformed planner response limit reached. Last error: ${repairError.message}`);
        }

        const retryable = new Error(`Planner repair failed: ${repairError.message}`);
        retryable.retryable = true;
        retryable.malformedResponses = malformedResponses;
        throw retryable;
      }
    }
  }

  composePrompt(context) {
    return composePrompt([
      "You are operating a constrained coding workspace.",
      "Work the issue by choosing exactly one JSON action per response.",
      "Allowed actions:",
      '- {"action":"list_files","glob":"src/**/*.js"}',
      '- {"action":"search_code","query":"composePrompt"}',
      '- {"action":"read_files","paths":["src/index.js"]}',
      '- {"action":"write_file","path":"src/example.js","content":"...full file content..."}',
      '- {"action":"delete_file","path":"src/old.js"}',
      '- {"action":"show_diff"}',
      '- {"action":"run_validation"}',
      '- {"action":"finish","summary":"...","rationale":"...","prTitle":"optional","prBody":"optional"}',
      "Rules:",
      "- Return JSON only.",
      "- Do not request arbitrary shell commands.",
      "- Read before you overwrite large files.",
      "- Use full replacement content for write_file.",
      "- run_validation must pass before finish will be accepted.",
      "- Protected files like .env are unavailable.",
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

  applyAction(action, latestValidation) {
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
          return {
            message: validation.summary,
            validation
          };
        }
        case "finish":
          if (!latestValidation?.passed) {
            return {
              message: "Finish rejected: run_validation must succeed before finish."
            };
          }

          return {
            message: "Finish accepted.",
            finished: true
          };
        default:
          return {
            message: `Unsupported action: ${action.action}`
          };
      }
    } catch (error) {
      return {
        message: `Action failed: ${error.message}`
      };
    }
  }
}
