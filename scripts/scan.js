#!/usr/bin/env node

/**
 * Network Scanner for Media Servers
 *
 * Scans the local network to find running media servers by:
 * 1. Checking common ports (80, 3000, 8080, etc.)
 * 2. Testing for HTTP responses
 * 3. Looking for media server indicators in responses
 */

const http = require('http');
const os = require('os');

// Configuration
const COMMON_PORTS = [80, 3000, 8080, 8000, 5000, 3001];
const TIMEOUT_MS = 1000; // 1 second timeout per check
const CONCURRENT_SCANS = 50; // Scan 50 IPs at a time for speed

/**
 * Get the local subnet for scanning
 */
function getLocalSubnet() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal (loopback) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                const parts = iface.address.split('.');
                return {
                    subnet: `${parts[0]}.${parts[1]}.${parts[2]}`,
                    localIP: iface.address
                };
            }
        }
    }
    return null;
}

/**
 * Check if a media server is running at the given IP and port
 */
function checkMediaServer(ip, port) {
    return new Promise((resolve) => {
        const options = {
            hostname: ip,
            port: port,
            path: '/',
            method: 'GET',
            timeout: TIMEOUT_MS,
            headers: {
                'User-Agent': 'MediaServerScanner/1.0'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            // Collect response data
            res.on('data', (chunk) => {
                data += chunk.toString();
                // Stop after collecting enough data to identify the server
                if (data.length > 5000) {
                    req.destroy();
                }
            });

            res.on('end', () => {
                // Check if this looks like a media server
                const isMediaServer =
                    data.toLowerCase().includes('matthiastv') ||
                    data.toLowerCase().includes('video') ||
                    data.toLowerCase().includes('movie') ||
                    data.toLowerCase().includes('stream') ||
                    res.headers['x-powered-by']?.includes('Express');

                if (isMediaServer || res.statusCode === 200) {
                    resolve({
                        ip,
                        port,
                        statusCode: res.statusCode,
                        headers: res.headers,
                        snippet: data.substring(0, 200),
                        confidence: isMediaServer ? 'high' : 'medium'
                    });
                } else {
                    resolve(null);
                }
            });
        });

        req.on('error', () => {
            resolve(null);
        });

        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });

        req.end();
    });
}

/**
 * Scan a single IP address on all common ports
 */
async function scanIP(ip) {
    const results = [];

    for (const port of COMMON_PORTS) {
        const result = await checkMediaServer(ip, port);
        if (result) {
            results.push(result);
        }
    }

    return results;
}

/**
 * Scan a batch of IPs concurrently
 */
async function scanBatch(ips) {
    const promises = ips.map(ip => scanIP(ip));
    const results = await Promise.all(promises);
    return results.flat().filter(r => r !== null && r.length > 0);
}

/**
 * Main scanning function
 */
async function scanNetwork() {
    console.log('Media Server Network Scanner\n');

    // Get local subnet
    const networkInfo = getLocalSubnet();
    if (!networkInfo) {
        console.error('ERROR: Could not determine local network subnet');
        process.exit(1);
    }

    const { subnet, localIP } = networkInfo;
    console.log(`Local IP: ${localIP}`);
    console.log(`Scanning subnet: ${subnet}.0/24`);
    console.log(`Checking ports: ${COMMON_PORTS.join(', ')}`);
    console.log('This may take a minute...\n');

    const startTime = Date.now();
    const allServers = [];

    // Build list of IPs to scan (1-254)
    const ipsToScan = [];
    for (let i = 1; i <= 254; i++) {
        const ip = `${subnet}.${i}`;
        // Skip our own IP
        if (ip !== localIP) {
            ipsToScan.push(ip);
        }
    }

    // Scan in batches for better performance
    console.log(`Scanning ${ipsToScan.length} IP addresses in batches of ${CONCURRENT_SCANS}...\n`);

    for (let i = 0; i < ipsToScan.length; i += CONCURRENT_SCANS) {
        const batch = ipsToScan.slice(i, i + CONCURRENT_SCANS);
        const progress = Math.round((i / ipsToScan.length) * 100);
        process.stdout.write(`Progress: ${progress}% (${i}/${ipsToScan.length} IPs scanned)\r`);

        const batchResults = await scanBatch(batch);
        allServers.push(...batchResults);

        // If we found servers, report them immediately
        for (const server of batchResults) {
            console.log(`\n[FOUND] Server at ${server.ip}:${server.port} (${server.confidence} confidence)`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\nScan Complete (${elapsed}s)`);
    console.log('='.repeat(60));

    if (allServers.length === 0) {
        console.log('No media servers found on the network');
        console.log('\nTroubleshooting:');
        console.log('  - Make sure the media server is running');
        console.log('  - Check if firewall is blocking connections');
        console.log('  - Verify you are on the same network');
    } else {
        console.log(`\nFound ${allServers.length} server(s):\n`);

        // Group by IP
        const serversByIP = {};
        for (const server of allServers) {
            if (!serversByIP[server.ip]) {
                serversByIP[server.ip] = [];
            }
            serversByIP[server.ip].push(server);
        }

        for (const [ip, servers] of Object.entries(serversByIP)) {
            console.log(`[${ip}]`);
            for (const server of servers) {
                console.log(`  Port ${server.port} (HTTP ${server.statusCode})`);
                console.log(`  URL: http://${server.ip}:${server.port}`);

                // Try to identify the server type
                if (server.snippet.toLowerCase().includes('matthiastv')) {
                    console.log(`  Type: MatthiasTV Media Server`);
                } else if (server.headers['server']) {
                    console.log(`  Server: ${server.headers['server']}`);
                }
                console.log('');
            }
        }

        // Summary
        console.log('='.repeat(60));
        console.log('\nQuick Access URLs:');
        for (const [ip, servers] of Object.entries(serversByIP)) {
            // Prefer port 80, then 3000, then first available
            const preferredServer = servers.find(s => s.port === 80) ||
                                   servers.find(s => s.port === 3000) ||
                                   servers[0];
            const url = preferredServer.port === 80 ?
                `http://${ip}` :
                `http://${ip}:${preferredServer.port}`;
            console.log(`  ${url}`);
        }
    }

    console.log('\n');
}

// Run the scanner
scanNetwork().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
