; Hovi Space was called Gemspace before. An install of the old name lives in its own folder with its own
; shortcuts and uninstall entry; this removes those after the new one is installed. The accounts and
; logins are not touched: they live in the app data folder of the identifier app.gemspace.allinone,
; which both names share.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$LOCALAPPDATA\Gemspace\Gemspace.exe" 0 hovi_no_old
    Delete "$LOCALAPPDATA\Gemspace\Gemspace.exe"
    Delete "$LOCALAPPDATA\Gemspace\uninstall.exe"
    RMDir /r "$LOCALAPPDATA\Gemspace\resources"
    RMDir "$LOCALAPPDATA\Gemspace"
    Delete "$DESKTOP\Gemspace.lnk"
    Delete "$SMPROGRAMS\Gemspace.lnk"
    RMDir /r "$SMPROGRAMS\Gemspace"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gemspace"
  hovi_no_old:
!macroend
