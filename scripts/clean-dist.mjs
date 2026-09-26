// tsc never removes output for a deleted source, so `dist` accumulates dead
// modules that then ship in the published tarball with no source behind them.
// Removing a module should not require remembering to clean by hand.
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
