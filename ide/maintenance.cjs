const { execFile } = require('node:child_process');
const { resolve, basename, join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { createHash } = require('node:crypto');

const STORE_ID = 'lumidarin.agy-capsule-ide';
const STORE_API = 'https://open-vsx.org/api/lumidarin/agy-capsule-ide';
const versionParts = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value.split('.').map(Number) : null;
const compare = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]); return 0; };

async function checkIdeRelease(currentVersion, fetchImpl = fetch, now = Date.now) {
  if (!versionParts(currentVersion)) return { status: 'error', reason: 'localVersion' };
  try {
    // A previously cached "not found" on the gallery must not mask a newly published version.
    const response = await fetchImpl(STORE_API + '/latest?check=' + now(), {
      headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: 'error', reason: response.status === 404 ? 'notListed' : response.status === 429 ? 'rateLimit' : 'http' };
    const meta = await response.json();
    if (meta?.namespace !== 'lumidarin' || meta.name !== 'agy-capsule-ide' || !versionParts(meta.version) ||
        meta.preRelease !== false || meta.downloadable !== true) return { status: 'error', reason: 'response' };
    return { status: compare(meta.version, currentVersion) > 0 ? 'available' : 'current', currentVersion, version: meta.version };
  } catch { return { status: 'error', reason: 'network' }; }
}

async function installStoreVersion(vscode, version, fetchImpl = fetch) {
  const command = 'workbench.extensions.installExtension';
  try { await vscode.commands.executeCommand(command, STORE_ID + '@' + version); return; }
  catch (error) {
    // Never substitute a VSIX after a cancellation, permission or compatibility error.
    if (error?.name !== 'NotFound' && error?.code !== 'NotFound' &&
        !/requested version .* was not found/i.test(error?.message || '')) throw error;
  }
  // The native index can still have a negative cache entry. Get the immutable
  // version directly from Open VSX; use the native installer, not a browser.
  const stem = STORE_ID + '-' + version;
  const base = STORE_API + '/' + version + '/file/' + stem;
  const get = async suffix => {
    const res = await fetchImpl(base + suffix, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('Open VSX file unavailable');
    return res;
  };
  const [digest, bytes] = await Promise.all([
    get('.sha256').then(r => r.text()), get('.vsix').then(r => r.arrayBuffer()).then(b => Buffer.from(b)),
  ]);
  if (createHash('sha256').update(bytes).digest('hex') !== digest.trim().toLowerCase()) throw new Error('Open VSX checksum mismatch');
  const dir = await mkdtemp(join(tmpdir(), 'agy-capsule-update-'));
  try {
    const file = join(dir, stem + '.vsix');
    await writeFile(file, bytes);
    await vscode.commands.executeCommand(command, vscode.Uri.file(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// Runs only after an explicit repair command; default roots are the current
// user's locations, never CommonStartMenu/CommonDesktop or App shortcuts.
function shortcutScript() {
  return `
$ErrorActionPreference = 'Stop'
$wanted = [IO.Path]::GetFullPath($env:AGY_IDE_EXE)
if ((Split-Path -Leaf $wanted) -cne 'Antigravity IDE.exe' -or -not [IO.File]::Exists($wanted)) { throw 'IDE executable not found' }
$roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu'), (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'))
if ($env:AGY_IDE_TEST_ROOTS) { $roots = @($env:AGY_IDE_TEST_ROOTS | ConvertFrom-Json) }
$shell = New-Object -ComObject WScript.Shell
$total = 0; $updated = 0; $failed = 0; $missing = 0; $manualAddress = 0
foreach ($root in ($roots | Select-Object -Unique)) {
  if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
  $errors = @()
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.lnk' -ErrorAction SilentlyContinue -ErrorVariable errors)
  $failed += $errors.Count
  foreach ($file in $files) {
    try {
      $link = $shell.CreateShortcut($file.FullName)
      if (-not $link.TargetPath -or [IO.Path]::GetFullPath($link.TargetPath) -ine $wanted) { continue }
      $total++
      $argsBefore = [string]$link.Arguments
      # Never enable a debug port when an existing bind address is non-loopback.
      # Preserve it for the user to change deliberately, including separate-value flags.
      $addressFlags = [regex]::Matches($argsBefore, '(?i)(^|\\s)--remote-debugging-address(?=\\s|=|$)')
      $addresses = [regex]::Matches($argsBefore, '(?i)(^|\\s)--remote-debugging-address(?:=|\\s+)([^\\s]+)')
      $unsafeAddress = $addressFlags.Count -ne $addresses.Count
      foreach ($address in $addresses) {
        $value = $address.Groups[2].Value.Trim([char[]]@([char]34, [char]39))
        if ($value -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) { $unsafeAddress = $true }
      }
      if ($unsafeAddress) { $manualAddress++; continue }
      $argsAfter = $argsBefore
      if ($argsAfter -notmatch '(^|\\s)--remote-debugging-port(?:=\\S*)?(?=\\s|$)') { $argsAfter += ' --remote-debugging-port=0' }
      if ($argsAfter -notmatch '(^|\\s)--remote-debugging-address(?:=\\S*)?(?=\\s|$)') { $argsAfter += ' --remote-debugging-address=127.0.0.1' }
      if ($argsAfter -ceq $argsBefore) { continue }
      $missing++
      if ($env:AGY_IDE_SCAN_ONLY -eq '1') { continue }
      $link.Arguments = $argsAfter.Trim()
      if ([string]$link.Arguments -cne $argsAfter.Trim()) { throw 'Shortcut arguments truncated' }
      $link.Save()
      $saved = $shell.CreateShortcut($file.FullName)
      if ([string]$saved.Arguments -cne $argsAfter.Trim()) { throw 'Shortcut verification failed' }
      $updated++; $missing--
    } catch { $failed++ }
  }
}
@{ total = $total; updated = $updated; failed = $failed; missing = $missing; manualAddress = $manualAddress } | ConvertTo-Json -Compress
`;
}

async function repairIdeShortcuts({ executablePath, execFileImpl = execFile, platform = process.platform, scanOnly = false, roots } = {}) {
  if (platform !== 'win32') return { status: 'unsupported', total: 0, updated: 0, failed: 0 };
  if (basename(executablePath || '') !== 'Antigravity IDE.exe') return { status: 'error', reason: 'executable' };
  const script = Buffer.from(shortcutScript(), 'utf16le').toString('base64');
  return new Promise(resolveResult => {
    execFileImpl(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
        windowsHide: true, timeout: 12000, encoding: 'utf8', env: { ...process.env, AGY_IDE_EXE: executablePath,
          AGY_IDE_SCAN_ONLY: scanOnly ? '1' : '', AGY_IDE_TEST_ROOTS: roots ? JSON.stringify(roots) : '' },
      }, (err, stdout) => {
        if (err) return resolveResult({ status: 'error', reason: 'scan' });
        try { const data = JSON.parse(String(stdout).replace(/^\uFEFF/, '')); resolveResult({ status: data.failed || data.manualAddress ? 'partial' : data.missing ? 'missing' : data.total ? 'ok' : 'notFound', ...data }); }
        catch { resolveResult({ status: 'error', reason: 'response' }); }
      });
  });
}

function createMaintenance({ vscode, context, getPrefs = () => ({}), executablePath, fetchImpl, now = Date.now } = {}) {
  const zh = vscode.env.language.toLowerCase().startsWith('zh');
  const text = (en, cn) => zh ? cn : en;
  let checked, checkedAt = 0, checking, notified = false, failures = 0, disposed = false, announcedVersion;
  let everOk = context.globalState.get('agyCapsule.cdpEverOk', false);
  const installVsix = () => vscode.commands.executeCommand('workbench.extensions.action.installVSIX');
  async function repairShortcuts() {
    const result = await repairIdeShortcuts({ executablePath: executablePath || resolve(vscode.env.appRoot, '..', '..', 'Antigravity IDE.exe') });
    const message = result.manualAddress ? text('An IDE shortcut already binds debugging to a non-loopback address. It was not changed and no debugging port was added. Change its --remote-debugging-address to 127.0.0.1 manually, then retry.', 'IDE 快捷方式已有非本机调试绑定地址。未改动该快捷方式，也未补调试端口。请先手动把 --remote-debugging-address 调整为 127.0.0.1，再重试。') : result.status === 'ok'
      ? text(`IDE shortcuts checked: ${result.total}; updated: ${result.updated}. Quit and reopen IDE from the shortcut to enable input capsules.`, `已检查 ${result.total} 个 IDE 快捷方式，补齐 ${result.updated} 个。完全退出 IDE 后从快捷方式重开即可恢复输入框胶囊。`)
      : text('Could not repair all user IDE shortcuts. Start Antigravity IDE with --remote-debugging-port=0 --remote-debugging-address=127.0.0.1.', '没有修复全部用户 IDE 快捷方式。可带 --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 启动 IDE。');
    await vscode.window.showInformationMessage(message);
    return result;
  }
  async function loadUpdate(manual) {
    if (manual || !checked || now() - checkedAt >= 6 * 60 * 60_000) {
      checking ??= checkIdeRelease(context.extension.packageJSON.version, fetchImpl, now).then(result => { checked = result; checkedAt = now(); return result; }).finally(() => { checking = null; });
      return checking;
    }
    return checked;
  }
  async function checkUpdates({ manual = false } = {}) {
    if (!manual && (getPrefs().notifyUpdates === false || (vscode.ExtensionMode?.Test !== undefined && context.extensionMode === vscode.ExtensionMode.Test))) return null;
    const result = await loadUpdate(manual);
    if (disposed || (!manual && (result.status !== 'available' || announcedVersion === result.version))) return result;
    if (!manual) announcedVersion = result.version;
    const update = text('Update now', '立即更新');
    const message = result.status === 'available'
      ? text(`Open VSX: agy-capsule ${result.currentVersion} → ${result.version}.`, `Open VSX 有新版：胶囊 ${result.currentVersion} → ${result.version}。`)
      : result.status === 'current'
      ? text(`Installed: ${result.currentVersion}. Open VSX: ${result.version}. No update needed.`, `已安装 ${result.currentVersion}，Open VSX 为 ${result.version}，无需更新。`)
      : text('Could not confirm the Open VSX version. Try checking again later.', '暂时查不到 Open VSX 的版本，请稍后再点检查。');
    const action = await vscode.window.showInformationMessage(message, ...(result.status === 'available' ? [update] : []));
    if (!disposed && result.status === 'available' && action === update) {
      try {
        await installStoreVersion(vscode, result.version, fetchImpl);
      } catch {
        await vscode.window.showWarningMessage(text(
          `The IDE could not install ${result.version} from the store. Try checking again shortly.`,
          `IDE 未能从商店安装 ${result.version}，请稍后再点检查重试。`));
        return { ...result, status: 'error', reason: 'install' };
      }
      if (!disposed) {
        const restart = text('Restart extensions', '重启扩展');
        const choice = await vscode.window.showInformationMessage(text(
          `Installed agy-capsule ${result.version}. Restart extensions to use it now.`,
          `已安装胶囊 ${result.version}，重启扩展即可使用新版。`), restart);
        if (choice === restart) await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      }
    }
    return result;
  }
  function observeCdp(state) {
    if (disposed) return;
    if (state === 'ok') { failures = 0; if (!everOk) { everOk = true; void context.globalState.update('agyCapsule.cdpEverOk', true); } return; }
    if (!['missing', 'unreachable'].includes(state)) { failures = 0; return; }
    if (++failures < 3 || !everOk || notified || getPrefs().notifyCdpRestart === false) return;
    notified = true;
    const fix = text('Repair IDE shortcut', '修复 IDE 快捷方式');
    void vscode.window.showInformationMessage(text('agy-capsule: IDE input capsules lost their local debugging connection. Sidebar statistics remain available.', 'agy-capsule：IDE 输入框胶囊的本机调试连接已断开，侧栏统计仍可使用。'), ...(process.platform === 'win32' ? [fix] : [])).then(action => { if (!disposed && action === fix) return repairShortcuts(); });
  }
  return { observeCdp, checkUpdates, installVsix, repairShortcuts, dispose() { disposed = true; } };
}
module.exports = { checkIdeRelease, repairIdeShortcuts, createMaintenance, shortcutScript };
