import { Command } from "commander";
import { registerDoctor } from "./commands/doctor.js";
import { registerDown } from "./commands/down.js";
import { registerInit } from "./commands/init.js";
import { registerLogs } from "./commands/logs.js";
import { registerReset } from "./commands/reset.js";
import { registerStatus } from "./commands/status.js";

import { registerUp } from "./commands/up.js";
import { registerUpdate } from "./commands/update.js";

const program = new Command();

program
  .name("yavio")
  .description("Yavio CLI — SDK setup and self-hosted platform management")
  .version("0.0.1")
  .option("--verbose", "Enable verbose output");

registerInit(program);
registerUp(program);
registerDown(program);
registerStatus(program);
registerLogs(program);
registerUpdate(program);
registerReset(program);
registerDoctor(program);

program.parse();
