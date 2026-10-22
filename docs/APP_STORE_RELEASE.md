# Mac App Store und TestFlight

Der App-Store-Build ist eine eigene Variante der macOS-App. Die normale `.dmg`-Version bleibt davon unabhängig.

## Voraussetzungen

- App-ID in Apple Developer und App Store Connect: `de.saschamolina.sitzungsbuddy`
- Im macOS-Schlüsselbund: ein gültiges `Apple Distribution`-Zertifikat und ein `Mac Installer Distribution`-Zertifikat desselben Teams
- Mac-App-Store-Connect-Bereitstellungsprofil für diese App-ID, lokal als `src-tauri/embedded.provisionprofile` abgelegt (wird nicht ins Repository aufgenommen)
- Xcode und beide Rust-Ziele: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`

## App erstellen

`src-tauri/tauri.appstore.conf.json` aktiviert die App-Sandbox und bindet das Bereitstellungsprofil ein. Die Signatur muss vom Team der App-ID stammen.

Die Sandbox benötigt außerdem `com.apple.security.network.client`: Ohne diese Berechtigung startet der WebKit-Inhaltsprozess nicht und die App zeigt nur ein graues Fenster.

```sh
APPLE_SIGNING_IDENTITY='Apple Distribution: <Name> (<Team-ID>)' \
  npm run tauri build -- --bundles app --target universal-apple-darwin \
  --config src-tauri/tauri.appstore.conf.json
```

Die App liegt unter `src-tauri/target/universal-apple-darwin/release/bundle/macos/Sitzungsbuddy.app`.

Vor dem Paketieren prüfen, dass `src-tauri/icons/icon.icns` auch eine 1024 × 1024 Pixel große Variante (`icon_512x512@2x.png`) enthält. Fehlt sie, lehnt Apple den Upload mit Fehler 90236 ab. Die aktuelle ICNS-Datei enthält diese Variante.

## Signiertes Upload-Paket erstellen

```sh
mkdir -p src-tauri/target/universal-apple-darwin/release/bundle/pkg
xcrun productbuild \
  --sign '3rd Party Mac Developer Installer: <Name> (<Team-ID>)' \
  --component src-tauri/target/universal-apple-darwin/release/bundle/macos/Sitzungsbuddy.app /Applications \
  src-tauri/target/universal-apple-darwin/release/bundle/pkg/Sitzungsbuddy_AppStore.pkg
```

Die Zertifikatsbezeichnung kann im Schlüsselbund auch als „Mac Installer Distribution“ erscheinen. Die vollständige Identität zeigt `security find-identity -v -p basic`.

```sh
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/Sitzungsbuddy.app
pkgutil --check-signature \
  src-tauri/target/universal-apple-darwin/release/bundle/pkg/Sitzungsbuddy_AppStore.pkg
```

Das `.pkg` wird mit der Apple-App **Transporter** zu App Store Connect hochgeladen. Dort kann der verarbeitete Build zunächst einer internen TestFlight-Gruppe zugeordnet werden. Für externe Testpersonen ist zusätzlich Apples Beta-Prüfung erforderlich.

Vor einem erneuten Upload derselben App-Version muss die Build-Nummer (`bundle.macOS.bundleVersion` in der App-Store-Konfiguration) erhöht werden. Sie ist unabhängig von der sichtbaren Version `1.2.0`.
