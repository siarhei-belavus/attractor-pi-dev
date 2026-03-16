#!/usr/bin/env node
import { createPiBackendFactory } from "@attractor/backend-pi-dev";
import { main, type CliDeps } from "./index.js";

const deps: CliDeps = {
  createBackend: createPiBackendFactory(),
};

main(process.argv.slice(2), deps).catch((error) => {
  console.error(String(error));
  process.exit(1);
});
