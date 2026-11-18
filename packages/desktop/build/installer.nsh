!macro customUnInstall
  ReadRegStr $R0 HKCU "Software\Google\Chrome\NativeMessagingHosts\com.ultrago.desktop" ""
  StrCmp $R0 "$APPDATA\UltraGoDesktop\native-host.json" 0 +2
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.ultrago.desktop"
  ; Start-at-login is written by Electron under the app user model id; an upgrade keeps the user's choice.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.ultrago.desktop"
  ${endIf}
!macroend
