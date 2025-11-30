#!/bin/bash

# Change to the application directory
cd /home/user/videostream

# Run git pull and npm install as the user user (not root)
# This ensures npm can find the correct node installation via nvm
if [ "$EUID" -eq 0 ]; then
    echo "Running as root - executing git pull and npm install as user user..."
    su - user -c "cd /home/user/videostream && git pull && /home/user/.nvm/versions/node/v25.2.0/bin/npm install"
else
    echo "Running as user user - executing git pull and npm install..."
    git pull
    /home/user/.nvm/versions/node/v25.2.0/bin/npm install
fi

# Start the server (this will run as root if the script was started as root)
echo "Starting server..."
/home/user/.nvm/versions/node/v25.2.0/bin/node server.js
