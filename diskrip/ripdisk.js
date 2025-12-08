#!/usr/bin/env node

const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const notifier = require('node-notifier');
const http = require('http');

// Load configuration from root directory
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
let config;
let outputFolder;

try {
    const rootConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Use the diskrip section of the config
    config = rootConfig.diskrip;
    if (!config) {
        console.error('Error: "diskrip" section not found in config.json');
        process.exit(1);
    }
    // Use videoDirectory from root config as the output folder for ripped discs
    outputFolder = rootConfig.videoDirectory;
    if (!outputFolder) {
        console.error('Error: "videoDirectory" not found in config.json');
        process.exit(1);
    }
} catch (error) {
    console.error('Error loading config.json:', error.message);
    process.exit(1);
}

// Global state
let isRipping = false;
let checkInterval = null;
let lastRippedDisc = null;  // Track recently ripped disc to avoid immediate re-rip
let lastRipTime = 0;
let lastDiscPresent = false;  // Track whether a disc was present in last check
let waitingForDiscRemoval = false;  // True after ejection, waiting for disc to be removed
const RIP_COOLDOWN_MS = 30000;  // Wait 30 seconds after ejection before detecting again
const CHECK_INTERVAL_MS = 60000;  // Check every 60 seconds (1 minute)

/**
 * Log message with timestamp
 */
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

/**
 * Send notification to server
 */
function sendNotification(type, title, message) {
    try {
        // Load config to get port
        const rootConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const port = rootConfig.port || 80;

        const data = JSON.stringify({ type, title, message });

        const options = {
            hostname: 'localhost',
            port: port,
            path: '/api/ripper-notification',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        log(`Sending notification to http://localhost:${port}/api/ripper-notification: ${type} - ${title}`);

        const req = http.request(options, (res) => {
            if (res.statusCode === 200) {
                log(`✓ Notification sent successfully`);
            } else {
                log(`Warning: Notification returned status ${res.statusCode}`);
            }
        });

        req.on('error', (error) => {
            log(`Warning: Failed to send notification: ${error.message}`);
        });

        req.write(data);
        req.end();
    } catch (error) {
        log(`Warning: Error sending notification: ${error.message}`);
    }
}

/**
 * Send notification
 */
function notify(title, message) {
    if (config.notifyOnComplete) {
        notifier.notify({
            title: title,
            message: message,
            sound: true
        });
    }
}

/**
 * Execute command and return promise
 */
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr });
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Check if a disc is present in the drive
 */
