// electron-builder afterPack hook: flip Electron "fuses" on the packaged binary
// so it cannot be turned back into a generic Node runtime. This closes a local
// key-custody hole — without it, an attacker who can launch the installed
// binary could set ELECTRON_RUN_AS_NODE=1 or pass --inspect to run code in /
// attach a debugger to the main process and read the in-memory private key.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;
  const name = context.packager.appInfo.productFilename;
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[electronPlatformName] ?? '';
  let binary = path.join(appOutDir, `${name}${ext}`);
  if (electronPlatformName === 'darwin') {
    binary = path.join(appOutDir, `${name}.app`, 'Contents', 'MacOS', name);
  }

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    // Block the binary from acting as a raw Node interpreter / debug target.
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  console.log(`[afterPack] hardened Electron fuses on ${binary}`);
};
