import os
from os.path import (
    join,
    isfile,
    exists,
)  # Consolidated os.path imports, removed dirname
import shutil  # Added for backup/restore operations

Import("env")

# include toolchain paths
env.Replace(COMPILATIONDB_INCLUDE_TOOLCHAIN=True)

# override compilation DB path
# MODIFIED: Use 'join' directly from os.path import
env.Replace(COMPILATIONDB_PATH=join("$BUILD_DIR", "compile_commands.json"))

# Name of the framework package being patched
FRAMEWORK_PKG_NAME = "framework-arduinoadafruitnrf52"  # 确保这是您使用的正确框架包名
FRAMEWORK_DIR = env.PioPlatform().get_package_dir(FRAMEWORK_PKG_NAME)
if not FRAMEWORK_DIR or not isfile(
    join(FRAMEWORK_DIR, "programmers.txt")
):  # 检查框架目录是否有效
    print(
        f"Error: Framework directory for {FRAMEWORK_PKG_NAME} not found or seems invalid at '{FRAMEWORK_DIR}'."
    )
    print(
        "Please ensure the framework name in the script matches your PlatformIO setup."
    )
    Exit(1)

# 补丁标志文件的路径。将其放置在当前环境的构建目录中。
patchflag_dir = join(env.get("PROJECT_BUILD_DIR"), env.get("PIOENV"))
if not exists(patchflag_dir):
    try:
        os.makedirs(patchflag_dir)
    except OSError as e:
        print(f"Error creating patchflag directory {patchflag_dir}: {e}")
        Exit(1)

# 补丁标志文件的唯一名称，特定于正在修补的框架。
patchflag_filename = f".{FRAMEWORK_PKG_NAME}.patching-done"
patchflag_path = join(patchflag_dir, patchflag_filename)

# 列表中的每个项目都是一个元组：(框架内文件的相对路径, 项目patches目录中的补丁文件名)
patches_to_apply = [
    (
        join(
            "cores", "nRF5", "linker", "nrf52840_s140_v6.ld"
        ),  # Relative path to the linker script
        "nrf52840_s140_v6.ld.patch",  # Your .patch file
    ),
    (
        join(
            "libraries", "InternalFileSytem", "src", "InternalFileSystem.cpp"
        ),  # Relative path to the C++ file
        "InternalFileSystem.cpp.patch",  # Your .patch file
    ),
]

