import * as fs from "node:fs";
import type { GraphNode } from "../model/graph.js";
import type { Context } from "../state/context.js";
import {
  HUMAN_INTERVIEW_PARSED_ATTR,
  HUMAN_INTERVIEW_PROMPT_CONTEXT_KEY_ATTR,
  HUMAN_INTERVIEW_PROMPT_FILE_ATTR,
  validateHumanPrompt,
  validateNormalizedPromptFileAttr,
} from "./human-prompt.js";
import type { HumanPrompt, HumanPromptQuestion } from "./types.js";

export function resolveHumanInterviewPrompt(
  node: GraphNode,
  context: Context,
  _logsRoot: string,
): HumanPrompt {
  const promptFile = node.attrs[HUMAN_INTERVIEW_PROMPT_FILE_ATTR];
  if (promptFile !== undefined) {
    const filePath = validateNormalizedPromptFileAttr(promptFile);
    const raw = fs.readFileSync(filePath, "utf-8");
    return validateHumanPrompt(JSON.parse(raw));
  }

  const promptContextKey = node.attrs[HUMAN_INTERVIEW_PROMPT_CONTEXT_KEY_ATTR];
  if (promptContextKey !== undefined) {
    if (typeof promptContextKey !== "string" || promptContextKey.trim().length === 0) {
      throw new Error(
        `Node '${node.id}' is missing a valid ${HUMAN_INTERVIEW_PROMPT_CONTEXT_KEY_ATTR} value`,
      );
    }
    return validateHumanPrompt(context.get(promptContextKey));
  }

  const parsedQuestions = node.attrs[HUMAN_INTERVIEW_PARSED_ATTR];
  if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
    throw new Error(
      `Node '${node.id}' is missing validated ${HUMAN_INTERVIEW_PARSED_ATTR} questions`,
    );
  }

  return {
    title: node.label || node.id,
    stage: node.id,
    questions: parsedQuestions as HumanPromptQuestion[],
    metadata: {
      handlerType: "human.interview",
    },
  };
}