async function isDiscPresent() {
    const device = config.diskDevice;
    log(`Checking for disc presence on ${device}...`);
    // Try several methods to detect media presence; udisksctl output varies across systems
    try {
        // 1) udisksctl
        try {
            const out = await execPromise(`udisksctl info -b ${device}`);
            log(`udisksctl: ${out.split('\n')[0] || ''}`);
            if (out.includes('optical') || out.includes('MediaAvailable: true') || /Media:/.test(out)) {
                return true;
            }
        } catch (e) {
            log(`udisksctl failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore and try next method
        }

        // 2) udevadm properties (ID_CDROM_MEDIA=1 when media present)
        try {
            const out = await execPromise(`udevadm info -q property -n ${device}`);
            log(`udevadm: ${out.split('\n')[0] || ''}`);
            if (/ID_CDROM_MEDIA=(1|true)/i.test(out) || /ID_FS_LABEL=/.test(out) || /ID_FS_TYPE=/.test(out)) {
                return true;
            }
        } catch (e) {
            log(`udevadm failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore and try next method
        }

        // 3) blkid will print info when there is a filesystem on the disc
        try {
            const out = await execPromise(`blkid ${device}`);
            if (out && out.trim().length > 0) {
                log(`blkid: ${out.trim()}`);
                return true;
            }
        } catch (e) {
            log(`blkid failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore
        }

        // 4) file -s can sometimes identify a filesystem on the raw device
        try {
            const out = await execPromise(`file -s ${device}`);
            log(`file -s: ${out.split('\n')[0] || ''}`);
            // If output contains common fs type or ISO9660, treat as present
            if (/ISO 9660|ISO9660|filesystem|FAT|NTFS|ext[234]/i.test(out)) {
                return true;
            }
        } catch (e) {
            log(`file -s failed: ${e && e.stderr ? e.stderr : (e && e.message) || e}`);
            // ignore
        }

        return false;
    } catch (error) {
        // If something unexpected happens, assume no disc
        log('isDiscPresent unexpected error: ' + (error && error.stderr ? error.stderr : (error && error.message) || error));
        return false;
    }
}

/**
 * Get disc information using makemkvcon
 */
async function getDiscInfo() {
    try {
        log('Scanning disc with MakeMKV...');
        const output = await execPromise(`makemkvcon -r info disc:0`);

        // Extract disc name from output
        const nameMatch = output.match(/CINFO:2,0,"([^"]+)"/);
        const discName = nameMatch ? nameMatch[1] : `Disc_${Date.now()}`;

        // Parse all titles with their durations
        const titles = [];
        const titleRegex = /TINFO:(\d+),9,0,"(\d+):(\d+):(\d+)"/g;
        let match;

        while ((match = titleRegex.exec(output)) !== null) {
            const titleIndex = parseInt(match[1]);
            const hours = parseInt(match[2]);
            const minutes = parseInt(match[3]);
            const seconds = parseInt(match[4]);
            const durationInSeconds = hours * 3600 + minutes * 60 + seconds;

            titles.push({
                index: titleIndex,
                duration: durationInSeconds,
                durationFormatted: `${match[2]}:${match[3]}:${match[4]}`
            });
        }

        // Sort by duration (longest first)
        titles.sort((a, b) => b.duration - a.duration);

        // Filter by minimum length
        const minLength = config.minTitleLength || 300;
        const validTitles = titles.filter(t => t.duration >= minLength);

        return {
            name: sanitizeFilename(discName),
            titles: validTitles,
            titleCount: validTitles.length
        };
    } catch (error) {
        log('Error getting disc info: ' + (error.stderr || error.message));
        throw error;
    }
}

/**
 * Expand ~ in paths to home directory
 */
function expandPath(filePath) {
    if (!filePath) return filePath;

    // If path starts with ~, expand it
    if (filePath.startsWith('~/') || filePath === '~') {
        const home = process.env.HOME || process.env.USERPROFILE;
        if (!home) {
            log('Warning: Cannot expand ~ in path - HOME environment variable not set');
            return filePath;
        }
        return filePath.replace(/^~/, home);
    }

    return filePath;
}

/**
 * Test if a directory is writable
 */
async function testDirectoryWritable(dirPath) {
    try {
        const testFile = path.join(dirPath, `.write-test-${Date.now()}`);
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Sanitize filename
 */
function sanitizeFilename(name) {
    return name.replace(/[^\w\s-]/g, '_').replace(/\s+/g, '_');
}

/**
 * Convert a sanitized folder/name into a human-friendly title-cased name
 * e.g. HOW_TO_TRAIN_YOUR_DRAGON -> How To Train Your Dragon
 */
function humanizeName(name) {
    // Replace underscores and dashes with spaces, collapse spaces
    let s = name.replace(/[_-]+/g, ' ').trim();
    // Lowercase then Title Case each word
    s = s.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return s;
}
/**
 * Rip disc to MKV using MakeMKV
 */
async function ripToMKV(discInfo) {
    // Allow configuring whether to create a subfolder per-disc inside tempFolder.
    // If config.createTempSubfolder is === false, write files directly into tempFolder.
    const useSubfolder = !(config.createTempSubfolder === false);
    const outputPath = useSubfolder ? path.join(config.tempFolder, discInfo.name) : config.tempFolder;

    // Create temp folder or per-disc subfolder with proper permissions so it's writable even when run as sudo
    if (!fs.existsSync(outputPath)) {
        log(`Creating output directory: ${outputPath}`);
        fs.mkdirSync(outputPath, { recursive: true, mode: 0o777 });
    }

    // Log current permissions before changes
    try {
        const statBefore = fs.statSync(outputPath);
        log(`Directory ${outputPath} before permission changes: uid=${statBefore.uid}, gid=${statBefore.gid}, mode=${statBefore.mode.toString(8)}`);
    } catch (err) {
        log(`Warning: Could not stat directory: ${err.message}`);
    }

    // Ensure directory is writable: chown to current user and chmod to 0o777
    // This fixes the issue where sudo creates root-owned directory that non-root can't write to
    try {
        // Get the user that should own this (if running as sudo, use the sudo user)
        let targetUid = process.getuid();
        let targetGid = process.getgid();

        // If running as root (uid 0), try to get the sudo user from environment
        if (targetUid === 0 && process.env.SUDO_UID) {
            targetUid = parseInt(process.env.SUDO_UID);
            targetGid = parseInt(process.env.SUDO_GID) || targetGid;
            log(`Running as root with sudo; setting directory owner to sudo user (uid: ${targetUid}, gid: ${targetGid})`);
        }

        fs.chownSync(outputPath, targetUid, targetGid);
        fs.chmodSync(outputPath, 0o777);
        log(`Set ${outputPath} to uid:${targetUid}, gid:${targetGid}, mode 0o777`);

        // Verify permissions were set correctly
        const statAfter = fs.statSync(outputPath);
        log(`Directory ${outputPath} after permission changes: uid=${statAfter.uid}, gid=${statAfter.gid}, mode=${statAfter.mode.toString(8)}`);
    } catch (err) {
        log(`Warning: Failed to set directory permissions: ${err.message}`);
    }

    // Test that the directory is actually writable
    log('Testing directory writability before starting MakeMKV...');
    const isWritable = await testDirectoryWritable(outputPath);
    if (!isWritable) {
        throw new Error(`Directory ${outputPath} is not writable! Check permissions and try again.`);
    }
    log('✓ Directory is writable');

    return new Promise((resolve, reject) => {

        // Determine which titles to rip
        const titlesToRip = config.titlesToRip || 1;
        const selectedTitles = discInfo.titles.slice(0, titlesToRip);

        log(`Ripping disc "${discInfo.name}" to MKV...`);
        log(`Found ${discInfo.titleCount} valid titles, ripping ${selectedTitles.length} largest:`);
        selectedTitles.forEach((title, idx) => {
            log(`  ${idx + 1}. Title ${title.index} - Duration: ${title.durationFormatted}`);
        });
        log(`Output path: ${outputPath}`);

        // If no titles selected, return early with empty result
        if (selectedTitles.length === 0) {
            log('No titles meet the minimum length requirement; skipping MKV rip.');
            resolve({ mkvFiles: [], outputPath, discInfo, createdSubfolder: useSubfolder });
            return;
        }

        // Build title list argument (comma-separated title indices)
        const titleList = selectedTitles.map(t => t.index).join(',');

        // Use makemkvcon to rip specific titles
        // Wrap in a shell command that sets umask before running makemkvcon
        // This ensures the child process has the correct umask when creating files
        const makemkvconCmd = `umask 0000 && makemkvcon -r mkv disc:0 ${titleList} ${outputPath}`;

        log(`Executing: ${makemkvconCmd}`);

        // Prepare spawn options to ensure makemkvcon runs with proper permissions
        const spawnOptions = {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true  // Use shell to execute the command with umask
        };

        // If running as root, explicitly set uid/gid for the child process
        // This ensures makemkvcon inherits root permissions and can write files
        const currentUid = process.getuid();
        const currentGid = process.getgid();

        if (currentUid === 0) {
            // Running as root - makemkvcon will also run as root
            spawnOptions.uid = 0;
            spawnOptions.gid = 0;
            log(`Spawning makemkvcon as root (uid: 0, gid: 0)`);
        } else {
            log(`Spawning makemkvcon as current user (uid: ${currentUid}, gid: ${currentGid})`);
        }

        log('Using shell with umask 0000 to ensure MakeMKV creates writable files');

        const makemkv = spawn(makemkvconCmd, [], spawnOptions);

        makemkv.on('error', (err) => {
            log('Failed to start makemkvcon: ' + (err.message || err));
            reject(err);
        });

        let output = '';
        let errorOutput = '';
        let hasReadErrors = false;

        makemkv.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;

            // Log progress
            const progressMatch = text.match(/PRGV:(\d+),(\d+),(\d+)/);
            if (progressMatch) {
                const current = parseInt(progressMatch[1]);
                const total = parseInt(progressMatch[2]);
                const percent = Math.round((current / total) * 100);
                log(`Progress: ${percent}%`);
            }

            // Log current operation
            const msgMatch = text.match(/MSG:(\d+),(\d+),\d+,"([^"]+)"/);
            if (msgMatch) {
                log(`MakeMKV: ${msgMatch[3]}`);
            }

            // Detect read errors (scratched disc, bad sectors, etc.)
            if (text.includes('Posix error') ||
                text.includes('No such device') ||
                text.includes('Read error') ||
                text.includes('Scsi error') ||
                text.includes('failed to read')) {
                hasReadErrors = true;
                errorOutput += text;
            }
        });

        makemkv.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            log(`MakeMKV Error: ${text}`);

            // Also check stderr for read errors
            if (text.includes('Posix error') ||
                text.includes('No such device') ||
                text.includes('Read error') ||
                text.includes('Scsi error')) {
                hasReadErrors = true;
            }
        });

        makemkv.on('close', (code) => {
            if (code === 0) {
                log('MKV ripping completed successfully');

                // Find all MKV files created
                try {
                    const mkvFiles = fs.readdirSync(outputPath)
                        .filter(f => f.endsWith('.mkv'))
                        .map(f => path.join(outputPath, f));

                    // Check if any files were actually created
                    if (mkvFiles.length === 0) {
                        log('Warning: MakeMKV reported success but no MKV files were created. This may indicate a read error.');
                        reject(new Error('MakeMKV completed but failed to create any output files'));
                        return;
                    }

                    resolve({ mkvFiles, outputPath, discInfo, createdSubfolder: useSubfolder });
                } catch (err) {
                    log(`Error reading output directory: ${err.message}`);
                    reject(err);
                }
            } else {
                log(`ERROR: MakeMKV exited with code ${code}`);

                // Provide user-friendly error message based on error type
                let userMessage = 'MakeMKV failed to rip the disc';

                if (hasReadErrors) {
                    log('=== DISC READ ERROR DETECTED ===');
                    log('The disc appears to be scratched, damaged, or unreadable.');
                    log('Common causes:');
                    log('  - Scratches or fingerprints on the disc surface');
                    log('  - Damaged or degraded disc (disc rot)');
                    log('  - Incompatible or region-locked disc');
                    log('  - Dirty or faulty optical drive');
                    log('');
                    log('Suggestions:');
                    log('  1. Clean the disc gently with a soft cloth (wipe from center outward)');
                    log('  2. Try the disc in a different drive if available');
                    log('  3. Check if the disc plays normally in a DVD/Blu-ray player');
                    log('  4. Clean the optical drive lens');

                    userMessage = 'Unable to read disc - the disc may be scratched, damaged, or dirty. Please clean the disc and try again.';
                    sendNotification('error', 'Disc Read Error', 'Unable to read disc - it may be scratched or damaged');
                } else {
                    // Generic error - show diagnostic information
                    log('=== Diagnostic Information ===');
                    log(`Output directory: ${outputPath}`);

                    // Try to list directory contents and permissions
                    try {
                        log('Attempting to list directory contents...');
                        execPromise(`ls -la ${outputPath}`).then(lsOutput => {
                            log(`Directory listing:\n${lsOutput}`);
                        }).catch(lsErr => {
                            log(`Failed to list directory: ${lsErr.message}`);
                        });
                    } catch (e) {
                        log(`Failed to execute ls command: ${e.message}`);
                    }

                    // Log directory permissions
                    try {
                        const stat = fs.statSync(outputPath);
                        log(`Directory permissions: uid=${stat.uid}, gid=${stat.gid}, mode=${stat.mode.toString(8)}`);
                    } catch (statErr) {
                        log(`Failed to stat directory: ${statErr.message}`);
                    }

                    // Log current process info
                    log(`Current process: uid=${process.getuid()}, gid=${process.getgid()}`);

                    // Log suggestions
                    log('=== Troubleshooting Suggestions ===');
                    log('1. Ensure the directory has proper permissions (chmod 777)');
                    log('2. Check if the disk has enough free space');
                    log('3. Verify MakeMKV can access the disc drive');
                    log('4. Check system logs for more details: journalctl -u ripdisk -n 50');
                }

                reject(new Error(userMessage));
            }
        });
    });
}

/**
 * Monitor ffmpeg process completion and send notification when done
 */
function monitorFFmpegCompletion(pid, mp4File, movieName, logFile) {
    const checkInterval = 5000; // Check every 5 seconds
    let lastSize = 0;
    let unchangedCount = 0;

    log(`Starting background monitor for ffmpeg PID ${pid}`);

    const monitor = setInterval(() => {
        // Check if process is still running
        let processRunning = false;
        try {
            process.kill(pid, 0);
            processRunning = true;
        } catch (err) {
            processRunning = false;
        }

        // Check if MP4 file exists and get its size
        let currentSize = 0;
        let fileExists = false;
        try {
            const stats = fs.statSync(mp4File);
            currentSize = stats.size;
            fileExists = true;
        } catch (err) {
            fileExists = false;
        }

        // If process is not running
        if (!processRunning) {
            clearInterval(monitor);

            if (fileExists && currentSize > 0) {
                // Process finished and file exists - success!
                log(`✓ FFmpeg compression completed for "${movieName}"`);
                log(`Final file size: ${(currentSize / 1024 / 1024).toFixed(2)} MB`);
                sendNotification('success', 'Compression Complete', `"${movieName}" is now ready to stream`);
            } else {
                // Process finished but no file - error
                log(`✗ FFmpeg process ended but no output file found for "${movieName}"`);
                sendNotification('error', 'Compression Failed', `Failed to compress "${movieName}". Check logs for details.`);

                // Try to read log file for error details
                try {
                    const logContent = fs.readFileSync(logFile, 'utf8');
                    log(`FFmpeg log:\n${logContent.slice(-1000)}`); // Last 1000 chars
                } catch (readErr) {
                    log(`Could not read ffmpeg log file: ${readErr.message}`);
                }
            }
            return;
        }

        // Process is still running - check if file is still growing
        if (fileExists) {
            if (currentSize === lastSize) {
                unchangedCount++;
                // If file hasn't changed in 30 seconds (6 checks), might be stalled
                if (unchangedCount >= 6) {
                    log(`Warning: MP4 file size hasn't changed in ${unchangedCount * checkInterval / 1000}s`);
                }
            } else {
                unchangedCount = 0;
                log(`Compression in progress: ${(currentSize / 1024 / 1024).toFixed(2)} MB (PID: ${pid})`);
            }
            lastSize = currentSize;
        }
    }, checkInterval);
}

