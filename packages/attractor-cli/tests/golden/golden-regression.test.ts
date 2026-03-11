import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getExpectedPath,
  listGoldenScenarios,
  runGoldenScenario,
} from "../helpers/cli-golden-harness.js";

const shouldUpdateGolden = process.env.UPDATE_GOLDEN === "1";

describe("CLI golden regression", () => {
  it("matches checked-in golden snapshots", async () => {
    const scenarios = listGoldenScenarios();
    expect(scenarios.length).toBeGreaterThan(0);

    for (const scenario of scenarios) {
      const actual = await runGoldenScenario(scenario);
      const expectedPath = getExpectedPath(scenario);

      if (shouldUpdateGolden) {
        fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
        fs.writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
        continue;
      }

      expect(fs.existsSync(expectedPath), `Missing golden file for ${scenario}`).toBe(true);
      const expected = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
      expect(actual).toEqual(expected);
    }
  }, 30_000);
});
