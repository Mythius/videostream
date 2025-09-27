#!/usr/bin/env python3
"""
roku_sideload.py

Upload (sideload) a Roku channel ZIP to a Roku device.

Usage:
    python3 roku_sideload.py <ROKU_IP> <PATH_TO_ZIP> [--username USER] [--password PASS] [--port PORT]

Examples:
    python3 roku_sideload.py 192.168.1.50 ./my_channel.zip --username rokudev --password hunter2
"""

import argparse
import os
import sys
import time
from requests import Session, RequestException
from requests.auth import HTTPBasicAuth

DEFAULT_PORT = 8060
TIMEOUT = 10  # seconds for HTTP requests

def build_args():
    p = argparse.ArgumentParser(description="Sideload a Roku channel ZIP to a Roku device.")
    p.add_argument("ip", help="Roku device IP address")
    p.add_argument("zipfile", help="Path to the channel zip file")
    p.add_argument("--username", "-u", default=None, help="Developer username (if required). Commonly 'rokudev'")
    p.add_argument("--password", "-p", default=None, help="Developer password (set when enabling dev mode)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Roku ECP port (default {DEFAULT_PORT})")
    p.add_argument("--wait", type=int, default=20, help="Seconds to wait/poll after upload for install (default 20s)")
    return p.parse_args()

def check_file(path):
    if not os.path.isfile(path):
        print(f"Error: zip file not found: {path}", file=sys.stderr)
        sys.exit(2)
    if not path.lower().endswith('.zip'):
        print("Warning: file does not end with .zip — ensure this is a Roku channel package zip.", file=sys.stderr)

def make_base_url(ip, port):
    return f"http://{ip}:{port}"

def simple_get(session, url, auth=None):
    try:
        r = session.get(url, timeout=TIMEOUT, auth=auth)
        return r
    except RequestException as e:
        print(f"Network error while contacting {url}: {e}", file=sys.stderr)
        return None

def upload_package(session, base_url, zip_path, auth=None):
    upload_url = f"{base_url}/plugin_install"
    # The form field name for the uploaded archive is 'archive'
    # Also include a submit field to mimic the web UI
    files = {
        'archive': (os.path.basename(zip_path), open(zip_path, 'rb'), 'application/zip')
    }
    data = {
        'mysubmit': 'Install'  # Field observed in Roku web form
    }
    headers = {
        # Let requests set Content-Type multipart/form-data with boundary
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }

    try:
        print(f"Uploading {zip_path} to {upload_url} ...")
        r = session.post(upload_url, files=files, data=data, headers=headers, timeout=120, auth=auth)
        return r
    except RequestException as e:
        print(f"Upload failed: {e}", file=sys.stderr)
        return None
    finally:
        try:
            files['archive'][1].close()
        except Exception:
            pass

def poll_install(session, base_url, timeout_sec=20, auth=None):
    # Poll /query/apps to see that the device responds and possibly reflect changes.
    # We can't always know the new app id; poll to ensure device is healthy / done processing.
    end_time = time.time() + timeout_sec
    last_status = None
    query_url = f"{base_url}/query/apps"
    while time.time() < end_time:
        r = simple_get(session, query_url, auth=auth)
        if r is None:
            time.sleep(1)
            continue
        if r.status_code == 200:
            # we received apps list (XML)
            if last_status != r.text:
                last_status = r.text
            # Return success because device is reachable and responded
            return True, r.text
        elif r.status_code == 401:
            return False, "Unauthorized (401) when querying apps - incorrect dev credentials?"
        else:
            # keep trying
            time.sleep(1)
    return False, "Timed out while waiting for Roku to respond after upload."

def power_on_tv(session, base_url, auth=None):
    """Sends a Home keypress to Roku, which turns on the TV if HDMI-CEC is enabled."""
    url = f"{base_url}/keypress/Home"
    try:
        r = session.post(url, auth=auth, timeout=5)
        if r.status_code == 200:
            print("Sent 'Home' keypress to Roku to wake TV.")
        else:
            print(f"Warning: Unexpected response from Roku when trying to wake TV: HTTP {r.status_code}")
    except requests.RequestException as e:
        print(f"Warning: Failed to send 'Home' keypress to Roku: {e}")

def main():
    args = build_args()
    check_file(args.zipfile)

    base_url = make_base_url(args.ip, args.port)
    session = Session()
    auth = None
    if args.username is not None or args.password is not None:
        # If either provided, build basic auth (Roku dev expects basic auth for plugin_install)
        auth = HTTPBasicAuth(args.username or 'rokudev', args.password or '')
    
    power_on_tv(session, base_url, auth=auth)

    # Quick check device reachable (device-info)
    di_url = f"{base_url}/query/device-info"
    print(f"Checking Roku device at {di_url} ...")
    r = simple_get(session, di_url, auth=auth)
    if r is None:
        print("Failed to contact Roku device. Make sure IP/port are correct and device is on the network.", file=sys.stderr)
        sys.exit(3)

    if r.status_code == 200:
        print("Device responded. Proceeding to upload.")
    elif r.status_code == 401:
        print("Device responded with 401 Unauthorized. Developer password required for sideloading.")
        if auth is None:
            print("You didn't provide credentials. Re-run with --username and --password.", file=sys.stderr)
            sys.exit(4)
    else:
        print(f"Device responded with HTTP {r.status_code}. Continuing but upload may fail.")

    # Upload
    resp = upload_package(session, base_url, args.zipfile, auth=auth)
    if resp is None:
        print("Upload did not complete.", file=sys.stderr)
        sys.exit(5)

    # Common status codes:
    # - 200 typically returns an HTML page with install progress/state.
    # - 401 indicates authentication required.
    if resp.status_code == 401:
        print("Upload returned 401 Unauthorized. Check dev username/password.", file=sys.stderr)
        sys.exit(6)

    # Print a short summary from Roku response (HTML or text)
    print(f"Upload finished with HTTP {resp.status_code}. Roku response snippet:")
    snippet = resp.text[:1000].replace('\n', ' ')
    print(snippet)

    # Polling to let Roku finish install and to verify device is alive
    print(f"Waiting up to {args.wait} seconds for Roku to process the install and become responsive...")
    ok, info = poll_install(session, base_url, timeout_sec=args.wait, auth=auth)
    if ok:
        print("Roku is responsive after upload. Installation may have completed or is in progress.")
        # If we have /query/apps XML, print it optionally
        if isinstance(info, str) and info.strip().startswith('<'):
            print("Current installed apps (XML snippet):")
            print(info[:1000])
    else:
        print(f"Post-upload check failed: {info}", file=sys.stderr)
        sys.exit(7)

    print("Done. If the channel didn't appear on the Roku, open the device UI and check the home screen and the channel list.")
    print("If you enabled dev mode, you can also open the Roku web interface at:"
          f" http://{args.ip}:{args.port}/ to confirm or see developer console output.")

if __name__ == "__main__":
    main()
