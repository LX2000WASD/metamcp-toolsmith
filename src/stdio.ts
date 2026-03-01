import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createToolsmithServer } from "./create-toolsmith-server";
import { resolveToolsDir } from "./config";

const toolsDir = resolveToolsDir();
const { server } = createToolsmithServer({ toolsDir });

const transport = new StdioServerTransport();
await server.connect(transport);

