import { describe, expect, it } from "vitest";
import { parseConfirmationAnswer } from "../src/handlers/interviewers.js";
import { AnswerValue } from "../src/handlers/types.js";

describe("parseConfirmationAnswer", () => {
  it("maps confirm-like answers to confirmed", () => {
    expect(parseConfirmationAnswer("confirm")).toBe(AnswerValue.CONFIRMED);
    expect(parseConfirmationAnswer("yes")).toBe(AnswerValue.CONFIRMED);
  });

  it("maps cancel-like answers to cancelled", () => {
    expect(parseConfirmationAnswer("cancel")).toBe(AnswerValue.CANCELLED);
    expect(parseConfirmationAnswer("cancelled")).toBe(AnswerValue.CANCELLED);
    expect(parseConfirmationAnswer("no")).toBe(AnswerValue.CANCELLED);
  });
});
