; Reuse the assisted template and its signed-uninstaller build. This hook is
; expanded once in its install section, after the original macros are defined.
!ifndef ZIP_COMPRESSION
  !error "BetterKuGou requires status-reporting ZIP extraction"
!endif

; The builder still emits its legacy uninstall functions but has no call sites.
!pragma warning disable 6010
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !if "${ROOT_KEY}" == "SHELL_CONTEXT"
    ; Keep the stock SetOutPath away from the live target until commit.
    StrCpy $BKInstallTarget $INSTDIR
    StrCpy $INSTDIR $PLUGINSDIR
  !endif
!macroend
!macroundef handleUninstallResult
!macro handleUninstallResult ROOT_KEY
!macroend

; Stock File would write this icon into the live directory before validation.
; The generated uninstaller retains MUI_UNICON; registration uses the app icon.
!ifdef UNINSTALLER_ICON
  !undef UNINSTALLER_ICON
!endif

!macroundef installApplicationFiles
!macro installApplicationFiles
  !include "${PROJECT_DIR}\installer\windows-install-section.nsh"
!macroend
