#!/usr/bin/env node
/**
 * pwa-snapshot CLI — env var reference
 *
 *   PWA_URL          URL of the PWA page or manifest (required)
 *   OUTPUT_PATH      Output zip path inside container   (default: /output/pwa-snapshot.zip)
 *   ICON_SIZES       Comma-separated sizes to generate  (default: 48,72,96,144,192,512)
 *   NO_RESIZE        "1" or "true" to skip resizing
 *   REQUEST_TIMEOUT  HTTP timeout in ms                 (default: 15000)
 *   VERBOSE          "1" or "true" for verbose logs
 *
 * CLI flags always win over env vars.
 */

import { program } from "commander";
import { snapshot } from "./snapshot.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

const env = {
  url:       process.env.PWA_URL         ?? "",
  output:    process.env.OUTPUT_PATH     ?? "/output/pwa-snapshot.zip",
  iconSizes: process.env.ICON_SIZES      ?? "48,72,96,144,192,512",
  noResize:  ["1","true"].includes((process.env.NO_RESIZE ?? "").toLowerCase()),
  timeout:   process.env.REQUEST_TIMEOUT ?? "15000",
  verbose:   ["1","true"].includes((process.env.VERBOSE ?? "").toLowerCase()),
};

program
  .name("pwa-snapshot")
  .description(
    "Fetch a PWA manifest, icons and metadata into a zip for offline TWA builds.\n" +
    "All options can be set via environment variables — ideal for Docker."
  )
  .version(pkg.version)
  .argument("[url]", "PWA URL (overrides $PWA_URL)")
  .option("-o, --output <path>",   "output zip path",              env.output)
  .option("--icon-sizes <sizes>",  "comma-separated sizes (px)",   env.iconSizes)
  .option("--no-resize",           "skip generating missing sizes")
  .option("--timeout <ms>",        "HTTP request timeout (ms)",    env.timeout)
  .option("--verbose",             "print every fetched URL")
  .addHelpText("after", `
Environment variables:
  PWA_URL          PWA page or manifest URL
  OUTPUT_PATH      Output zip path (default: /output/pwa-snapshot.zip)
  ICON_SIZES       Comma-separated icon sizes, e.g. 48,192,512
  NO_RESIZE        Set to "1" to skip icon resizing
  REQUEST_TIMEOUT  HTTP timeout in ms (default: 15000)
  VERBOSE          Set to "1" for verbose output

Docker quick-start:
  docker run --rm \\
    -e PWA_URL=https://myapp.example.com \\
    -v \$(pwd)/dist:/output \\
    pwa-snapshot
`)
  .action(async (urlArg, opts) => {
    const url = urlArg ?? env.url;
    if (!url) {
      console.error(
        "✗  No URL provided.\n" +
        "   Argument:  pwa-snapshot <url>\n" +
        "   Env var:   PWA_URL=https://myapp.example.com"
      );
      process.exit(1);
    }

    const resize = opts.resize === false ? false : !env.noResize;

    try {
      await snapshot(url, {
        output:    opts.output,
        iconSizes: opts.iconSizes.split(",").map(Number),
        resize,
        timeout:   parseInt(opts.timeout, 10),
        verbose:   opts.verbose || env.verbose,
      });
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
