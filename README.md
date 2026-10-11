# LotCAD

LotCAD is a cross-platform 3D CAD application built on a custom Vulkan rendering engine —
modeling, B-Rep features, drawing views, assemblies and SubD, with an AutoCAD-style command line.

> **0.1.0 Beta** — an early preview. Expect rough edges; please report problems through GitHub Issues.

## Download

Get the installer for your system from **[Releases](https://github.com/lotcad/lotcad.github.io/releases)**.

| System | File | Requirements |
|---|---|---|
| macOS | `LotCAD-0.1.0-arm64.dmg` | Apple Silicon (M1 or later), macOS 14 or later |
| Linux | `LotCAD-0.1.0-x86_64.AppImage` | x86-64, **Ubuntu 24.04 or later** (or another distro with glibc 2.38+, e.g. Fedora 39+, Debian 13), Vulkan GPU driver |
| Windows | `LotCAD-0.1.0-x64-setup.exe` | 64-bit Windows 10 or 11, Vulkan GPU driver |

Every file has a matching `.sha256` next to it so you can check the download.

## Install

### macOS
1. Open the `.dmg` and drag **LotCAD** into **Applications**.
2. The beta is not notarized by Apple, so the first launch is blocked once:
   right-click **LotCAD** → **Open** → **Open**
   (or System Settings → Privacy & Security → **Open Anyway**).

### Windows
1. Run `LotCAD-0.1.0-x64-setup.exe` and follow the installer (Start menu shortcut and uninstaller included).
2. The beta is not code-signed, so Windows SmartScreen may warn once: **More info** → **Run anyway**.

### Linux (AppImage)
```bash
chmod +x LotCAD-0.1.0-x86_64.AppImage
./LotCAD-0.1.0-x86_64.AppImage
```
- No installation and no root needed — the AppImage is the whole app. Move it anywhere (e.g. `~/Applications`).
- Ubuntu 22.04 and older are **not** supported by this build (it fails with `GLIBC_2.38 not found`).
- A Vulkan driver is required. Most distributions include one (Mesa for AMD/Intel); NVIDIA needs the proprietary driver.

### Check the download (optional)
```bash
sha256sum -c LotCAD-0.1.0-x86_64.AppImage.sha256     # Linux
shasum -a 256 -c LotCAD-0.1.0-arm64.dmg.sha256        # macOS
# Windows (PowerShell): Get-FileHash LotCAD-0.1.0-x64-setup.exe  — compare with the .sha256 file
```

## First launch

- Starts with an empty scene, in your system language (Korean or English — switch any time from the language box at the top right).
- Example projects (`AirPods Case`, `Mouse`, `Hex Spacer`) are copied to **Documents/LotCAD Examples** — open them from **File → Open Example…**.
- Everything is driven from the command line at the bottom: type a command name and press Enter (e.g. `box`, `circle`, `extrude`).

## Settings and uninstall

LotCAD keeps window layout, language and other settings in your user folder:

| System | Settings folder |
|---|---|
| macOS | `~/Library/Application Support/LotCAD` |
| Linux | `~/.config/lotcad` |
| Windows | `%APPDATA%\LotCAD` |

To uninstall, remove the app (Windows: Settings → Apps → LotCAD → Uninstall; macOS: drag LotCAD out of Applications; Linux: delete the AppImage) and, if you want a clean slate, the settings folder above.
Your example copies in Documents/LotCAD Examples are yours to keep or delete.

## Developers

The engine is also available as an SDK with host samples (Qt/QML, MFC, WinForms, WPF, Swift, Android, C++):
**[Vulkan_CMake_Sample](https://github.com/kimyuheon/Vulkan_CMake_Sample)**.

## License notices

LotCAD includes third-party open-source software, fonts and textures.
Their notices are shipped with the app (`THIRD_PARTY_NOTICES.txt`).
"Vulkan" is a trademark of the Khronos Group Inc.

---

## 한국어 요약

- **내려받기:** [Releases](https://github.com/lotcad/lotcad.github.io/releases) — macOS(Apple Silicon, macOS 14 이상) `.dmg`, 리눅스 `.AppImage`(**우분투 24.04 이상**, glibc 2.38+), Windows `-x64-setup.exe`(64비트 Windows 10·11).
- **macOS:** `.dmg` 를 열어 LotCAD 를 응용 프로그램으로 끌어 놓기. 첫 실행은 LotCAD 를 오른쪽 클릭 → **열기**(애플 공증 전 베타라 한 번 필요).
- **Windows:** 설치 프로그램 실행. 서명 전 베타라 SmartScreen 경고가 뜨면 **추가 정보 → 실행**.
- **리눅스:** `chmod +x` 후 실행 — 설치·관리자 권한 필요 없음. 우분투 22.04 이하는 이 빌드로는 실행되지 않습니다.
- **첫 실행:** 빈 장면, 시스템 언어(한국어/영어), 예제 3개가 **문서/LotCAD Examples** 에 복사 — **파일 → 예제 열기…**. 명령은 아래 명령행에 이름을 치고 Enter(`box`, `circle`, `extrude` …).
- **설정 위치:** macOS `~/Library/Application Support/LotCAD` · 리눅스 `~/.config/lotcad` · Windows `%APPDATA%\LotCAD` — 지우려면 앱과 이 폴더를 삭제.
- **베타:** 0.1.0 Beta 는 미리보기판입니다. 문제는 GitHub Issues 로 알려 주세요.
