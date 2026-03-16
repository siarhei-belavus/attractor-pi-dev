import {
  AnswerValue,
  QuestionType,
  type Answer,
  type HumanPrompt,
  type HumanPromptQuestion,
  type QuestionOption,
} from "./types.js";

export const HUMAN_INTERVIEW_QUESTIONS_ATTR = "human.questions";
export const HUMAN_INTERVIEW_PARSED_ATTR = "internal.human.questions";

export interface NormalizedPromptAnswer {
  question: HumanPromptQuestion;
  answer: Answer;
  value: string;
  label?: string;
}

export interface ValidatedPromptAnswers {
  normalizedByKey: Record<string, NormalizedPromptAnswer>;
  scalarValues: Record<string, string>;
  labels: Record<string, string>;
}

export function isHumanPromptQuestionType(value: unknown): value is QuestionType {
  return Object.values(QuestionType).includes(value as QuestionType);
}

export function getQuestionOptions(question: HumanPromptQuestion): QuestionOption[] {
  return question.options ?? [];
}

export function getQuestionRequired(question: HumanPromptQuestion): boolean {
  return question.required !== false;
}

export function validateHumanPrompt(prompt: unknown): HumanPrompt {
  if (!prompt || typeof prompt !== "object") {
    throw new Error("Human prompt record is malformed: expected object");
  }

  const candidate = prompt as Record<string, unknown>;
  const title = readRequiredString(candidate.title, "Human prompt record is missing title");
  const stage = readRequiredString(candidate.stage, "Human prompt record is missing stage");
  const questions = validateHumanPromptQuestions(candidate.questions);
  const metadata = readMetadata(candidate.metadata);

  return {
    title,
    stage,
    questions,
    ...(metadata ? { metadata } : {}),
  };
}

export function validateHumanPromptAnswers(
  prompt: HumanPrompt,
  answers: unknown,
): ValidatedPromptAnswers {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error(`Prompt ${prompt.stage} answers must be an object map keyed by question key`);
  }

  const answerMap = answers as Record<string, unknown>;
  const normalizedByKey: Record<string, NormalizedPromptAnswer> = {};
  const scalarValues: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const knownKeys = new Set(prompt.questions.map((question) => question.key));

  for (const key of Object.keys(answerMap)) {
    if (!knownKeys.has(key)) {
      throw new Error(`Prompt ${prompt.stage} received unexpected answer key '${key}'`);
    }
  }

  for (const question of prompt.questions) {
    const rawEntry = answerMap[question.key];
    if (rawEntry === undefined || rawEntry === null) {
      if (getQuestionRequired(question)) {
        throw new Error(
          `Prompt ${prompt.stage} is missing required answer '${question.key}'`,
        );
      }
      continue;
    }

    if (typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(
        `Prompt ${prompt.stage} answer '${question.key}' must be an object with a value field`,
      );
    }

    const answer = rawEntry as Record<string, unknown>;
    const rawValue = answer.value;
    if (rawValue === undefined || rawValue === null) {
      if (getQuestionRequired(question)) {
        throw new Error(
          `Prompt ${prompt.stage} is missing required answer '${question.key}'`,
        );
      }
      continue;
    }

    const normalized = normalizeQuestionAnswer(question, rawEntry as Answer);
    normalizedByKey[question.key] = normalized;
    scalarValues[question.key] = normalized.value;
    if (normalized.label) {
      labels[question.key] = normalized.label;
    }
  }

  return { normalizedByKey, scalarValues, labels };
}

function validateHumanPromptQuestions(rawQuestions: unknown): HumanPromptQuestion[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("Human prompt record is missing questions");
  }

  const seenKeys = new Set<string>();
  return rawQuestions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Human prompt question ${index + 1} is malformed`);
    }
    const question = entry as Record<string, unknown>;
    const key = readRequiredString(
      question.key,
      `Human prompt question ${index + 1} is missing key`,
    );
    if (seenKeys.has(key)) {
      throw new Error(`Human prompt question '${key}' is duplicated`);
    }
    seenKeys.add(key);
    const text = readRequiredString(
      question.text,
      `Human prompt question '${key}' is missing text`,
    );
    const type = question.type;
    if (!isHumanPromptQuestionType(type)) {
      throw new Error(`Human prompt question '${key}' has unsupported type '${String(type ?? "")}'`);
    }

    const required = question.required === false ? false : true;
    const options = readQuestionOptions(question.options, key, type);
    const defaultValue = readDefault(question.default);

    return {
      key,
      text,
      type,
      ...(options ? { options } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      required,
    };
  });
}

function normalizeQuestionAnswer(
  question: HumanPromptQuestion,
  answer: Answer,
): NormalizedPromptAnswer {
  const rawValue = answer.value;

  if (question.type === QuestionType.FREEFORM) {
    if (typeof rawValue !== "string") {
      throw new Error(`Question '${question.key}' requires a string value`);
    }
    if (getQuestionRequired(question) && rawValue.length === 0) {
      throw new Error(`Question '${question.key}' requires a non-empty freeform value`);
    }
    return {
      question,
      answer: {
        value: rawValue,
        ...(typeof answer.text === "string" ? { text: answer.text } : {}),
      },
      value: rawValue,
    };
  }

  if (question.type === QuestionType.YES_NO) {
    if (rawValue !== AnswerValue.YES && rawValue !== AnswerValue.NO) {
      throw new Error(`Question '${question.key}' requires value 'yes' or 'no'`);
    }
    return {
      question,
      answer: { value: rawValue },
      value: rawValue,
    };
  }

  if (question.type === QuestionType.CONFIRMATION) {
    if (rawValue !== AnswerValue.CONFIRMED && rawValue !== AnswerValue.CANCELLED) {
      throw new Error(
        `Question '${question.key}' requires value 'confirmed' or 'cancelled'`,
      );
    }
    return {
      question,
      answer: { value: rawValue },
      value: rawValue,
    };
  }

  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error(`Question '${question.key}' requires a selected option key`);
  }

  const matchedOption = getQuestionOptions(question).find((option) => option.key === rawValue);
  if (!matchedOption) {
    throw new Error(
      `Question '${question.key}' received invalid option '${rawValue}'`,
    );
  }

  return {
    question,
    answer: {
      value: matchedOption.key,
      selectedOption: matchedOption,
      ...(typeof answer.text === "string" ? { text: answer.text } : {}),
    },
    value: matchedOption.key,
    label: matchedOption.label,
  };
}

function readQuestionOptions(
  rawOptions: unknown,
  key: string,
  type: QuestionType,
): QuestionOption[] | undefined {
  if (type !== QuestionType.MULTIPLE_CHOICE) {
    if (rawOptions !== undefined) {
      throw new Error(`Question '${key}' must not define options unless type is multiple_choice`);
    }
    return undefined;
  }

  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    throw new Error(`Question '${key}' requires at least one option`);
  }

  return rawOptions.map((option, index) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new Error(`Question '${key}' option ${index + 1} is malformed`);
    }
    const candidate = option as Record<string, unknown>;
    return {
      key: readRequiredString(
        candidate.key,
        `Question '${key}' option ${index + 1} is missing key`,
      ),
      label: readRequiredString(
        candidate.label,
        `Question '${key}' option ${index + 1} is missing label`,
      ),
    };
  });
}

function readDefault(value: unknown): string | AnswerValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Human prompt question default must be a string");
  }
  return value as string | AnswerValue;
}

function readMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Human prompt metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}
