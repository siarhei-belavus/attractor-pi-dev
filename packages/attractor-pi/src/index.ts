#!/usr/bin/env node
import { main, shouldRunAsCliEntry, type CliDeps } from "../../attractor-cli/dist/index.js";
import { PiAgentCodergenBackend } from "../../backend-pi-dev/dist/index.js";

const deps: CliDeps = {
  createBackend: (options) =>
    new PiAgentCodergenBackend({
      cwd: options.cwd,
      steeringQueue: options.steeringQueue,
      ...(options.provider ? { defaultProvider: options.provider } : {}),
      ...(options.model ? { defaultModel: options.model } : {}),
      ...(options.debugSink ? { debugSink: options.debugSink } : {}),
      ...(options.warningSink ? { onWarning: options.warningSink } : {}),
    }),
};

export { main, shouldRunAsCliEntry };

if (shouldRunAsCliEntry()) {
  main(process.argv.slice(2), deps).catch((err) => {
    console.error(err);
    process.exit(1);
  }).then(() => {
    process.exit(0);
  });
}
