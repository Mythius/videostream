#!/bin/bash

# Change to the application directory
cd /home/user/videostream

# Function to setup nvm and node paths
setup_node() {
    # Load nvm if available
    export NVM_DIR="/home/user/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

    # Get node and npm paths (nvm will use the default version)
    NODE_PATH=$(which node 2>/dev/null)
    NPM_PATH=$(which npm 2>/dev/null)

    # If nvm didn't work, try to find node manually in nvm directory
    if [ -z "$NODE_PATH" ] || [ -z "$NPM_PATH" ]; then
        # Find the most recently modified node installation (likely the current version)
        NVM_NODE_DIR=$(find /home/user/.nvm/versions/node -maxdepth 1 -type d -name "v*" 2>/dev/null | sort -V | tail -n 1)
        if [ -n "$NVM_NODE_DIR" ]; then
            NODE_PATH="$NVM_NODE_DIR/bin/node"
            NPM_PATH="$NVM_NODE_DIR/bin/npm"
        fi
    fi

    # Final fallback to system node
    if [ -z "$NODE_PATH" ]; then
        NODE_PATH=$(command -v node)
    fi
    if [ -z "$NPM_PATH" ]; then
        NPM_PATH=$(command -v npm)
    fi

    if [ -z "$NODE_PATH" ] || [ -z "$NPM_PATH" ]; then
        echo "ERROR: Could not find node or npm installation"
        exit 1
    fi

    echo "Using Node: $NODE_PATH"
    echo "Using NPM: $NPM_PATH"
}

# Run git pull and npm install as the user user (not root)
# This ensures npm can find the correct node installation via nvm
if [ "$EUID" -eq 0 ]; then
    echo "Running as root - executing git pull and npm install as user user..."
    su - user -c "
        cd /home/user/videostream
        git pull

        # Load nvm
        export NVM_DIR=\"/home/user/.nvm\"
        [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"

        # Run npm install
        npm install
    "
else
    echo "Running as user user - executing git pull and npm install..."
    git pull

    # Load nvm
    export NVM_DIR="/home/user/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

    npm install
fi

# Setup node paths for server startup
setup_node

# Start the server (this will run as root if the script was started as root)
echo "Starting server..."
exec "$NODE_PATH" server.js
