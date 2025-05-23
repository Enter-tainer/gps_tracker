#include "littlefs_handler.h"
#include "Adafruit_LittleFS.h"
#include "InternalFileSystem.h" // Make sure this is the correct header for InternalFS
#include "config.h"             // Include for MAX_GPX_FILES
#include "gpx_logger.h"
#include "logger.h" // <--- Add Logger header
#include <Arduino.h>
#include <TimeLib.h> // Include for time functions (year, month, day)
#include <algorithm> // For std::sort
#include <cstdio>    // For sprintf
#include <string>    // Using std::string for sorting
#include <vector>    // Using vector for easier list management

using namespace Adafruit_LittleFS_Namespace;

// Global variables to keep track of the current file
static File currentGpxFile(InternalFS); // Declaration might be okay if
                                        // assignment handles state
static String currentFilename = "";
static uint32_t currentFileDate = 0; // Store date as YYYYMMDD for comparison
static bool isFileOpen =
    false; // Flag to track if currentGpxFile holds a valid open file

static GpsDataEncoder gpsDataEncoder(64);

// Helper function to manage old log files - keeps total file size below
// MAX_FILE_SIZE
void manageOldFiles() {
  std::vector<String> gpxFiles;
  File root = InternalFS.open("/");
  if (!root) {
    Log.println("Failed to open root directory for cleanup");
    return;
  }
  if (!root.isDirectory()) {
    Log.println("Root is not a directory");
    root.close();
    return;
  }

  File file = root.openNextFile();
  while (file) {
    Log.printf("Found file: %s\n", file.name());
    if (!file.isDirectory()) {
      // Check if the filename matches the pattern YYYYMMDD.gpx
      String name = file.name();
      if (name.endsWith(".gpx")) {
        gpxFiles.push_back(name);
      }
    }
    file.close(); // Close the file handle
    file = root.openNextFile();
  }
  root.close(); // Close the root directory handle

  // Sort files alphabetically (which is chronologically for YYYYMMDD format)
  std::sort(gpxFiles.begin(), gpxFiles.end());

  // Calculate total file size
  uint32_t totalFileSize = 0;
  std::vector<std::pair<String, uint32_t>> fileDetails;

  for (const auto &filename : gpxFiles) {
    File file = InternalFS.open(filename.c_str(), FILE_O_READ);
    if (file) {
      uint32_t fileSize = file.size();
      totalFileSize += fileSize;
      fileDetails.push_back(std::make_pair(filename, fileSize));
      file.close();
    }
  }

  // Check if we need to delete files
  Log.printf("Total GPX file size: %lu bytes, MAX_FILE_SIZE: %lu bytes\n",
             totalFileSize, (uint32_t)MAX_FILE_SIZE);

  if (totalFileSize > MAX_FILE_SIZE) {
    // Delete oldest files until we get below the limit
    for (size_t i = 0; i < fileDetails.size(); ++i) {
      Log.printf("Deleting old log file: %s (%lu bytes)\n",
                 fileDetails[i].first.c_str(), fileDetails[i].second);

      if (!InternalFS.remove(fileDetails[i].first.c_str())) {
        Log.printf("Failed to delete %s\n", fileDetails[i].first.c_str());
        // Continue trying to delete others even if one fails
      } else {
        totalFileSize -= fileDetails[i].second;
        Log.printf("Remaining file size: %lu bytes\n", totalFileSize);

        // Check if we're below the threshold now
        if (totalFileSize <= MAX_FILE_SIZE) {
          Log.println("Successfully cleaned up to target size");
          break;
        }
      }
    }
  }
}

// Function to check if the date has changed and rotate log file if needed
// Also handles opening the file initially or after an error
bool RotateLogFileIfNeeded(uint32_t timestamp) {
  // Extract date components from the timestamp
  int y = year(timestamp);
  int m = month(timestamp);
  int d = day(timestamp);

  // Create the date integer YYYYMMDD for comparison
  uint32_t newDate = y * 10000 + m * 100 + d;

  // Check if the date has changed or if no file is currently open
  if (newDate != currentFileDate || !isFileOpen) {
    if (isFileOpen) {
      currentGpxFile.close(); // Close the previous day's file
      isFileOpen = false;     // Mark as closed
      Log.printf("Closed log file: %s\n", currentFilename.c_str());
    }

    // Format the new filename: /YYYYMMDD.gpx
    char filenameBuffer[14]; // "/YYYYMMDD.gpx" + null terminator
    sprintf(filenameBuffer, "/%04d%02d%02d.gpx", y, m, d);
    currentFilename = String(filenameBuffer);
    currentFileDate = newDate; // Update the current date

    Log.printf("Switching to log file: %s\n", currentFilename.c_str());

    // Manage old files before opening the new one
    manageOldFiles();

    // Open the new file in write mode (append/create)
    File openedFile = InternalFS.open(currentFilename.c_str(), FILE_O_WRITE);

    if (!openedFile) { // Check if the open operation failed
      Log.printf("Failed to open log file: %s\n", currentFilename.c_str());
      currentFilename = ""; // Reset filename if open failed
      currentFileDate = 0;  // Reset date
      isFileOpen = false;   // Ensure marked as not open
      return false;         // Indicate failure
    } else {
      // Open succeeded, assign the valid file handle
      currentGpxFile = openedFile; // Assign the returned File object
      isFileOpen = true;           // Mark as open
      gpsDataEncoder.clear();
      Log.printf("Successfully opened log file: %s\n", currentFilename.c_str());
    }
  }

  // Return true if the file is marked as open
  return isFileOpen;
}

