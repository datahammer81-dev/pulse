; Custom NSIS hooks for the Pulse installer.
; When Pulse is already installed, offer Update/Reinstall, a clean reinstall,
; or Cancel — instead of silently overwriting.

!macro customInit
  ; Is Pulse already installed for this user? (DisplayVersion set = yes)
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${if} $R8 != ""
    ; Label the primary action based on how the installed version compares.
    StrCpy $R9 "Update"
    ${if} $R8 == "${VERSION}"
      StrCpy $R9 "Reinstall"
    ${endif}

    ; /SD IDYES => silent installs (/S) auto-pick the normal update path.
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "Pulse $R8 is already installed on this PC.$\n$\nChoose how to continue:$\n$\n     YES  —  $R9 to ${VERSION}  (keeps your dashboard layout and settings)$\n$\n     NO  —  Uninstall and reinstall clean  (resets settings to defaults)$\n$\n     CANCEL  —  Quit without changes" /SD IDYES IDYES pulseProceed IDNO pulseCleanReinstall
    ; Any other result (Cancel) stops here.
    Quit

    pulseCleanReinstall:
      ; Wipe per-user app data so the reinstall starts from a clean slate.
      ; Program files are replaced by the normal install that follows.
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
      RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
      Goto pulseProceed

    pulseProceed:
  ${endif}
!macroend
