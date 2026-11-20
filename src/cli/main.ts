#!/usr/bin/env node
import { HARNESS_VERSION } from "../version.ts";

function main(args: string[]): number {
  if (args.includes("--version") || args.includes("-v")) {
    console.log(HARNESS_VERSION);
    return 0;
  }
  console.log(`Protege ${HARNESS_VERSION}: nothing here yet.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));