#!/bin/bash

# Clear the URL from config.json
# This script reads config.json, removes the url field, and saves it back

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: config.json not found at $CONFIG_FILE"
    exit 1
fi

# Use jq to remove the url field if jq is available
if command -v jq &> /dev/null; then
    jq 'del(.url)' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv -f "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    echo "URL cleared from config.json using jq"
else
    # Fallback: use node to modify the JSON
    node -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        delete config.url;
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
        console.log('URL cleared from config.json using node');
    "
fi
