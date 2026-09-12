# SillyTavern

LLM Frontend for Power Users

## Remote Hosting (24/7, Tailscale-only)

`docker/cloud-init.sh` provisions a minimal, no-Docker, distro-agnostic VPS running SillyTavern as a
`systemd` service, reachable only over your [Tailscale](https://tailscale.com/) tailnet - never on the
public IP. It's a plain cloud-init user-data script, so it works unchanged on any provider that accepts
one: DigitalOcean, AWS EC2/Lightsail, Vultr, Hetzner Cloud, Linode, OVHcloud, etc. - paste it into
whichever field that provider calls "user data" / "cloud-init" / "startup script".

For DigitalOcean specifically, `docker/create-droplet.sh` (bash) / `create-droplet.ps1` (PowerShell,
Windows-native, no WSL needed) collapse the whole thing into one command via `doctl` - no web UI, no
manual paste. See the comments at the top of each script for setup.

The script also installs a set of default extensions (WorldInfoInfo, Guided Generations, Moonlit Echoes
Theme, Tavernary, Chub Search, Character Library) the same way SillyTavern's own "Install extension"
button would - see `install_default_extension` calls in `docker/cloud-init.sh` to add/remove from the list.

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