/**
 * Convert MKV to MP4 using FFmpeg
 * Runs as a detached background process to survive service restarts
 */
async function convertToMP4(mkvFile, outputFolder, outputFilename = null, movieName = null) {
    return new Promise((resolve, reject) => {
        const basename = path.basename(mkvFile, '.mkv');
        const mp4Name = outputFilename || `${basename}.mp4`;
        const mp4File = path.join(outputFolder, mp4Name);
        const displayName = movieName || mp4Name;

        log(`Converting ${basename}.mkv to MP4 as ${mp4Name}...`);
        log('Starting ffmpeg as detached process to survive service restarts...');

        // Create a log file for ffmpeg output
        const logFile = path.join(config.tempFolder, `ffmpeg-${Date.now()}.log`);

        // Build ffmpeg command with nohup to ensure it survives parent exit
        // Using shell command with nohup ensures the process won't receive SIGTERM
        const ffmpegCmd = `nohup ffmpeg -i "${mkvFile}" -c:v ${config.mp4Settings.videoCodec} -preset ${config.mp4Settings.preset} -crf ${config.mp4Settings.crf} -c:a ${config.mp4Settings.audioCodec} -b:a 192k -movflags +faststart "${mp4File}" >> "${logFile}" 2>&1 &`;

        log(`Executing: ${ffmpegCmd}`);

        // Execute the command in a shell to spawn truly independent process
        exec(ffmpegCmd);

        log(`FFmpeg output will be written to: ${logFile}`);

        // Give the process a moment to start and get its PID
        setTimeout(() => {
            try {
                // Try to find the ffmpeg process by looking for our specific output file
                const { execSync } = require('child_process');
                const psOutput = execSync(
                    `ps aux | grep "[f]fmpeg.*${path.basename(mp4File)}" | awk '{print $2}'`
                ).toString().trim();

                if (psOutput) {
                    const ffmpegPid = parseInt(psOutput.split('\n')[0]);
                    log(`✓ FFmpeg process confirmed running (PID: ${ffmpegPid})`);
                    log(`Note: Conversion will continue in background. Check ${mp4File} for completion.`);

                    // Start monitoring the process for completion
                    monitorFFmpegCompletion(ffmpegPid, mp4File, displayName, logFile);

                    resolve(mp4File);
                } else {
                    // Process might not have started or already finished
                    log('Warning: FFmpeg process not found in process list');

                    // Check if process failed immediately by looking at log
                    setTimeout(() => {
                        try {
                            const logContent = fs.readFileSync(logFile, 'utf8');
                            if (logContent.toLowerCase().includes('error')) {
                                log(`FFmpeg error detected:\n${logContent.slice(-500)}`);
                                reject(new Error(`FFmpeg failed to start. Check log: ${logFile}`));
                            } else {
                                // Process might have started and finished very quickly (unlikely for video)
                                log('FFmpeg process completed or log is empty');
                                resolve(mp4File);
                            }
                        } catch (readErr) {
                            log('Could not read ffmpeg log file');
                            resolve(mp4File); // Resolve anyway, monitor will catch failures
                        }
                    }, 500);
                }
            } catch (err) {
                log(`Error finding ffmpeg process: ${err.message}`);
                // Still resolve - the file monitoring will detect if conversion failed
                resolve(mp4File);
            }
        }, 1000);
    });
}

