# ADR-0020: Windows installer — MSI built with WiX v5

**Status:** Accepted — 2026-10-04 (product owner decision; closes the "MSI toolset" owner item of BUILD_PLAN 10.4)

## Context
Hotels on Windows install the hotel agent (ADR-0017). Until now that was `packaging/windows/install.ps1`, which works
but is not the professional, simple installation hotel IT expects. The WiX Toolset is the standard open-source way to
build MSI packages. From WiX v6 (April 2025) organisations above a revenue threshold pay the Open Source Maintenance
Fee; WiX v5 (GA 2024, MS-RL) has no fee. The owner decided not to take on the v6 cost now.

## Decision
- **Production installs on Windows use an MSI built with WiX v5** (`WixToolset.Sdk` 5.x as an MSBuild SDK project in
  `apps/hotel-agent/packaging/windows/msi`). The MSI is built on a Windows CI runner from the same self-contained
  `win-x64` publish the zip uses; it is the artefact handed to hotels.
- **The MSI is a thin shell.** It lays the files into `%ProgramFiles%\Hotella\Agent\versions\<version>\`, asks for (or
  takes as public properties for silent installs) the platform address and the enrollment token, and calls the agent
  itself — `hotella-agent setup install` / `setup remove` — for everything with logic: the `current` link, the data
  directory and its ACL, the default settings, the Windows service and its recovery actions, enrollment and start.
  The same subcommand serves `install.ps1`, so the two paths cannot drift, and moving to another WiX version or
  installer technology later changes only the shell, never the agent or the platform.
- **The enrollment token never appears on a command line or in an MSI log.** The token property is `Hidden`; the MSI
  writes it to a file in the ACL-protected data directory, the agent enrolls from that file and deletes it.
- **Upgrades:** a newer MSI is a major upgrade (same `UpgradeCode`) — it installs its version side by side and switches
  `current`. The agent's own signed self-updater (10.4) keeps working between MSIs; it only adds version directories,
  which `setup remove` cleans up on uninstall. Uninstall keeps the data directory (identity, queue) unless
  `REMOVE_DATA=1`, so a reinstall does not need a new enrollment.
- **PowerShell stays** for development, diagnostics, automation and emergency/manual installs; it is not the hotel
  installation experience.
- **Code signing** of the MSI (and the executable) needs an Authenticode certificate — a purchase, so the owner's
  decision; until then the MSI is unsigned and SmartScreen warns on first run.

## Amendment — as built (Sprint 10.10, 2026-10-05)
- The installer asks for **enrollment codes** — one value per connector carrying the gateway address, the token and
  the agent CA's fingerprint — instead of an address and a token; the platform's answer to enrollment names the
  connector and its capabilities. One service per code (`HotellaAgent-<connector>`).
- The codes cross from the dialog to the agent through one small .NET Framework custom action (WiX DTF) that writes
  them, under a hidden action, into the data directory after making it SYSTEM/Administrators-only; Windows
  Installer's own INI or registry actions would have printed the values into a verbose log. All other steps run the
  agent (`setup install | stop | remove`) through `WixQuietExec`. Silent installs use `ENROLLMENT_CODES_FILE`.
- Repair asks for codes again, which is how a connector is added to an installed host.

## Consequences
- A Windows job in CI builds the MSI on every change and checks it with WiX's validation; installing it is part of the
  pilot readiness checklist (no Windows install test runs in CI beyond the build).
- WiX v6+ (or another toolset) remains an exit path: the `.wxs` holds no logic, so a migration is a packaging change.
