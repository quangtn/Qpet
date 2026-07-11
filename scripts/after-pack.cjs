const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async function removeUnusedMacPermissions(context) {
  if (context.electronPlatformName !== 'darwin') return

  const plistPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  )
  const unusedKeys = [
    'NSAppTransportSecurity',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]

  for (const key of unusedKeys) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plistPath], {
        stdio: 'ignore'
      })
    } catch {
      // Electron versions differ in their default plist. Missing keys are fine.
    }
  }
}

