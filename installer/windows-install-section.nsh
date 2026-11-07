; Only staging and the archive use disk space until commit. Never execute files
; from an earlier installation or register a payload before checked extraction.
StrCpy $INSTDIR $BKInstallTarget
!insertmacro BKLockFiles
Call BKAssertRegistration
SetOutPath "$PLUGINSDIR"
!insertmacro BKRunFileHelper prepare
${If} $BKFilesExit != 0
  StrCpy $BKInstallError $BKFilesResult
  DetailPrint "$BKInstallError"
  SetErrorLevel 2
  Abort "$BKInstallError"
${EndIf}
StrCpy $BKStage $BKFilesResult
${If} $BKStage == ""
  StrCpy $BKInstallError "未能建立安装暂存目录。"
  Call BKAbortFileInstall
${EndIf}

ClearErrors
Var /GLOBAL packageArch
!insertmacro identify_package
!ifdef COMPRESS
  SetCompress off
!endif
!insertmacro compute_files_for_current_arch
!ifdef COMPRESS
  SetCompress "${COMPRESS}"
!endif
${If} ${Errors}
  StrCpy $BKInstallError "无法写入安装压缩包，请检查系统临时盘空间。"
  Call BKAbortFileInstall
${EndIf}
nsisunz::Unzip "$PLUGINSDIR\app-$packageArch.zip" "$BKStage"
Pop $0
${If} $0 != "success"
  StrCpy $BKInstallError "解包失败：$0"
  Call BKAbortFileInstall
${EndIf}

ClearErrors
SetOutPath "$BKStage"
File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
${If} ${Errors}
  StrCpy $BKInstallError "无法写入卸载程序。"
  Call BKAbortFileInstall
${EndIf}
SetOutPath "$PLUGINSDIR"

; Recheck after extraction, including in the elevated child. A restarted
; legacy process can block the swap but can never reach a taskkill branch.
Call BKCheckRunning
${If} $BKQuitFailed != 0
  StrCpy $BKInstallError "BetterKuGou 仍在运行，文件未替换。"
  Call BKAbortFileInstall
${EndIf}
!insertmacro BKRunFileHelper commit
${If} $BKFilesExit != 0
  StrCpy $BKInstallError $BKFilesResult
  Call BKAbortFileInstall
${EndIf}

ReadRegStr $BKPriorInstallVersion SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" BetterKuGouVersion
ReadRegStr $BKPriorDisplayVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
ReadRegStr $BKPriorDisplayName SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName
ClearErrors
!insertmacro registryAddInstallInfo
${IfNot} ${Errors}
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" BetterKuGouVersion "${VERSION}"
${EndIf}
${If} ${Errors}
  ${If} $BKExisting == 0
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"
  ${Else}
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" BetterKuGouVersion "$BKPriorInstallVersion"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "$BKPriorDisplayVersion"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName "$BKPriorDisplayName"
  ${EndIf}
  StrCpy $BKInstallError "无法登记安装版本。"
  Call BKAbortFileInstall
${EndIf}

!insertmacro BKRunFileHelper finish
${If} $BKFilesExit != 0
  ; The new files and registration are committed. A backup cleanup failure
  ; must leave the backup available and must not undo a completed installation.
  DetailPrint "$BKFilesResult"
  MessageBox MB_OK|MB_ICONEXCLAMATION "$BKFilesResult"
${ElseIf} $BKFilesResult != ""
  MessageBox MB_OK|MB_ICONINFORMATION "旧安装包含需要保留的文件，已保存在：$\r$\n$BKFilesResult"
${EndIf}

; Registration was checked above while the previous file tree was recoverable.
!macroundef registryAddInstallInfo
!macro registryAddInstallInfo
!macroend
