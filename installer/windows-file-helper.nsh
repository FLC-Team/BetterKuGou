Var BKFilesExit
Var BKFilesResult
Var BKFilesMutex

; Hold the same mutex from both file sections, including across login sessions.
; The operating system releases ownership when the section thread exits.
!macro BKLockFiles
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\BetterKuGou.InstallFiles.${APP_GUID}")p.s'
  Pop $BKFilesMutex
  StrCpy $0 -1
  ${If} $BKFilesMutex != 0
    System::Call 'kernel32::WaitForSingleObject(p $BKFilesMutex, i 0)i.r0'
  ${EndIf}
  ${If} $0 != 0
  ${AndIf} $0 != 0x80
    SetErrorLevel 2
    Abort "另一项安装或卸载正在进行，或无法取得安装锁。请稍后重试。"
  ${EndIf}
!macroend

!macro BKEmbedFileHelper
  InitPluginsDir
  File /oname=$PLUGINSDIR\bk-install-files.ps1 "${PROJECT_DIR}\installer\windows-files.ps1"
!macroend

; Use the system PowerShell and pass paths as data. A Unicode result file keeps
; destination names independent of the active console code page.
!macro BKRunFileHelper ACTION
  SetOutPath "$PLUGINSDIR"
  Push $INSTDIR
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_TARGET", w s)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_MODE", w "$installMode")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_EXISTING", w "$BKExisting")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_ALLOW_BACKUP", w "$BKAllowBackup")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_VERSION", w "${VERSION}")'
  ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" BetterKuGouVersion
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_RECORDED_VERSION", w "$R8")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_MACHINE_ROOT", w "$PROGRAMFILES64")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_MACHINE_ROOT_X86", w "$PROGRAMFILES32")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_EXE", w "${APP_EXECUTABLE_FILENAME}")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_UNINSTALLER", w "${UNINSTALL_FILENAME}")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "BK_INSTALL_RESULT", w "$PLUGINSDIR\bk-files-result.txt")'
  Delete "$PLUGINSDIR\bk-files-result.txt"
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\bk-install-files.ps1" ${ACTION}'
  Pop $BKFilesExit
  StrCpy $BKFilesResult ""
  ClearErrors
  FileOpen $R9 "$PLUGINSDIR\bk-files-result.txt" r
  ${IfNot} ${Errors}
    FileReadUTF16LE $R9 $BKFilesResult
    FileClose $R9
  ${EndIf}
  ${If} $BKFilesExit != 0
  ${AndIf} $BKFilesResult == ""
    StrCpy $BKFilesResult "无法完成安装文件操作（${ACTION}，错误 $BKFilesExit）。"
  ${EndIf}
!macroend
