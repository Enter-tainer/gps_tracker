#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Post-build script to generate UF2 file from hex/bin file
Compatible with nRF52840 and other microcontrollers that support UF2 bootloader
"""

import os
import sys
import subprocess
from os.path import join, isfile, exists, dirname, basename, splitext
import urllib.request
import stat

Import("env")


def download_uf2conv():
    """Download uf2conv.py if it doesn't exist"""
    uf2conv_path = join(env.get("PROJECT_DIR"), "uf2conv.py")

    if not isfile(uf2conv_path):
        print("Downloading uf2conv.py...")
        try:
            url = "https://raw.githubusercontent.com/microsoft/uf2/master/utils/uf2conv.py"
            urllib.request.urlretrieve(url, uf2conv_path)

            # Make it executable on Unix-like systems
            if os.name != "nt":
                st = os.stat(uf2conv_path)
                os.chmod(uf2conv_path, st.st_mode | stat.S_IEXEC)

            print(f"Downloaded uf2conv.py to {uf2conv_path}")
        except Exception as e:
            print(f"Error downloading uf2conv.py: {e}")
            return None

    return uf2conv_path


def generate_uf2_file(source, target, env):
    """Generate UF2 file from the built firmware"""

    # Get the built firmware file path
    firmware_path = str(target[0])
    firmware_dir = dirname(firmware_path)
    firmware_name = splitext(basename(firmware_path))[0]

    # Look for hex file first, then bin file
    hex_file = join(firmware_dir, firmware_name + ".hex")
    bin_file = join(firmware_dir, firmware_name + ".bin")

    input_file = None
    if isfile(hex_file):
        input_file = hex_file
        input_format = "hex"
    elif isfile(bin_file):
        input_file = bin_file
        input_format = "bin"
    else:
        print("Error: No hex or bin file found for UF2 conversion")
        return

    # Download uf2conv.py if needed
    uf2conv_path = download_uf2conv()
    if not uf2conv_path:
        print("Error: Could not obtain uf2conv.py")
        return

    # Output UF2 file path
    uf2_file = join(firmware_dir, firmware_name + ".uf2")

    # nRF52840 family ID for UF2
    # See: https://github.com/microsoft/uf2/blob/master/utils/uf2families.json
    family_id = "0xADA52840"  # nRF52840

    try:
        # Build the command
        cmd = [
            sys.executable,
            uf2conv_path,
            input_file,
            "--convert",
            "--family",
            family_id,
            "--output",
            uf2_file,
        ]

        # For bin files, we need to specify the base address
        if input_format == "bin":
            # nRF52840 application base address (after SoftDevice)
            base_addr = "0x26000"  # Typical for S140 SoftDevice
            cmd.extend(["--base", base_addr])

        print(f"Generating UF2 file: {uf2_file}")
        print(f"Command: {' '.join(cmd)}")

        # Execute the conversion
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode == 0:
            if isfile(uf2_file):
                file_size = os.path.getsize(uf2_file)
                print(
                    f"✓ UF2 file generated successfully: {uf2_file} ({file_size} bytes)"
                )

                # Copy to project root for easy access
                project_uf2 = join(env.get("PROJECT_DIR"), firmware_name + ".uf2")
                try:
                    import shutil

                    shutil.copy2(uf2_file, project_uf2)
                    print(f"✓ UF2 file copied to project root: {project_uf2}")
                except Exception as e:
                    print(f"Warning: Could not copy UF2 to project root: {e}")
            else:
                print("Error: UF2 file was not created")
        else:
            print(f"Error running uf2conv.py: {result.stderr}")
            print(f"stdout: {result.stdout}")

    except Exception as e:
        print(f"Error generating UF2 file: {e}")


# Register the post-build action for multiple targets
env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", generate_uf2_file)
env.AddPostAction("$BUILD_DIR/${PROGNAME}.hex", generate_uf2_file)

print("UF2 generation script loaded. UF2 file will be created after successful build.")