# MODIFIED: Logic for applying patches with backup and rollback
if not isfile(patchflag_path):
    print(
        f"Framework {FRAMEWORK_PKG_NAME} patching needed. Flag not found: {patchflag_path}"
    )

    if not patches_to_apply:
        print(
            "No patches defined in patches_to_apply list. Nothing to do. Patch flag not created."
        )
    else:
        backup_files_map = {}  # Stores original_path: backup_path
        backup_creation_successful = True

        # --- Backup Phase ---
        print("Starting backup phase...")
        for relative_path_to_target, patch_file_name in patches_to_apply:
            original_file_path = join(FRAMEWORK_DIR, relative_path_to_target)
            # Check existence of patch file itself early on
            patch_file_path_check = join(
                env.get("PROJECT_DIR"), "patches", patch_file_name
            )

            if not isfile(original_file_path):
                print(
                    f"Error: Original file for patching not found (cannot backup): {original_file_path}"
                )
                backup_creation_successful = False
                break

            if not isfile(patch_file_path_check):
                print(f"Error: Patch file not found: {patch_file_path_check}")
                backup_creation_successful = False
                break

            backup_file_path = original_file_path + ".bak"
            try:
                # If a backup file from a previous failed run exists, remove it first.
                if isfile(backup_file_path):
                    print(
                        f"Warning: Pre-existing backup file found: {backup_file_path}. Removing it before creating a new one."
                    )
                    os.remove(backup_file_path)
                shutil.copy2(original_file_path, backup_file_path)
                backup_files_map[original_file_path] = backup_file_path
                print(f"Backed up: {original_file_path} to {backup_file_path}")
            except Exception as e:
                print(f"Error backing up {original_file_path}: {e}")
                backup_creation_successful = False
                break

        if not backup_creation_successful:
            print("Backup phase failed. Cleaning up any created backups...")
            # Iterate over items in backup_files_map as those are the ones attempted/created
            for _orig_path, bk_path in backup_files_map.items():
                if isfile(
                    bk_path
                ):  # Check if backup was actually created before trying to remove
                    try:
                        os.remove(bk_path)
                        print(f"Removed incomplete backup: {bk_path}")
                    except Exception as e_rem:
                        print(f"Error removing incomplete backup {bk_path}: {e_rem}")
            print("Patching aborted due to backup failure.")
            Exit(1)

        # --- Patching Phase (only if all backups were successful) ---
        all_patches_applied_successfully = True  # Assume success for this phase
        print("Starting patching phase...")
        for relative_path_to_target, patch_file_name in patches_to_apply:
            original_file_path = join(FRAMEWORK_DIR, relative_path_to_target)
            patch_file_path = join(env.get("PROJECT_DIR"), "patches", patch_file_name)

            # Original file and patch file existence already checked in backup phase.
            print(f"Attempting to patch: {original_file_path}")
            print(f"Using patch file: {patch_file_path}")
            cmd = f'patch "{original_file_path}" "{patch_file_path}"'

            try:
                return_code = env.Execute(cmd)
                if return_code == 0:
                    print(f"Successfully patched: {original_file_path}")
                else:
                    print(
                        f"Error patching {original_file_path}. 'patch' command returned {return_code}."
                    )
                    print(
                        "Make sure the patch file format is compatible and the 'patch' command is installed and in PATH."
                    )
                    all_patches_applied_successfully = False
                    break  # Stop on first error
            except Exception as e:
                print(f"Exception during patching of {original_file_path}: {e}")
                print(
                    "Ensure the 'patch' command is installed and in your system PATH."
                )
                all_patches_applied_successfully = False
                break  # Stop on first error

        # --- Post-Patching / Rollback / Finalize Phase ---
        if all_patches_applied_successfully:
            print("All defined patches applied successfully.")
            # Clean up backups by removing them
            print("Cleaning up backup files...")
            for _orig_path, bk_path in backup_files_map.items():
                if isfile(bk_path):
                    try:
                        os.remove(bk_path)
                        print(f"Removed backup: {bk_path}")
                    except Exception as e:
                        # Log error but consider this non-critical for build success at this point
                        print(f"Error removing backup file {bk_path}: {e}")

            # Create patch flag
            print(f"Creating patch flag: {patchflag_path}")
            try:
                with open(patchflag_path, "w") as fp:
                    for rel_path, patch_name in patches_to_apply:
                        fp.write(f"- {rel_path} with {patch_name}\n")
                print(
                    "Patch flag created successfully."
                )  # MODIFIED: Removed unnecessary f-string
            except IOError as e:
                print(f"Error creating patch flag file {patchflag_path}: {e}")
                # Patches were applied, but flag creation failed.
                # This is an inconsistent state. Build should ideally fail.
                Exit(1)
        else:
            # Rollback from backups
            print("One or more patches failed. Initiating rollback...")
            for original_path, backup_path_to_restore in backup_files_map.items():
                # Only attempt to restore if the backup file actually exists
                if isfile(backup_path_to_restore):
                    try:
                        shutil.move(
                            backup_path_to_restore, original_path
                        )  # Moves backup over original
                        print(
                            f"Restored: {original_path} from {backup_path_to_restore}"
                        )
                    except Exception as e:
                        print(
                            f"CRITICAL: Error restoring {original_path} from {backup_path_to_restore}: {e}"
                        )
                        # At this point, state of original_file_path is uncertain.
                else:
                    # This case implies the backup file was not found for restoration.
                    # If backup_files_map is correctly populated, this shouldn't happen unless
                    # the backup file was deleted by an external process or an earlier error in cleanup logic.
                    print(
                        f"Warning: Backup file {backup_path_to_restore} not found during rollback for {original_path}. The original file might be in a modified state if patching started on it."
                    )

            print(
                "Rollback attempted. Patch flag will NOT be created. Please check errors above."
            )
            Exit(1)  # Signal failure
else:
    print(
        f"Framework {FRAMEWORK_PKG_NAME} already patched for this environment (flag found: {patchflag_path}). Skipping."
    )

# 提示：要强制重新打补丁，请从项目的 .pio/build/<envname>/ 目录中删除相应的 .patching-done 文件
# 例如，在命令行中运行: del .pio\\build\\promicro_nrf52840\\.framework-arduinoadafruitnrf52.patching-done (Windows)
# 或者运行 'pio run -t clean' (如果 clean 会删除构建目录，通常是这样)
