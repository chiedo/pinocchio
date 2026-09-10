import { joinSession } from "@github/copilot-sdk/extension";
import { createIdentityTool } from "./tool.js";

await joinSession({ tools: [createIdentityTool()] });
