!macro NSIS_HOOK_PREINSTALL
  ; Stop only Praetorium and its child Node process before replacing packaged
  ; resources. Unrelated applications and port owners are never touched.
  nsExec::Exec 'taskkill /IM Praetorium.exe /T /F'
  Pop $0
  Sleep 1000
  ; v2.0.0 development builds briefly packaged these resource directory names
  ; as flat files. Delete only those exact stale files before installing the
  ; corrected directory layout; Delete is a no-op when the target is a folder.
  Delete "$INSTDIR\css"
  Delete "$INSTDIR\js"
  Delete "$INSTDIR\lib"
  Delete "$INSTDIR\routes"
!macroend
