; The universal installer used the 64-bit registry view on all 64-bit systems.
; Keep that view for every split installer and its generated uninstaller.
!macroundef check64BitAndSetRegView
!macro check64BitAndSetRegView
  ${If} ${IsWin2000}
  ${OrIf} ${IsWinME}
  ${OrIf} ${IsWinXP}
  ${OrIf} ${IsWinVista}
    MessageBox MB_OK "$(win7Required)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}

  ${If} ${RunningX64}
  ${OrIf} ${IsNativeARM64}
    SetRegView 64
  ${EndIf}

  !ifdef BUILD_UNINSTALLER | APP_32
    ; Uninstallers and packages with an x86 payload run on every supported host.
  !else ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "此安装包需要 ARM64 版 Windows。请选择与电脑架构对应的安装包。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    !endif
  !else ifdef APP_64
    ${IfNot} ${IsNativeAMD64}
      StrCpy $0 0
      StrCpy $1 -1
      ${If} ${IsNativeARM64}
        ; Windows 11 exposes whether AMD64 user-mode emulation is enabled.
        System::Call 'kernel32::GetMachineTypeAttributes(i 0x8664, *i .r0)i.r1'
        IntOp $0 $0 & 1
      ${EndIf}
      ${If} $1 != 0
      ${OrIf} $0 == 0
        MessageBox MB_OK|MB_ICONSTOP "当前 Windows 无法运行 x64 程序。请选择与电脑架构对应的安装包。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; The stock size macro covers ARM64 only alongside both x86 payloads.
!ifdef APP_64_UNPACKED_SIZE | APP_32_UNPACKED_SIZE
  ; Keep the stock size calculation for packages with an x86 or x64 payload.
!else ifdef APP_ARM64_UNPACKED_SIZE
  !macroundef setSpaceRequired
  !macro setSpaceRequired SECTION_ID
    SectionSetSize ${SECTION_ID} ${APP_ARM64_UNPACKED_SIZE}
  !macroend
!endif
