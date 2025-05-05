#include "littlefs_handler.h"
#include "Adafruit_LittleFS.h"
#include "InternalFileSystem.h" // Make sure this is the correct header for InternalFS
#include "config.h"             // Include for MAX_GPX_FILES
#include "gpx_logger.h"
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

// Helper function to manage old log files
void manageOldFiles() {
  std::vector<std::string> gpxFiles;
  File root = InternalFS.open("/");
  if (!root) {
    Serial.println("Failed to open root directory for cleanup");
    return;
  }
  if (!root.isDirectory()) {
    Serial.println("Root is not a directory");
    root.close();
    return;
  }

  File file = root.openNextFile();
  while (file) {
    if (!file.isDirectory()) {
      // Check if the filename matches the pattern YYYYMMDD.gpx
      const char *name = file.name();
      if (strlen(name) == 12 && // Length of "/YYYYMMDD.gpx"
          isdigit(name[1]) && isdigit(name[2]) && isdigit(name[3]) &&
          isdigit(name[4]) &&                     // Year
          isdigit(name[5]) && isdigit(name[6]) && // Month
          isdigit(name[7]) && isdigit(name[8]) && // Day
          strcmp(name + 9, ".gpx") == 0) {
        gpxFiles.push_back(name);
      }
    }
    file.close(); // Close the file handle
    file = root.openNextFile();
  }
  root.close(); // Close the root directory handle

  if (gpxFiles.size() > MAX_GPX_FILES) {
    // Sort files alphabetically (which is chronologically for YYYYMMDD format)
    std::sort(gpxFiles.begin(), gpxFiles.end());

    // Calculate how many files to delete
    int filesToDelete = gpxFiles.size() - MAX_GPX_FILES;
    Serial.printf("Found %d GPX files, need to delete %d oldest files.\n",
                  gpxFiles.size(), filesToDelete);

    // Delete the oldest files
    for (int i = 0; i < filesToDelete; ++i) {
      Serial.printf("Deleting old log file: %s\n", gpxFiles[i].c_str());
      if (!InternalFS.remove(gpxFiles[i].c_str())) {
        Serial.printf("Failed to delete %s\n", gpxFiles[i].c_str());
        // Continue trying to delete others even if one fails
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
      Serial.printf("Closed log file: %s\n", currentFilename.c_str());
    }

    // Format the new filename: /YYYYMMDD.gpx
    char filenameBuffer[14]; // "/YYYYMMDD.gpx" + null terminator
    sprintf(filenameBuffer, "/%04d%02d%02d.gpx", y, m, d);
    currentFilename = String(filenameBuffer);
    currentFileDate = newDate; // Update the current date

    Serial.printf("Switching to log file: %s\n", currentFilename.c_str());

    // Manage old files before opening the new one
    manageOldFiles();

    // Open the new file in write mode (append/create)
    File openedFile = InternalFS.open(currentFilename.c_str(), FILE_O_WRITE);

    if (!openedFile) { // Check if the open operation failed
      Serial.printf("Failed to open log file: %s\n", currentFilename.c_str());
      currentFilename = ""; // Reset filename if open failed
      currentFileDate = 0;  // Reset date
      isFileOpen = false;   // Ensure marked as not open
      return false;         // Indicate failure
    } else {
      // Open succeeded, assign the valid file handle
      currentGpxFile = openedFile; // Assign the returned File object
      isFileOpen = true;           // Mark as open
      Serial.printf("Successfully opened log file: %s\n",
                    currentFilename.c_str());
    }
  }

  // Return true if the file is marked as open
  return isFileOpen;
}

// Initialize Internal Flash File System
bool initInternalFlash() {
  Serial.println("Initializing Internal Flash Filesystem...");
  // Wait for Filesystem to setup
  // Note: begin() might format if it's the first time or corrupted.
  if (!InternalFS.begin()) {
    Serial.println("Failed to mount internal filesystem!");
    Serial.println("Try formatting the filesystem?");
    // Optionally add formatting code here if needed, e.g.:
    InternalFS.format();
    Serial.println("Filesystem formatted.");
    return false;
  }
  Serial.println("Internal Filesystem mounted successfully.");
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
    Serial.println("Cannot write GPS data: Log file not ready.");
    return false;
  }

  // Write the binary data
  size_t bytesWritten =
      currentGpxFile.write((const uint8_t *)&entry, sizeof(GpxPointInternal));

  if (bytesWritten != sizeof(GpxPointInternal)) {
    Serial.printf("Failed to write GPS data to %s. Expected %d, wrote %d\n",
                  currentFilename.c_str(),
                  (int)sizeof(GpxPointInternal), // Cast size_t to int
                  (int)bytesWritten);            // Cast size_t to int
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
      Serial.print("  ");
    }

    if (entry.isDirectory()) {
      Serial.print("DIR : ");
      Serial.println(entry.name());
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
      Serial.print("FILE: ");
      Serial.print(entry.name());
      Serial.print("\tSIZE: ");
      char sizeBuf[12];
      sprintf(sizeBuf, "%lu", entry.size()); // Use %lu for unsigned long
      Serial.println(sizeBuf);
    }
    entry.close(); // Close the entry handle
  }
}

// Modified function to start the recursive listing
void listInternalFlashContents() {
  Serial.println("--- Listing Internal Flash Contents (Recursive) ---");
  File root = InternalFS.open("/");
  if (!root) {
    Serial.println("Failed to open root directory.");
    return;
  }
  if (!root.isDirectory()) {
    Serial.println("Root is not a directory.");
    root.close();
    return;
  }

  Serial.println("DIR : /"); // Print root directory
  listDirectoryRecursive(root,
                         1); // Start recursion from root with indent level 1

  root.close();
  Serial.println("--------------------------------------------------");
}
