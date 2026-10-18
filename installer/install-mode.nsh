; Replace builder's fixed-size read of a short CoTaskMem known-folder string.
; Apply before PAGE_INSTALL_MODE expands, as well as before .onInit expands.
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !ifndef BK_SAFE_PER_USER_INSTALL_MODE
      !define BK_SAFE_PER_USER_INSTALL_MODE
      !macroundef setInstallModePerUser
      !macro setInstallModePerUser
        StrCpy $installMode CurrentUser
        SetShellVarContext current
        ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $perUserInstallationFolder != ""
          StrCpy $INSTDIR $perUserInstallationFolder
        ${Else}
          Push $0
          Push $1
          Push $2
          StrCpy $0 "$LocalAppData\Programs"
          System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
          ${If} $1 == 0
          ${AndIf} $2 != 0
            ; The OS allocation ends at the NUL, not at NSIS_MAX_STRLEN.
            System::Call 'kernel32::lstrcpynW(w .r1, p r2, i ${NSIS_MAX_STRLEN})'
            ${If} $1 != ""
              StrCpy $0 $1
            ${EndIf}
            System::Call 'OLE32::CoTaskMemFree(p r2)'
          ${EndIf}
          StrCpy $INSTDIR "$0\${APP_FILENAME}"
          Pop $2
          Pop $1
          Pop $0
        ${EndIf}
        ; Preserve builder's explicit /D override and existing-install behavior.
        ${StdUtils.GetParameter} $R0 "D" ""
        ${If} $R0 != ""
          StrCpy $INSTDIR $R0
        ${EndIf}
      !macroend
    !endif
  !endif