// Initialize Internal Flash File System
bool initInternalFlash() {
  Log.println("Initializing Internal Flash Filesystem...");
  // Wait for Filesystem to setup
  // Note: begin() might format if it's the first time or corrupted.
  if (!InternalFS.begin()) {
    Log.println("Failed to mount internal filesystem!");
    Log.println("Try formatting the filesystem?");
    // Optionally add formatting code here if needed, e.g.:
    InternalFS.format();
    Log.println("Filesystem formatted.");
    return false;
  }
  Log.println("Internal Filesystem mounted successfully.");
  // Perform initial cleanup check in case the device restarted mid-day
  manageOldFiles();

  // Reset state on initialization
  currentFilename = "";
  currentFileDate = 0;
  isFileOpen = false; // Ensure file is marked as not open initially

  return true;
}

// Write GPS log data to the current daily file
bool writeGpsLogData(const GpxPointInternal &entry) {
  // Ensure the correct file is open for the entry's timestamp
  if (!RotateLogFileIfNeeded(entry.timestamp)) {
    Log.println("Cannot write GPS data: Log file not ready.");
    return false;
  }
  auto len = gpsDataEncoder.encode(entry);

  // Write the binary data
  size_t bytesWritten = currentGpxFile.write(gpsDataEncoder.getBuffer(), len);

  if (bytesWritten != len) {
    Log.printf("Failed to write GPS data to %s. Expected %d, wrote %d\n",
               currentFilename.c_str(),
               (int)len,           // Cast size_t to int
               (int)bytesWritten); // Cast size_t to int
    // Attempt to close and mark as not open on error
    currentGpxFile.close();
    isFileOpen = false;   // Mark as closed due to error
    currentFilename = ""; // Force file rotation check on next call
    currentFileDate = 0;
    return false;
  }

  // Optional: Flush data to ensure it's written physically,
  // but this can impact performance and wear leveling.
  currentGpxFile.flush();

  return true;
}

// Recursive helper function to list directory contents
void listDirectoryRecursive(File dir, int indentLevel) {
  while (true) {
    File entry = dir.openNextFile();
    if (!entry) {
      // No more entries in this directory
      break;
    }

    // Print indentation
    for (int i = 0; i < indentLevel; i++) {
      Log.print("  ");
    }

    if (entry.isDirectory()) {
      Log.print("DIR : ");
      Log.println(entry.name());
      // Recursively list the subdirectory contents
      // Note: entry.name() might return just the name, not the full path.
      // Construct the full path if necessary for InternalFS.open()
      // For simplicity here, assuming InternalFS handles relative paths or
      // entry.name() gives enough context. If not, path concatenation is
      // needed. String subDirPath = String(dir.name()) + "/" + entry.name(); //
      // Example path concat File subDir = InternalFS.open(subDirPath);
      // if(subDir) { listDirectoryRecursive(subDir, indentLevel + 1);
      // subDir.close(); }

      // Simpler approach if openNextFile handles traversal correctly within the
      // dir handle:
      listDirectoryRecursive(entry, indentLevel + 1);
    } else {
      // Print file name and size
      Log.print("FILE: ");
      Log.print(entry.name());
      Log.print("\tSIZE: ");
      char sizeBuf[12];
      sprintf(sizeBuf, "%lu", entry.size()); // Use %lu for unsigned long
      Log.println(sizeBuf);
    }
    entry.close(); // Close the entry handle
  }
}

// Modified function to start the recursive listing
void listInternalFlashContents() {
  Log.println("--- Listing Internal Flash Contents (Recursive) ---");
  File root = InternalFS.open("/");
  if (!root) {
    Log.println("Failed to open root directory.");
    return;
  }
  if (!root.isDirectory()) {
    Log.println("Root is not a directory.");
    root.close();
    return;
  }

  Log.println("DIR : /"); // Print root directory
  listDirectoryRecursive(root,
                         1); // Start recursion from root with indent level 1

  root.close();
  Log.println("--------------------------------------------------");
}
