const { promisify } = require("util");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const execAsync = promisify(exec);

module.exports.checkPermissions = async () => {
  try {
    // Get absolute path to the Swift binary
    const swiftBinaryPath = path.resolve(__dirname, "../../swift/Recorder");
    console.log('Checking permissions for:', swiftBinaryPath);
    
    // First, check if the binary exists
    if (!fs.existsSync(swiftBinaryPath)) {
      console.error('Swift binary does not exist at:', swiftBinaryPath);
      return false;
    }
    
    // Check if binary is executable
    try {
      fs.accessSync(swiftBinaryPath, fs.constants.X_OK);
      console.log('Binary is executable ✓');
    } catch (error) {
      console.error('Binary is not executable:', error.message);
      return false;
    }
    
    const { stdout, stderr } = await execAsync(`"${swiftBinaryPath}" --check-permissions`);
    console.log('Permission check stdout:', stdout);
    console.log('Permission check stderr:', stderr);
    
    // Swift sends JSON responses to stderr, not stdout
    const jsonOutput = stderr.trim() || stdout.trim();
    
    if (!jsonOutput) {
      console.error('No output from Swift binary');
      return false;
    }
    
    const { code: checkPermissionCode } = JSON.parse(jsonOutput);
    console.log('Permission code:', checkPermissionCode);
    
    return checkPermissionCode === "PERMISSION_GRANTED";
  } catch (error) {
    console.error('Permission check error:', error);
    return false;
  }
};
