!macro NSIS_HOOK_PREINSTALL
  ; Never kill Praetorium or its Hermes/Codex child sessions during an update.
  ; The Owner must use tray Quit; Praetorium refuses that quit while work runs.
  nsExec::Exec 'powershell.exe -NoProfile -Command "if ((Get-Process -Name Praetorium -ErrorAction SilentlyContinue) -or (Get-NetTCPConnection -LocalPort 3848 -State Listen -ErrorAction SilentlyContinue)) { exit 1 }"'
  Pop $0
  StrCmp $0 "0" praetorium_preinstall_ready
  MessageBox MB_ICONSTOP|MB_OK "Praetorium is still running. Finish active work, then choose Quit Praetorium from the tray before updating. No session was terminated."
  Abort
  praetorium_preinstall_ready:
  ; v2.0.0 development builds briefly packaged these resource directory names
  ; as flat files. Delete only those exact stale files before installing the
  ; corrected directory layout; Delete is a no-op when the target is a folder.
  Delete "$INSTDIR\css"
  Delete "$INSTDIR\js"
  Delete "$INSTDIR\lib"
  Delete "$INSTDIR\routes"
!macroend
