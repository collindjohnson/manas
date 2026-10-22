The canonical runtime can run as a per-user macOS service. Use an installed Manas release binary and an existing configuration and Git brain:

```sh
manas service preview --config /absolute/config.json --repo /absolute/brain --binary /absolute/manas
manas service install --config /absolute/config.json --repo /absolute/brain
manas service installation-status --config /absolute/config.json
manas service status --config /absolute/config.json
```

Preview shows the full plist without creating files. Installation uses the separate `com.collindjohnson.manas.service` label, leaving the legacy nightly sync LaunchAgent intact. It loads into the current user's GUI launchd domain, starts at login, and restarts after unexpected process exit. The runtime retains exclusive store ownership and resumes durable queued work and due schedules; missed schedule intervals coalesce into one run. Logs are `service.log` and `service.err.log` in the configured state directory.

`installation-status` reports file ownership and whether launchd loaded the job. `service status` contacts the authenticated runtime and checks that it is responding. A loaded job does not establish model health or successful ingestion. A failed bootstrap leaves owned configuration on disk, reports an activation error, and can be retried with install.

```sh
manas service uninstall --preview --config /absolute/config.json
manas service uninstall --config /absolute/config.json
```

Removal unloads the owned job before deleting its exact recorded plist. Edited or unrelated files are preserved. Installation uses a hash receipt and serialized updates; a crash before receipt publication conservatively leaves an ownership conflict for manual inspection. It never removes the brain, operational state, legacy archives, or logs. `service stop` stops a foreground service, but launchd restarts an installed persistent service; use uninstall to stop it persistently. Installation requires macOS and must be invoked from the installed release binary. Automated tests inject launchctl. The [native launchd smoke](native-service-verification.json) additionally verifies actual bootstrap, health, forced-process-death recovery, durable recall after restart, and ownership-aware removal on arm64 macOS. It uses a disposable brain and temporary plist, refuses an existing loaded service, and removes its job afterward. A real logout/login and machine-resume check remains outstanding.

Run `bun run scripts/verify-native-service.ts --run-native --report docs/native-service-verification.json` after building the release binaries, from a macOS user session without an existing Manas service. The check temporarily uses the production service label but does not install a plist into the user login directory.

`bun run build:release` builds both macOS architectures. `bun run scripts/verify-release-runtime.ts` exercises compiled binaries against disposable brains, including a memory write and recall in a new process. The [recorded runtime check](release-runtime-verification.json) passed for arm64. The x64 artifact was built and identified as Mach-O x86_64, but this arm64 host returned `EBADARCH` when executing it; native Intel runtime verification remains outstanding. The check does not install launchd jobs or change owner configuration.

Release CI runs `bun run scripts/verify-release-runtime.ts --target <matrix-target> --require-target` on each native macOS runner before packaging. That check must write and recall the same canonical memory across processes; an unavailable required architecture fails the job instead of being counted as a pass. The default local check still records unavailable cross-architecture execution explicitly.
