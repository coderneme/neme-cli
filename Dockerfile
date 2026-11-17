# Runs the neme.world MCP server over stdio. It starts and lists its tools with no settings;
# publishing needs the developer's own token in NEME_TOKEN.
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY src ./src
USER node
ENTRYPOINT ["node", "src/cli.js", "mcp"]
