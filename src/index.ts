#!/usr/bin/env node

async function main() {
  // `skylight-mcp auth ...` is a CLI, not the MCP server. Credential commands
  // are never registered as MCP tools.
  if (process.argv[2] === "auth") {
    const { runAuthCommand } = await import("./cli.js");
    process.exitCode = await runAuthCommand(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "init") {
    const { runInit } = await import("./init.js");
    process.exitCode = await runInit(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    const { applyConfigFile, ConfigFileError } = await import("./config-file.js");
    let fileConfig = null;
    let fileConfigError: string | undefined;
    try {
      fileConfig = await applyConfigFile();
    } catch (error) {
      if (!(error instanceof ConfigFileError)) throw error;
      fileConfigError = error.message;
    }
    process.exitCode = await runDoctor(process.argv.slice(3), { fileConfig, fileConfigError });
    return;
  }

  // Saved settings (from `skylight-mcp init`) fill in the frame ID and timezone
  // that the environment does not set. A settings file that exists but is
  // invalid stops the server rather than guessing.
  const { applyConfigFile, ConfigFileError } = await import("./config-file.js");
  try {
    await applyConfigFile();
  } catch (error) {
    if (!(error instanceof ConfigFileError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  const { createServer } = await import("./server.js");
  const server = await createServer();
  await server.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