/**
 * Eject disc
 */
async function ejectDisc() {
    try {
        log('Ejecting disc...');
        await execPromise(`eject ${config.diskDevice}`);
        log('✓ Disc ejected successfully');

        // Set flag to wait for disc removal before checking for new discs
        waitingForDiscRemoval = true;
        log('Waiting for disc to be removed before detecting new discs...');
    } catch (error) {
        log('✗ Error ejecting disc: ' + (error.stderr || error.message || error));
        log('Possible causes:');
        log('  - Disc drive is not accessible');
        log('  - No disc is in the drive');
        log('  - Drive is being used by another process');
        log(`  - Check device path: ${config.diskDevice}`);
        // Don't throw error - ejection failure shouldn't stop the process
    }
}

/**
 * Main ripping process
 */
async function ripDisc() {
    if (isRipping) {
        log('Already ripping a disc, skipping...');
        return;
    }

    try {
        isRipping = true;

        log('=== Starting disc ripping process ===');

        // Wait a bit for disc to be fully loaded
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get disc information
        const discInfo = await getDiscInfo();

        if (discInfo.titleCount === 0) {
            log('No valid titles found on disc (all titles are shorter than minimum length)');
            notify('No Valid Titles', 'Disc has no titles meeting minimum length requirement');
            if (config.autoEject) {
                await ejectDisc();
            }
            return;
        }

        const titlesToRip = Math.min(config.titlesToRip || 1, discInfo.titleCount);
        log(`Disc detected: ${discInfo.name} (${discInfo.titleCount} valid titles, ripping ${titlesToRip})`);

        notify('Disc Detected', `Retrieving: ${discInfo.name}`);
        sendNotification('info', 'Disc Detected', `Starting to rip "${discInfo.name}"`);

    // Rip to MKV
    const { mkvFiles, outputPath, createdSubfolder } = await ripToMKV(discInfo);
        log(`Created ${mkvFiles.length} MKV files`);

        // Eject disc immediately after MKV ripping (disc is no longer needed)
        // This allows the user to insert the next disc while MP4 conversion happens
        if (config.autoEject) {
            log('Ejecting disc (no longer needed for MP4 conversion)...');
            await ejectDisc();
        }

        // Create output folder (with optional subfolder)
        let finalOutputFolder = outputFolder;
        if (config.outputSubfolder && config.outputSubfolder.trim()) {
            finalOutputFolder = path.join(outputFolder, config.outputSubfolder.trim());
        }
        if (!fs.existsSync(finalOutputFolder)) {
            fs.mkdirSync(finalOutputFolder, { recursive: true });
            log(`Created output folder: ${finalOutputFolder}`);
        }

        // Notify that compression is starting
        sendNotification('info', 'Starting Compression', `Converting "${discInfo.name}" to MP4 format`);

        // Convert each MKV to MP4
        for (let i = 0; i < mkvFiles.length; i++) {
            const mkvFile = mkvFiles[i];
            const movieBase = humanizeName(discInfo.name);
            let outputFilename;
            let displayName;
            if (mkvFiles.length === 1) {
                outputFilename = `${movieBase}.mp4`;
                displayName = movieBase;
            } else {
                // If multiple titles, append the original mkv basename to keep uniqueness
                const titleBasename = path.basename(mkvFile, '.mkv');
                outputFilename = `${movieBase} - ${titleBasename}.mp4`;
                displayName = `${movieBase} - Part ${i + 1}`;
            }

            try {
                log(`Converting ${i + 1}/${mkvFiles.length}: ${path.basename(mkvFile)}`);
                await convertToMP4(mkvFile, finalOutputFolder, outputFilename, displayName);
                log(`✓ Successfully started conversion ${i + 1}/${mkvFiles.length} (running in background)`);
            } catch (conversionError) {
                log(`✗ Failed to start conversion ${path.basename(mkvFile)}: ${conversionError.message}`);
                sendNotification('error', 'Compression Failed', `Failed to start converting "${displayName}": ${conversionError.message}`);
                throw conversionError; // Re-throw to trigger main error handler
            }
        }

        // Handle MKV files based on config
        if (config.keepMKV) {
            log('Moving MKV files to output folder...');
            for (const mkvFile of mkvFiles) {
                const dest = path.join(finalOutputFolder, path.basename(mkvFile));
                fs.renameSync(mkvFile, dest);
            }
        } else {
            log('Deleting temporary MKV files...');
            for (const mkvFile of mkvFiles) {
                fs.unlinkSync(mkvFile);
            }
        }

        // Clean up temp folder (only remove per-disc subfolder, not the shared tempFolder)
        if (createdSubfolder && fs.existsSync(outputPath)) {
            fs.rmdirSync(outputPath, { recursive: true });
        }

        log(`=== Ripping and conversion started! ===`);
        log(`MKV files created, MP4 conversion running in background`);
        log(`Files will be saved to: ${finalOutputFolder}`);
        notify('Ripping Complete', `${discInfo.name} is being compressed to MP4`);
        sendNotification('info', 'Ripping Complete', `"${discInfo.name}" extracted. Compression running in background...`);

        // Fetch thumbnail for the newly ripped movie
        log('Fetching thumbnail for newly ripped movie...');
        try {
            const getThumbnails = require('./get_thumbnails.js');
            await getThumbnails.main();
        } catch (error) {
            log(`Error fetching thumbnails: ${error.message}`);
        }

        // Track this rip to avoid immediate re-rip
        lastRippedDisc = discInfo.name;
        lastRipTime = Date.now();
        log(`Cooldown started (${RIP_COOLDOWN_MS / 1000}s) to prevent re-ripping the same disc`);

    } catch (error) {
        log('Error during ripping process: ' + (error.message || error));
        log('Stack trace: ' + (error.stack || 'No stack trace available'));

        // Send detailed notification (compression errors already sent above, this catches others)
        // Check if error was already notified (compression errors send their own notification)
        const errorMsg = error.message || error.toString();
        if (!errorMsg.includes('FFmpeg') && !errorMsg.includes('convert')) {
            // This is likely a ripping error, not compression
            sendNotification('error', 'Ripping Failed', `Error during disc ripping: ${errorMsg}`);
        }

        notify('Ripping Failed', 'An error occurred during disc ripping');

        // Try to eject disc even on error (cleanup)
        if (config.autoEject) {
            try {
                log('Attempting to eject disc after error...');
                await ejectDisc();
            } catch (ejectError) {
                log(`Failed to eject disc after error: ${ejectError.message}`);
            }
        }
    } finally {
        isRipping = false;
    }
}

