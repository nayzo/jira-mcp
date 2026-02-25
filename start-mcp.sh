#!/bin/bash

# Load environment variables from .env file
if [ -f "$(dirname "$0")/.env" ]; then
    export $(cat "$(dirname "$0")/.env" | grep -v '^#' | xargs)
fi

# Start the MCP server
node "$(dirname "$0")/build/index.js"
