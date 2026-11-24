# fastlane

Store releases of the Kubernanny app. Everything (one-time setup, commands, versioning, macOS vs. Linux) is in [docs/RELEASING.md](../docs/RELEASING.md).

```sh
bundle install                      # once, at the repository root
cd app && npm run release           # bump, tag, build, upload to TestFlight and the internal track
cd app && npm run release:production
```