/**
 * Check for disc and start ripping if found
 *
 * This function implements smart disc detection:
 * - After ejecting a disc, waits for it to be physically removed before detecting new discs
 * - Only logs/acts when disc state changes (prevents spam in logs)
 * - Respects cooldown period to avoid re-ripping the same disc
 */
async function checkForDisc() {
    if (isRipping) {
        return;
    }

    try {
        const discPresent = await isDiscPresent();

        // If we're waiting for disc removal, check if disc has been removed
        if (waitingForDiscRemoval) {
            if (!discPresent && lastDiscPresent) {
                log('✓ Disc removed, ready to detect new discs');
                waitingForDiscRemoval = false;
                lastRippedDisc = null;
            } else if (discPresent) {
                // Disc still present, keep waiting silently (no log spam)
                lastDiscPresent = discPresent;
                return;
            }
        }

        // Update disc presence state
        const discStateChanged = discPresent !== lastDiscPresent;
        lastDiscPresent = discPresent;

        // Skip detection during cooldown period after a successful rip
        if (lastRippedDisc && Date.now() - lastRipTime < RIP_COOLDOWN_MS) {
            const timeLeft = Math.ceil((RIP_COOLDOWN_MS - (Date.now() - lastRipTime)) / 1000);
            if (discStateChanged && discPresent) {
                log(`Disc detected but still in cooldown for "${lastRippedDisc}" (${timeLeft}s remaining)`);
            }
            return;
        }

        // Clear cooldown state if cooldown has expired
        if (lastRippedDisc && Date.now() - lastRipTime >= RIP_COOLDOWN_MS) {
            log(`Cooldown expired for "${lastRippedDisc}"; resuming detection`);
            lastRippedDisc = null;
        }

        // Only log and rip when a disc is newly detected (state change)
        if (discPresent && discStateChanged) {
            log('Disc detected in drive!');
            await ripDisc();
        }
    } catch (error) {
        // Silently handle errors during checking
    }
}

