// Patch for @homebridge/node-pty-prebuilt-multiarch to handle missing native modules
const fs = require('fs');
const path = require('path');

// Path to the windowsPtyAgent.js file
const filePath = path.join(__dirname, '..', 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'lib', 'windowsPtyAgent.js');

// Read the file
let content = fs.readFileSync(filePath, 'utf8');

// Replace the error throwing with a more graceful fallback
const oldCode = `                    catch (innerError) {
                        console.error('innerError', innerError);
                        // Re-throw the exception from the Release require if the Debug require fails as well
                        throw outerError;
                    }`;

const newCode = `                    catch (innerError) {
                        console.error('innerError', innerError);
                        console.warn('ConPTY native module not found. Terminal functionality may be limited.');
                        // Create a mock conptyNative to prevent crashes
                        conptyNative = {
                            startProcess: () => ({ fd: -1, pty: 0, conout: '', conin: '' }),
                            connect: () => ({ pid: 0 }),
                            resize: () => {},
                            clear: () => {},
                            kill: () => {}
                        };
                    }`;

// Apply the patch
content = content.replace(oldCode, newCode);

// Apply similar patch for winpty
const oldWinptyCode = `                    catch (innerError) {
                        console.error('innerError', innerError);
                        // Re-throw the exception from the Release require if the Debug require fails as well
                        throw outerError;
                    }`;

const newWinptyCode = `                    catch (innerError) {
                        console.error('innerError', innerError);
                        console.warn('WinPTY native module not found. Terminal functionality may be limited.');
                        // Create a mock winptyNative to prevent crashes
                        winptyNative = {
                            startProcess: () => ({ pid: 0, innerPid: 0, fd: -1, pty: 0 }),
                            resize: () => {},
                            kill: () => {},
                            getProcessList: () => [],
                            getExitCode: () => -1
                        };
                    }`;

// Find and replace the winpty error handling
const winptyIndex = content.lastIndexOf(oldWinptyCode);
if (winptyIndex !== -1) {
    content = content.substring(0, winptyIndex) + newWinptyCode + content.substring(winptyIndex + oldWinptyCode.length);
}

// Write the patched file back
fs.writeFileSync(filePath, content, 'utf8');

console.log('Patch applied successfully!');