/**
 * Scan temp folder for orphaned MKV files and convert them to MP4
 * This handles cases where conversion may have failed or was interrupted
 */
async function processOrphanedMkvFiles() {
    try {
        log('Checking for orphaned MKV files in temp folder...');

        // Function to recursively find all MKV files in a directory
        function findMkvFiles(dir, fileList = []) {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    findMkvFiles(filePath, fileList);
                } else if (file.endsWith('.mkv')) {
                    fileList.push(filePath);
                }
            });
            return fileList;
        }

        // Find all MKV files in temp folder and subfolders
        const mkvFiles = findMkvFiles(config.tempFolder);

        if (mkvFiles.length === 0) {
            log('No orphaned MKV files found');
            return;
        }

        log(`Found ${mkvFiles.length} orphaned MKV file(s):`);
        mkvFiles.forEach(file => log(`  - ${file}`));

        // Determine output folder
        let finalOutputFolder = outputFolder;
        if (config.outputSubfolder && config.outputSubfolder.trim()) {
            finalOutputFolder = path.join(outputFolder, config.outputSubfolder.trim());
        }
        if (!fs.existsSync(finalOutputFolder)) {
            fs.mkdirSync(finalOutputFolder, { recursive: true });
            log(`Created output folder: ${finalOutputFolder}`);
        }

        // Process each MKV file
        for (let i = 0; i < mkvFiles.length; i++) {
            const mkvFile = mkvFiles[i];
            const basename = path.basename(mkvFile, '.mkv');

            // Try to extract a human-readable name from the filename or parent folder
            const parentFolder = path.basename(path.dirname(mkvFile));
            let movieName = parentFolder;

            // If the parent folder is just the temp folder, use the basename
            if (parentFolder === path.basename(config.tempFolder)) {
                movieName = basename;
            }

            // Humanize the name
            const displayName = humanizeName(movieName);
            const outputFilename = `${displayName}.mp4`;

            // Check if MP4 already exists in output folder
            const mp4Path = path.join(finalOutputFolder, outputFilename);
            if (fs.existsSync(mp4Path)) {
                log(`Skipping ${basename}.mkv - MP4 already exists at ${mp4Path}`);
                continue;
            }

            try {
                log(`Converting orphaned MKV ${i + 1}/${mkvFiles.length}: ${basename}.mkv`);
                sendNotification('info', 'Recovering Orphaned File', `Converting "${displayName}" to MP4`);
                await convertToMP4(mkvFile, finalOutputFolder, outputFilename, displayName);
                log(`✓ Successfully started conversion for orphaned MKV (running in background)`);
            } catch (conversionError) {
                log(`✗ Failed to convert orphaned MKV ${basename}.mkv: ${conversionError.message}`);
                sendNotification('error', 'Recovery Failed', `Failed to convert orphaned MKV "${displayName}"`);
            }
        }

        log('Orphaned MKV processing complete');
    } catch (error) {
        log(`Error processing orphaned MKV files: ${error.message}`);
    }
}

/**
 * Main entry point
 */
async function main() {
    log('=== CD/DVD Auto-Ripper Started ===');

    // Log process information
    log(`Process UID: ${process.getuid()}, GID: ${process.getgid()}`);
    log(`Environment: USER=${process.env.USER}, HOME=${process.env.HOME}`);
    log(`SUDO_UID=${process.env.SUDO_UID || 'not set'}, SUDO_GID=${process.env.SUDO_GID || 'not set'}`);

    // Expand and resolve paths
    const tempFolder = path.resolve(expandPath(config.tempFolder));
    const resolvedOutputFolder = path.resolve(expandPath(outputFolder));

    // Warn if tilde was detected in original config
    if (config.tempFolder.includes('~')) {
        log(`Warning: tempFolder in config contains '~' - expanded from '${config.tempFolder}' to '${tempFolder}'`);
    }
    if (outputFolder.includes('~')) {
        log(`Warning: videoDirectory in config contains '~' - expanded from '${outputFolder}' to '${resolvedOutputFolder}'`);
    }

    // Update config with resolved paths
    config.tempFolder = tempFolder;
    outputFolder = resolvedOutputFolder;

    log(`Monitoring device: ${config.diskDevice}`);
    log(`Output folder: ${outputFolder}`);
    log(`Temp folder: ${config.tempFolder}`);

    // Create directories if they don't exist
    if (!fs.existsSync(config.tempFolder)) {
        log(`Creating temp folder: ${config.tempFolder}`);
        fs.mkdirSync(config.tempFolder, { recursive: true });
    }
    if (!fs.existsSync(outputFolder)) {
        log(`Creating output folder: ${outputFolder}`);
        fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Test writability on startup
    log('Testing directory permissions...');
    const tempWritable = await testDirectoryWritable(config.tempFolder);
    const outputWritable = await testDirectoryWritable(outputFolder);

    if (!tempWritable) {
        log(`ERROR: Temp folder ${config.tempFolder} is not writable!`);
        log(`Current permissions: ${JSON.stringify(fs.statSync(config.tempFolder))}`);
        log('Please check directory permissions and ensure the service has write access.');
        process.exit(1);
    }
    if (!outputWritable) {
        log(`ERROR: Output folder ${outputFolder} is not writable!`);
        log(`Current permissions: ${JSON.stringify(fs.statSync(outputFolder))}`);
        log('Please check directory permissions and ensure the service has write access.');
        process.exit(1);
    }

    log('✓ Temp folder is writable');
    log('✓ Output folder is writable');

    // Check for and process any orphaned MKV files on startup
    await processOrphanedMkvFiles();

    log(`Waiting for disc insertion (checking every ${CHECK_INTERVAL_MS / 1000} seconds)...`);

    // Check immediately on startup
    await checkForDisc();

    // Then check periodically (every 60 seconds instead of 5 seconds)
    checkInterval = setInterval(checkForDisc, CHECK_INTERVAL_MS);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        log('Shutting down...');
        if (checkInterval) {
            clearInterval(checkInterval);
        }
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('Shutting down...');
        if (checkInterval) {
            clearInterval(checkInterval);
        }
        process.exit(0);
    });
}

// Start the application
main().catch(error => {
    log('Fatal error: ' + error.message);
    process.exit(1);
});
